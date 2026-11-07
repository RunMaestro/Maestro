// Related Cue tests; each source keeps its own hooks and state.
// Source: src/__tests__/main/cue/cue-fan-in-tracker.test.ts
// Source: src/__tests__/main/cue/cue-fan-in-edge-cases.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
	CueSettings as S0_CueSettings,
	CueSubscription as S0_CueSubscription,
	AgentCompletionData as S0_AgentCompletionData,
} from '../../../main/cue/cue-types';
import { createCueFanInTracker as s0_createCueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';
import type {
	AgentCompletionData as S1_AgentCompletionData,
	CueSettings as S1_CueSettings,
	CueSubscription as S1_CueSubscription,
} from '../../../main/cue/cue-types';
import { createCueFanInTracker as s1_createCueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';
describe('cue-fan-in-tracker', () => {
	// ─── Helpers ─────────────────────────────────────────────────────────────────
	function makeSub(overrides: Partial<S0_CueSubscription> = {}): S0_CueSubscription {
		return {
			name: 'fan-in-sub',
			event: 'agent.completed',
			enabled: true,
			prompt: 'compile results',
			source_sessions: ['session-a', 'session-b'],
			...overrides,
		};
	}
	function makeSettings(overrides: Partial<S0_CueSettings> = {}): S0_CueSettings {
		return {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
			...overrides,
		};
	}
	function makeCompletion(overrides: Partial<S0_AgentCompletionData> = {}): S0_AgentCompletionData {
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
	describe('CueFanInTracker - new inspection methods', () => {
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
			return s0_createCueFanInTracker({
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
				// Fan-in fired - no more active trackers
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
		describe('clearForSession - cleans up fanInCreatedAt', () => {
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
		describe('reset - clears all fanInCreatedAt entries', () => {
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
		// ─── Phase 12D - checkHealth ────────────────────────────────────────────
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
		// bypassed the depth guard in CueCompletionService.notifyAgentCompleted -
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
				// Last positional argument is chainDepth - must equal max(3, 7) = 7,
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
});
describe('cue-fan-in-edge-cases', () => {
	// ─── Helpers ─────────────────────────────────────────────────────────────────
	function makeSub(overrides: Partial<S1_CueSubscription> = {}): S1_CueSubscription {
		return {
			name: 'fan-in-sub',
			event: 'agent.completed',
			enabled: true,
			prompt: 'merge results',
			source_sessions: ['session-a', 'session-b'],
			...overrides,
		};
	}
	function makeSettings(overrides: Partial<S1_CueSettings> = {}): S1_CueSettings {
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
	function makeCompletion(overrides: Partial<S1_AgentCompletionData> = {}): S1_AgentCompletionData {
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
	describe('CueFanInTracker - edge cases', () => {
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
			return s1_createCueFanInTracker({
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
				// Tracker state is cleaned up - timeout consumed the entry.
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
				// Advance past the timeout - must NOT fire because the timer was cleared.
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
				// Same session completes a second time - must NOT count as a new vote
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
				// Remaining 60s + 1ms must trigger the original timeout - the
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
				// cycle or dropping them - the tracker itself is stateless across
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
				// Late completion arrives from session-b - tracker was cleared, so
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
				// Advance past the original timeout - expireTracker should have
				// cleared the timer; no dispatch must occur.
				vi.advanceTimersByTime(5 * 60 * 1000 + 1);
				expect(dispatch).not.toHaveBeenCalled();
			});
		});
	});
});
