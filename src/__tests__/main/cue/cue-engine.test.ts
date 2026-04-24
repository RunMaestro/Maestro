/**
 * Tests for the Cue Engine core.
 *
 * Tests cover:
 * - Engine lifecycle (start, stop, isEnabled)
 * - Session initialization from YAML configs
 * - Timer-based subscriptions (time.heartbeat)
 * - File watcher subscriptions (file.changed)
 * - Agent completion subscriptions (agent.completed)
 * - Fan-in tracking for multi-source agent.completed
 * - Active run tracking and stopping
 * - Activity log ring buffer
 * - Session refresh and removal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueConfig, CueEvent, CueRunResult } from '../../../main/cue/cue-types';

// Mock the yaml loader
const mockLoadCueConfig = vi.fn<(projectRoot: string) => CueConfig | null>();
type DetailedResult =
	| { ok: true; config: CueConfig; warnings: string[] }
	| { ok: false; reason: 'missing' }
	| { ok: false; reason: 'parse-error'; message: string }
	| { ok: false; reason: 'invalid'; errors: string[] };
const mockLoadCueConfigDetailed = vi.fn<(projectRoot: string) => DetailedResult>();
const mockWatchCueYaml = vi.fn<(projectRoot: string, onChange: () => void) => () => void>();
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (...args: unknown[]) => mockLoadCueConfig(args[0] as string),
	loadCueConfigDetailed: (...args: unknown[]) => mockLoadCueConfigDetailed(args[0] as string),
	watchCueYaml: (...args: unknown[]) => mockWatchCueYaml(args[0] as string, args[1] as () => void),
	findAncestorCueConfigRoot: () => null,
}));

// Mock the file watcher
const mockCreateCueFileWatcher = vi.fn<(config: unknown) => () => void>();
vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: (...args: unknown[]) => mockCreateCueFileWatcher(args[0]),
}));

// Mock the GitHub poller
const mockCreateCueGitHubPoller = vi.fn<(config: unknown) => () => void>();
vi.mock('../../../main/cue/cue-github-poller', () => ({
	createCueGitHubPoller: (...args: unknown[]) => mockCreateCueGitHubPoller(args[0]),
}));

// Mock the task scanner
const mockCreateCueTaskScanner = vi.fn<(config: unknown) => () => void>();
vi.mock('../../../main/cue/cue-task-scanner', () => ({
	createCueTaskScanner: (...args: unknown[]) => mockCreateCueTaskScanner(args[0]),
}));

// Mock the database
const mockInitCueDb = vi.fn();
const mockCloseCueDb = vi.fn();
const mockPruneCueEvents = vi.fn();
vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: (...args: unknown[]) => mockInitCueDb(...args),
	closeCueDb: () => mockCloseCueDb(),
	pruneCueEvents: (...args: unknown[]) => mockPruneCueEvents(...args),
	isCueDbReady: () => true,
	recordCueEvent: vi.fn(),
	updateCueEventStatus: vi.fn(),
	safeRecordCueEvent: vi.fn(),
	safeUpdateCueEventStatus: vi.fn(),
	persistQueuedEvent: vi.fn(),
	removeQueuedEvent: vi.fn(),
	getQueuedEvents: vi.fn(() => []),
	clearPersistedQueue: vi.fn(),
	safePersistQueuedEvent: vi.fn(),
	safeRemoveQueuedEvent: vi.fn(),
	clearGitHubSeenForSubscription: vi.fn(),
}));

// Mock crypto
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
}));

import { CueEngine, type CueEngineDeps } from '../../../main/cue/cue-engine';
// `calculateNextScheduledTime` moved to triggers/cue-schedule-utils as part of
// the Phase 4 trigger source isolation. cue-subscription-setup.ts is gone.
import { calculateNextScheduledTime } from '../../../main/cue/triggers/cue-schedule-utils';
import { createMockSession, createMockConfig, createMockDeps } from './cue-test-helpers';

describe('CueEngine', () => {
	let yamlWatcherCleanup: ReturnType<typeof vi.fn>;
	let fileWatcherCleanup: ReturnType<typeof vi.fn>;

	let gitHubPollerCleanup: ReturnType<typeof vi.fn>;
	let taskScannerCleanup: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		yamlWatcherCleanup = vi.fn();
		mockWatchCueYaml.mockReturnValue(yamlWatcherCleanup);

		// Default loadCueConfigDetailed: derive from loadCueConfig for tests that
		// only configure mockLoadCueConfig. Tests that need to inject warnings or
		// load failures can override mockLoadCueConfigDetailed directly.
		mockLoadCueConfigDetailed.mockImplementation((projectRoot: string) => {
			const config = mockLoadCueConfig(projectRoot);
			return config ? { ok: true, config, warnings: [] } : { ok: false, reason: 'missing' };
		});

		fileWatcherCleanup = vi.fn();
		mockCreateCueFileWatcher.mockReturnValue(fileWatcherCleanup);

		gitHubPollerCleanup = vi.fn();
		mockCreateCueGitHubPoller.mockReturnValue(gitHubPollerCleanup);

		taskScannerCleanup = vi.fn();
		mockCreateCueTaskScanner.mockReturnValue(taskScannerCleanup);
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

			expect(deps.onLog).toHaveBeenCalledWith('cue', expect.stringContaining('started'), {
				type: 'engineStarted',
			});
			expect(deps.onLog).toHaveBeenCalledWith('cue', expect.stringContaining('stopped'), {
				type: 'engineStopped',
			});
		});

		it('does not enable when initCueDb throws', () => {
			mockInitCueDb.mockImplementation(() => {
				throw new Error('DB corrupted');
			});
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();
			expect(engine.isEnabled()).toBe(false);
		});

		it('logs error when initCueDb throws', () => {
			mockInitCueDb.mockImplementation(() => {
				throw new Error('DB corrupted');
			});
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();
			expect(deps.onLog).toHaveBeenCalledWith(
				'error',
				expect.stringContaining('Failed to initialize Cue database')
			);
		});

		it('does not initialize sessions when initCueDb throws', () => {
			mockInitCueDb.mockImplementation(() => {
				throw new Error('DB corrupted');
			});
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();
			expect(mockLoadCueConfig).not.toHaveBeenCalled();
		});

		it('does not start heartbeat when initCueDb throws', () => {
			mockInitCueDb.mockImplementation(() => {
				throw new Error('DB corrupted');
			});
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();
			// Engine is not enabled, so getStatus should return empty
			expect(engine.getStatus()).toEqual([]);
		});

		it('can retry start after DB failure', () => {
			mockInitCueDb
				.mockImplementationOnce(() => {
					throw new Error('DB corrupted');
				})
				.mockImplementation(() => {});
			mockLoadCueConfig.mockReturnValue(null);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);

			engine.start();
			expect(engine.isEnabled()).toBe(false);

			engine.start();
			expect(engine.isEnabled()).toBe(true);
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
						event: 'time.heartbeat',
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

	describe('time.heartbeat subscriptions', () => {
		it('fires immediately on setup', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'periodic',
						event: 'time.heartbeat',
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
				expect.objectContaining({
					sessionId: 'session-1',
					prompt: 'Run check',
					timeoutMs: 30 * 60 * 1000,
					event: expect.objectContaining({ type: 'time.heartbeat', triggerName: 'periodic' }),
				})
			);
		});

		it('fires on the interval', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'periodic',
						event: 'time.heartbeat',
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

			// Flush microtasks to let the initial run complete and free the concurrency slot
			await vi.advanceTimersByTimeAsync(0);
			vi.clearAllMocks();

			// Advance 5 minutes
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Advance another 5 minutes
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);

			engine.stop();
		});

		it('skips disabled subscriptions', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'disabled',
						event: 'time.heartbeat',
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
						event: 'time.heartbeat',
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
				expect.objectContaining({
					sessionId: 'session-1',
					prompt: 'follow up',
					event: expect.objectContaining({
						type: 'agent.completed',
						triggerName: 'on-done',
					}),
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
				expect.objectContaining({
					sessionId: 'session-1',
					prompt: 'aggregate',
					event: expect.objectContaining({
						type: 'agent.completed',
						triggerName: 'all-done',
					}),
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
						event: 'time.heartbeat',
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
						event: 'time.heartbeat',
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
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 10,
					},
					{
						name: 'new-2',
						event: 'time.heartbeat',
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

	describe('YAML hot reload', () => {
		it('logs "Config reloaded" with subscription count when config changes', () => {
			const config1 = createMockConfig({
				subscriptions: [
					{
						name: 'old-sub',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 5,
					},
				],
			});
			const config2 = createMockConfig({
				subscriptions: [
					{
						name: 'new-sub-1',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 10,
					},
					{
						name: 'new-sub-2',
						event: 'time.heartbeat',
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

			vi.clearAllMocks();
			engine.refreshSession('session-1', '/projects/test');

			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Config reloaded for "Test Session" (2 subscriptions)'),
				expect.objectContaining({ type: 'configReloaded', sessionId: 'session-1' })
			);
		});

		it('passes data to onLog for IPC push on config reload', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'sub',
						event: 'time.heartbeat',
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

			vi.clearAllMocks();
			engine.refreshSession('session-1', '/projects/test');

			// Verify data parameter is passed (triggers cue:activityUpdate in main process)
			const reloadCall = (deps.onLog as ReturnType<typeof vi.fn>).mock.calls.find(
				(call: unknown[]) => typeof call[1] === 'string' && call[1].includes('Config reloaded')
			);
			expect(reloadCall).toBeDefined();
			expect(reloadCall![2]).toEqual(
				expect.objectContaining({ type: 'configReloaded', sessionId: 'session-1' })
			);

			engine.stop();
		});

		it('logs "Config removed" when YAML file is deleted', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'sub',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 5,
					},
				],
			});
			// First call returns config (initial load), second returns null (file deleted)
			mockLoadCueConfig.mockReturnValueOnce(config).mockReturnValue(null);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			engine.refreshSession('session-1', '/projects/test');

			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Config removed for "Test Session"'),
				expect.objectContaining({ type: 'configRemoved', sessionId: 'session-1' })
			);
			expect(engine.getStatus()).toHaveLength(0);
		});

		it('sets up a pending yaml watcher after config deletion for re-creation', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'sub',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValueOnce(config).mockReturnValue(null);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			const initialWatchCalls = mockWatchCueYaml.mock.calls.length;
			engine.refreshSession('session-1', '/projects/test');

			// A new yaml watcher should be created for watching re-creation
			expect(mockWatchCueYaml.mock.calls.length).toBe(initialWatchCalls + 1);
		});

		it('recovers when config file is re-created after deletion', () => {
			const config1 = createMockConfig({
				subscriptions: [
					{
						name: 'original',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 5,
					},
				],
			});
			const config2 = createMockConfig({
				subscriptions: [
					{
						name: 'recreated',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test2',
						interval_minutes: 10,
					},
				],
			});
			// First: initial config, second: null (deleted), third: new config (re-created)
			mockLoadCueConfig
				.mockReturnValueOnce(config1)
				.mockReturnValueOnce(null)
				.mockReturnValue(config2);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Delete config
			engine.refreshSession('session-1', '/projects/test');
			expect(engine.getStatus()).toHaveLength(0);

			// Capture the pending yaml watcher callback
			const lastWatchCall = mockWatchCueYaml.mock.calls[mockWatchCueYaml.mock.calls.length - 1];
			const pendingOnChange = lastWatchCall[1] as () => void;

			// Simulate file re-creation by invoking the watcher callback
			pendingOnChange();

			// Session should be re-initialized with the new config
			const status = engine.getStatus();
			expect(status).toHaveLength(1);
			expect(status[0].subscriptionCount).toBe(1);
		});

		it('cleans up pending yaml watchers on engine stop', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'sub',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 5,
					},
				],
			});
			const pendingCleanup = vi.fn();
			mockLoadCueConfig.mockReturnValueOnce(config).mockReturnValue(null);
			mockWatchCueYaml.mockReturnValueOnce(yamlWatcherCleanup).mockReturnValue(pendingCleanup);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Delete config — creates pending yaml watcher
			engine.refreshSession('session-1', '/projects/test');

			// Stop engine — should clean up pending watcher
			engine.stop();
			expect(pendingCleanup).toHaveBeenCalled();
		});

		it('cleans up pending yaml watchers on removeSession', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'sub',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 5,
					},
				],
			});
			const pendingCleanup = vi.fn();
			mockLoadCueConfig.mockReturnValueOnce(config).mockReturnValue(null);
			mockWatchCueYaml.mockReturnValueOnce(yamlWatcherCleanup).mockReturnValue(pendingCleanup);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Delete config — creates pending yaml watcher
			engine.refreshSession('session-1', '/projects/test');

			// Remove session — should clean up pending watcher
			engine.removeSession('session-1');
			expect(pendingCleanup).toHaveBeenCalled();
		});

		it('triggers refresh via yaml watcher callback on file change', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'sub',
						event: 'time.heartbeat',
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

			// Capture the yaml watcher callback
			const watchCall = mockWatchCueYaml.mock.calls[0];
			const onChange = watchCall[1] as () => void;

			vi.clearAllMocks();
			mockLoadCueConfig.mockReturnValue(config);
			mockWatchCueYaml.mockReturnValue(vi.fn());

			// Simulate file change by invoking the watcher callback
			onChange();

			// refreshSession should have been called (loadCueConfig invoked for re-init)
			expect(mockLoadCueConfig).toHaveBeenCalledWith('/projects/test');
			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Config reloaded'),
				expect.any(Object)
			);
		});

		it('does not log "Config removed" when session never had config', () => {
			mockLoadCueConfig.mockReturnValue(null);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			// Session never had a config, so refreshSession with null should not log "Config removed"
			engine.refreshSession('session-1', '/projects/test');

			const removedCall = (deps.onLog as ReturnType<typeof vi.fn>).mock.calls.find(
				(call: unknown[]) => typeof call[1] === 'string' && call[1].includes('Config removed')
			);
			expect(removedCall).toBeUndefined();
		});
	});

	describe('activity log', () => {
		it('records completed runs', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'periodic',
						event: 'time.heartbeat',
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
						event: 'time.heartbeat',
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

		it('stopRun signals the executor callback for active runs', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);

			const activeRun = engine.getActiveRuns()[0];
			expect(activeRun).toBeDefined();
			expect(engine.stopRun(activeRun.runId)).toBe(true);
			expect(deps.onStopCueRun).toHaveBeenCalledWith(activeRun.runId);

			engine.stop();
		});

		it('stopRun adds the stopped run to the activity log', async () => {
			const deps = createMockDeps({
				onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			});
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(10);

			const activeRun = engine.getActiveRuns()[0];
			expect(activeRun).toBeDefined();
			engine.stopRun(activeRun.runId);

			const log = engine.getActivityLog();
			expect(log).toHaveLength(1);
			expect(log[0].runId).toBe(activeRun.runId);
			expect(log[0].status).toBe('stopped');

			engine.stop();
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
						event: 'time.heartbeat',
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
			expect(deps.onStopCueRun).toHaveBeenCalled();

			engine.stop();
		});
	});

	describe('github.pull_request / github.issue subscriptions', () => {
		it('github.pull_request subscription creates a GitHub poller with correct config', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'pr-watcher',
						event: 'github.pull_request',
						enabled: true,
						prompt: 'review PR',
						repo: 'owner/repo',
						poll_minutes: 10,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(createMockDeps());
			engine.start();

			expect(mockCreateCueGitHubPoller).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: 'github.pull_request',
					repo: 'owner/repo',
					pollMinutes: 10,
					projectRoot: '/projects/test',
					triggerName: 'pr-watcher',
					subscriptionId: 'session-1:pr-watcher',
				})
			);

			engine.stop();
		});

		it('github.issue subscription creates a GitHub poller', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'issue-watcher',
						event: 'github.issue',
						enabled: true,
						prompt: 'triage issue',
						repo: 'owner/repo',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(createMockDeps());
			engine.start();

			expect(mockCreateCueGitHubPoller).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: 'github.issue',
					pollMinutes: 5, // default
					triggerName: 'issue-watcher',
					subscriptionId: 'session-1:issue-watcher',
				})
			);

			engine.stop();
		});

		it('cleanup function is called on session teardown', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'pr-watcher',
						event: 'github.pull_request',
						enabled: true,
						prompt: 'review',
						repo: 'owner/repo',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(createMockDeps());
			engine.start();

			engine.removeSession('session-1');

			expect(gitHubPollerCleanup).toHaveBeenCalled();
		});

		it('passes gh_state to GitHub poller config', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'merged-prs',
						event: 'github.pull_request',
						enabled: true,
						prompt: 'review merged PR',
						gh_state: 'merged',
						repo: 'owner/repo',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(createMockDeps());
			engine.start();

			expect(mockCreateCueGitHubPoller).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: 'github.pull_request',
					ghState: 'merged',
					triggerName: 'merged-prs',
				})
			);

			engine.stop();
		});

		it('disabled github subscription is skipped', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'pr-watcher',
						event: 'github.pull_request',
						enabled: false,
						prompt: 'review',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(createMockDeps());
			engine.start();

			expect(mockCreateCueGitHubPoller).not.toHaveBeenCalled();

			engine.stop();
		});
	});

	describe('task.pending subscriptions', () => {
		it('creates a task scanner with correct config', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'task-queue',
						event: 'task.pending',
						enabled: true,
						prompt: 'process tasks',
						watch: 'tasks/**/*.md',
						poll_minutes: 2,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(createMockDeps());
			engine.start();

			expect(mockCreateCueTaskScanner).toHaveBeenCalledWith(
				expect.objectContaining({
					watchGlob: 'tasks/**/*.md',
					pollMinutes: 2,
					projectRoot: '/projects/test',
					triggerName: 'task-queue',
				})
			);

			engine.stop();
		});

		it('defaults poll_minutes to 1 when not specified', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'task-queue',
						event: 'task.pending',
						enabled: true,
						prompt: 'process tasks',
						watch: 'tasks/**/*.md',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(createMockDeps());
			engine.start();

			expect(mockCreateCueTaskScanner).toHaveBeenCalledWith(
				expect.objectContaining({
					pollMinutes: 1,
				})
			);

			engine.stop();
		});

		it('cleanup function is called on session teardown', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'task-queue',
						event: 'task.pending',
						enabled: true,
						prompt: 'process tasks',
						watch: 'tasks/**/*.md',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(createMockDeps());
			engine.start();

			engine.removeSession('session-1');

			expect(taskScannerCleanup).toHaveBeenCalled();
		});

		it('disabled task.pending subscription is skipped', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'task-queue',
						event: 'task.pending',
						enabled: false,
						prompt: 'process tasks',
						watch: 'tasks/**/*.md',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const engine = new CueEngine(createMockDeps());
			engine.start();

			expect(mockCreateCueTaskScanner).not.toHaveBeenCalled();

			engine.stop();
		});
	});

	describe('getStatus', () => {
		it('returns correct status for active sessions', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 5,
					},
					{
						name: 'disabled',
						event: 'time.heartbeat',
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

		it('returns sessions with cue configs when engine is disabled', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			// Engine never started — getStatus should still find configs on disk

			const status = engine.getStatus();
			expect(status).toHaveLength(1);
			expect(status[0].sessionId).toBe('session-1');
			expect(status[0].sessionName).toBe('Test Session');
			expect(status[0].enabled).toBe(false);
			expect(status[0].subscriptionCount).toBe(1);
			expect(status[0].activeRuns).toBe(0);
		});

		it('returns sessions with enabled=false after engine is stopped', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
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

			// While running, enabled is true
			expect(engine.getStatus()[0].enabled).toBe(true);

			engine.stop();

			// After stopping, sessions should still appear but with enabled=false
			const status = engine.getStatus();
			expect(status).toHaveLength(1);
			expect(status[0].enabled).toBe(false);
		});
	});

	describe('output_prompt execution', () => {
		it('executes output prompt after successful main task', async () => {
			const mainResult: CueRunResult = {
				runId: 'run-1',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'timer',
				event: {} as CueEvent,
				status: 'completed',
				stdout: 'main task output',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			};
			const outputResult: CueRunResult = {
				...mainResult,
				runId: 'run-2',
				stdout: 'formatted output for downstream',
			};
			const onCueRun = vi
				.fn()
				.mockResolvedValueOnce(mainResult)
				.mockResolvedValueOnce(outputResult);

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'do work',
						output_prompt: 'format results',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps({ onCueRun });
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(100);

			// onCueRun called twice: main task + output prompt
			expect(onCueRun).toHaveBeenCalledTimes(2);

			// First call is the main prompt
			expect(onCueRun.mock.calls[0][0].prompt).toBe('do work');

			// Second call is the output prompt with context appended
			expect(onCueRun.mock.calls[1][0].prompt).toContain('format results');
			expect(onCueRun.mock.calls[1][0].prompt).toContain('main task output');

			// Activity log should have the output prompt's stdout
			const log = engine.getActivityLog();
			expect(log[0].stdout).toBe('formatted output for downstream');

			engine.stop();
		});

		it('skips output prompt when main task fails', async () => {
			const failedResult: CueRunResult = {
				runId: 'run-1',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'timer',
				event: {} as CueEvent,
				status: 'failed',
				stdout: '',
				stderr: 'error',
				exitCode: 1,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			};
			const onCueRun = vi.fn().mockResolvedValue(failedResult);

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'do work',
						output_prompt: 'format results',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps({ onCueRun });
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(100);

			// Only called once — output prompt skipped
			expect(onCueRun).toHaveBeenCalledTimes(1);

			engine.stop();
		});

		it('falls back to main output when output prompt fails', async () => {
			const mainResult: CueRunResult = {
				runId: 'run-1',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'timer',
				event: {} as CueEvent,
				status: 'completed',
				stdout: 'main task output',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			};
			const failedOutputResult: CueRunResult = {
				...mainResult,
				runId: 'run-2',
				status: 'failed',
				stdout: '',
				stderr: 'output prompt error',
			};
			const onCueRun = vi
				.fn()
				.mockResolvedValueOnce(mainResult)
				.mockResolvedValueOnce(failedOutputResult);

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'do work',
						output_prompt: 'format results',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps({ onCueRun });
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(100);

			// Both calls made
			expect(onCueRun).toHaveBeenCalledTimes(2);

			// Activity log should retain main task output (fallback)
			const log = engine.getActivityLog();
			expect(log[0].stdout).toBe('main task output');

			engine.stop();
		});

		it('does not execute output prompt when none is configured', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'do work',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(100);

			// Only one call — no output prompt
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			engine.stop();
		});
	});

	describe('getGraphData', () => {
		it('returns graph data for active sessions', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
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

			const graph = engine.getGraphData();
			expect(graph).toHaveLength(1);
			expect(graph[0].sessionId).toBe('session-1');
			expect(graph[0].subscriptions).toHaveLength(1);

			engine.stop();
		});

		it('returns graph data from disk configs when engine is disabled', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			// Never started

			const graph = engine.getGraphData();
			expect(graph).toHaveLength(1);
			expect(graph[0].sessionId).toBe('session-1');
			expect(graph[0].sessionName).toBe('Test Session');
			expect(graph[0].subscriptions).toHaveLength(1);
		});

		it('returns graph data after engine is stopped', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
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
			engine.stop();

			const graph = engine.getGraphData();
			expect(graph).toHaveLength(1);
			expect(graph[0].sessionId).toBe('session-1');
		});

		it('filters out subscriptions whose agent_id targets a different session', () => {
			// getGraphData reports only subscriptions that belong to each session
			// (agent_id matches, or agent_id absent) so the pipeline editor never
			// sees a subscription under an unrelated session.
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'step-a',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'do A',
						interval_minutes: 5,
					},
					{
						name: 'step-b',
						event: 'agent.completed',
						enabled: true,
						prompt: 'do B',
						agent_id: 'other-session-99',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			const graph = engine.getGraphData();
			expect(graph).toHaveLength(1);
			// Only step-a (no agent_id, so unbound) is reported — step-b targets a
			// different session.
			expect(graph[0].subscriptions.map((s) => s.name)).toEqual(['step-a']);

			engine.stop();
		});

		it('filters foreign-agent_id subscriptions when loading from disk (engine disabled)', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'trigger',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'start',
						interval_minutes: 10,
					},
					{
						name: 'downstream',
						event: 'agent.completed',
						enabled: true,
						prompt: 'continue',
						agent_id: 'closed-agent-id',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			// Engine never started — simulates disabled path

			const graph = engine.getGraphData();
			expect(graph).toHaveLength(1);
			// Only `trigger` (unbound) is reported — `downstream` is bound to a
			// session that doesn't exist in this view.
			expect(graph[0].subscriptions.map((s) => s.name)).toEqual(['trigger']);
		});

		it('scopes subscriptions to their owning session when multiple sessions share a config', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'step-a',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'do A',
						interval_minutes: 5,
						agent_id: 'session-1',
					},
					{
						name: 'step-b',
						event: 'agent.completed',
						enabled: true,
						prompt: 'do B',
						agent_id: 'session-2',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);

			const session1 = createMockSession({ id: 'session-1', name: 'Agent A' });
			const session2 = createMockSession({ id: 'session-2', name: 'Agent B' });
			const deps = createMockDeps({
				getSessions: vi.fn(() => [session1, session2]),
			});
			const engine = new CueEngine(deps);
			engine.start();

			const graph = engine.getGraphData();
			expect(graph).toHaveLength(2);
			// Each session reports only its own subscriptions (agent_id match).
			const byId = new Map(graph.map((g) => [g.sessionId, g]));
			expect(byId.get('session-1')!.subscriptions.map((s) => s.name)).toEqual(['step-a']);
			expect(byId.get('session-2')!.subscriptions.map((s) => s.name)).toEqual(['step-b']);

			engine.stop();
		});
	});

	describe('calculateNextScheduledTime', () => {
		it('returns null for empty times array', () => {
			expect(calculateNextScheduledTime([])).toBeNull();
		});

		it('returns next occurrence today if time is ahead', () => {
			// Monday 2026-03-09 at 08:00
			vi.setSystemTime(new Date('2026-03-09T08:00:00'));
			const result = calculateNextScheduledTime(['09:00']);
			expect(result).not.toBeNull();
			const date = new Date(result!);
			expect(date.getHours()).toBe(9);
			expect(date.getMinutes()).toBe(0);
			expect(date.getDate()).toBe(9); // same day
		});

		it('returns next occurrence tomorrow if time has passed', () => {
			// Monday 2026-03-09 at 10:00
			vi.setSystemTime(new Date('2026-03-09T10:00:00'));
			const result = calculateNextScheduledTime(['09:00']);
			expect(result).not.toBeNull();
			const date = new Date(result!);
			expect(date.getHours()).toBe(9);
			expect(date.getMinutes()).toBe(0);
			expect(date.getDate()).toBe(10); // next day
		});

		it('picks earliest matching time', () => {
			// Monday 2026-03-09 at 08:00
			vi.setSystemTime(new Date('2026-03-09T08:00:00'));
			const result = calculateNextScheduledTime(['14:00', '09:00']);
			expect(result).not.toBeNull();
			const date = new Date(result!);
			expect(date.getHours()).toBe(9);
			expect(date.getMinutes()).toBe(0);
		});

		it('respects days filter — skips non-matching days', () => {
			// Monday 2026-03-09 at 10:00
			vi.setSystemTime(new Date('2026-03-09T10:00:00'));
			const result = calculateNextScheduledTime(['09:00'], ['wed']);
			expect(result).not.toBeNull();
			const date = new Date(result!);
			// Wednesday is 2026-03-11
			expect(date.getDay()).toBe(3); // Wednesday
			expect(date.getHours()).toBe(9);
		});

		it('returns null for invalid time strings', () => {
			vi.setSystemTime(new Date('2026-03-09T08:00:00'));
			const result = calculateNextScheduledTime(['25:99']);
			// Out-of-bounds hour (25) and minute (99) must be rejected — the function
			// validates bounds before calling setHours, so no Date rollover occurs.
			expect(result).toBeNull();
		});

		it('handles midnight crossing', () => {
			// Monday 2026-03-09 at 23:30
			vi.setSystemTime(new Date('2026-03-09T23:30:00'));
			const result = calculateNextScheduledTime(['00:15']);
			expect(result).not.toBeNull();
			const date = new Date(result!);
			expect(date.getDate()).toBe(10); // next day
			expect(date.getHours()).toBe(0);
			expect(date.getMinutes()).toBe(15);
		});

		it('handles all days when no days filter provided', () => {
			// Monday 2026-03-09 at 08:00
			vi.setSystemTime(new Date('2026-03-09T08:00:00'));
			const result = calculateNextScheduledTime(['09:00']);
			expect(result).not.toBeNull();
			// Should be today since no day restriction
			const date = new Date(result!);
			expect(date.getDate()).toBe(9);
		});

		it('wraps around week boundary', () => {
			// Saturday 2026-03-14 at 10:00
			vi.setSystemTime(new Date('2026-03-14T10:00:00'));
			const result = calculateNextScheduledTime(['09:00'], ['mon']);
			expect(result).not.toBeNull();
			const date = new Date(result!);
			// Next Monday is 2026-03-16
			expect(date.getDay()).toBe(1); // Monday
			expect(date.getDate()).toBe(16);
		});
	});

	describe('time.scheduled subscriptions', () => {
		it('fires when current time matches schedule_times', async () => {
			// Set to Monday 2026-03-09 at 08:59:00 — interval fires at 09:00
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'daily-check',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'run daily check',
						schedule_times: ['09:00'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Advance past the 60s check interval — time becomes 09:00
			await vi.advanceTimersByTimeAsync(60_000);

			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					prompt: 'run daily check',
					subscriptionName: 'daily-check',
					event: expect.objectContaining({
						type: 'time.scheduled',
					}),
				})
			);

			engine.stop();
		});

		it('does not fire when current time does not match', async () => {
			// Set to Monday 2026-03-09 at 09:01:30 — neither the immediate check nor
			// the first interval tick (at 09:02:30) matches the '09:00' schedule slot.
			vi.setSystemTime(new Date('2026-03-09T09:01:30'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'daily-check',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'run daily check',
						schedule_times: ['09:00'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(60_000);

			expect(deps.onCueRun).not.toHaveBeenCalled();

			engine.stop();
		});

		it('respects schedule_days filter — skips non-matching days', async () => {
			// Saturday 2026-03-14 at 08:59:00 — interval fires at 09:00
			vi.setSystemTime(new Date('2026-03-14T08:59:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'weekday-check',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'run weekday check',
						schedule_times: ['09:00'],
						schedule_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(60_000);

			expect(deps.onCueRun).not.toHaveBeenCalled();

			engine.stop();
		});

		it('fires when day matches schedule_days', async () => {
			// Monday 2026-03-09 at 08:59:00 — interval fires at 09:00
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'monday-check',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'monday task',
						schedule_times: ['09:00'],
						schedule_days: ['mon'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(60_000);

			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			engine.stop();
		});

		it('skips when schedule_times is empty', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'no-times',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'should not run',
						schedule_times: [],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// No interval should be created, no run triggered
			expect(deps.onCueRun).not.toHaveBeenCalled();

			engine.stop();
		});

		it('does not fire when engine is disabled', async () => {
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'daily-check',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'run check',
						schedule_times: ['09:00'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();
			engine.stop(); // Disable

			await vi.advanceTimersByTimeAsync(60_000);

			expect(deps.onCueRun).not.toHaveBeenCalled();
		});

		it('applies filter before firing', async () => {
			// Monday at 08:59 — fires at 09:00
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'filtered-schedule',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'filtered task',
						schedule_times: ['09:00'],
						filter: { matched_day: 'tue' }, // Won't match — today is Monday
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(60_000);

			expect(deps.onCueRun).not.toHaveBeenCalled();
			expect(deps.onLog).toHaveBeenCalledWith('cue', expect.stringContaining('filter not matched'));

			engine.stop();
		});

		it('event payload includes matched_time and matched_day', async () => {
			// Monday at 08:59 — fires at 09:00
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'payload-check',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'check payload',
						schedule_times: ['09:00'],
						schedule_days: ['mon'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(60_000);

			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					event: expect.objectContaining({
						type: 'time.scheduled',
						triggerName: 'payload-check',
						payload: expect.objectContaining({
							matched_time: '09:00',
							matched_day: 'mon',
							schedule_times: ['09:00'],
							schedule_days: ['mon'],
						}),
					}),
				})
			);

			engine.stop();
		});

		it('tracks nextTriggers via calculateNextScheduledTime', () => {
			// Monday 2026-03-09 at 08:00 — next trigger should be 09:00 today
			vi.setSystemTime(new Date('2026-03-09T08:00:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'tracked-schedule',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'check',
						schedule_times: ['09:00'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			const status = engine.getStatus();
			const sessionStatus = status.find((s) => s.sessionId === 'session-1');
			expect(sessionStatus).toBeDefined();
			expect(sessionStatus!.subscriptionCount).toBe(1);
			expect(sessionStatus!.nextTrigger).toBeDefined();

			engine.stop();
		});

		it('refreshes nextTriggers after time.scheduled fires', async () => {
			// Monday 2026-03-09 at 08:59 — next trigger should be 09:00 today
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'refresh-schedule',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'check',
						schedule_times: ['09:00'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			const statusBefore = engine.getStatus();
			const subBefore = statusBefore.find((s) => s.sessionId === 'session-1');
			const nextBefore = subBefore!.nextTrigger!;
			// nextTrigger should be pointing at 09:00 today (ISO string)
			const nextBeforeDate = new Date(nextBefore);
			expect(nextBeforeDate.getHours()).toBe(9);
			expect(nextBeforeDate.getMinutes()).toBe(0);

			// Advance to 09:00 — the subscription fires
			vi.advanceTimersByTime(60_000);
			await vi.advanceTimersByTimeAsync(10);

			// After firing, nextTrigger should have advanced to a future time (tomorrow 09:00)
			const statusAfter = engine.getStatus();
			const subAfter = statusAfter.find((s) => s.sessionId === 'session-1');
			expect(subAfter!.nextTrigger).toBeDefined();
			expect(new Date(subAfter!.nextTrigger!).getTime()).toBeGreaterThan(nextBeforeDate.getTime());

			engine.stop();
		});

		it('uses hydrated prompt content from materialized config', async () => {
			// Monday at 08:59 — fires at 09:00
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));

			// As of the Phase 2 cleanup, prompt_file no longer exists on the runtime
			// CueSubscription contract — the normalizer resolves it into `prompt` at
			// load time. This test confirms that hydrated content flows through to
			// onCueRun unchanged.
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'file-prompt',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'hydrated prompt content',
						schedule_times: ['09:00'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(60_000);

			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: 'hydrated prompt content',
				})
			);

			engine.stop();
		});

		it('passes output_prompt through', async () => {
			// Monday at 08:59 — fires at 09:00
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'with-output',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'main task',
						output_prompt: 'summarize results',
						schedule_times: ['09:00'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);

			let runCount = 0;
			const deps = createMockDeps({
				onCueRun: vi.fn(async (request) => {
					runCount++;
					return {
						runId: `run-${runCount}`,
						sessionId: 'session-1',
						sessionName: 'Test Session',
						subscriptionName: request.subscriptionName,
						event: request.event,
						status: 'completed' as const,
						stdout: 'task output',
						stderr: '',
						exitCode: 0,
						durationMs: 100,
						startedAt: new Date().toISOString(),
						endedAt: new Date().toISOString(),
					};
				}),
			});

			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(60_000);

			// Main run + output prompt run = 2 calls
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);
			// Second call should be the output prompt
			expect(deps.onCueRun).toHaveBeenLastCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('summarize results'),
				})
			);

			engine.stop();
		});

		it('clears timers on stop', () => {
			vi.setSystemTime(new Date('2026-03-09T08:00:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer-cleanup',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'test',
						schedule_times: ['09:00'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();
			engine.stop();

			// After stop, advancing to 08:59 then 60s more = 09:00
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));
			vi.advanceTimersByTime(60_000);

			expect(deps.onCueRun).not.toHaveBeenCalled();
		});

		it('skips disabled subscriptions', () => {
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'disabled-schedule',
						event: 'time.scheduled',
						enabled: false,
						prompt: 'should not run',
						schedule_times: ['09:00'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.advanceTimersByTime(60_000);

			expect(deps.onCueRun).not.toHaveBeenCalled();

			engine.stop();
		});

		it('does not double-fire when config is refreshed within the same minute', () => {
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'morning-check',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'Run morning check',
						schedule_times: ['09:00'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const session = createMockSession();
			const deps = createMockDeps({ getSessions: vi.fn(() => [session]) });
			const engine = new CueEngine(deps);
			engine.start();

			// Advance to 09:00 — should fire once
			vi.advanceTimersByTime(60_000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Simulate config refresh within the same minute (e.g., YAML hot reload)
			engine.refreshSession(session.id, session.projectRoot);

			// The new timer fires again in the same 09:00 minute — should NOT double-fire
			vi.advanceTimersByTime(60_000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			engine.stop();
		});

		it('fires again in a new minute after the guard key is evicted', async () => {
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'multi-time',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'Run',
						schedule_times: ['09:00', '09:02'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Advance to 09:00 — fires
			await vi.advanceTimersByTimeAsync(60_000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// 09:01 — no match, stale key for 09:00 is evicted
			await vi.advanceTimersByTimeAsync(60_000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// 09:02 — fires for the second scheduled time
			await vi.advanceTimersByTimeAsync(60_000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);

			engine.stop();
		});

		it('clears scheduled fired keys when engine is stopped and restarted', () => {
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'restart-test',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'Run',
						schedule_times: ['09:00'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);

			// First start: fire at 09:00
			engine.start();
			vi.advanceTimersByTime(60_000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Stop and restart — keys should be cleared
			engine.stop();
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));
			engine.start();
			vi.advanceTimersByTime(60_000);

			// Should fire again because the engine was stopped (keys cleared)
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);

			engine.stop();
		});
	});

	describe('output prompt separate runId (Fix 5)', () => {
		it('output prompt uses a different runId from main run', async () => {
			const mainResult: CueRunResult = {
				runId: 'run-main',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'timer',
				event: {} as CueEvent,
				status: 'completed',
				stdout: 'main output',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			};
			const outputResult: CueRunResult = {
				...mainResult,
				runId: 'run-output',
				stdout: 'formatted output',
			};
			const onCueRun = vi
				.fn()
				.mockResolvedValueOnce(mainResult)
				.mockResolvedValueOnce(outputResult);

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'do work',
						output_prompt: 'format results',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps({ onCueRun });
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(100);

			expect(onCueRun).toHaveBeenCalledTimes(2);
			const firstRunId = onCueRun.mock.calls[0][0].runId;
			const secondRunId = onCueRun.mock.calls[1][0].runId;
			expect(firstRunId).not.toBe(secondRunId);

			engine.stop();
		});

		it('output prompt timeout falls back to main output', async () => {
			const mainResult: CueRunResult = {
				runId: 'run-main',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'timer',
				event: {} as CueEvent,
				status: 'completed',
				stdout: 'main-output',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			};
			const timeoutResult: CueRunResult = {
				...mainResult,
				runId: 'run-output',
				status: 'timeout',
				stdout: '',
			};
			const onCueRun = vi
				.fn()
				.mockResolvedValueOnce(mainResult)
				.mockResolvedValueOnce(timeoutResult);

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'do work',
						output_prompt: 'format results',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps({ onCueRun });
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(100);

			// Activity log entry should have the main output (fallback)
			const log = engine.getActivityLog();
			expect(log[0].stdout).toBe('main-output');

			engine.stop();
		});

		it('output prompt event includes outputPromptPhase: true', async () => {
			const mainResult: CueRunResult = {
				runId: 'run-main',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'timer',
				event: {} as CueEvent,
				status: 'completed',
				stdout: 'main output',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			};
			const outputResult: CueRunResult = {
				...mainResult,
				runId: 'run-output',
				stdout: 'formatted',
			};
			const onCueRun = vi
				.fn()
				.mockResolvedValueOnce(mainResult)
				.mockResolvedValueOnce(outputResult);

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'timer',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'do work',
						output_prompt: 'format results',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);
			const deps = createMockDeps({ onCueRun });
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(100);

			expect(onCueRun).toHaveBeenCalledTimes(2);
			const secondCallEvent = onCueRun.mock.calls[1][0].event;
			expect(secondCallEvent.payload.outputPromptPhase).toBe(true);

			engine.stop();
		});

		it('completion chain receives output prompt stdout when successful', async () => {
			// Session A has heartbeat + output_prompt; Session B watches session A via agent.completed
			const sessionA = createMockSession({
				id: 'session-a',
				name: 'Agent A',
				projectRoot: '/proj/a',
			});
			const sessionB = createMockSession({
				id: 'session-b',
				name: 'Agent B',
				projectRoot: '/proj/b',
			});

			const configA = createMockConfig({
				subscriptions: [
					{
						name: 'heartbeat-a',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'do work',
						output_prompt: 'format nicely',
						interval_minutes: 60,
					},
				],
			});
			const configB = createMockConfig({
				subscriptions: [
					{
						name: 'chain-b',
						event: 'agent.completed',
						enabled: true,
						prompt: 'react to A',
						source_session: 'Agent A',
					},
				],
			});

			mockLoadCueConfig.mockImplementation((root: string) => {
				if (root === '/proj/a') return configA;
				if (root === '/proj/b') return configB;
				return null;
			});

			let runCount = 0;
			const onCueRun = vi.fn(async (request: Parameters<CueEngineDeps['onCueRun']>[0]) => {
				runCount++;
				const result: CueRunResult = {
					runId: `run-${runCount}`,
					sessionId: request.sessionId,
					sessionName: request.sessionId === 'session-a' ? 'Agent A' : 'Agent B',
					subscriptionName: request.subscriptionName,
					event: request.event,
					status: 'completed' as const,
					stdout: runCount === 1 ? 'raw' : runCount === 2 ? 'formatted' : 'chain-output',
					stderr: '',
					exitCode: 0,
					durationMs: 100,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				};
				return result;
			});

			const deps = createMockDeps({
				getSessions: vi.fn(() => [sessionA, sessionB]),
				onCueRun,
			});

			const engine = new CueEngine(deps);
			engine.start();

			// Let the heartbeat fire (immediate) + output prompt + completion chain
			await vi.advanceTimersByTimeAsync(100);

			// Session B's agent.completed event should have sourceOutput from the output prompt (formatted)
			const chainCall = (onCueRun as ReturnType<typeof vi.fn>).mock.calls.find(
				(call: unknown[]) =>
					(call[0] as { subscriptionName: string }).subscriptionName === 'chain-b'
			);
			expect(chainCall).toBeDefined();
			expect((chainCall![0] as { event: CueEvent }).event.payload.sourceOutput).toContain(
				'formatted'
			);

			engine.stop();
		});
	});

	describe('configuration hotloading', () => {
		it('new subscription fires after hot reload', async () => {
			const config1 = createMockConfig({
				subscriptions: [
					{
						name: 'heartbeat-1',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'first',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config1);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);

			// Capture the watchCueYaml onChange callback
			let capturedOnChange: (() => void) | undefined;
			mockWatchCueYaml.mockImplementation((_root: string, cb: () => void) => {
				capturedOnChange = cb;
				return vi.fn();
			});

			engine.start();
			await vi.advanceTimersByTimeAsync(0);
			vi.clearAllMocks();

			// Update config to have 2 subscriptions
			const config2 = createMockConfig({
				subscriptions: [
					{
						name: 'heartbeat-1',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'first',
						interval_minutes: 60,
					},
					{
						name: 'heartbeat-2',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'second',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config2);

			// Invoke onChange to trigger hot reload
			expect(capturedOnChange).toBeDefined();
			capturedOnChange!();

			// Both heartbeats fire immediately on setup
			await vi.advanceTimersByTimeAsync(0);
			expect(deps.onCueRun).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'second' }));

			engine.stop();
		});

		it('removed subscription stops after hot reload', async () => {
			const config1 = createMockConfig({
				subscriptions: [
					{
						name: 'heartbeat-1',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'first',
						interval_minutes: 5,
					},
					{
						name: 'heartbeat-2',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'second',
						interval_minutes: 10,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config1);
			const deps = createMockDeps();

			let capturedOnChange: (() => void) | undefined;
			mockWatchCueYaml.mockImplementation((_root: string, cb: () => void) => {
				capturedOnChange = cb;
				return vi.fn();
			});

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(0);
			vi.clearAllMocks();

			// Reload with only heartbeat-1
			const config2 = createMockConfig({
				subscriptions: [
					{
						name: 'heartbeat-1',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'first',
						interval_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config2);
			capturedOnChange!();

			await vi.advanceTimersByTimeAsync(0);
			vi.clearAllMocks();

			// Advance 5 minutes — only heartbeat-1 should fire
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
			expect(deps.onCueRun).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'first' }));

			engine.stop();
		});

		it('YAML deletion tears down session', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'heartbeat',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 60,
					},
				],
			});

			let capturedOnChange: (() => void) | undefined;
			mockWatchCueYaml.mockImplementation((_root: string, cb: () => void) => {
				capturedOnChange = cb;
				return vi.fn();
			});

			mockLoadCueConfig.mockReturnValueOnce(config);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(0);

			// Reload returns null (YAML deleted)
			mockLoadCueConfig.mockReturnValue(null);
			capturedOnChange!();

			// Session state should be removed
			expect(engine.getStatus()).toHaveLength(0);
			// Should log config removed
			expect(deps.onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining('Config removed'),
				expect.objectContaining({ type: 'configRemoved' })
			);

			engine.stop();
		});

		it('scheduledFiredKeys are cleaned on refresh', async () => {
			// Start at 08:59 — 1 minute before the scheduled time
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'schedule-test',
						event: 'time.scheduled',
						enabled: true,
						prompt: 'scheduled task',
						schedule_times: ['09:00'],
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);

			let capturedOnChange: (() => void) | undefined;
			mockWatchCueYaml.mockImplementation((_root: string, cb: () => void) => {
				capturedOnChange = cb;
				return vi.fn();
			});

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Advance to 09:00 — should fire
			await vi.advanceTimersByTimeAsync(60_000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Refresh session — scheduledFiredKeys are cleared in teardownSession
			capturedOnChange!();

			// Reset system time to 08:59 so the next 60s advance lands at 09:00 again
			vi.setSystemTime(new Date('2026-03-09T08:59:00'));
			await vi.advanceTimersByTimeAsync(60_000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);

			engine.stop();
		});

		it('changed max_concurrent applies to next drain', async () => {
			const config1 = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'heartbeat',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});

			let capturedOnChange: (() => void) | undefined;
			mockWatchCueYaml.mockImplementation((_root: string, cb: () => void) => {
				capturedOnChange = cb;
				return vi.fn();
			});

			// First run never resolves to keep the slot occupied
			let resolveFirstRun: ((result: CueRunResult) => void) | undefined;
			const firstRunPromise = new Promise<CueRunResult>((resolve) => {
				resolveFirstRun = resolve;
			});
			const subsequentResult: CueRunResult = {
				runId: 'run-sub',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'heartbeat',
				event: {} as CueEvent,
				status: 'completed',
				stdout: 'output',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			};
			const onCueRun = vi
				.fn()
				.mockReturnValueOnce(firstRunPromise)
				.mockResolvedValue(subsequentResult);

			mockLoadCueConfig.mockReturnValue(config1);
			const deps = createMockDeps({ onCueRun });
			const engine = new CueEngine(deps);
			engine.start();

			// First heartbeat fires immediately, occupying the single slot
			await vi.advanceTimersByTimeAsync(0);
			expect(onCueRun).toHaveBeenCalledTimes(1);

			// Advance 1 minute — second heartbeat queued (max_concurrent=1, slot occupied)
			await vi.advanceTimersByTimeAsync(60_000);

			// Reload with max_concurrent=2
			const config2 = createMockConfig({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 2,
					queue_size: 10,
				},
				subscriptions: [
					{
						name: 'heartbeat',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'test',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config2);
			capturedOnChange!();

			// The config reload tears down and reinitializes — the immediate heartbeat fires again
			// With max_concurrent=2, the new heartbeat can dispatch immediately
			await vi.advanceTimersByTimeAsync(0);

			// Resolve the first run to free the slot
			resolveFirstRun!({
				...subsequentResult,
				runId: 'run-1',
			});
			await vi.advanceTimersByTimeAsync(0);

			// After reload with max_concurrent=2, at least one additional run should have dispatched
			expect(onCueRun.mock.calls.length).toBeGreaterThanOrEqual(2);

			engine.stop();
		});
	});

	describe('prompt file existence warning (Fix 7)', () => {
		// The warning now originates inside materializeCueConfig() and flows through
		// loadCueConfigDetailed().warnings, which session-runtime-service forwards to
		// the logger. These tests inject the warning directly via the detailed mock to
		// verify the integration path: loader warnings → engine logger.
		it('logs warning when prompt_file is set but prompt is empty', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'missing-file-sub',
						event: 'time.heartbeat',
						enabled: true,
						prompt: '',
						interval_minutes: 60,
					},
				],
			});
			mockLoadCueConfigDetailed.mockReturnValue({
				ok: true,
				config,
				warnings: [
					'"missing-file-sub" has prompt_file "missing.md" but the file was not found — subscription will fail on trigger',
				],
			});
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			expect(deps.onLog).toHaveBeenCalledWith('warn', expect.stringContaining('prompt_file'));
			expect(deps.onLog).toHaveBeenCalledWith('warn', expect.stringContaining('missing.md'));

			engine.stop();
		});

		it('does not warn when prompt_file is set and prompt is populated', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'valid-file-sub',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'content from file',
						interval_minutes: 60,
					},
				],
			});
			// No warnings — the loader successfully resolved the prompt file content.
			mockLoadCueConfigDetailed.mockReturnValue({
				ok: true,
				config,
				warnings: [],
			});
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			const warnCalls = (deps.onLog as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call: unknown[]) =>
					call[0] === 'warn' && typeof call[1] === 'string' && call[1].includes('prompt_file')
			);
			expect(warnCalls).toHaveLength(0);

			engine.stop();
		});
	});

	describe('triggerSubscription with sourceAgentId', () => {
		it('should include sourceAgentId in the event payload', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'test-sub',
						event: 'cli.trigger',
						enabled: true,
						prompt: 'Do the thing',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			const result = engine.triggerSubscription('test-sub', undefined, 'agent-xyz-123');
			expect(result).toBe(true);

			// Verify the event passed to onCueRun contains sourceAgentId in payload
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					event: expect.objectContaining({
						payload: expect.objectContaining({
							manual: true,
							sourceAgentId: 'agent-xyz-123',
						}),
					}),
				})
			);

			engine.stop();
		});

		it('should not include sourceAgentId in event payload when not provided', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'test-sub',
						event: 'cli.trigger',
						enabled: true,
						prompt: 'Do the thing',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			engine.triggerSubscription('test-sub');

			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					event: expect.objectContaining({
						payload: expect.objectContaining({
							manual: true,
						}),
					}),
				})
			);
			// Verify sourceAgentId is NOT in the payload
			const callArgs = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(callArgs.event.payload).not.toHaveProperty('sourceAgentId');

			engine.stop();
		});

		it('should include both sourceAgentId and cliPrompt in event payload', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'test-sub',
						event: 'cli.trigger',
						enabled: true,
						prompt: 'Default prompt',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			engine.triggerSubscription('test-sub', 'override prompt', 'agent-abc');

			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					event: expect.objectContaining({
						payload: expect.objectContaining({
							manual: true,
							sourceAgentId: 'agent-abc',
							cliPrompt: 'override prompt',
						}),
					}),
				})
			);

			engine.stop();
		});

		it('should return false when subscription is not found', () => {
			const config = createMockConfig({ subscriptions: [] });
			mockLoadCueConfig.mockReturnValue(config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			const result = engine.triggerSubscription('nonexistent', undefined, 'agent-xyz');
			expect(result).toBe(false);
			expect(deps.onCueRun).not.toHaveBeenCalled();

			engine.stop();
		});
	});

	describe('triggerSubscription fires sibling branch group', () => {
		// Regression guard for the per-branch fan-out shape (two parallel
		// subs sharing one trigger). A natural scheduled tick fires every
		// armed sub; manual trigger must match that so the editor Play
		// button runs both branches in one click, not just the one whose
		// name happens to be bound to the trigger node.
		//
		// Each config raises `max_concurrent` so the run manager dispatches
		// all siblings immediately instead of queueing the tail. The queued
		// case is still correct (queued runs execute when a slot frees) but
		// would make the assertions flaky on call-count timing.
		const CONCURRENT_SETTINGS = {
			timeout_minutes: 30,
			timeout_on_fail: 'break' as const,
			max_concurrent: 4,
			queue_size: 10,
		};

		it('fires every branch sub sharing pipeline_name + event config when exact name matches', () => {
			const config = createMockConfig({
				settings: CONCURRENT_SETTINGS,
				subscriptions: [
					{
						name: 'Pipeline 1-cmd-a',
						event: 'time.scheduled',
						enabled: true,
						prompt: './script1.sh',
						action: 'command',
						command: { mode: 'shell', shell: './script1.sh' },
						schedule_times: ['07:00'],
						pipeline_name: 'Pipeline 1',
					},
					{
						name: 'Pipeline 1-cmd-b',
						event: 'time.scheduled',
						enabled: true,
						prompt: './script2.sh',
						action: 'command',
						command: { mode: 'shell', shell: './script2.sh' },
						schedule_times: ['07:00'],
						pipeline_name: 'Pipeline 1',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			const result = engine.triggerSubscription('Pipeline 1-cmd-a');

			expect(result).toBe(true);
			const names = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls
				.map((c) => c[0].subscriptionName)
				.sort();
			expect(names).toEqual(['Pipeline 1-cmd-a', 'Pipeline 1-cmd-b']);

			engine.stop();
		});

		it('falls back to pipeline_name when no sub has that exact name', () => {
			// Pipeline-editor Play-button case: a freshly-rebuilt trigger node
			// that hasn't been reloaded from YAML carries only the pipeline
			// name. No sub is named "Pipeline 1" exactly in the per-branch
			// emission, but the fallback resolves to the pipeline's initial-
			// trigger subs and fires them all.
			const config = createMockConfig({
				settings: CONCURRENT_SETTINGS,
				subscriptions: [
					{
						name: 'Pipeline 1-cmd-a',
						event: 'time.scheduled',
						enabled: true,
						prompt: './a.sh',
						action: 'command',
						command: { mode: 'shell', shell: './a.sh' },
						schedule_times: ['07:00'],
						pipeline_name: 'Pipeline 1',
					},
					{
						name: 'Pipeline 1-cmd-b',
						event: 'time.scheduled',
						enabled: true,
						prompt: './b.sh',
						action: 'command',
						command: { mode: 'shell', shell: './b.sh' },
						schedule_times: ['07:00'],
						pipeline_name: 'Pipeline 1',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			const result = engine.triggerSubscription('Pipeline 1');

			expect(result).toBe(true);
			const names = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls
				.map((c) => c[0].subscriptionName)
				.sort();
			expect(names).toEqual(['Pipeline 1-cmd-a', 'Pipeline 1-cmd-b']);

			engine.stop();
		});

		it('does NOT fire chain subs (agent.completed) even if they share pipeline_name', () => {
			// Chain subs exist for every non-initial node in a pipeline.
			// They must only fire on their upstream's completion, not on a
			// manual pipeline trigger — otherwise a chain would dispatch
			// with no upstream output and run its downstream agent blindly.
			const config = createMockConfig({
				settings: CONCURRENT_SETTINGS,
				subscriptions: [
					{
						name: 'Pipeline 1-cmd-a',
						event: 'time.scheduled',
						enabled: true,
						prompt: './a.sh',
						action: 'command',
						command: { mode: 'shell', shell: './a.sh' },
						schedule_times: ['07:00'],
						pipeline_name: 'Pipeline 1',
					},
					{
						name: 'Pipeline 1-chain-1',
						event: 'agent.completed',
						enabled: true,
						prompt: 'run agent',
						source_session: 'agent-a',
						pipeline_name: 'Pipeline 1',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			const result = engine.triggerSubscription('Pipeline 1');

			expect(result).toBe(true);
			const names = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls.map(
				(c) => c[0].subscriptionName
			);
			expect(names).toEqual(['Pipeline 1-cmd-a']);
			expect(names).not.toContain('Pipeline 1-chain-1');

			engine.stop();
		});

		it('fires only the anchor (not the group) when promptOverride is provided', () => {
			// CLI-shaped call: `maestro cue trigger <sub> --prompt "..."` wants
			// exactly that sub to run with the override. Applying the override
			// to sibling branches would surprise the caller.
			const config = createMockConfig({
				settings: CONCURRENT_SETTINGS,
				subscriptions: [
					{
						name: 'Pipeline 1-cmd-a',
						event: 'cli.trigger',
						enabled: true,
						prompt: './a.sh',
						pipeline_name: 'Pipeline 1',
					},
					{
						name: 'Pipeline 1-cmd-b',
						event: 'cli.trigger',
						enabled: true,
						prompt: './b.sh',
						pipeline_name: 'Pipeline 1',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			const result = engine.triggerSubscription('Pipeline 1-cmd-a', 'override prompt');

			expect(result).toBe(true);
			const names = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls.map(
				(c) => c[0].subscriptionName
			);
			expect(names).toEqual(['Pipeline 1-cmd-a']);

			engine.stop();
		});

		it('does NOT fire unrelated triggers that share pipeline_name but differ in event config', () => {
			// Multi-trigger pipelines: morning schedule (07:00) and evening
			// schedule (19:00) share pipeline_name but are intentionally
			// independent. The group key pins on event-specific config so
			// clicking Play on the morning trigger does NOT fire evening.
			const config = createMockConfig({
				settings: CONCURRENT_SETTINGS,
				subscriptions: [
					{
						name: 'morning-1',
						event: 'time.scheduled',
						enabled: true,
						prompt: './morning1.sh',
						action: 'command',
						command: { mode: 'shell', shell: './morning1.sh' },
						schedule_times: ['07:00'],
						pipeline_name: 'Pipeline 1',
					},
					{
						name: 'morning-2',
						event: 'time.scheduled',
						enabled: true,
						prompt: './morning2.sh',
						action: 'command',
						command: { mode: 'shell', shell: './morning2.sh' },
						schedule_times: ['07:00'],
						pipeline_name: 'Pipeline 1',
					},
					{
						name: 'evening',
						event: 'time.scheduled',
						enabled: true,
						prompt: './evening.sh',
						action: 'command',
						command: { mode: 'shell', shell: './evening.sh' },
						schedule_times: ['19:00'],
						pipeline_name: 'Pipeline 1',
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			vi.clearAllMocks();
			const result = engine.triggerSubscription('morning-1');

			expect(result).toBe(true);
			const names = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls
				.map((c) => c[0].subscriptionName)
				.sort();
			expect(names).toEqual(['morning-1', 'morning-2']);
			expect(names).not.toContain('evening');

			engine.stop();
		});
	});
});
