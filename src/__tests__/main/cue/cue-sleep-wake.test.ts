/**
 * Tests for the CueEngine sleep/wake detection and reconciliation.
 *
 * Tests cover:
 * - Heartbeat starts on engine.start() and stops on engine.stop()
 * - Sleep detection triggers reconciler when gap >= 2 minutes
 * - No reconciliation when gap < 2 minutes
 * - Database pruning on start
 * - Graceful handling of missing/uninitialized database
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueConfig, CueEvent, CueRunResult } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';

// Track cue-db calls
const mockInitCueDb = vi.fn();
const mockCloseCueDb = vi.fn();
const mockUpdateHeartbeat = vi.fn();
const mockGetLastHeartbeat = vi.fn<() => number | null>();
const mockPruneCueEvents = vi.fn();

vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: (...args: unknown[]) => mockInitCueDb(...args),
	closeCueDb: () => mockCloseCueDb(),
	updateHeartbeat: () => mockUpdateHeartbeat(),
	getLastHeartbeat: () => mockGetLastHeartbeat(),
	pruneCueEvents: (...args: unknown[]) => mockPruneCueEvents(...args),
}));

// Track reconciler calls
const mockReconcileMissedTimeEvents = vi.fn();
vi.mock('../../../main/cue/cue-reconciler', () => ({
	reconcileMissedTimeEvents: (...args: unknown[]) => mockReconcileMissedTimeEvents(...args),
}));

// Mock the yaml loader
const mockLoadCueConfig = vi.fn<(projectRoot: string) => CueConfig | null>();
const mockWatchCueYaml = vi.fn<(projectRoot: string, onChange: () => void) => () => void>();
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (...args: unknown[]) => mockLoadCueConfig(args[0] as string),
	watchCueYaml: (...args: unknown[]) => mockWatchCueYaml(args[0] as string, args[1] as () => void),
}));

// Mock the file watcher
vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: vi.fn(() => vi.fn()),
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
		subscriptions: [
			{
				name: 'timer-sub',
				event: 'time.interval',
				enabled: true,
				prompt: 'check status',
				interval_minutes: 15,
			},
		],
		settings: { timeout_minutes: 30, timeout_on_fail: 'break', max_concurrent: 1, queue_size: 10 },
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

describe('CueEngine sleep/wake detection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockWatchCueYaml.mockReturnValue(vi.fn());
		mockLoadCueConfig.mockReturnValue(createMockConfig());
		mockGetLastHeartbeat.mockReturnValue(null);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should initialize the Cue database on start', () => {
		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start();

		expect(mockInitCueDb).toHaveBeenCalledTimes(1);
		expect(mockInitCueDb).toHaveBeenCalledWith(expect.any(Function));

		engine.stop();
	});

	it('should prune old events on start', () => {
		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start();

		expect(mockPruneCueEvents).toHaveBeenCalledTimes(1);
		// 7 days in milliseconds
		expect(mockPruneCueEvents).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1000);

		engine.stop();
	});

	it('should write heartbeat immediately on start', () => {
		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start();

		expect(mockUpdateHeartbeat).toHaveBeenCalledTimes(1);

		engine.stop();
	});

	it('should write heartbeat every 30 seconds', () => {
		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start();

		// Initial call
		expect(mockUpdateHeartbeat).toHaveBeenCalledTimes(1);

		// Advance 30 seconds
		vi.advanceTimersByTime(30_000);
		expect(mockUpdateHeartbeat).toHaveBeenCalledTimes(2);

		// Advance another 30 seconds
		vi.advanceTimersByTime(30_000);
		expect(mockUpdateHeartbeat).toHaveBeenCalledTimes(3);

		engine.stop();
	});

	it('should stop heartbeat on engine stop', () => {
		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start();

		const callCount = mockUpdateHeartbeat.mock.calls.length;
		engine.stop();

		// Advance time — no more heartbeats should fire
		vi.advanceTimersByTime(60_000);
		expect(mockUpdateHeartbeat).toHaveBeenCalledTimes(callCount);
	});

	it('should close the database on stop', () => {
		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start();
		engine.stop();

		expect(mockCloseCueDb).toHaveBeenCalledTimes(1);
	});

	it('should not reconcile on first start (no previous heartbeat)', () => {
		mockGetLastHeartbeat.mockReturnValue(null);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start();

		expect(mockReconcileMissedTimeEvents).not.toHaveBeenCalled();

		engine.stop();
	});

	it('should not reconcile when gap is less than 2 minutes', () => {
		// Last heartbeat was 60 seconds ago (below 120s threshold)
		mockGetLastHeartbeat.mockReturnValue(Date.now() - 60_000);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start();

		expect(mockReconcileMissedTimeEvents).not.toHaveBeenCalled();

		engine.stop();
	});

	it('should reconcile when gap exceeds 2 minutes', () => {
		// Last heartbeat was 10 minutes ago
		const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
		mockGetLastHeartbeat.mockReturnValue(tenMinutesAgo);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start();

		expect(mockReconcileMissedTimeEvents).toHaveBeenCalledTimes(1);
		const reconcileArgs = mockReconcileMissedTimeEvents.mock.calls[0][0];
		expect(reconcileArgs.sleepStartMs).toBe(tenMinutesAgo);
		expect(reconcileArgs.sessions).toBeInstanceOf(Map);
		expect(typeof reconcileArgs.onDispatch).toBe('function');
		expect(typeof reconcileArgs.onLog).toBe('function');

		engine.stop();
	});

	it('should log sleep detection with gap duration', () => {
		const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
		mockGetLastHeartbeat.mockReturnValue(fiveMinutesAgo);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start();

		expect(deps.onLog).toHaveBeenCalledWith(
			'cue',
			expect.stringContaining('Sleep detected (gap: 5m)')
		);

		engine.stop();
	});

	it('should handle database initialization failure gracefully', () => {
		mockInitCueDb.mockImplementation(() => {
			throw new Error('DB init failed');
		});

		const deps = createMockDeps();
		const engine = new CueEngine(deps);

		// Should not throw
		expect(() => engine.start()).not.toThrow();

		// Should log the warning
		expect(deps.onLog).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('Failed to initialize Cue database')
		);

		engine.stop();
	});

	it('should handle heartbeat read failure gracefully during sleep detection', () => {
		mockGetLastHeartbeat.mockImplementation(() => {
			throw new Error('DB read failed');
		});

		const deps = createMockDeps();
		const engine = new CueEngine(deps);

		// Should not throw
		expect(() => engine.start()).not.toThrow();

		engine.stop();
	});

	it('should pass session info to the reconciler', () => {
		const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
		mockGetLastHeartbeat.mockReturnValue(tenMinutesAgo);

		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start();

		const reconcileArgs = mockReconcileMissedTimeEvents.mock.calls[0][0];
		const sessions = reconcileArgs.sessions as Map<string, unknown>;

		// Should contain the session from our mock
		expect(sessions.size).toBe(1);
		expect(sessions.has('session-1')).toBe(true);

		const sessionInfo = sessions.get('session-1') as { config: CueConfig; sessionName: string };
		expect(sessionInfo.sessionName).toBe('Test Session');
		expect(sessionInfo.config.subscriptions).toHaveLength(1);

		engine.stop();
	});
});
