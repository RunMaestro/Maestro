/**
 * Tests for Cue sleep prevention integration.
 *
 * Tests cover:
 * - Schedule-level sleep prevention (heartbeat/scheduled subscriptions keep PC awake)
 * - Run-level sleep prevention (active Cue runs keep PC awake)
 * - Cleanup on teardown, removal, stop, and reset
 * - Edge cases: disabled subs, agent_id mismatch, config refresh, optional callbacks
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueConfig, CueRunResult } from '../../../main/cue/cue-types';

// Mock the yaml loader
const mockLoadCueConfig = vi.fn<(projectRoot: string) => CueConfig | null>();
const mockWatchCueYaml = vi.fn<(projectRoot: string, onChange: () => void) => () => void>();
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (...args: unknown[]) => mockLoadCueConfig(args[0] as string),
	loadCueConfigDetailed: (...args: unknown[]) => {
		const config = mockLoadCueConfig(args[0] as string);
		return config
			? { ok: true as const, config, warnings: [] as string[] }
			: { ok: false as const, reason: 'missing' as const };
	},
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
vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	closeCueDb: vi.fn(),
	pruneCueEvents: vi.fn(),
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
}));

// Mock crypto
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
}));

import { CueEngine, type CueEngineDeps } from '../../../main/cue/cue-engine';
import { createMockSession, createMockConfig, createMockDeps } from './cue-test-helpers';

describe('Cue Sleep Prevention', () => {
	let yamlWatcherCleanup: ReturnType<typeof vi.fn>;
	let fileWatcherCleanup: ReturnType<typeof vi.fn>;
	let gitHubPollerCleanup: ReturnType<typeof vi.fn>;
	let taskScannerCleanup: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		yamlWatcherCleanup = vi.fn();
		mockWatchCueYaml.mockReturnValue(yamlWatcherCleanup);

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

	describe('schedule-level sleep prevention', () => {
		it('adds schedule reason when session has heartbeat subscription', () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat-sub',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'do stuff',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			expect(onPreventSleep).toHaveBeenCalledWith('cue:schedule:session-1');
		});

		it('adds schedule reason when session has scheduled subscription', () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'scheduled-sub',
							event: 'time.scheduled',
							schedule_times: ['09:00'],
							prompt: 'do stuff',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			expect(onPreventSleep).toHaveBeenCalledWith('cue:schedule:session-1');
		});

		it('does not add schedule reason for file.changed subscriptions only', () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'file-watcher',
							event: 'file.changed',
							watch: '**/*.ts',
							prompt: 'review changes',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			expect(onPreventSleep).not.toHaveBeenCalledWith(expect.stringContaining('cue:schedule:'));
		});

		it('does not add schedule reason for agent.completed subscriptions only', () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'completion-sub',
							event: 'agent.completed',
							source_session: 'other-session',
							prompt: 'follow up',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			expect(onPreventSleep).not.toHaveBeenCalledWith(expect.stringContaining('cue:schedule:'));
		});

		it('does not add schedule reason for github subscriptions only', () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'pr-watcher',
							event: 'github.pull_request',
							prompt: 'review pr',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			expect(onPreventSleep).not.toHaveBeenCalledWith(expect.stringContaining('cue:schedule:'));
		});

		it('does not add schedule reason for task.pending subscriptions only', () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'task-scanner',
							event: 'task.pending',
							watch: '**/*.md',
							prompt: 'do tasks',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			expect(onPreventSleep).not.toHaveBeenCalledWith(expect.stringContaining('cue:schedule:'));
		});

		it('adds schedule reason once for mixed subs (heartbeat + file.changed)', () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat-sub',
							event: 'time.heartbeat',
							interval_minutes: 10,
							prompt: 'check health',
							enabled: true,
						},
						{
							name: 'file-watcher',
							event: 'file.changed',
							watch: '**/*.ts',
							prompt: 'review',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			const scheduleCalls = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:schedule:')
			);
			expect(scheduleCalls).toHaveLength(1);
			expect(scheduleCalls[0][0]).toBe('cue:schedule:session-1');
		});

		it('does not add schedule reason for disabled heartbeat subscription', () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'disabled-heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'do stuff',
							enabled: false,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			expect(onPreventSleep).not.toHaveBeenCalledWith(expect.stringContaining('cue:schedule:'));
		});

		it('does not add schedule reason for heartbeat bound to different agent_id', () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'other-agent-heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'do stuff',
							enabled: true,
							agent_id: 'different-session',
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			expect(onPreventSleep).not.toHaveBeenCalledWith(expect.stringContaining('cue:schedule:'));
		});

		it('adds separate schedule reasons for multiple sessions', () => {
			const onPreventSleep = vi.fn();
			const session1 = createMockSession({ id: 'session-1', name: 'Session 1' });
			const session2 = createMockSession({
				id: 'session-2',
				name: 'Session 2',
				projectRoot: '/projects/test2',
			});
			const deps = createMockDeps({
				onPreventSleep,
				getSessions: vi.fn(() => [session1, session2]),
			});

			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			expect(onPreventSleep).toHaveBeenCalledWith('cue:schedule:session-1');
			expect(onPreventSleep).toHaveBeenCalledWith('cue:schedule:session-2');
		});

		it('removes schedule reason on teardownSession via removeSession', () => {
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({ onAllowSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			engine.removeSession('session-1');

			expect(onAllowSleep).toHaveBeenCalledWith('cue:schedule:session-1');
		});

		it('removes all schedule reasons on stop()', () => {
			const onAllowSleep = vi.fn();
			const session1 = createMockSession({ id: 'session-1', name: 'Session 1' });
			const session2 = createMockSession({
				id: 'session-2',
				name: 'Session 2',
				projectRoot: '/projects/test2',
			});
			const deps = createMockDeps({
				onAllowSleep,
				getSessions: vi.fn(() => [session1, session2]),
			});

			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			engine.stop();

			expect(onAllowSleep).toHaveBeenCalledWith('cue:schedule:session-1');
			expect(onAllowSleep).toHaveBeenCalledWith('cue:schedule:session-2');
		});

		it('refreshSession re-adds schedule reason when config still has heartbeat', () => {
			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep, onAllowSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			onPreventSleep.mockClear();
			onAllowSleep.mockClear();

			engine.refreshSession('session-1', '/projects/test');

			// teardown releases, re-init re-adds
			expect(onAllowSleep).toHaveBeenCalledWith('cue:schedule:session-1');
			expect(onPreventSleep).toHaveBeenCalledWith('cue:schedule:session-1');
		});

		it('refreshSession cleans up reason when heartbeat removed from config', () => {
			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep, onAllowSleep });

			// Initial config has heartbeat
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			onPreventSleep.mockClear();
			onAllowSleep.mockClear();

			// Refreshed config has no heartbeat
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'file-watcher',
							event: 'file.changed',
							watch: '**/*.ts',
							prompt: 'review',
							enabled: true,
						},
					],
				})
			);

			engine.refreshSession('session-1', '/projects/test');

			// teardown releases the old reason
			expect(onAllowSleep).toHaveBeenCalledWith('cue:schedule:session-1');
			// re-init does NOT add schedule reason (no time-based subs)
			expect(onPreventSleep).not.toHaveBeenCalledWith(expect.stringContaining('cue:schedule:'));
		});

		it('refreshSession adds reason when heartbeat added to config', () => {
			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep, onAllowSleep });

			// Initial config has no heartbeat
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'file-watcher',
							event: 'file.changed',
							watch: '**/*.ts',
							prompt: 'review',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			onPreventSleep.mockClear();

			// Refreshed config adds heartbeat
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			engine.refreshSession('session-1', '/projects/test');

			expect(onPreventSleep).toHaveBeenCalledWith('cue:schedule:session-1');
		});

		it('operates normally when callbacks are not provided', () => {
			const deps = createMockDeps(); // no onPreventSleep/onAllowSleep
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);

			// Should not throw
			expect(() => {
				engine.start();
				engine.removeSession('session-1');
				engine.stop();
			}).not.toThrow();
		});
	});

	describe('run-level sleep prevention', () => {
		it('adds block reason when run starts', async () => {
			const onPreventSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			// Advance to trigger the heartbeat (immediate fire on setup)
			await vi.advanceTimersByTimeAsync(100);

			// Should have been called with a cue:run: reason
			const runCalls = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			);
			expect(runCalls.length).toBeGreaterThanOrEqual(1);
		});

		it('removes block reason when run completes', async () => {
			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({ onPreventSleep, onAllowSleep });
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();

			// Let the run complete
			await vi.advanceTimersByTimeAsync(100);

			// Find the run reason that was added
			const runAddCalls = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			);
			expect(runAddCalls.length).toBeGreaterThanOrEqual(1);

			const runReason = runAddCalls[0][0];

			// Same reason should have been removed
			expect(onAllowSleep).toHaveBeenCalledWith(runReason);
		});

		it('removes block reason when run fails', async () => {
			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({
				onPreventSleep,
				onAllowSleep,
				onCueRun: vi.fn(async () => ({
					runId: 'run-1',
					sessionId: 'session-1',
					sessionName: 'Test Session',
					subscriptionName: 'heartbeat',
					event: {
						id: 'e1',
						type: 'time.heartbeat' as const,
						triggerName: 'heartbeat',
						timestamp: new Date().toISOString(),
						payload: {},
					},
					status: 'failed' as const,
					stdout: '',
					stderr: 'something broke',
					exitCode: 1,
					durationMs: 100,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				})),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			const runAddCalls = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			);
			expect(runAddCalls.length).toBeGreaterThanOrEqual(1);

			const runReason = runAddCalls[0][0];
			expect(onAllowSleep).toHaveBeenCalledWith(runReason);
		});

		it('removes block reason when run is manually stopped', async () => {
			let resolveRun: (result: CueRunResult) => void;
			const runPromise = new Promise<CueRunResult>((resolve) => {
				resolveRun = resolve;
			});

			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({
				onPreventSleep,
				onAllowSleep,
				onCueRun: vi.fn(() => runPromise),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			// Get the active run
			const activeRuns = engine.getActiveRuns();
			expect(activeRuns.length).toBe(1);
			const runId = activeRuns[0].runId;

			// Stop the run
			engine.stopRun(runId);

			expect(onAllowSleep).toHaveBeenCalledWith(`cue:run:${runId}`);

			// Resolve the run promise to avoid hanging
			resolveRun!({
				runId,
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'heartbeat',
				event: {
					id: 'e1',
					type: 'time.heartbeat',
					triggerName: 'heartbeat',
					timestamp: new Date().toISOString(),
					payload: {},
				},
				status: 'stopped',
				stdout: '',
				stderr: '',
				exitCode: null,
				durationMs: 0,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});
			await vi.advanceTimersByTimeAsync(100);
		});

		it('stopAll removes all run block reasons', async () => {
			let resolveRun1: (result: CueRunResult) => void;
			let resolveRun2: (result: CueRunResult) => void;
			let callCount = 0;

			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({
				onPreventSleep,
				onAllowSleep,
				onCueRun: vi.fn(() => {
					callCount++;
					if (callCount === 1) {
						return new Promise<CueRunResult>((resolve) => {
							resolveRun1 = resolve;
						});
					}
					return new Promise<CueRunResult>((resolve) => {
						resolveRun2 = resolve;
					});
				}),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
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
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			// Trigger a second run by advancing to next heartbeat
			vi.advanceTimersByTime(5 * 60 * 1000);
			await vi.advanceTimersByTimeAsync(100);

			const activeRuns = engine.getActiveRuns();
			expect(activeRuns.length).toBe(2);

			engine.stopAll();

			// Both run reasons should have been released
			for (const run of activeRuns) {
				expect(onAllowSleep).toHaveBeenCalledWith(`cue:run:${run.runId}`);
			}

			// Resolve promises to avoid hanging
			const makeResult = (runId: string): CueRunResult => ({
				runId,
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'heartbeat',
				event: {
					id: 'e1',
					type: 'time.heartbeat',
					triggerName: 'heartbeat',
					timestamp: new Date().toISOString(),
					payload: {},
				},
				status: 'stopped',
				stdout: '',
				stderr: '',
				exitCode: null,
				durationMs: 0,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});
			resolveRun1!(makeResult(activeRuns[0].runId));
			resolveRun2!(makeResult(activeRuns[1].runId));
			await vi.advanceTimersByTimeAsync(100);
		});

		it('engine stop (reset) removes all run block reasons', async () => {
			let resolveRun: (result: CueRunResult) => void;

			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			const deps = createMockDeps({
				onPreventSleep,
				onAllowSleep,
				onCueRun: vi.fn(
					() =>
						new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						})
				),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 5,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			const activeRuns = engine.getActiveRuns();
			expect(activeRuns.length).toBe(1);
			const runId = activeRuns[0].runId;

			engine.stop();

			// reset() should release run reason
			expect(onAllowSleep).toHaveBeenCalledWith(`cue:run:${runId}`);

			// Resolve to avoid hanging
			resolveRun!({
				runId,
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'heartbeat',
				event: {
					id: 'e1',
					type: 'time.heartbeat',
					triggerName: 'heartbeat',
					timestamp: new Date().toISOString(),
					payload: {},
				},
				status: 'stopped',
				stdout: '',
				stderr: '',
				exitCode: null,
				durationMs: 0,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});
			await vi.advanceTimersByTimeAsync(100);
		});

		it('multiple concurrent runs each get their own block reason', async () => {
			let callCount = 0;
			const resolvers: Array<(result: CueRunResult) => void> = [];

			const onPreventSleep = vi.fn();
			const deps = createMockDeps({
				onPreventSleep,
				onCueRun: vi.fn(() => {
					callCount++;
					return new Promise<CueRunResult>((resolve) => {
						resolvers.push(resolve);
					});
				}),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					settings: {
						timeout_minutes: 30,
						timeout_on_fail: 'break',
						max_concurrent: 3,
						queue_size: 10,
					},
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 1,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			// Trigger more runs
			vi.advanceTimersByTime(60 * 1000);
			await vi.advanceTimersByTimeAsync(100);
			vi.advanceTimersByTime(60 * 1000);
			await vi.advanceTimersByTimeAsync(100);

			const runReasons = onPreventSleep.mock.calls
				.filter((call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:'))
				.map((call) => call[0]);

			// Each run should have a unique reason
			const uniqueReasons = new Set(runReasons);
			expect(uniqueReasons.size).toBe(runReasons.length);
			expect(runReasons.length).toBe(3);

			// Clean up
			engine.stop();
			for (const resolve of resolvers) {
				resolve({
					runId: 'cleanup',
					sessionId: 'session-1',
					sessionName: 'Test Session',
					subscriptionName: 'heartbeat',
					event: {
						id: 'e1',
						type: 'time.heartbeat',
						triggerName: 'heartbeat',
						timestamp: new Date().toISOString(),
						payload: {},
					},
					status: 'stopped',
					stdout: '',
					stderr: '',
					exitCode: null,
					durationMs: 0,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				});
			}
			await vi.advanceTimersByTimeAsync(100);
		});

		it('run with output prompt has single add/remove pair for the main runId', async () => {
			const onPreventSleep = vi.fn();
			const onAllowSleep = vi.fn();
			let callCount = 0;
			const deps = createMockDeps({
				onPreventSleep,
				onAllowSleep,
				onCueRun: vi.fn(async (request) => ({
					runId: request.runId,
					sessionId: 'session-1',
					sessionName: 'Test Session',
					subscriptionName: request.subscriptionName,
					event: request.event,
					status: 'completed' as const,
					stdout: `output-${++callCount}`,
					stderr: '',
					exitCode: 0,
					durationMs: 50,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				})),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 60,
							prompt: 'main task',
							output_prompt: 'summarize results',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			// Count run-level sleep calls
			const runAddCalls = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			);
			const runRemoveCalls = onAllowSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			);

			// One add (main runId) and one remove (same runId in finally)
			expect(runAddCalls).toHaveLength(1);
			expect(runRemoveCalls).toHaveLength(1);
			expect(runAddCalls[0][0]).toBe(runRemoveCalls[0][0]);
		});

		it('queued event does not add block reason until dispatched', async () => {
			let resolveRun: (result: CueRunResult) => void;
			let callCount = 0;

			const onPreventSleep = vi.fn();
			const deps = createMockDeps({
				onPreventSleep,
				onCueRun: vi.fn(() => {
					callCount++;
					if (callCount === 1) {
						return new Promise<CueRunResult>((resolve) => {
							resolveRun = resolve;
						});
					}
					return Promise.resolve({
						runId: 'run-2',
						sessionId: 'session-1',
						sessionName: 'Test Session',
						subscriptionName: 'heartbeat',
						event: {
							id: 'e2',
							type: 'time.heartbeat' as const,
							triggerName: 'heartbeat',
							timestamp: new Date().toISOString(),
							payload: {},
						},
						status: 'completed' as const,
						stdout: '',
						stderr: '',
						exitCode: 0,
						durationMs: 50,
						startedAt: new Date().toISOString(),
						endedAt: new Date().toISOString(),
					});
				}),
			});
			mockLoadCueConfig.mockReturnValue(
				createMockConfig({
					settings: {
						timeout_minutes: 30,
						timeout_on_fail: 'break',
						max_concurrent: 1, // Only 1 concurrent
						queue_size: 10,
					},
					subscriptions: [
						{
							name: 'heartbeat',
							event: 'time.heartbeat',
							interval_minutes: 1,
							prompt: 'check',
							enabled: true,
						},
					],
				})
			);

			const engine = new CueEngine(deps);
			engine.start();
			await vi.advanceTimersByTimeAsync(100);

			// Count current run-level adds
			const runAddsBefore = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			).length;
			expect(runAddsBefore).toBe(1); // First run started

			// Trigger another event (will be queued since max_concurrent=1)
			vi.advanceTimersByTime(60 * 1000);
			await vi.advanceTimersByTimeAsync(100);

			// Queued event should NOT have added a run reason
			const runAddsAfterQueue = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			).length;
			expect(runAddsAfterQueue).toBe(1); // Still just the first run

			// Now resolve the first run — queued event should be dispatched
			resolveRun!({
				runId: 'run-1',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'heartbeat',
				event: {
					id: 'e1',
					type: 'time.heartbeat',
					triggerName: 'heartbeat',
					timestamp: new Date().toISOString(),
					payload: {},
				},
				status: 'completed',
				stdout: '',
				stderr: '',
				exitCode: 0,
				durationMs: 50,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			});
			await vi.advanceTimersByTimeAsync(100);

			// Now the queued event should have been dispatched and added its own reason
			const runAddsAfterDrain = onPreventSleep.mock.calls.filter(
				(call) => typeof call[0] === 'string' && call[0].startsWith('cue:run:')
			).length;
			expect(runAddsAfterDrain).toBe(2);
		});
	});
});
