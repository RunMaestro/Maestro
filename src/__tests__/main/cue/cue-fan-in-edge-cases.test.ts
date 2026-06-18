/**
 * Phase 15A — fan-in tracker edge cases.
 *
 * Complements `cue-fan-in-tracker.test.ts` (which focuses on the inspection
 * API added in Phase 8C) by exercising the lifecycle corners the main runtime
 * relies on:
 *   - a source that never completes → timeout fires in 'continue' and 'break' modes
 *   - a source session removed mid-wait → clearForSession cleans the tracker
 *   - duplicate completion from the same source → treated idempotently
 *   - completion after timeout fired → no-op, no double dispatch
 *
 * Uses `vi.useFakeTimers()` to deterministically advance past the fan-in
 * timeout without sleeping in real time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
	AgentCompletionData,
	CueSettings,
	CueSubscription,
} from '../../../main/cue/cue-types';
import { createCueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'fan-in-sub',
		event: 'agent.completed',
		enabled: true,
		prompt: 'merge results',
		source_sessions: ['session-a', 'session-b'],
		...overrides,
	};
}

function makeSettings(overrides: Partial<CueSettings> = {}): CueSettings {
	return {
		// Small default so tests can advance a handful of minutes; individual
		// tests override this as needed.
		timeout_minutes: 2,
		timeout_on_fail: 'continue',
		max_concurrent: 1,
		queue_size: 10,
		...overrides,
	};
}

function makeCompletion(overrides: Partial<AgentCompletionData> = {}): AgentCompletionData {
	return {
		sessionName: 'agent-a',
		status: 'completed',
		exitCode: 0,
		durationMs: 1000,
		stdout: 'output from agent',
		triggeredBy: 'fan-in-sub',
		chainDepth: 0,
		...overrides,
	};
}

const SOURCES = ['session-a', 'session-b'];
const OWNER = 'owner-session';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CueFanInTracker — edge cases', () => {
	let dispatch: ReturnType<typeof vi.fn>;
	let onLog: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		dispatch = vi.fn();
		onLog = vi.fn();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function makeTracker() {
		return createCueFanInTracker({
			onLog,
			getSessions: () => [
				{ id: 'session-a', name: 'Agent A', toolType: 'claude-code', cwd: '/', projectRoot: '/' },
				{ id: 'session-b', name: 'Agent B', toolType: 'claude-code', cwd: '/', projectRoot: '/' },
			],
			dispatchSubscription: dispatch,
		});
	}

	// ─── Timeout behavior ──────────────────────────────────────────────────

	describe('source never completes → timeout', () => {
		it('fires with partial data in "continue" mode', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 2, timeout_on_fail: 'continue' });

			// Only session-a completes; session-b never does.
			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion({ sessionName: 'Agent A', stdout: 'A-OUTPUT' })
			);
			expect(dispatch).not.toHaveBeenCalled();
			expect(tracker.getActiveTrackerKeys()).toEqual([`${OWNER}:${sub.name}`]);

			// Advance just past the 2-minute timeout.
			vi.advanceTimersByTime(2 * 60 * 1000 + 1);

			expect(dispatch).toHaveBeenCalledTimes(1);
			const [ownerArg, subArg, eventArg, sourceNameArg] = dispatch.mock.calls[0];
			expect(ownerArg).toBe(OWNER);
			expect(subArg).toBe(sub);
			// Partial dispatch: only Agent A is in the completedSessions list;
			// Agent B shows up in timedOutSessions.
			expect(eventArg.payload.completedSessions).toEqual(['session-a']);
			expect(eventArg.payload.timedOutSessions).toEqual(['session-b']);
			expect(eventArg.payload.partial).toBe(true);
			expect(eventArg.payload.sourceOutput).toContain('A-OUTPUT');
			expect(sourceNameArg).toBe('Agent A');

			// Tracker state is cleaned up — timeout consumed the entry.
			expect(tracker.getActiveTrackerKeys()).toEqual([]);
			expect(tracker.getTrackerCreatedAt(`${OWNER}:${sub.name}`)).toBeUndefined();
		});

		it('logs but does not dispatch in "break" mode', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 2, timeout_on_fail: 'break' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);

			vi.advanceTimersByTime(2 * 60 * 1000 + 1);

			expect(dispatch).not.toHaveBeenCalled();
			expect(tracker.getActiveTrackerKeys()).toEqual([]);
			// Break-mode log surface: mentions timeout + waiting list.
			expect(
				onLog.mock.calls.some(
					(call) => typeof call[1] === 'string' && /timed out \(break mode\)/.test(call[1])
				)
			).toBe(true);
		});

		it('honors per-subscription fan_in_timeout_minutes over settings.timeout_minutes', () => {
			const tracker = makeTracker();
			const sub = makeSub({ fan_in_timeout_minutes: 1 });
			const settings = makeSettings({ timeout_minutes: 60, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);

			// settings.timeout_minutes is 60, but the per-sub override is 1 →
			// timeout fires just after 1 minute, well before 60.
			vi.advanceTimersByTime(60 * 1000 + 1);
			expect(dispatch).toHaveBeenCalledTimes(1);
		});

		it('honors per-subscription fan_in_timeout_on_fail override', () => {
			const tracker = makeTracker();
			const sub = makeSub({ fan_in_timeout_on_fail: 'break' });
			// Settings says "continue" but the sub pins "break" → must not
			// dispatch on timeout.
			const settings = makeSettings({ timeout_minutes: 1, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);

			vi.advanceTimersByTime(60 * 1000 + 1);
			expect(dispatch).not.toHaveBeenCalled();
		});
	});

	// ─── Mid-wait cleanup ──────────────────────────────────────────────────

	describe('source session removed during fan-in wait', () => {
		it('clearForSession cleans up tracker without firing timeout', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 5, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);
			expect(tracker.getActiveTrackerKeys()).toHaveLength(1);

			// Owner session goes away (user closed the agent); clear its fan-in state.
			tracker.clearForSession(OWNER);

			// Advance past the timeout — must NOT fire because the timer was cleared.
			vi.advanceTimersByTime(5 * 60 * 1000 + 1);

			expect(dispatch).not.toHaveBeenCalled();
			expect(tracker.getActiveTrackerKeys()).toEqual([]);
			expect(tracker.getTrackerCreatedAt(`${OWNER}:${sub.name}`)).toBeUndefined();
		});

		it('clearForSession only clears entries owned by the given session', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 5, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				'owner-1',
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);
			tracker.handleCompletion(
				'owner-2',
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);

			expect(tracker.getActiveTrackerKeys().sort()).toEqual(
				[`owner-1:${sub.name}`, `owner-2:${sub.name}`].sort()
			);

			tracker.clearForSession('owner-1');

			// owner-2 is still tracked and will time out normally.
			expect(tracker.getActiveTrackerKeys()).toEqual([`owner-2:${sub.name}`]);
		});
	});

	// ─── Idempotency / late-arrivals ───────────────────────────────────────

	describe('duplicate completion from the same source', () => {
		it('treats the second completion as a replacement, not a second vote', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 5, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion({ stdout: 'A-FIRST' })
			);
			// Same session completes a second time — must NOT count as a new vote
			// toward the fan-in, otherwise a 2-source fan-in would fire prematurely
			// after one agent completes twice without the other ever running.
			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion({ stdout: 'A-SECOND' })
			);

			expect(dispatch).not.toHaveBeenCalled();
			expect(tracker.getActiveTrackerKeys()).toEqual([`${OWNER}:${sub.name}`]);
		});

		it('second completion does not extend the timeout window', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 2, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);
			// Half the timeout window passes, then a duplicate arrives.
			vi.advanceTimersByTime(60 * 1000);
			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);
			// Remaining 60s + 1ms must trigger the original timeout — the
			// duplicate did NOT reset the timer.
			vi.advanceTimersByTime(60 * 1000 + 1);
			expect(dispatch).toHaveBeenCalledTimes(1);
		});
	});

	// ─── Late completion after timeout ─────────────────────────────────────

	describe('completion after timeout already fired', () => {
		it('is accepted as a fresh fan-in cycle (starts a new tracker)', () => {
			// This documents the current semantics: once a tracker is cleaned up
			// by a timeout, a late completion from the same source for the same
			// subscription starts a NEW tracker. In-flight coordination logic
			// upstream is responsible for treating post-timeout events as a new
			// cycle or dropping them — the tracker itself is stateless across
			// timeout boundaries.
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 2, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);
			vi.advanceTimersByTime(2 * 60 * 1000 + 1); // timeout fires
			expect(dispatch).toHaveBeenCalledTimes(1);

			// Late completion arrives from session-b — tracker was cleared, so
			// this becomes the first completion of a new cycle.
			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-b',
				'Agent B',
				makeCompletion()
			);
			// A new timer is ticking; we have NOT re-dispatched yet.
			expect(dispatch).toHaveBeenCalledTimes(1);
			expect(tracker.getActiveTrackerKeys()).toEqual([`${OWNER}:${sub.name}`]);
		});

		it('expireTracker prevents further completions from that tracker dispatching', () => {
			// expireTracker is the cleanup-service's eviction path. After it runs,
			// subsequent completions for the same key start a fresh tracker
			// cycle, but the tracker we expired must never dispatch.
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings({ timeout_minutes: 5, timeout_on_fail: 'continue' });

			tracker.handleCompletion(
				OWNER,
				settings,
				sub,
				SOURCES,
				'session-a',
				'Agent A',
				makeCompletion()
			);

			tracker.expireTracker(`${OWNER}:${sub.name}`);

			// Advance past the original timeout — expireTracker should have
			// cleared the timer; no dispatch must occur.
			vi.advanceTimersByTime(5 * 60 * 1000 + 1);
			expect(dispatch).not.toHaveBeenCalled();
		});
	});
});
