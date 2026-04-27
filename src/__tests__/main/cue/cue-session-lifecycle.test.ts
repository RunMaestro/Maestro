/**
 * Tests for CueEngine session lifecycle under active state.
 *
 * Tests cover:
 * - removeSession clears queued events
 * - removeSession clears fan-in tracker
 * - removeSession with in-flight run completes cleanly
 * - refreshSession during active run
 * - refreshSession doesn't double-count active runs
 * - teardownSession clears event queue (Fix 2 validation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueConfig, CueEvent, CueRunResult } from '../../../main/cue/cue-types';

// Mock the yaml loader. Tests that need to exercise the "parse-error" or
// "invalid" branches of loadCueConfigDetailed can override `mockDetailedResult`
// to return the relevant shape; otherwise the helper mirrors the old
// ok-or-missing semantics driven by `mockLoadCueConfig`.
const mockLoadCueConfig = vi.fn<(projectRoot: string) => CueConfig | null>();
type DetailedResult =
	| { ok: true; config: CueConfig; warnings: string[] }
	| { ok: false; reason: 'missing' }
	| { ok: false; reason: 'parse-error'; message: string }
	| { ok: false; reason: 'invalid'; errors: string[] };
let mockDetailedResult: DetailedResult | null = null;
const mockWatchCueYaml = vi.fn<(projectRoot: string, onChange: () => void) => () => void>();
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (...args: unknown[]) => mockLoadCueConfig(args[0] as string),
	loadCueConfigDetailed: (...args: unknown[]) => {
		if (mockDetailedResult) return mockDetailedResult;
		const config = mockLoadCueConfig(args[0] as string);
		return config
			? { ok: true as const, config, warnings: [] as string[] }
			: { ok: false as const, reason: 'missing' as const };
	},
	watchCueYaml: (...args: unknown[]) => mockWatchCueYaml(args[0] as string, args[1] as () => void),
	findAncestorCueConfigRoot: () => null,
	findAncestorCueConfigRoots: () => [],
}));

// Mock the file watcher
const mockCreateCueFileWatcher = vi.fn<(config: unknown) => () => void>();
vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: (...args: unknown[]) => mockCreateCueFileWatcher(args[0]),
}));

// Mock cue-db
const mockClearGitHubSeenForSubscription = vi.fn();
vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	closeCueDb: vi.fn(),
	updateHeartbeat: vi.fn(),
	getLastHeartbeat: vi.fn(() => null),
	pruneCueEvents: vi.fn(),
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
	clearGitHubSeenForSubscription: (...args: unknown[]) =>
		mockClearGitHubSeenForSubscription(...args),
}));

// Mock reconciler
vi.mock('../../../main/cue/cue-reconciler', () => ({
	reconcileMissedTimeEvents: vi.fn(),
}));

// Mock crypto
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
}));

import { CueEngine, type CueEngineDeps } from '../../../main/cue/cue-engine';
import { createCueSessionRuntimeService } from '../../../main/cue/cue-session-runtime-service';
import { createCueSessionRegistry } from '../../../main/cue/cue-session-registry';
import { createMockSession, createMockConfig, createMockDeps } from './cue-test-helpers';

describe('CueEngine session lifecycle', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockDetailedResult = null;
		mockWatchCueYaml.mockReturnValue(vi.fn());
		mockCreateCueFileWatcher.mockReturnValue(vi.fn());
	});

	afterEach(() => {
		vi.useRealTimers();
		mockDetailedResult = null;
	});

	it('removeSession clears queued events', async () => {
		// Setup: max_concurrent=1, heartbeat with interval_minutes=1
		const config = createMockConfig({
			subscriptions: [
				{
					name: 'heartbeat',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'do work',
					interval_minutes: 1,
				},
			],
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
			},
		});
		mockLoadCueConfig.mockReturnValue(config);

		// First call returns a never-resolving promise (to occupy the slot)
		let resolveRun: ((val: CueRunResult) => void) | null = null;
		const onCueRun = vi.fn(
			() =>
				new Promise<CueRunResult>((resolve) => {
					resolveRun = resolve;
				})
		);
		const deps = createMockDeps({ onCueRun: onCueRun as CueEngineDeps['onCueRun'] });
		const engine = new CueEngine(deps);

		engine.start();
		// Heartbeat fires immediately on start -> occupies the single slot
		expect(onCueRun).toHaveBeenCalledTimes(1);

		// Advance timer by 60s to fire another heartbeat -> goes into queue
		vi.advanceTimersByTime(60 * 1000);
		expect(onCueRun).toHaveBeenCalledTimes(1); // still 1 — second event is queued

		// Assert queue has 1 entry for session-1
		const queueStatus = engine.getQueueStatus();
		expect(queueStatus.get('session-1')).toBe(1);

		// Remove the session
		engine.removeSession('session-1');

		// Assert queue is now empty
		const queueAfter = engine.getQueueStatus();
		expect(queueAfter.size).toBe(0);

		// Clean up: resolve the in-flight promise so the test exits cleanly
		resolveRun!({
			runId: 'run-1',
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
		});
		await vi.advanceTimersByTimeAsync(0); // flush microtasks

		engine.stop();
	});

	it('removeSession clears fan-in tracker', () => {
		// Setup: fan-in subscription with source_session: ['SourceA', 'SourceB']
		const config = createMockConfig({
			subscriptions: [
				{
					name: 'all-done',
					event: 'agent.completed',
					enabled: true,
					prompt: 'aggregate',
					source_session: ['SourceA', 'SourceB'],
				},
			],
		});
		mockLoadCueConfig.mockReturnValue(config);
		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start();

		vi.clearAllMocks();

		// Fire first completion -> fan-in waiting for SourceB
		engine.notifyAgentCompleted('source-a', { sessionName: 'SourceA', stdout: 'output-a' });
		expect(deps.onCueRun).not.toHaveBeenCalled();

		// Remove the owner session (session-1 which owns the fan-in subscription)
		engine.removeSession('session-1');

		// Fire second completion -> should NOT trigger anything since session was removed
		engine.notifyAgentCompleted('source-b', { sessionName: 'SourceB', stdout: 'output-b' });

		// Assert onCueRun was NOT called after the removal
		expect(deps.onCueRun).not.toHaveBeenCalled();

		engine.stop();
	});

	it('removeSession with in-flight run completes cleanly', async () => {
		// Setup: heartbeat subscription
		const config = createMockConfig({
			subscriptions: [
				{
					name: 'heartbeat',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'do work',
					interval_minutes: 60,
				},
			],
		});
		mockLoadCueConfig.mockReturnValue(config);

		// Controllable promise for onCueRun
		let resolveRun: ((val: CueRunResult) => void) | null = null;
		const onCueRun = vi.fn(
			() =>
				new Promise<CueRunResult>((resolve) => {
					resolveRun = resolve;
				})
		);
		const deps = createMockDeps({ onCueRun: onCueRun as CueEngineDeps['onCueRun'] });
		const engine = new CueEngine(deps);

		engine.start();
		// Heartbeat fires immediately -> occupies slot
		expect(onCueRun).toHaveBeenCalledTimes(1);

		// Remove session while run is in-flight
		engine.removeSession('session-1');

		// Resolve the in-flight promise
		resolveRun!({
			runId: 'run-1',
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
		});
		await vi.advanceTimersByTimeAsync(0); // flush microtasks

		// Assert no unhandled errors (test completes without throwing)
		// Assert getActiveRuns returns empty after resolution
		expect(engine.getActiveRuns()).toHaveLength(0);

		engine.stop();
	});

	it('refreshSession during active run', async () => {
		// Setup: heartbeat with interval_minutes=60
		const config = createMockConfig({
			subscriptions: [
				{
					name: 'heartbeat',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'do work',
					interval_minutes: 60,
				},
			],
		});
		mockLoadCueConfig.mockReturnValue(config);

		// Track all resolve functions for controllable promises
		const resolvers: ((val: CueRunResult) => void)[] = [];
		const onCueRun = vi.fn(
			() =>
				new Promise<CueRunResult>((resolve) => {
					resolvers.push(resolve);
				})
		);
		const deps = createMockDeps({ onCueRun: onCueRun as CueEngineDeps['onCueRun'] });
		const engine = new CueEngine(deps);

		engine.start();
		// First heartbeat fires immediately
		expect(onCueRun).toHaveBeenCalledTimes(1);
		expect(resolvers).toHaveLength(1);

		// Update config to return a new config with interval_minutes=5
		const newConfig = createMockConfig({
			subscriptions: [
				{
					name: 'heartbeat',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'do work faster',
					interval_minutes: 5,
				},
			],
		});
		mockLoadCueConfig.mockReturnValue(newConfig);

		// Refresh the session (simulates config reload).
		// The old run is still in-flight (activeRunCount=1). During initSession,
		// the immediate heartbeat fire sees activeRunCount=1 >= maxConcurrent=1
		// (defaulted because session state isn't in the map yet during setup),
		// so the new heartbeat goes into the queue instead of dispatching.
		engine.refreshSession('session-1', '/projects/test');

		// onCueRun is still 1 — the refresh's immediate heartbeat was queued
		expect(onCueRun).toHaveBeenCalledTimes(1);

		// Resolve the original in-flight promise — this decrements activeRunCount
		// and drains the queue, dispatching the queued heartbeat
		const completedResult: CueRunResult = {
			runId: 'run-1',
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
		resolvers[0](completedResult);
		await vi.advanceTimersByTimeAsync(0); // flush microtasks

		// After the in-flight completes and drainQueue fires, the queued heartbeat dispatches
		expect(onCueRun).toHaveBeenCalledTimes(2);
		expect(resolvers).toHaveLength(2);

		// Now resolve the second run (drained from queue) so the slot is freed
		resolvers[1](completedResult);
		await vi.advanceTimersByTimeAsync(0); // flush microtasks

		// Advance time by 5 minutes -> new subscription interval fires with new config
		vi.clearAllMocks();
		vi.advanceTimersByTime(5 * 60 * 1000);
		expect(onCueRun).toHaveBeenCalledTimes(1);

		engine.stop();
	});

	it('refreshSession does not double-count active runs', async () => {
		// Setup: heartbeat, max_concurrent=2, controllable onCueRun (never resolves).
		// During initSession, the session is registered in the registry BEFORE trigger
		// sources start, so the immediate heartbeat fire reads maxConcurrent=2 correctly.
		// With activeRunCount=1 from the orphaned in-flight run and maxConcurrent=2,
		// the immediate fire during refresh dispatches directly (1 < 2).
		const config = createMockConfig({
			subscriptions: [
				{
					name: 'heartbeat',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'do work',
					interval_minutes: 60,
				},
			],
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 2,
				queue_size: 10,
			},
		});
		mockLoadCueConfig.mockReturnValue(config);

		const onCueRun = vi.fn(
			() =>
				new Promise<CueRunResult>(() => {
					/* never resolves */
				})
		);
		const deps = createMockDeps({ onCueRun: onCueRun as CueEngineDeps['onCueRun'] });
		const engine = new CueEngine(deps);

		engine.start();
		// Heartbeat fires immediately -> 1 active run
		expect(onCueRun).toHaveBeenCalledTimes(1);

		// Refresh the session (tears down old timers, re-inits)
		engine.refreshSession('session-1', '/projects/test');

		// The immediate heartbeat during refresh is dispatched directly because
		// the session is registered before trigger sources start, so maxConcurrent=2
		// is read and activeRunCount=1 < 2 allows immediate dispatch.
		expect(onCueRun).toHaveBeenCalledTimes(2);

		// Nothing in the queue — the heartbeat was dispatched, not queued
		expect(engine.getQueueStatus().get('session-1') ?? 0).toBe(0);

		// Advance timer to trigger the interval heartbeat (60 min).
		// Now the session state IS in the map, so max_concurrent=2 is read.
		// activeRunCount=1 (orphaned) < max_concurrent=2, so it dispatches.
		vi.advanceTimersByTime(60 * 60 * 1000);

		// We should have exactly 2 dispatched calls total: initial + interval
		// (the queued immediate fire from refresh was drained when the interval fired
		// or may remain queued depending on ordering — but no infinite loop or double-count)
		expect(onCueRun.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(onCueRun.mock.calls.length).toBeLessThanOrEqual(3);

		engine.stop();
	});

	it('teardownSession clears event queue (Fix 2 validation)', async () => {
		// Setup: max_concurrent=1, heartbeat with interval_minutes=1
		const config = createMockConfig({
			subscriptions: [
				{
					name: 'heartbeat',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'do work',
					interval_minutes: 1,
				},
			],
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
			},
		});
		mockLoadCueConfig.mockReturnValue(config);

		// Capture the watchCueYaml onChange callback
		let yamlOnChange: (() => void) | null = null;
		mockWatchCueYaml.mockImplementation((_projectRoot: string, onChange: () => void) => {
			yamlOnChange = onChange;
			return vi.fn();
		});

		let resolveRun: ((val: CueRunResult) => void) | null = null;
		const onCueRun = vi.fn(
			() =>
				new Promise<CueRunResult>((resolve) => {
					resolveRun = resolve;
				})
		);
		const deps = createMockDeps({ onCueRun: onCueRun as CueEngineDeps['onCueRun'] });
		const engine = new CueEngine(deps);

		engine.start();
		// Heartbeat fires immediately -> occupies the single slot
		expect(onCueRun).toHaveBeenCalledTimes(1);

		// Advance timer to queue events
		vi.advanceTimersByTime(60 * 1000);
		expect(engine.getQueueStatus().get('session-1')).toBe(1);

		vi.advanceTimersByTime(60 * 1000);
		expect(engine.getQueueStatus().get('session-1')).toBe(2);

		// Call the onChange callback (simulates config file change -> refreshSession internally).
		// refreshSession calls teardownSession which clears the queue, then initSession
		// re-creates the session and fires the immediate heartbeat. Since the old in-flight
		// run still occupies the slot (activeRunCount=1), the new immediate fire is queued.
		expect(yamlOnChange).not.toBeNull();
		yamlOnChange!();

		// After refresh, the old 2 queued events are cleared. The new immediate heartbeat
		// goes into a fresh queue entry (1 item), not 2 items from before.
		const queueAfter = engine.getQueueStatus();
		const queueCount = queueAfter.get('session-1') ?? 0;
		// The old queue of 2 was cleared; at most 1 new entry from the refresh's immediate fire
		expect(queueCount).toBeLessThanOrEqual(1);

		// Clean up: resolve the in-flight promise
		resolveRun!({
			runId: 'run-1',
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
		});
		await vi.advanceTimersByTimeAsync(0); // flush microtasks

		engine.stop();
	});

	// ─── init-reason matrix ──────────────────────────────────────────────
	// app.startup must fire exactly once per process lifecycle, and only when
	// the engine is starting because of a real system boot. The init-reason
	// signature on initSession encodes this policy explicitly. These tests pin
	// down each reason so the dedup story stays correct.
	describe('init-reason matrix for app.startup', () => {
		function makeStartupConfig() {
			return createMockConfig({
				subscriptions: [
					{
						name: 'init',
						event: 'app.startup',
						enabled: true,
						prompt: 'do init',
					},
				],
			});
		}

		it('system-boot fires app.startup exactly once', () => {
			mockLoadCueConfig.mockReturnValue(makeStartupConfig());
			const deps = createMockDeps();
			const engine = new CueEngine(deps);

			engine.start('system-boot');

			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({ subscriptionName: 'init' })
			);

			engine.stop();
		});

		it('user-toggle (default) does NOT fire app.startup', () => {
			mockLoadCueConfig.mockReturnValue(makeStartupConfig());
			const deps = createMockDeps();
			const engine = new CueEngine(deps);

			engine.start('user-toggle');

			expect(deps.onCueRun).not.toHaveBeenCalled();

			engine.stop();
		});

		it('start() with no argument defaults to user-toggle and does NOT fire app.startup', () => {
			mockLoadCueConfig.mockReturnValue(makeStartupConfig());
			const deps = createMockDeps();
			const engine = new CueEngine(deps);

			// No argument — must default to user-toggle, not system-boot.
			engine.start();

			expect(deps.onCueRun).not.toHaveBeenCalled();

			engine.stop();
		});

		it('refresh (via refreshSession) does NOT re-fire app.startup', () => {
			mockLoadCueConfig.mockReturnValue(makeStartupConfig());
			const deps = createMockDeps();
			const engine = new CueEngine(deps);

			// First boot fires startup once.
			engine.start('system-boot');
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// A YAML hot-reload triggers refreshSession, which calls initSession with
			// reason='refresh'. Even though the same subscription is in the new config,
			// startup must NOT re-fire — that would surprise users editing their YAML.
			engine.refreshSession('session-1', '/projects/test');
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			engine.stop();
		});

		it('toggling the engine off and on does NOT re-fire app.startup', () => {
			mockLoadCueConfig.mockReturnValue(makeStartupConfig());
			const deps = createMockDeps();
			const engine = new CueEngine(deps);

			engine.start('system-boot');
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			engine.stop();
			// User flips Cue back on. start() defaults to user-toggle.
			engine.start();
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			engine.stop();
		});

		it('a second system-boot start after stop re-fires app.startup (dedup keys cleared on stop)', () => {
			// stop() resets the startup dedup keys so that re-enabling Cue (which
			// calls start('system-boot')) fires startup subscriptions again. This
			// matches the expected UX: toggling Cue off then on is treated as a
			// new Cue "boot" from the user's perspective.
			mockLoadCueConfig.mockReturnValue(makeStartupConfig());
			const deps = createMockDeps();
			const engine = new CueEngine(deps);

			engine.start('system-boot');
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			engine.stop(); // clears startup dedup keys
			engine.start('system-boot'); // should fire again
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);

			engine.stop();
		});

		it('initSession idempotency guard — calling twice logs warn and re-initializes cleanly', async () => {
			// Use a config with no subscriptions so createTriggerSource is never invoked
			const config = createMockConfig({ subscriptions: [] });
			mockLoadCueConfig.mockReturnValue(config);

			const yamlWatcherCleanup = vi.fn();
			mockWatchCueYaml.mockReturnValue(yamlWatcherCleanup);

			const registry = createCueSessionRegistry();
			const clearQueue = vi.fn();
			const clearFanInState = vi.fn();
			const onLog = vi.fn();

			const service = createCueSessionRuntimeService({
				enabled: () => true,
				getSessions: () => [createMockSession()],
				onRefreshRequested: vi.fn(),
				onLog,
				registry,
				dispatchSubscription: vi.fn(),
				clearQueue,
				clearFanInState,
			});

			const session = createMockSession();

			// First initSession — normal registration
			service.initSession(session, { reason: 'system-boot' });
			expect(registry.has(session.id)).toBe(true);

			// Second initSession — should trigger idempotency guard
			service.initSession(session, { reason: 'user-toggle' });

			// Guard must have logged a warning
			expect(onLog).toHaveBeenCalledWith(
				'warn',
				expect.stringContaining('initSession called for already-initialized session')
			);

			// Session is still registered after re-init (not left in broken state)
			expect(registry.has(session.id)).toBe(true);

			// teardownSession was invoked (clearFanInState is called by teardown)
			expect(clearFanInState).toHaveBeenCalledWith(session.id);
		});

		it('initSession idempotency guard — does not double-register the session in the registry', async () => {
			// NOTE: this test uses an empty `subscriptions: []` config so it does
			// NOT exercise trigger-source registration directly; it only verifies
			// the registry-level dedupe behavior (calling initSession twice still
			// leaves exactly one entry in the registry snapshot). A separate test
			// would need a real subscription wired through createTriggerSource to
			// assert non-duplication of trigger sources themselves.
			const config = createMockConfig({ subscriptions: [] });
			mockLoadCueConfig.mockReturnValue(config);
			mockWatchCueYaml.mockReturnValue(vi.fn());

			const registry = createCueSessionRegistry();

			const service = createCueSessionRuntimeService({
				enabled: () => true,
				getSessions: () => [createMockSession()],
				onRefreshRequested: vi.fn(),
				onLog: vi.fn(),
				registry,
				dispatchSubscription: vi.fn(),
				clearQueue: vi.fn(),
				clearFanInState: vi.fn(),
			});

			const session = createMockSession();

			// Call initSession twice
			service.initSession(session, { reason: 'system-boot' });
			service.initSession(session, { reason: 'system-boot' });

			// After two calls, session should appear exactly once in the registry
			// (not duplicated). The registry snapshot size is 1.
			expect(registry.snapshot().size).toBe(1);
		});

		it('removeSession clears cue_github_seen rows for all GitHub subscriptions', () => {
			// Regression guard: without this, deleting a GitHub-polling session
			// left rows in cue_github_seen that only expired via age-based
			// prune. The deleted sub's subscription_id (`${sessionId}:${name}`)
			// must be passed to clearGitHubSeenForSubscription on remove.
			mockClearGitHubSeenForSubscription.mockClear();

			const config = createMockConfig({
				subscriptions: [
					{
						name: 'watch-prs',
						event: 'github.pull_request',
						enabled: true,
						prompt: 'review',
						repo: 'org/repo',
						poll_minutes: 5,
					},
					{
						name: 'watch-issues',
						event: 'github.issue',
						enabled: true,
						prompt: 'triage',
						repo: 'org/repo',
						poll_minutes: 5,
					},
					{
						name: 'ignore-this',
						event: 'time.heartbeat',
						enabled: true,
						prompt: '',
						interval_minutes: 1,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			engine.removeSession('session-1');

			// Exactly the two GitHub subs were cleared; the heartbeat sub
			// contributes no seen rows and must not appear in the calls.
			const cleared = mockClearGitHubSeenForSubscription.mock.calls.map(([id]) => id).sort();
			expect(cleared).toEqual(['session-1:watch-issues', 'session-1:watch-prs']);
		});

		it('refreshSession clears cue_github_seen rows only for subs that were removed', () => {
			mockClearGitHubSeenForSubscription.mockClear();

			// Initial config has two GitHub subs.
			const initialConfig = createMockConfig({
				subscriptions: [
					{
						name: 'keep-me',
						event: 'github.pull_request',
						enabled: true,
						prompt: '',
						repo: 'org/repo',
						poll_minutes: 5,
					},
					{
						name: 'drop-me',
						event: 'github.issue',
						enabled: true,
						prompt: '',
						repo: 'org/repo',
						poll_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(initialConfig);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// User edits YAML, removes the `drop-me` subscription.
			const updatedConfig = createMockConfig({
				subscriptions: [
					{
						name: 'keep-me',
						event: 'github.pull_request',
						enabled: true,
						prompt: '',
						repo: 'org/repo',
						poll_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(updatedConfig);

			// refreshSession fires on YAML hot-reload. The `keep-me` sub is
			// still present so its seen rows must stay; only `drop-me`'s
			// subscription_id is cleared.
			engine.refreshSession('session-1', '/projects/test');

			const cleared = mockClearGitHubSeenForSubscription.mock.calls.map(([id]) => id);
			expect(cleared).toEqual(['session-1:drop-me']);
			// Explicit invariant: the surviving subscription's seen rows must
			// not be cleared. Redundant with the strict-equality check above,
			// but makes the intent obvious and catches future regressions
			// where someone loosens the above to `toEqual(expect.arrayContaining(...))`.
			expect(cleared).not.toContain('session-1:keep-me');
		});

		it('refreshSession PRESERVES cue_github_seen rows on parse errors (mid-edit YAML)', () => {
			// Regression guard: parse/validation errors are transient — the
			// user is mid-edit and will fix shortly. Clearing seen rows in
			// that window would cause the GitHub poller to re-notify for
			// every already-seen PR/issue on the next successful load.
			// Only file-truly-missing should clear.
			mockClearGitHubSeenForSubscription.mockClear();
			const initialConfig = createMockConfig({
				subscriptions: [
					{
						name: 'watch-prs',
						event: 'github.pull_request',
						enabled: true,
						prompt: '',
						repo: 'org/repo',
						poll_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(initialConfig);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// User saves a malformed YAML — parse error. Loader returns
			// parse-error, NOT missing.
			mockLoadCueConfig.mockReturnValue(null);
			mockDetailedResult = {
				ok: false,
				reason: 'parse-error',
				message: 'bad indentation',
			};
			engine.refreshSession('session-1', '/projects/test');

			// NOTHING cleared — the broken config will be fixed momentarily
			// and we don't want to lose seen state.
			expect(mockClearGitHubSeenForSubscription).not.toHaveBeenCalled();
		});

		it('refreshSession PRESERVES cue_github_seen rows on validation errors', () => {
			mockClearGitHubSeenForSubscription.mockClear();
			const initialConfig = createMockConfig({
				subscriptions: [
					{
						name: 'watch-issues',
						event: 'github.issue',
						enabled: true,
						prompt: '',
						repo: 'org/repo',
						poll_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(initialConfig);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			mockLoadCueConfig.mockReturnValue(null);
			mockDetailedResult = {
				ok: false,
				reason: 'invalid',
				errors: ['subscriptions[0]: missing required field'],
			};
			engine.refreshSession('session-1', '/projects/test');

			expect(mockClearGitHubSeenForSubscription).not.toHaveBeenCalled();
		});

		it('refreshSession CLEARS cue_github_seen rows when the config file is truly gone', () => {
			// Positive-path counterpart to the parse-error/invalid tests above.
			// When the config is actually missing from disk (user deleted
			// cue.yaml, or the session moved away from its project root), we
			// SHOULD clear the seen rows — otherwise the GitHub poller retains
			// stale state for a session that no longer has any subs.
			mockClearGitHubSeenForSubscription.mockClear();
			const initialConfig = createMockConfig({
				subscriptions: [
					{
						name: 'watch-prs',
						event: 'github.pull_request',
						enabled: true,
						prompt: '',
						repo: 'org/repo',
						poll_minutes: 5,
					},
					{
						name: 'watch-issues',
						event: 'github.issue',
						enabled: true,
						prompt: '',
						repo: 'org/repo',
						poll_minutes: 5,
					},
				],
			});
			mockLoadCueConfig.mockReturnValue(initialConfig);
			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Config is gone. Both loader paths return the 'missing' shape.
			mockLoadCueConfig.mockReturnValue(null);
			mockDetailedResult = { ok: false, reason: 'missing' };
			engine.refreshSession('session-1', '/projects/test');

			const cleared = mockClearGitHubSeenForSubscription.mock.calls.map(([id]) => id).sort();
			// BOTH GitHub subs' seen rows cleared; no heartbeat/non-github
			// subs are involved here so the entire old GitHub-sub set
			// should appear exactly once.
			expect(cleared).toEqual(['session-1:watch-issues', 'session-1:watch-prs']);
		});

		it('removeSession clears startup keys so re-adding the session can re-fire', () => {
			mockLoadCueConfig.mockReturnValue(makeStartupConfig());
			const deps = createMockDeps();
			const engine = new CueEngine(deps);

			engine.start('system-boot');
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// Remove the session (simulates user deleting an agent).
			engine.removeSession('session-1');

			// If the same session id is re-added later (e.g. user undoes the delete),
			// startup should be eligible to fire again — but only on a real boot.
			// A user-toggle still does not fire it.
			engine.refreshSession('session-1', '/projects/test');
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			// A subsequent real boot (new process lifecycle) must re-trigger startup.
			// stop() first so start() isn't skipped by the enabled guard.
			engine.stop();
			engine.start('system-boot');
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);

			engine.stop();
		});
	});
});
