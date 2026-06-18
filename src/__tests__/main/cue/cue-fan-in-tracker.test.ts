/**
 * Unit tests for CueFanInTracker — focused on the three new methods added
 * in Phase 8C: getActiveTrackerKeys, getTrackerCreatedAt, expireTracker,
 * plus the lifecycle cleanup of fanInCreatedAt in clearForSession and reset.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
	CueSettings,
	CueSubscription,
	AgentCompletionData,
} from '../../../main/cue/cue-types';
import { createCueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'fan-in-sub',
		event: 'agent.completed',
		enabled: true,
		prompt: 'compile results',
		source_sessions: ['session-a', 'session-b'],
		...overrides,
	};
}

function makeSettings(overrides: Partial<CueSettings> = {}): CueSettings {
	return {
		timeout_minutes: 30,
		timeout_on_fail: 'break',
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CueFanInTracker — new inspection methods', () => {
	let dispatch: ReturnType<typeof vi.fn>;
	let onLog: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		dispatch = vi.fn();
		onLog = vi.fn();
		vi.useFakeTimers();
	});

	afterEach(() => {
		// checkHealth tests additionally call vi.setSystemTime; restore real
		// timers here so other suites run against the real clock.
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

	describe('getActiveTrackerKeys', () => {
		it('returns empty array when no trackers are active', () => {
			const tracker = makeTracker();
			expect(tracker.getActiveTrackerKeys()).toEqual([]);
		});

		it('returns the key after the first completion arrives', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings();

			tracker.handleCompletion(
				'owner-session',
				settings,
				sub,
				['session-a', 'session-b'],
				'session-a',
				'Agent A',
				makeCompletion()
			);

			expect(tracker.getActiveTrackerKeys()).toEqual(['owner-session:fan-in-sub']);
		});

		it('removes the key after all sources complete (fan-in fires)', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings();
			const sources = ['session-a', 'session-b'];

			tracker.handleCompletion(
				'owner',
				settings,
				sub,
				sources,
				'session-a',
				'Agent A',
				makeCompletion()
			);
			tracker.handleCompletion(
				'owner',
				settings,
				sub,
				sources,
				'session-b',
				'Agent B',
				makeCompletion()
			);

			// Fan-in fired — no more active trackers
			expect(tracker.getActiveTrackerKeys()).toEqual([]);
		});
	});

	describe('getTrackerCreatedAt', () => {
		it('returns undefined for an unknown key', () => {
			const tracker = makeTracker();
			expect(tracker.getTrackerCreatedAt('nonexistent:key')).toBeUndefined();
		});

		it('returns the timestamp set when the first completion arrives', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings();
			const before = Date.now();

			tracker.handleCompletion(
				'owner-session',
				settings,
				sub,
				['session-a', 'session-b'],
				'session-a',
				'Agent A',
				makeCompletion()
			);

			const createdAt = tracker.getTrackerCreatedAt('owner-session:fan-in-sub');
			expect(createdAt).toBeGreaterThanOrEqual(before);
			expect(createdAt).toBeLessThanOrEqual(Date.now());
		});
	});

	describe('expireTracker', () => {
		it('removes the tracker and its timer without dispatching', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings();

			tracker.handleCompletion(
				'owner',
				settings,
				sub,
				['session-a', 'session-b'],
				'session-a',
				'Agent A',
				makeCompletion()
			);

			const key = 'owner:fan-in-sub';
			expect(tracker.getActiveTrackerKeys()).toContain(key);

			tracker.expireTracker(key);

			expect(tracker.getActiveTrackerKeys()).not.toContain(key);
			expect(tracker.getTrackerCreatedAt(key)).toBeUndefined();
			expect(dispatch).not.toHaveBeenCalled();
		});

		it('is a no-op for an unknown key', () => {
			const tracker = makeTracker();
			expect(() => tracker.expireTracker('nonexistent:key')).not.toThrow();
		});
	});

	describe('clearForSession — cleans up fanInCreatedAt', () => {
		it('removes createdAt entry when the owning session is cleared', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings();

			tracker.handleCompletion(
				'owner',
				settings,
				sub,
				['session-a', 'session-b'],
				'session-a',
				'Agent A',
				makeCompletion()
			);

			expect(tracker.getTrackerCreatedAt('owner:fan-in-sub')).toBeDefined();

			tracker.clearForSession('owner');

			expect(tracker.getTrackerCreatedAt('owner:fan-in-sub')).toBeUndefined();
			expect(tracker.getActiveTrackerKeys()).toEqual([]);
		});
	});

	describe('reset — clears all fanInCreatedAt entries', () => {
		it('removes all createdAt entries on reset', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings();

			tracker.handleCompletion(
				'owner',
				settings,
				sub,
				['session-a', 'session-b'],
				'session-a',
				'Agent A',
				makeCompletion()
			);

			expect(tracker.getActiveTrackerKeys()).toHaveLength(1);

			tracker.reset();

			expect(tracker.getActiveTrackerKeys()).toEqual([]);
			expect(tracker.getTrackerCreatedAt('owner:fan-in-sub')).toBeUndefined();
		});
	});

	// ─── Phase 12D — checkHealth ────────────────────────────────────────────
	describe('checkHealth', () => {
		const sessions = [
			{ id: 'session-a', name: 'Agent A', toolType: 'claude-code', cwd: '/', projectRoot: '/' },
			{ id: 'session-b', name: 'Agent B', toolType: 'claude-code', cwd: '/', projectRoot: '/' },
		];
		const sub = makeSub({ fan_in_timeout_minutes: 10 });

		function primeTracker(tracker: ReturnType<typeof makeTracker>) {
			tracker.handleCompletion(
				'owner',
				makeSettings(),
				sub,
				['session-a', 'session-b'],
				'session-a',
				'Agent A',
				makeCompletion()
			);
		}

		it('returns empty when no trackers are active', () => {
			const tracker = makeTracker();
			expect(
				tracker.checkHealth({ sessions, lookupSubscription: () => null, now: Date.now() })
			).toEqual([]);
		});

		it('excludes trackers <= 50% elapsed', () => {
			vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
			const tracker = makeTracker();
			primeTracker(tracker);
			// 3 minutes elapsed of a 10 minute timeout = 30%
			const now = Date.now() + 3 * 60 * 1000;
			const result = tracker.checkHealth({
				sessions,
				lookupSubscription: () => ({
					sub,
					settings: makeSettings(),
					sources: ['session-a', 'session-b'],
				}),
				now,
			});
			expect(result).toEqual([]);
		});

		it('includes trackers > 50% elapsed with correct counts', () => {
			vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
			const tracker = makeTracker();
			primeTracker(tracker);
			// 7 minutes elapsed of a 10 minute timeout = 70%
			const now = Date.now() + 7 * 60 * 1000;
			const result = tracker.checkHealth({
				sessions,
				lookupSubscription: () => ({
					sub,
					settings: makeSettings(),
					sources: ['session-a', 'session-b'],
				}),
				now,
			});
			expect(result).toHaveLength(1);
			const entry = result[0];
			expect(entry.key).toBe('owner:fan-in-sub');
			expect(entry.ownerSessionId).toBe('owner');
			expect(entry.subscriptionName).toBe('fan-in-sub');
			expect(entry.completedCount).toBe(1);
			expect(entry.expectedCount).toBe(2);
			expect(entry.pendingSourceIds).toEqual(['session-b']);
			expect(entry.percentElapsed).toBeGreaterThan(50);
			expect(entry.percentElapsed).toBeLessThan(100);
			expect(entry.timeoutMs).toBe(10 * 60 * 1000);
		});

		it('clamps negative elapsed (clock moved backward) to 0 and excludes', () => {
			vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
			const tracker = makeTracker();
			primeTracker(tracker);
			// Clock moved backward by 5 minutes from tracker creation
			const now = Date.now() - 5 * 60 * 1000;
			const result = tracker.checkHealth({
				sessions,
				lookupSubscription: () => ({
					sub,
					settings: makeSettings(),
					sources: ['session-a', 'session-b'],
				}),
				now,
			});
			expect(result).toEqual([]);
		});

		it('excludes trackers whose subscription can no longer be resolved', () => {
			vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
			const tracker = makeTracker();
			primeTracker(tracker);
			const now = Date.now() + 8 * 60 * 1000;
			const result = tracker.checkHealth({
				sessions,
				lookupSubscription: () => null, // subscription gone
				now,
			});
			expect(result).toEqual([]);
		});

		it('uses per-subscription fan_in_timeout_minutes over global settings', () => {
			vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
			const tracker = makeTracker();
			const localSub = makeSub({ fan_in_timeout_minutes: 2 });
			tracker.handleCompletion(
				'owner',
				makeSettings({ timeout_minutes: 100 }), // global 100m, but per-sub is 2m
				localSub,
				['session-a', 'session-b'],
				'session-a',
				'Agent A',
				makeCompletion()
			);
			// 1.5 minutes elapsed > 50% of 2 minute timeout
			const now = Date.now() + 90 * 1000;
			const result = tracker.checkHealth({
				sessions,
				lookupSubscription: () => ({
					sub: localSub,
					settings: makeSettings({ timeout_minutes: 100 }),
					sources: ['session-a', 'session-b'],
				}),
				now,
			});
			expect(result).toHaveLength(1);
			expect(result[0].timeoutMs).toBe(2 * 60 * 1000);
		});

		it('resolves pendingSourceIds via dedup (name+id referring to same session collapses)', () => {
			vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
			const tracker = makeTracker();
			primeTracker(tracker);
			const now = Date.now() + 8 * 60 * 1000;
			// Sources reference same session B by name + id.
			const result = tracker.checkHealth({
				sessions,
				lookupSubscription: () => ({
					sub,
					settings: makeSettings(),
					sources: ['session-a', 'session-b', 'Agent B'],
				}),
				now,
			});
			expect(result).toHaveLength(1);
			// Agent B resolves to session-b (already in set), so total expected is 2.
			expect(result[0].expectedCount).toBe(2);
		});
	});

	// ─── Regression: chainDepth propagation through fan-in ────────────────────
	// Bug 30ab9a5c4: fan-in dispatch did not forward the max chainDepth across
	// completed sources, so circular pipelines routed through fan-in nodes
	// bypassed the depth guard in CueCompletionService.notifyAgentCompleted —
	// the next dispatch saw chainDepth=0 and ran indefinitely. The fix stores
	// chainDepth in FanInSourceCompletion and the all-complete + timeout-continue
	// paths both pass `Math.max(...completions.map(c => c.chainDepth))` to
	// dispatchSubscription. These tests guard both paths.
	describe('chainDepth propagation', () => {
		it('forwards max chainDepth to dispatchSubscription when all sources complete', () => {
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings();
			const sources = ['session-a', 'session-b'];

			tracker.handleCompletion(
				'owner',
				settings,
				sub,
				sources,
				'session-a',
				'Agent A',
				makeCompletion({ chainDepth: 3 })
			);
			tracker.handleCompletion(
				'owner',
				settings,
				sub,
				sources,
				'session-b',
				'Agent B',
				makeCompletion({ chainDepth: 7 })
			);

			expect(dispatch).toHaveBeenCalledTimes(1);
			// dispatchSubscription signature: (ownerSessionId, sub, event, completedNames, chainDepth?)
			const call = dispatch.mock.calls[0];
			expect(call[0]).toBe('owner');
			expect(call[1]).toBe(sub);
			// Last positional argument is chainDepth — must equal max(3, 7) = 7,
			// NOT the last completion's depth (would mask cycles where the
			// deepest source isn't the most recent), and NOT 0 (the original
			// bug, which let cycles run forever).
			expect(call[4]).toBe(7);
		});

		it('forwards max chainDepth in timeout-continue mode', () => {
			vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
			const tracker = makeTracker();
			const sub = makeSub({ fan_in_timeout_minutes: 10 });
			const settings = makeSettings({ timeout_on_fail: 'continue' });
			const sources = ['session-a', 'session-b'];

			// Only session-a completes; session-b is left dangling and the
			// timer fires the timeout-continue branch.
			tracker.handleCompletion(
				'owner',
				settings,
				sub,
				sources,
				'session-a',
				'Agent A',
				makeCompletion({ chainDepth: 5 })
			);

			// Advance past the per-sub fan_in_timeout_minutes (10m).
			vi.advanceTimersByTime(11 * 60 * 1000);

			expect(dispatch).toHaveBeenCalledTimes(1);
			const call = dispatch.mock.calls[0];
			// Only one completion arrived, so max == that source's chainDepth (5).
			// The bug would have passed 0 here, masking cycles when partial
			// fan-ins continue through to dispatch.
			expect(call[4]).toBe(5);
		});

		it('falls back to chainDepth=0 when completions carry no chainDepth field', () => {
			// Defensive: events from older code paths or external callers may
			// omit chainDepth. The tracker must default to 0 (matching the
			// `?? 0` fallback in cue-fan-in-tracker.ts:219) rather than NaN
			// (which Math.max returns when fed undefined).
			const tracker = makeTracker();
			const sub = makeSub();
			const settings = makeSettings();
			const sources = ['session-a', 'session-b'];

			// Spread overrides into makeCompletion but force chainDepth=undefined
			// to simulate an external completion that didn't set it.
			const completionMissingDepth = {
				sessionName: 'agent-a',
				status: 'completed' as const,
				exitCode: 0,
				durationMs: 1000,
				stdout: 'output',
				triggeredBy: 'fan-in-sub',
			};

			tracker.handleCompletion(
				'owner',
				settings,
				sub,
				sources,
				'session-a',
				'Agent A',
				completionMissingDepth as never
			);
			tracker.handleCompletion(
				'owner',
				settings,
				sub,
				sources,
				'session-b',
				'Agent B',
				completionMissingDepth as never
			);

			expect(dispatch).toHaveBeenCalledTimes(1);
			const call = dispatch.mock.calls[0];
			expect(call[4]).toBe(0);
			expect(Number.isNaN(call[4])).toBe(false);
		});
	});
});
