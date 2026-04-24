/**
 * Phase 15A — race-condition regression tests for the Cue run manager.
 *
 * The run manager is the main source of concurrency coordination in the Cue
 * backend: it tracks active runs, queues events at the concurrency limit,
 * and owns the cleanup dance between `stopRun`, `reset`, and the in-flight
 * `onCueRun` Promise.
 *
 * Existing `cue-run-manager.test.ts` covers the single-step state machine
 * (running → stopping → finished) and the happy-path completion pipeline.
 * This file targets the interleavings that only appear when the outside
 * world changes state while `onCueRun` is mid-flight:
 *
 *   - `reset()` called while a run is still executing (engine shutdown)
 *   - `stopRun()` invoked right after `execute()`, before the run's Promise
 *     resolution has had a chance to flush to `activeRuns`
 *   - rapid-fire `execute` calls filling the queue beyond capacity, with the
 *     oldest event dropped and preserving FIFO
 *   - queue drain interleaving with a new `execute` that arrives mid-drain
 *
 * Uses `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` to get
 * deterministic microtask ordering without real sleeps.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueEvent, CueRunResult, CueSettings } from '../../../main/cue/cue-types';

vi.mock('../../../main/cue/cue-db', () => ({
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

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../../main/cue/cue-cli-executor', () => ({
	runMaestroCliSend: vi.fn().mockResolvedValue({
		ok: true,
		exitCode: 0,
		stdout: '{}',
		stderr: '',
		resolvedTarget: '',
	}),
}));

let uuidCounter = 0;
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `run-${++uuidCounter}`),
}));

import { safeUpdateCueEventStatus } from '../../../main/cue/cue-db';
import { createCueRunManager, type CueRunManagerDeps } from '../../../main/cue/cue-run-manager';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createEvent(overrides: Partial<CueEvent> = {}): CueEvent {
	return {
		id: 'evt-race',
		type: 'time.heartbeat',
		timestamp: new Date().toISOString(),
		triggerName: 'race-test',
		payload: {},
		...overrides,
	};
}

function makeResult(overrides: Partial<CueRunResult> = {}): CueRunResult {
	return {
		runId: 'r',
		sessionId: 'session-1',
		sessionName: 'Race Session',
		subscriptionName: 'race-sub',
		event: createEvent(),
		status: 'completed',
		stdout: '',
		stderr: '',
		exitCode: 0,
		durationMs: 1,
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
		...overrides,
	};
}

const defaultSettings: CueSettings = {
	timeout_minutes: 30,
	timeout_on_fail: 'break',
	max_concurrent: 1,
	queue_size: 3,
};

function createDeps(overrides: Partial<CueRunManagerDeps> = {}): CueRunManagerDeps {
	return {
		getSessions: vi.fn(() => [{ id: 'session-1', name: 'Race Session' }]),
		getSessionSettings: vi.fn(() => defaultSettings),
		onCueRun: vi.fn(async () => makeResult()),
		onStopCueRun: vi.fn(() => true),
		onLog: vi.fn(),
		onRunCompleted: vi.fn(),
		onRunStopped: vi.fn(),
		onPreventSleep: vi.fn(),
		onAllowSleep: vi.fn(),
		...overrides,
	};
}

/**
 * Helper to construct an `onCueRun` that blocks until the returned `resolve`
 * is called — lets tests interleave state changes with an in-flight run.
 */
