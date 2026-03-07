/**
 * Tests for per-session concurrency control and event queuing.
 *
 * Tests cover:
 * - Concurrency limits (max_concurrent) gate event dispatch
 * - Event queuing when at concurrency limit
 * - Queue draining when slots free
 * - Queue overflow (oldest entry dropped)
 * - Stale event eviction during drain
 * - Queue cleanup on stopAll, removeSession, and stop
 * - getQueueStatus() and clearQueue() public API
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueConfig, CueEvent, CueRunResult } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';

// Mock the yaml loader
const mockLoadCueConfig = vi.fn<(projectRoot: string) => CueConfig | null>();
const mockWatchCueYaml = vi.fn<(projectRoot: string, onChange: () => void) => () => void>();
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (...args: unknown[]) => mockLoadCueConfig(args[0] as string),
	watchCueYaml: (...args: unknown[]) => mockWatchCueYaml(args[0] as string, args[1] as () => void),
}));

// Mock the file watcher
const mockCreateCueFileWatcher = vi.fn<(config: unknown) => () => void>();
vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: (...args: unknown[]) => mockCreateCueFileWatcher(args[0]),
}));

// Mock crypto
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
}));

import { CueEngine, type CueEngineDeps } from '../../../main/cue/cue-engine';

function createMockSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		cwd: '/projects/test',
		projectRoot: '/projects/test',
		...overrides,
	};
}

function createMockConfig(overrides: Partial<CueConfig> = {}): CueConfig {
	return {
		subscriptions: [],
		settings: {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		},
		...overrides,
	};
}

function createMockDeps(overrides: Partial<CueEngineDeps> = {}): CueEngineDeps {
	return {
		getSessions: vi.fn(() => [createMockSession()]),
		onCueRun: vi.fn(async () => ({
			runId: 'run-1',
			sessionId: 'session-1',
			sessionName: 'Test Session',
			subscriptionName: 'test',
			event: {} as CueEvent,
			status: 'completed' as const,
			stdout: 'output',
			stderr: '',
			exitCode: 0,
			durationMs: 100,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
		})),
		onLog: vi.fn(),
		...overrides,
	};
}

describe('CueEngine Concurrency Control', () => {
	let yamlWatcherCleanup: ReturnType<typeof vi.fn>;
	let fileWatcherCleanup: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		yamlWatcherCleanup = vi.fn();
		mockWatchCueYaml.mockReturnValue(yamlWatcherCleanup);

		fileWatcherCleanup = vi.fn();
		mockCreateCueFileWatcher.mockReturnValue(fileWatcherCleanup);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('max_concurrent enforcement', () => {
		it('allows dispatching when below max_concurrent', async () => {
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 3,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Initial fire should dispatch (1/3 concurrent)
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
			engine.stop();
		});

		it('queues events when at max_concurrent limit', async () => {
			// Create a never-resolving onCueRun to keep runs active
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			// Allow the initial fire to start (never completes)
			await vi.advanceTimersByTimeAsync(10);

			// First call dispatched
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Trigger another interval — should be queued
			vi.advanceTimersByTime(1 * 60 * 1000);
			// Still only 1 call — the second was queued
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Verify queue has an entry
			const queueStatus = engine.getQueueStatus();
			expect(queueStatus.get('session-1')).toBe(1);

			engine.stopAll();
			engine.stop();
		});

		it('logs queue activity with correct format', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 5,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);

			// Trigger another interval — should be queued
			vi.advanceTimersByTime(1 * 60 * 1000);

			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Event queued for "Test Session"')
			);
			expect(deps.onLog).toHaveBeenCalledWith('cue', expect.stringContaining('1/5 in queue'));

			engine.stopAll();
			engine.stop();
		});
	});

	describe('queue draining', () => {
		it('dequeues and dispatches when a slot frees up', async () => {
			let resolveRun: ((val: CueRunResult) => void) | undefined;
			const deps = createMockDeps({
				onCueRun: vi.fn(
					() =>
						new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						})
				),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Trigger another — should be queued
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			// Complete the first run — should drain the queue
			resolveRun!({
				runId: 'r1',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'timer',
				event: {} as CueEvent,
				status: 'completed',
				stdout: '',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});
			await vi.advanceTimersByTimeAsync(10);

			// The queued event should now be dispatched
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			// Queue should be empty
			expect(engine.getQueueStatus().size).toBe(0);

			engine.stopAll();
			engine.stop();
		});
	});

	describe('queue overflow', () => {
		it('drops oldest entry when queue is full', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 2,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);

			// Fill the queue (size 2)
			vi.advanceTimersByTime(1 * 60 * 1000); // queued: 1
			vi.advanceTimersByTime(1 * 60 * 1000); // queued: 2

			expect(engine.getQueueStatus().get('session-1')).toBe(2);

			// Overflow — should drop oldest
			vi.advanceTimersByTime(1 * 60 * 1000); // queued: still 2, but oldest dropped

			expect(engine.getQueueStatus().get('session-1')).toBe(2);
			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Queue full for "Test Session", dropping oldest event')
			);

			engine.stopAll();
			engine.stop();
		});
	});

	describe('stale event eviction', () => {
		it('drops stale events during drain', async () => {
			let resolveRun: ((val: CueRunResult) => void) | undefined;
			const deps = createMockDeps({
				onCueRun: vi.fn(
					() =>
						new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						})
				),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 1, // 1 minute timeout
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Queue an event
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			// Wait long enough for the queued event to become stale (> 1 minute)
			vi.advanceTimersByTime(2 * 60 * 1000);

			// Complete the first run — drain should evict the stale event
			resolveRun!({
				runId: 'r1',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'timer',
				event: {} as CueEvent,
				status: 'completed',
				stdout: '',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});
			await vi.advanceTimersByTimeAsync(10);

			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Dropping stale queued event')
			);

			engine.stopAll();
			engine.stop();
		});
	});

	describe('queue cleanup', () => {
		it('stopAll clears all queues', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			engine.stopAll();
			expect(engine.getQueueStatus().size).toBe(0);
			engine.stop();
		});

		it('removeSession clears queue for that session', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			engine.removeSession('session-1');
			expect(engine.getQueueStatus().size).toBe(0);
			engine.stop();
		});

		it('engine stop clears all queues', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			engine.stop();
			expect(engine.getQueueStatus().size).toBe(0);
		});
	});

	describe('clearQueue', () => {
		it('clears queued events for a specific session', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			vi.advanceTimersByTime(1 * 60 * 1000);
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(engine.getQueueStatus().get('session-1')).toBe(2);

			engine.clearQueue('session-1');
			expect(engine.getQueueStatus().size).toBe(0);

			engine.stopAll();
			engine.stop();
		});
	});

	describe('getQueueStatus', () => {
		it('returns empty map when no events are queued', () => {
			mockLoadCueConfig.mockReturnValue(null);
			const engine = new CueEngine(createMockDeps());
			engine.start();

			expect(engine.getQueueStatus().size).toBe(0);
			engine.stop();
		});

		it('returns correct count per session', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			vi.advanceTimersByTime(1 * 60 * 1000);
			vi.advanceTimersByTime(1 * 60 * 1000);
			vi.advanceTimersByTime(1 * 60 * 1000);

			expect(engine.getQueueStatus().get('session-1')).toBe(3);

			engine.stopAll();
			engine.stop();
		});
	});

	describe('multi-concurrent slots', () => {
		it('allows multiple concurrent runs up to max_concurrent', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 3,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1); // Initial fire

			// Trigger 2 more intervals — all should dispatch (3 slots)
			vi.advanceTimersByTime(1 * 60 * 1000);
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(3);
			expect(engine.getQueueStatus().size).toBe(0); // Nothing queued

			// 4th trigger should be queued
			vi.advanceTimersByTime(1 * 60 * 1000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(3);
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			engine.stopAll();
			engine.stop();
		});
	});
});
