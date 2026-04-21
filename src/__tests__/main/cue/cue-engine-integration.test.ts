/**
 * Phase 15B — Cue engine end-to-end integration tests.
 *
 * Drives the real `CueEngine` with its real backing services (session
 * registry, fan-in tracker, run manager, heartbeat, dispatch, completion,
 * cleanup) and the in-memory Cue DB from `cue-integration-test-helpers.ts`.
 * Only the boundary callbacks are mocked:
 *   - `onCueRun`          — the executor is not invoked; we assert the engine
 *                           reached the dispatch point with the right payload
 *   - `loadCueConfig`     — we inject configs directly instead of reading disk
 *   - file watcher, GitHub poller, task scanner — provide a cleanup fn only
 *
 * This file complements the narrower unit tests in `cue-engine.test.ts` by
 * exercising interleavings that span multiple services: heartbeat →
 * runManager → fan-in tracker → completion → chain propagation. The goal is
 * to catch wiring regressions where a refactor to one service's contract
 * silently breaks a neighbor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueConfig } from '../../../main/cue/cue-types';
import {
	createInMemoryCueDb,
	buildCueDbModuleMock,
	type InMemoryCueDb,
} from './cue-integration-test-helpers';

// ─── Module mocks ────────────────────────────────────────────────────────────
// cue-db: delegates every call to a shared in-memory instance. The indirection
// through `getSharedDb` is required because vi.mock factories hoist above
// imports; we can't assign the instance at top level.

let sharedDb: InMemoryCueDb | null = null;
function getSharedDb(): InMemoryCueDb {
	if (!sharedDb) sharedDb = createInMemoryCueDb();
	return sharedDb;
}

vi.mock('../../../main/cue/cue-db', () => buildCueDbModuleMock(() => getSharedDb()));

// cue-yaml-loader: per-project config injection.
type DetailedResult =
	| { ok: true; config: CueConfig; warnings: string[] }
	| { ok: false; reason: 'missing' }
	| { ok: false; reason: 'parse-error'; message: string }
	| { ok: false; reason: 'invalid'; errors: string[] };

const configsByProject = new Map<string, CueConfig>();
const mockLoadCueConfig = vi.fn<(projectRoot: string) => CueConfig | null>((root) => {
	return configsByProject.get(root) ?? null;
});
const mockLoadCueConfigDetailed = vi.fn<(projectRoot: string) => DetailedResult>((root) => {
	const cfg = configsByProject.get(root);
	return cfg ? { ok: true, config: cfg, warnings: [] } : { ok: false, reason: 'missing' };
});
const mockWatchCueYaml = vi.fn<(projectRoot: string, onChange: () => void) => () => void>();
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (root: string) => mockLoadCueConfig(root),
	loadCueConfigDetailed: (root: string) => mockLoadCueConfigDetailed(root),
	watchCueYaml: (root: string, onChange: () => void) => mockWatchCueYaml(root, onChange),
	findAncestorCueConfigRoot: () => null,
}));

// Trigger sources whose real implementations would need real IO — keep their
// constructors as cleanup-fn-returning stubs.
vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: vi.fn(() => () => {}),
}));
vi.mock('../../../main/cue/cue-github-poller', () => ({
	createCueGitHubPoller: vi.fn(() => () => {}),
}));
vi.mock('../../../main/cue/cue-task-scanner', () => ({
	createCueTaskScanner: vi.fn(() => () => {}),
}));

vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 10)}`),
}));

// ─── Imports (AFTER mocks hoist) ─────────────────────────────────────────────

import { CueEngine } from '../../../main/cue/cue-engine';
import { createMockSession, createMockConfig, createMockDeps } from './cue-test-helpers';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resetSharedState() {
	sharedDb?.resetAll();
	sharedDb = null;
	configsByProject.clear();
	mockLoadCueConfig.mockClear();
	mockLoadCueConfigDetailed.mockClear();
	mockWatchCueYaml.mockClear();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Phase 15B — CueEngine integration', () => {
	let yamlWatcherCleanup: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		resetSharedState();
		yamlWatcherCleanup = vi.fn();
		mockWatchCueYaml.mockReturnValue(yamlWatcherCleanup);
	});

	afterEach(() => {
		vi.useRealTimers();
		resetSharedState();
	});

	// ─── Heartbeat end-to-end ──────────────────────────────────────────────

	describe('heartbeat → onCueRun → DB round-trip', () => {
		it('fires onCueRun immediately and records the event in the DB', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'hb',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'tick',
						interval_minutes: 5,
					},
				],
			});
			configsByProject.set('/projects/test', config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Initial firing on setup.
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'session-1',
					prompt: 'tick',
					event: expect.objectContaining({ type: 'time.heartbeat', triggerName: 'hb' }),
				})
			);

			// Let the run's Promise resolve so the run-manager finalizes the DB row.
			await vi.advanceTimersByTimeAsync(0);

			// The in-memory DB recorded the run as running + then finalized to completed.
			const events = getSharedDb().getRecentCueEvents(0);
			expect(events.length).toBeGreaterThanOrEqual(1);
			expect(events[0].subscriptionName).toBe('hb');
			expect(events[0].status).toBe('completed');

			engine.stop();
		});

		it('fires on each interval tick', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'hb',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'tick',
						interval_minutes: 5,
					},
				],
			});
			configsByProject.set('/projects/test', config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(0); // initial fire drains
			vi.clearAllMocks();

			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
			expect(deps.onCueRun).toHaveBeenCalledTimes(2);

			engine.stop();
		});
	});

	// ─── Agent-completion chain propagation ────────────────────────────────

	describe('agent.completed chain propagation', () => {
		it('notifyAgentCompleted fires a downstream subscription', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'chain',
						event: 'agent.completed',
						enabled: true,
						prompt: 'react to completion',
						source_session: 'session-1',
					},
				],
			});
			configsByProject.set('/projects/test', config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Simulate an external agent completion event for session-1.
			engine.notifyAgentCompleted('session-1', {
				sessionName: 'Test Session',
				status: 'completed',
				exitCode: 0,
				durationMs: 2000,
				stdout: 'CHAIN_SOURCE_OUTPUT',
				triggeredBy: 'manual',
				chainDepth: 0,
			});

			await vi.advanceTimersByTimeAsync(0);

			// The downstream chain subscription fired.
			expect(deps.onCueRun).toHaveBeenCalledWith(
				expect.objectContaining({
					subscriptionName: 'chain',
					event: expect.objectContaining({ type: 'agent.completed' }),
				})
			);

			engine.stop();
		});

		it('a completed run propagates through the chain back into the engine', async () => {
			// Two subs:
			//   - "seed" fires on heartbeat, prompt "S"
			//   - "chain" fires on agent.completed, sources = session-1
			// When seed completes via the mocked onCueRun, the run-manager calls
			// onRunCompleted → notifyAgentCompleted → completion service → chain
			// subscription dispatches a second onCueRun call.
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'seed',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'S',
						interval_minutes: 10,
					},
					{
						name: 'chain',
						event: 'agent.completed',
						enabled: true,
						prompt: 'chain-prompt',
						source_session: 'session-1',
					},
				],
			});
			configsByProject.set('/projects/test', config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// seed fires immediately → onRunCompleted → chain fires.
			await vi.advanceTimersByTimeAsync(0);

			const calls = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls.map(
				(c) => c[0].subscriptionName
			);
			expect(calls).toContain('seed');
			expect(calls).toContain('chain');

			engine.stop();
		});
	});

	// ─── Hot-reload ────────────────────────────────────────────────────────

	describe('hot-reload', () => {
		it('refreshSession replaces subscriptions when the config changes', async () => {
			const originalConfig = createMockConfig({
				subscriptions: [
					{
						name: 'original',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'original',
						interval_minutes: 5,
					},
				],
			});
			configsByProject.set('/projects/test', originalConfig);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			// Initial fire from the original sub.
			await vi.advanceTimersByTimeAsync(0);
			expect(
				(deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls.some(
					(c) => c[0].subscriptionName === 'original'
				)
			).toBe(true);

			vi.clearAllMocks();

			// Swap the config out: replace "original" with "replacement".
			const replacementConfig = createMockConfig({
				subscriptions: [
					{
						name: 'replacement',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'replacement',
						interval_minutes: 5,
					},
				],
			});
			configsByProject.set('/projects/test', replacementConfig);
			engine.refreshSession('session-1', '/projects/test');

			await vi.advanceTimersByTimeAsync(0);

			const postRefreshCalls = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls.map(
				(c) => c[0].subscriptionName
			);
			expect(postRefreshCalls).toContain('replacement');
			expect(postRefreshCalls).not.toContain('original');

			// Advancing the interval must not re-fire "original" — the watcher
			// was torn down on refresh.
			vi.clearAllMocks();
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
			const tickCalls = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls.map(
				(c) => c[0].subscriptionName
			);
			expect(tickCalls).toContain('replacement');
			expect(tickCalls).not.toContain('original');

			engine.stop();
		});

		it('removeSession tears down all subscriptions for that session', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'hb',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'tick',
						interval_minutes: 5,
					},
				],
			});
			configsByProject.set('/projects/test', config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(0);
			vi.clearAllMocks();

			engine.removeSession('session-1');

			// No further firings.
			await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
			expect(deps.onCueRun).not.toHaveBeenCalled();

			engine.stop();
		});
	});

	// ─── Lifecycle integrity ───────────────────────────────────────────────

	describe('lifecycle integrity', () => {
		it('stop + restart reuses the same DB instance and does NOT replay finalized events', async () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'hb',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'tick',
						interval_minutes: 5,
					},
				],
			});
			configsByProject.set('/projects/test', config);

			const deps = createMockDeps();
			const engine1 = new CueEngine(deps);
			engine1.start();
			await vi.advanceTimersByTimeAsync(0);

			const eventsAfterFirstRun = getSharedDb().getRecentCueEvents(0);
			expect(eventsAfterFirstRun.length).toBeGreaterThan(0);

			engine1.stop();

			// Fresh engine, same process. DB was not cleared — the event row
			// from the first run is still there.
			const engine2 = new CueEngine(deps);
			engine2.start();
			await vi.advanceTimersByTimeAsync(0);

			const eventsAfterRestart = getSharedDb().getRecentCueEvents(0);
			// Original events preserved, plus new ones from the restart tick.
			expect(eventsAfterRestart.length).toBeGreaterThanOrEqual(eventsAfterFirstRun.length);

			// Cross-check by status: none of the original `completed` rows
			// regressed to `running`. A naive reinit that re-recorded events
			// by id would have overwritten the completed status.
			for (const priorEvent of eventsAfterFirstRun) {
				const current = eventsAfterRestart.find((e) => e.id === priorEvent.id);
				expect(current?.status).toBe(priorEvent.status);
			}

			engine2.stop();
		});

		it('getStatus reflects registered subscriptions', () => {
			const config = createMockConfig({
				subscriptions: [
					{
						name: 'one',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'a',
						interval_minutes: 5,
					},
					{
						name: 'two',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'b',
						interval_minutes: 10,
					},
				],
			});
			configsByProject.set('/projects/test', config);

			const deps = createMockDeps();
			const engine = new CueEngine(deps);
			engine.start();

			const status = engine.getStatus();
			expect(status).toHaveLength(1);
			expect(status[0].subscriptionCount).toBe(2);

			engine.stop();
		});
	});

	// ─── Multi-session isolation ───────────────────────────────────────────

	describe('multi-session isolation', () => {
		it('two sessions with different configs fire independently', async () => {
			configsByProject.set(
				'/proj-a',
				createMockConfig({
					subscriptions: [
						{
							name: 'hb-a',
							event: 'time.heartbeat',
							enabled: true,
							prompt: 'A',
							interval_minutes: 5,
						},
					],
				})
			);
			configsByProject.set(
				'/proj-b',
				createMockConfig({
					subscriptions: [
						{
							name: 'hb-b',
							event: 'time.heartbeat',
							enabled: true,
							prompt: 'B',
							interval_minutes: 7,
						},
					],
				})
			);

			const sessions = [
				createMockSession({ id: 's-a', projectRoot: '/proj-a' }),
				createMockSession({ id: 's-b', projectRoot: '/proj-b' }),
			];
			const deps = createMockDeps({ getSessions: vi.fn(() => sessions) });
			const engine = new CueEngine(deps);
			engine.start();

			await vi.advanceTimersByTimeAsync(0);

			const names = (deps.onCueRun as ReturnType<typeof vi.fn>).mock.calls.map(
				(c) => c[0].subscriptionName
			);
			expect(names).toContain('hb-a');
			expect(names).toContain('hb-b');

			engine.stop();
		});
	});
});
