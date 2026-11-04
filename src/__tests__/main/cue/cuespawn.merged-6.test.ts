// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/main/cue/cue-fan-in-edge-cases.test.ts
// Source: src/__tests__/main/cue/cue-query-service.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
	AgentCompletionData,
	CueSettings as S1_CueSettings,
	CueSubscription as S1_CueSubscription,
} from '../../../main/cue/cue-types';
import { createCueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';
import {
	createCueQueryService,
	type CueQueryServiceDeps,
} from '../../../main/cue/cue-query-service';
import {
	DEFAULT_CUE_SETTINGS,
	type CueConfig,
	type CueSettings as S2_CueSettings,
	type CueSubscription as S2_CueSubscription,
} from '../../../main/cue/cue-types';
import type { SessionState } from '../../../main/cue/cue-session-state';
// Source: src/__tests__/main/cue/cue-fan-in-edge-cases.test.ts
describe('', () => {
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
// Source: src/__tests__/main/cue/cue-query-service.test.ts
describe('', () => {
	// ─── Helpers ─────────────────────────────────────────────────────────────────
	function makeConfig(
		subscriptions: S2_CueSubscription[] = [],
		settingsOverrides: Partial<S2_CueSettings> = {}
	): CueConfig {
		return {
			subscriptions,
			settings: { ...DEFAULT_CUE_SETTINGS, ...settingsOverrides },
		};
	}
	function makeState(config?: CueConfig): SessionState {
		return {
			config: config ?? makeConfig(),
			triggerSources: [],
			sleepPrevented: false,
		};
	}
	function makeSession(id: string, name = `Session-${id}`, projectRoot = `/proj/${id}`) {
		return { id, name, toolType: 'claude-code', projectRoot };
	}
	function makeDeps(overrides: Partial<CueQueryServiceDeps> = {}): CueQueryServiceDeps {
		return {
			getAllSessions: vi.fn(() => []),
			getSessionStates: vi.fn(() => new Map()),
			getActiveRunCount: vi.fn(() => 0),
			loadConfigForProjectRoot: vi.fn(() => null),
			...overrides,
		};
	}
	// ─── getStatus ────────────────────────────────────────────────────────────────
	describe('getStatus', () => {
		it('returns active session with enabled:true when in registry', () => {
			const session = makeSession('s1');
			const state = makeState(
				makeConfig([
					{
						name: 'sub1',
						event: 'time.heartbeat',
						enabled: true,
						prompt: 'p',
						interval_minutes: 60,
					},
				])
			);
			const deps = makeDeps({
				getAllSessions: () => [session],
				getSessionStates: () => new Map([['s1', state]]),
				getActiveRunCount: () => 2,
			});
			const svc = createCueQueryService(deps);
			const result = svc.getStatus();
			expect(result).toHaveLength(1);
			expect(result[0].sessionId).toBe('s1');
			expect(result[0].enabled).toBe(true);
			expect(result[0].activeRuns).toBe(2);
			expect(result[0].subscriptionCount).toBe(1);
		});
		it('returns dormant session with enabled:false when engine is running but session not in registry', () => {
			const session = makeSession('s1');
			const config = makeConfig([
				{ name: 'sub1', event: 'time.heartbeat', enabled: true, prompt: 'p', interval_minutes: 30 },
			]);
			const deps = makeDeps({
				getAllSessions: () => [session],
				getSessionStates: () => new Map(), // engine running but s1 not initialized
				loadConfigForProjectRoot: () => config,
			});
			const svc = createCueQueryService(deps);
			const result = svc.getStatus();
			expect(result).toHaveLength(1);
			expect(result[0].sessionId).toBe('s1');
			expect(result[0].enabled).toBe(false);
			expect(result[0].activeRuns).toBe(0);
			expect(result[0].subscriptionCount).toBe(1);
		});
		it('dormant subscriptionCount excludes disabled subscriptions', () => {
			const session = makeSession('s1');
			const config = makeConfig([
				{
					name: 'active-sub',
					event: 'time.heartbeat',
					enabled: true,
					prompt: 'p',
					interval_minutes: 30,
				},
				{
					name: 'disabled-sub',
					event: 'time.heartbeat',
					enabled: false,
					prompt: 'p',
					interval_minutes: 60,
				},
			]);
			const deps = makeDeps({
				getAllSessions: () => [session],
				getSessionStates: () => new Map(),
				loadConfigForProjectRoot: () => config,
			});
			const result = createCueQueryService(deps).getStatus();
			expect(result[0].subscriptionCount).toBe(1);
		});
		it('does not double-report a session that is both in registry and allSessions', () => {
			const session = makeSession('s1');
			const state = makeState();
			const deps = makeDeps({
				getAllSessions: () => [session],
				getSessionStates: () => new Map([['s1', state]]),
				loadConfigForProjectRoot: () => makeConfig(),
			});
			const svc = createCueQueryService(deps);
			const result = svc.getStatus();
			expect(result).toHaveLength(1);
		});
		it('excludes dormant sessions with no cue config', () => {
			const session = makeSession('s1');
			const deps = makeDeps({
				getAllSessions: () => [session],
				getSessionStates: () => new Map(),
				loadConfigForProjectRoot: () => null,
			});
			const svc = createCueQueryService(deps);
			expect(svc.getStatus()).toHaveLength(0);
		});
		it('reports both active and dormant sessions simultaneously', () => {
			const active = makeSession('a1');
			const dormant = makeSession('d1');
			const state = makeState();
			const deps = makeDeps({
				getAllSessions: () => [active, dormant],
				getSessionStates: () => new Map([['a1', state]]),
				loadConfigForProjectRoot: (root) => (root === dormant.projectRoot ? makeConfig() : null),
			});
			const svc = createCueQueryService(deps);
			const result = svc.getStatus();
			expect(result).toHaveLength(2);
			expect(result.find((r) => r.sessionId === 'a1')?.enabled).toBe(true);
			expect(result.find((r) => r.sessionId === 'd1')?.enabled).toBe(false);
		});
	});
	// ─── getGraphData ─────────────────────────────────────────────────────────────
	describe('getGraphData', () => {
		it('returns dormant session subscriptions when engine is running but session not initialized', () => {
			const session = makeSession('s1', 'Agent1');
			const sub: S2_CueSubscription = {
				name: 'heartbeat',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'go',
				interval_minutes: 60,
			};
			const config = makeConfig([sub]);
			const deps = makeDeps({
				getAllSessions: () => [session],
				getSessionStates: () => new Map(),
				loadConfigForProjectRoot: () => config,
			});
			const svc = createCueQueryService(deps);
			const result = svc.getGraphData();
			expect(result).toHaveLength(1);
			expect(result[0].sessionId).toBe('s1');
			expect(result[0].sessionName).toBe('Agent1');
			expect(result[0].subscriptions).toHaveLength(1);
			expect(result[0].subscriptions[0].name).toBe('heartbeat');
		});
		it('does not double-report a session that is both initialized and in allSessions', () => {
			const session = makeSession('s1');
			const sub: S2_CueSubscription = {
				name: 'sub1',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'p',
				interval_minutes: 60,
			};
			const state = makeState(makeConfig([sub]));
			const deps = makeDeps({
				getAllSessions: () => [session],
				getSessionStates: () => new Map([['s1', state]]),
				loadConfigForProjectRoot: () => makeConfig([sub]),
			});
			const svc = createCueQueryService(deps);
			const result = svc.getGraphData();
			expect(result).toHaveLength(1);
		});
		it('excludes dormant sessions with no cue config', () => {
			const session = makeSession('s1');
			const deps = makeDeps({
				getAllSessions: () => [session],
				getSessionStates: () => new Map(),
				loadConfigForProjectRoot: () => null,
			});
			expect(createCueQueryService(deps).getGraphData()).toHaveLength(0);
		});
		it('filters dormant subscriptions via isSubscriptionParticipant - owned by other agent excluded', () => {
			const session = makeSession('s1', 'A');
			const ownedBySelf: S2_CueSubscription = {
				name: 'mine',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'p',
				interval_minutes: 30,
				agent_id: 's1',
			};
			const ownedByOther: S2_CueSubscription = {
				name: 'theirs',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'p',
				interval_minutes: 30,
				agent_id: 'other-session',
			};
			const config = makeConfig([ownedBySelf, ownedByOther]);
			const deps = makeDeps({
				getAllSessions: () => [session],
				getSessionStates: () => new Map(),
				loadConfigForProjectRoot: () => config,
			});
			const result = createCueQueryService(deps).getGraphData();
			expect(result[0].subscriptions).toHaveLength(1);
			expect(result[0].subscriptions[0].name).toBe('mine');
		});
		it('includes fan-out target sessions in dormant graph data', () => {
			const owner = makeSession('owner', 'Owner');
			const target = makeSession('target', 'Target');
			const sub: S2_CueSubscription = {
				name: 'fanout-sub',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'p',
				interval_minutes: 60,
				agent_id: 'owner',
				fan_out: ['Target'],
			};
			const config = makeConfig([sub]);
			// Neither session is initialized (both dormant)
			const deps = makeDeps({
				getAllSessions: () => [owner, target],
				getSessionStates: () => new Map(),
				loadConfigForProjectRoot: () => config,
			});
			const result = createCueQueryService(deps).getGraphData();
			// Both owner and fan-out target should appear with the sub
			expect(result).toHaveLength(2);
			const targetEntry = result.find((r) => r.sessionId === 'target');
			expect(targetEntry?.subscriptions).toHaveLength(1);
			expect(targetEntry?.subscriptions[0].name).toBe('fanout-sub');
		});
	});
	// ─── getSettings ─────────────────────────────────────────────────────────────
	describe('getSettings', () => {
		it('returns settings from an initialized session', () => {
			const state = makeState(
				makeConfig([], {
					timeout_minutes: 99,
					timeout_on_fail: 'continue',
					max_concurrent: 5,
					queue_size: 20,
				})
			);
			const deps = makeDeps({ getSessionStates: () => new Map([['s1', state]]) });
			const settings = createCueQueryService(deps).getSettings();
			expect(settings.timeout_minutes).toBe(99);
			expect(settings.max_concurrent).toBe(5);
		});
		it('falls back to DEFAULT_CUE_SETTINGS when no sessions are initialized', () => {
			const deps = makeDeps({ getSessionStates: () => new Map() });
			const settings = createCueQueryService(deps).getSettings();
			expect(settings).toEqual(DEFAULT_CUE_SETTINGS);
		});
		it('strips per-root owner_agent_id so it is never exposed as a global setting', () => {
			// Regression: owner_agent_id is per-root (it names an agent that must live
			// at that cue.yaml's root). When getSettings surfaced the first session's
			// owner_agent_id, the Settings modal read it and saveSettings broadcast it
			// into every cue.yaml - flagging unrelated single-agent projects with a
			// bogus "owner_agent_id does not match any agent" warning.
			const state = makeState(
				makeConfig([], {
					timeout_minutes: 60,
					timeout_on_fail: 'continue',
					max_concurrent: 1,
					queue_size: 50,
					owner_agent_id: 'pedsidian-uuid',
				})
			);
			const deps = makeDeps({ getSessionStates: () => new Map([['s1', state]]) });
			const settings = createCueQueryService(deps).getSettings();
			expect(settings.owner_agent_id).toBeUndefined();
			// Non-ownership global fields still flow through.
			expect(settings.timeout_minutes).toBe(60);
			expect(settings.max_concurrent).toBe(1);
		});
	});
});
