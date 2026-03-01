/**
 * Tests for the Cue Engine core.
 *
 * Tests cover:
 * - Engine lifecycle (start, stop, isEnabled)
 * - Session initialization from YAML configs
 * - Timer-based subscriptions (time.interval)
 * - File watcher subscriptions (file.changed)
 * - Agent completion subscriptions (agent.completed)
 * - Fan-in tracking for multi-source agent.completed
 * - Active run tracking and stopping
 * - Activity log ring buffer
 * - Session refresh and removal
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
		settings: { timeout_minutes: 30, timeout_on_fail: 'break' },
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

describe('CueEngine', () => {
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

	describe('lifecycle', () => {
		it('starts as disabled', () => {
			const engine = new CueEngine(createMockDeps());
			expect(engine.isEnabled()).toBe(false);
		});

		it('becomes enabled after start()', () => {
			mockLoadCueConfig.mockReturnValue(null);
			const engine = new CueEngine(createMockDeps());
			engine.start();
			expect(engine.isEnabled()).toBe(true);
		});

		it('becomes disabled after stop()', () => {
			mockLoadCueConfig.mockReturnValue(null);
			const engine = new CueEngine(createMockDeps());
			engine.start();
			engine.stop();
			expect(engine.isEnabled()).toBe(false);
		});

		it('logs start and stop events', () => {
			mockLoadCueConfig.mockReturnValue(null);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();
			engine.stop();

			expect(deps.onLog).toHaveBeenCalledWith('cue', expect.stringContaining('started'));
			expect(deps.onLog).toHaveBeenCalledWith('cue', expect.stringContaining('stopped'));
		});
	});

	describe('session initialization', () => {
		it('scans all sessions on start', () => {
			const sessions = [
				createMockSession({ id: 's1', projectRoot: '/proj1' }),
				createMockSession({ id: 's2', projectRoot: '/proj2' }),
			];
			mockLoadCueConfig.mockReturnValue(null);
			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			expect(mockLoadCueConfig).toHaveBeenCalledWith('/proj1');
			expect(mockLoadCueConfig).toHaveBeenCalledWith('/proj2');
		});

		it('skips sessions without a cue config', () => {
			mockLoadCueConfig.mockReturnValue(null);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			expect(engine.getStatus()).toHaveLength(0);
		});

		it('initializes sessions with valid config', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 10,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			const status = engine.getStatus();
			expect(status).toHaveLength(1);
			expect(status[0].subscriptionCount).toBe(1);
		});

		it('sets up YAML file watcher for config changes', () => {
			mockLoadCueConfig.mockReturnValue(createMockConfig());
			const engine = new CueEngine(createMockDeps());
			engine.start();

			expect(mockWatchCueYaml).toHaveBeenCalled();
		});
	});

	describe('time.interval subscriptions', () => {
		it('fires immediately on setup', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'periodic',
						event: 'time.interval',
						enabled: true,
						prompt: 'Run check',
						interval_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Should fire immediately
			expect(deps.onCueRun).toHaveBeenCalledWith(
				'session-1',
				'Run check',
				expect.objectContaining({ type: 'time.interval', triggerName: 'periodic' })
			);
		});

		it('fires on the interval', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'periodic',
						event: 'time.interval',
						enabled: true,
						prompt: 'Run check',
						interval_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();

			// Advance 5 minutes
			vi.advanceTimersByTime(5 * 60 * 1000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Advance another 5 minutes
			vi.advanceTimersByTime(5 * 60 * 1000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);

			engine.stop();
		});

		it('skips disabled subscriptions', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'disabled',
						event: 'time.interval',
						enabled: false,
						prompt: 'noop',
						interval_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			expect(deps.onCueRun).not.toHaveBeenCalled();
			engine.stop();
		});

		it('clears timers on stop', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'periodic',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.stop();

			vi.advanceTimersByTime(60 * 1000);
			expect(deps.onCueRun).not.toHaveBeenCalled();
		});
	});

	describe('file.changed subscriptions', () => {
		it('creates a file watcher with correct config', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'watch-src',
						event: 'file.changed',
						enabled: true,
						prompt: 'lint',
						watch: 'src/**/*.ts',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(createMockDeps());
			engine.start();

			expect(mockCreateCueFileWatcher).toHaveBeenCalledWith(
				expect.objectContaining({
					watchGlob: 'src/**/*.ts',
					projectRoot: '/projects/test',
					debounceMs: 5000,
					triggerName: 'watch-src',
				})
			);

			engine.stop();
		});

		it('cleans up file watcher on stop', () => {
			const config = createMockConfig({
				subscriptions: [
					{ name: 'watch', event: 'file.changed', enabled: true, prompt: 'test', watch: '**/*.ts' },
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(createMockDeps());
			engine.start();
			engine.stop();

			expect(fileWatcherCleanup).toHaveBeenCalled();
		});
	});

	describe('agent.completed subscriptions', () => {
		it('fires for single source_session match', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'on-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'agent-a',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-a');

			expect(deps.onCueRun).toHaveBeenCalledWith(
				'session-1',
				'follow up',
				expect.objectContaining({
					type: 'agent.completed',
					triggerName: 'on-done',
				})
			);
		});

		it('does not fire for non-matching session', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'on-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'follow up',
						source_session: 'agent-a',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.notifyAgentCompleted('agent-b');

			expect(deps.onCueRun).not.toHaveBeenCalled();
		});

		it('tracks fan-in completions', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'all-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: ['agent-a', 'agent-b'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();

			// First completion — should not fire
			engine.notifyAgentCompleted('agent-a');
			expect(deps.onCueRun).not.toHaveBeenCalled();

			// Second completion — should fire
			engine.notifyAgentCompleted('agent-b');
			expect(deps.onCueRun).toHaveBeenCalledWith(
				'session-1',
				'aggregate',
				expect.objectContaining({
					type: 'agent.completed',
					triggerName: 'all-done',
				})
			);
		});

		it('resets fan-in tracker after firing', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'all-done',
						event: 'agent.completed',
						enabled: true,
						prompt: 'aggregate',
						source_session: ['agent-a', 'agent-b'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();

			engine.notifyAgentCompleted('agent-a');
			engine.notifyAgentCompleted('agent-b');
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			vi.clearAllMocks();

			// Start again — should need both to fire again
			engine.notifyAgentCompleted('agent-a');
			expect(deps.onCueRun).not.toHaveBeenCalled();
		});
	});

	describe('session management', () => {
		it('removeSession tears down subscriptions', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			engine.removeSession('session-1');
			expect(engine.getStatus()).toHaveLength(0);
			expect(yamlWatcherCleanup).toHaveBeenCalled();
		});

		it('refreshSession re-reads config', () => {
			const config1 = createMockConfig({
				subscriptions: [
					{
						name: 'old',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 5,
					},
				],
			});
			const config2 = createMockConfig({
				subscriptions: [
					{
						name: 'new-1',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 10,
					},
					{
						name: 'new-2',
						event: 'time.interval',
						enabled: true,
						prompt: 'test2',
						interval_minutes: 15,
					},
				],
			});
			mockLoadCueConfig.mockReturnValueOnce(config1).mockReturnValue(config2);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			engine.refreshSession('session-1', '/projects/test');

			const status = engine.getStatus();
			expect(status).toHaveLength(1);
			expect(status[0].subscriptionCount).toBe(2);
		});
	});

	describe('activity log', () => {
		it('records completed runs', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'periodic',
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

			// Wait for the async run to complete
			await vi.advanceTimersByTimeAsync(100);

			const log = engine.getActivityLog();
			expect(log.length).toBeGreaterThan(0);
			expect(log[0].subscriptionName).toBe('periodic');
		});

		it('respects limit parameter', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'periodic',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Run multiple intervals
			await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
			await vi.advanceTimersByTimeAsync(1 * 60 * 1000);

			const limited = engine.getActivityLog(1);
			expect(limited).toHaveLength(1);

			engine.stop();
		});
	});

	describe('run management', () => {
		it('stopRun returns false for non-existent run', () => {
			const engine = new CueEngine(createMockDeps());
			expect(engine.stopRun('nonexistent')).toBe(false);
		});

		it('stopAll clears all active runs', async () => {
			// Use a slow-resolving onCueRun to keep runs active
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})), // Never resolves
			});
			const config = createMockConfig({
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
			const engine = new CueEngine(deps);
			engine.start();

			// Allow async execution to start
			await vi.advanceTimersByTimeAsync(10);

			expect(engine.getActiveRuns().length).toBeGreaterThan(0);
			engine.stopAll();
			expect(engine.getActiveRuns()).toHaveLength(0);

			engine.stop();
		});
	});

	describe('getStatus', () => {
		it('returns correct status for active sessions', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.interval',
						enabled: true,
						prompt: 'test',
						interval_minutes: 5,
					},
					{
						name: 'disabled',
						event: 'time.interval',
						enabled: false,
						prompt: 'noop',
						interval_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			const status = engine.getStatus();
			expect(status).toHaveLength(1);
			expect(status[0].sessionId).toBe('session-1');
			expect(status[0].sessionName).toBe('Test Session');
			expect(status[0].subscriptionCount).toBe(1); // Only enabled ones
			expect(status[0].enabled).toBe(true);

			engine.stop();
		});
	});
});