function deferredOnCueRun() {
	let resolve!: (value: CueRunResult) => void;
	const promise = new Promise<CueRunResult>((res) => {
		resolve = res;
	});
	const fn = vi.fn(() => promise);
	return { fn, resolve };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CueRunManager — race conditions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		uuidCounter = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ─── reset() mid-flight ────────────────────────────────────────────────

	describe('reset during an in-flight run', () => {
		it('does NOT invoke onRunCompleted after reset; activity log still finalizes the DB row', async () => {
			const deferred = deferredOnCueRun();
			const deps = createDeps({ onCueRun: deferred.fn });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'race-sub');
			// Run is active — reset() clears it out as if the engine is shutting down.
			expect(manager.getActiveRunMap().size).toBe(1);

			manager.reset();
			expect(manager.getActiveRunMap().size).toBe(0);

			// onCueRun finally resolves — the finally block must detect that the
			// run was removed from activeRuns and skip the onRunCompleted call
			// (which would otherwise fire a chain propagation after engine
			// shutdown — the regression Phase 7 was designed to prevent).
			deferred.resolve(makeResult({ runId: 'r1' }));
			await vi.advanceTimersByTimeAsync(0);

			expect(deps.onRunCompleted).not.toHaveBeenCalled();
			expect(deps.onRunStopped).not.toHaveBeenCalled();
			// DB row is still finalized so the activity log never shows a
			// phantom forever-"running" row.
			expect(safeUpdateCueEventStatus).toHaveBeenCalled();
		});

		it('clears the event queue so no drain fires after reset', () => {
			const deferred = deferredOnCueRun();
			const deps = createDeps({
				onCueRun: deferred.fn,
				getSessionSettings: vi.fn(() => ({ ...defaultSettings, max_concurrent: 1 })),
			});
			const manager = createCueRunManager(deps);

			// First execute dispatches (slot available); the next two queue up.
			manager.execute('session-1', 'prompt-1', createEvent(), 'sub-1');
			manager.execute('session-1', 'prompt-2', createEvent(), 'sub-2');
			manager.execute('session-1', 'prompt-3', createEvent(), 'sub-3');
			expect(manager.getQueueStatus().get('session-1')).toBe(2);

			manager.reset();
			expect(manager.getQueueStatus().size).toBe(0);
			// onCueRun was called exactly once (for the immediately-dispatched
			// first event). After reset, queue cannot drain.
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
		});
	});

	// ─── stopRun immediately after execute ─────────────────────────────────

	describe('stopRun called mid-flight', () => {
		it('fires onRunStopped exactly once and the late onCueRun resolution is discarded', async () => {
			const deferred = deferredOnCueRun();
			const deps = createDeps({ onCueRun: deferred.fn });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt', createEvent(), 'race-sub');
			const runId = manager.getActiveRuns()[0].runId;

			// stopRun fires while onCueRun is still pending.
			expect(manager.stopRun(runId)).toBe(true);
			expect(deps.onRunStopped).toHaveBeenCalledTimes(1);

			// The in-flight run resolves after the fact — the finally block
			// must skip onRunCompleted because stopRun already removed the run.
			deferred.resolve(makeResult({ runId }));
			await vi.advanceTimersByTimeAsync(0);

			expect(deps.onRunCompleted).not.toHaveBeenCalled();
			// onRunStopped is not double-called from the finally path.
			expect(deps.onRunStopped).toHaveBeenCalledTimes(1);
		});

		it('frees the concurrency slot so a queued event drains immediately', async () => {
			// Two in-flight runs — stop the first, the queued second must start.
			let resolveCount = 0;
			const pending: Array<(result: CueRunResult) => void> = [];
			const deps = createDeps({
				onCueRun: vi.fn(
					() =>
						new Promise<CueRunResult>((res) => {
							resolveCount += 1;
							pending.push(res);
						})
				),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'prompt-1', createEvent(), 'sub-1');
			manager.execute('session-1', 'prompt-2', createEvent(), 'sub-2'); // queued
			expect(manager.getQueueStatus().get('session-1')).toBe(1);
			expect(resolveCount).toBe(1);

			const activeRunId = manager.getActiveRuns()[0].runId;
			manager.stopRun(activeRunId);

			// Queue drained → second run dispatched to onCueRun.
			expect(resolveCount).toBe(2);
			expect(manager.getQueueStatus().size).toBe(0);

			// Resolve both runs to prevent open promises leaking into other tests.
			pending.forEach((res) => res(makeResult()));
			await vi.advanceTimersByTimeAsync(0);
		});
	});

	// ─── Queue behavior under rapid execute() calls ───────────────────────

	describe('queue saturation + drop policy', () => {
		it('drops the oldest queued event when queue exceeds queue_size', () => {
			const deferred = deferredOnCueRun();
			const deps = createDeps({
				onCueRun: deferred.fn,
				getSessionSettings: vi.fn(() => ({
					...defaultSettings,
					max_concurrent: 1,
					queue_size: 2,
				})),
			});
			const manager = createCueRunManager(deps);

			// First execute dispatches (slot 1); next three queue. With queue_size=2
			// the third queued item displaces the first queued entry (FIFO drop
			// of oldest). Queue length stays at 2.
			manager.execute('session-1', 'p1', createEvent(), 'sub-1');
			manager.execute('session-1', 'p2', createEvent(), 'sub-2'); // queued
			manager.execute('session-1', 'p3', createEvent(), 'sub-3'); // queued
			manager.execute('session-1', 'p4', createEvent(), 'sub-4'); // displaces p2

			expect(manager.getQueueStatus().get('session-1')).toBe(2);
			// Log includes the "dropping oldest" notice.
			const logCalls = (deps.onLog as ReturnType<typeof vi.fn>).mock.calls;
			expect(logCalls.some((call) => /dropping oldest/.test(String(call[1])))).toBe(true);
		});

		it('drains the queue in FIFO order when the active run completes', async () => {
			const resolvers: Array<(r: CueRunResult) => void> = [];
			const onCueRun = vi.fn(
				(req: { runId: string; subscriptionName: string }) =>
					new Promise<CueRunResult>((res) => {
						resolvers.push((result) => res({ ...result, runId: req.runId }));
					})
			);
			const deps = createDeps({
				onCueRun,
				getSessionSettings: vi.fn(() => ({
					...defaultSettings,
					max_concurrent: 1,
					queue_size: 5,
				})),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'p1', createEvent(), 'sub-1');
			manager.execute('session-1', 'p2', createEvent(), 'sub-2');
			manager.execute('session-1', 'p3', createEvent(), 'sub-3');
			expect(onCueRun).toHaveBeenCalledTimes(1);
			expect(onCueRun.mock.calls[0][0].subscriptionName).toBe('sub-1');

			// Resolve the first run — sub-2 must start before sub-3 (FIFO).
			resolvers.shift()!(makeResult({ status: 'completed' }));
			await vi.advanceTimersByTimeAsync(0);

			expect(onCueRun).toHaveBeenCalledTimes(2);
			expect(onCueRun.mock.calls[1][0].subscriptionName).toBe('sub-2');

			// Resolve sub-2 → sub-3 starts.
			resolvers.shift()!(makeResult({ status: 'completed' }));
			await vi.advanceTimersByTimeAsync(0);

			expect(onCueRun).toHaveBeenCalledTimes(3);
			expect(onCueRun.mock.calls[2][0].subscriptionName).toBe('sub-3');

			// Drain remaining resolvers to avoid leaked promises.
			resolvers.shift()!(makeResult({ status: 'completed' }));
			await vi.advanceTimersByTimeAsync(0);
		});

		it('a new execute() during a drain joins at the tail, not the head', async () => {
			const resolvers: Array<(r: CueRunResult) => void> = [];
			const onCueRun = vi.fn(
				(req: { runId: string; subscriptionName: string }) =>
					new Promise<CueRunResult>((res) => {
						resolvers.push((result) => res({ ...result, runId: req.runId }));
					})
			);
			const deps = createDeps({
				onCueRun,
				getSessionSettings: vi.fn(() => ({
					...defaultSettings,
					max_concurrent: 1,
					queue_size: 5,
				})),
			});
			const manager = createCueRunManager(deps);

			// p1 dispatches; p2 queued.
			manager.execute('session-1', 'p1', createEvent(), 'sub-1');
			manager.execute('session-1', 'p2', createEvent(), 'sub-2');
			// Resolve p1 to trigger drain.
			resolvers.shift()!(makeResult());
			await vi.advanceTimersByTimeAsync(0);
			// Now sub-2 is in flight.
			expect(onCueRun.mock.calls[1][0].subscriptionName).toBe('sub-2');

			// p3 arrives while sub-2 is running → must queue (not jump ahead).
			manager.execute('session-1', 'p3', createEvent(), 'sub-3');
			expect(manager.getQueueStatus().get('session-1')).toBe(1);
			expect(onCueRun).toHaveBeenCalledTimes(2); // sub-3 hasn't started

			// Resolve sub-2 → sub-3 drains.
			resolvers.shift()!(makeResult());
			await vi.advanceTimersByTimeAsync(0);
			expect(onCueRun).toHaveBeenCalledTimes(3);
			expect(onCueRun.mock.calls[2][0].subscriptionName).toBe('sub-3');

			// Drain last resolver.
			resolvers.shift()!(makeResult());
			await vi.advanceTimersByTimeAsync(0);
		});
	});

	// ─── stopAll interleaving ───────────────────────────────────────────────

	describe('stopAll + concurrent new execute', () => {
		it('stopAll clears both the queue and every active run (no drained run escapes)', () => {
			// stopAll's contract: after this function returns, zero active runs
			// and zero queued events. It achieves this by clearing the queue
			// FIRST — otherwise stopRun's slot-release would drain a queued
			// event into a fresh active run that escaped the snapshot.
			//
			// This test pins the invariant so a future refactor that reorders
			// clear/stop surfaces as an assertion flip.
			const deferred = deferredOnCueRun();
			const deps = createDeps({
				onCueRun: deferred.fn,
				getSessionSettings: vi.fn(() => ({
					...defaultSettings,
					max_concurrent: 1,
					queue_size: 3,
				})),
			});
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'p1', createEvent(), 'sub-1');
			manager.execute('session-1', 'p2', createEvent(), 'sub-2');
			manager.execute('session-1', 'p3', createEvent(), 'sub-3');

			expect(manager.getActiveRuns()).toHaveLength(1);
			expect(manager.getQueueStatus().get('session-1')).toBe(2);

			manager.stopAll();

			expect(manager.getActiveRuns()).toHaveLength(0);
			expect(manager.getQueueStatus().size).toBe(0);
			expect(deps.onRunStopped).toHaveBeenCalledTimes(1); // one active run stopped
			// onCueRun was called once (for sub-1's initial dispatch) and must
			// NOT have been called a second time for sub-2 — the queue-clear
			// prevents the drain during stopRun from re-dispatching.
			expect(deps.onCueRun).toHaveBeenCalledTimes(1);
		});

		it('execute after stopAll still works (engine re-enable scenario)', async () => {
			const deferred = deferredOnCueRun();
			const deps = createDeps({ onCueRun: deferred.fn });
			const manager = createCueRunManager(deps);

			manager.execute('session-1', 'p1', createEvent(), 'sub-1');
			manager.stopAll();
			expect(manager.getActiveRuns()).toHaveLength(0);

			// User re-enables Cue; an event fires shortly after.
			manager.execute('session-1', 'p2', createEvent(), 'sub-2');
			expect(manager.getActiveRuns()).toHaveLength(1);

			// Clean up.
			deferred.resolve(makeResult());
			await vi.advanceTimersByTimeAsync(0);
		});
	});
});
