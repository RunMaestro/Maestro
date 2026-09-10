/**
 * Tests for retryStore - the Agent Resilience auto-retry engine.
 *
 * Covers scheduling/classification gating, the scheduled → in-flight state
 * machine, backoff continuation, resend vs batch-resume modes, dispatch
 * supersession, and the manual retry-now / cancel / settle transitions.
 *
 * Uses fake timers so the scheduled setTimeout is deterministic. `fireRetry`
 * invokes `processQueuedItem` (or the batch resumer) synchronously before its
 * first await, so assertions can run immediately after a timer flush or
 * retryNow without additional microtask flushing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	scheduleRetryForError,
	noteDispatch,
	retryNow,
	cancelRetry,
	clearRetryIfSettled,
	getRetryEntry,
	hasPendingRetry,
	getOutage,
	sessionHasActiveOutage,
	registerBatchResumer,
	replayAfterAuth,
	useRetryStore,
} from '../../../renderer/stores/retryStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useAgentStore, type ProcessQueuedItemDeps } from '../../../renderer/stores/agentStore';
import { availabilityDelayMs, RESET_TIME_BUFFER_MS } from '../../../shared/retryClassification';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { AgentError } from '../../../renderer/types';

const NOW = new Date('2026-01-01T00:00:00Z').getTime();

const deps: ProcessQueuedItemDeps = {
	conductorProfile: '',
	customAICommands: [],
	speckitCommands: [],
	openspecCommands: [],
} as unknown as ProcessQueuedItemDeps;

let processQueuedItem: ReturnType<typeof vi.fn>;

/** Build an AgentError-shaped object with sensible recoverable defaults. */
function err(partial: Partial<AgentError> & { message: string }): AgentError {
	return {
		type: 'rate_limited',
		recoverable: true,
		timestamp: NOW,
		agentId: 'claude-code',
		...partial,
	} as AgentError;
}

const overload = () => err({ type: 'rate_limited', message: 'API Error: 529 Overloaded' });
const quota = () => err({ type: 'rate_limited', message: 'Usage limit reached' });

/** Put a single resilience-enabled session (with one AI tab) into the store. */
function setupSession(id: string, tabId: string, overrides = {}) {
	const tab = createMockAITab({ id: tabId });
	const session = createMockSession({
		id,
		aiTabs: [tab],
		activeTabId: tabId,
		...overrides,
	});
	useSessionStore.setState({ sessions: [session] } as any);
}

/** Record a dispatch snapshot so a `resend` retry has something to replay. */
function seedSnapshot(id: string, tabId: string) {
	noteDispatch(id, { id: 'item-1', timestamp: 1, tabId, type: 'message', text: 'hi' }, deps);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	useRetryStore.setState({ retries: {}, outages: {} });
	useSessionStore.setState({ sessions: [] } as any);
	processQueuedItem = vi.fn().mockResolvedValue(undefined);
	useAgentStore.setState({ processQueuedItem } as any);
	registerBatchResumer(null);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	registerBatchResumer(null);
});

describe('scheduleRetryForError - classification gating', () => {
	it('schedules an availability retry when resilience is on and a snapshot exists', () => {
		setupSession('s1', 't1');
		seedSnapshot('s1', 't1');

		expect(scheduleRetryForError('s1', 't1', overload())).toBe(true);

		const entry = getRetryEntry('s1', 't1');
		expect(entry?.strategy).toBe('availability');
		expect(entry?.mode).toBe('resend');
		expect(entry?.status).toBe('scheduled');
		expect(entry?.attempt).toBe(0);
		expect(entry?.nextRetryAt).toBe(NOW + availabilityDelayMs(0));
	});

	it('schedules a token-exhaustion retry for quota messages', () => {
		setupSession('s2', 't1');
		seedSnapshot('s2', 't1');

		expect(scheduleRetryForError('s2', 't1', quota())).toBe(true);
		expect(getRetryEntry('s2', 't1')?.strategy).toBe('token-exhaustion');
	});

	it('returns false (falls back to modal) when there is no snapshot to resend', () => {
		setupSession('s3', 't1');
		// No seedSnapshot for this key.
		expect(scheduleRetryForError('s3', 't1', overload())).toBe(false);
		expect(getRetryEntry('s3', 't1')).toBeUndefined();
	});

	it('returns false for a non-retryable error type', () => {
		setupSession('s4', 't1');
		seedSnapshot('s4', 't1');
		expect(
			scheduleRetryForError('s4', 't1', err({ type: 'auth_expired', message: 'expired' }))
		).toBe(false);
	});

	it('returns false when the availability toggle is off for the agent', () => {
		setupSession('s5', 't1', { retryOnAvailabilityErrors: false });
		seedSnapshot('s5', 't1');
		expect(scheduleRetryForError('s5', 't1', overload())).toBe(false);
	});

	it('returns false when the token-exhaustion toggle is off for the agent', () => {
		setupSession('s6', 't1', { retryOnTokenExhaustion: false });
		seedSnapshot('s6', 't1');
		expect(scheduleRetryForError('s6', 't1', quota())).toBe(false);
	});

	it('returns false when the session cannot be found', () => {
		seedSnapshot('missing', 't1');
		expect(scheduleRetryForError('missing', 't1', overload())).toBe(false);
	});
});

describe('scheduleRetryForError - backoff continuation', () => {
	it('increments the attempt and lengthens the delay when re-scheduled', () => {
		setupSession('s7', 't1');
		seedSnapshot('s7', 't1');

		scheduleRetryForError('s7', 't1', overload());
		expect(getRetryEntry('s7', 't1')?.attempt).toBe(0);

		// A failed resend re-enters scheduleRetryForError for the same key.
		scheduleRetryForError('s7', 't1', overload());
		const entry = getRetryEntry('s7', 't1');
		expect(entry?.attempt).toBe(1);
		expect(entry?.nextRetryAt).toBe(NOW + availabilityDelayMs(1));
		expect(availabilityDelayMs(1)).toBeGreaterThan(availabilityDelayMs(0));
	});
});

describe('firing the retry', () => {
	it('replays the snapshot through processQueuedItem when the timer fires', () => {
		setupSession('s8', 't1');
		seedSnapshot('s8', 't1');
		scheduleRetryForError('s8', 't1', overload());

		vi.advanceTimersByTime(availabilityDelayMs(0));

		expect(processQueuedItem).toHaveBeenCalledTimes(1);
		expect(processQueuedItem).toHaveBeenCalledWith(
			's8',
			expect.objectContaining({ id: 'item-1', tabId: 't1' }),
			deps
		);
		// Flipped to in-flight before dispatch; stays there until the exit listener settles it.
		expect(getRetryEntry('s8', 't1')?.status).toBe('in-flight');
	});

	it('retryNow cancels the timer and fires immediately', () => {
		setupSession('s9', 't1');
		seedSnapshot('s9', 't1');
		scheduleRetryForError('s9', 't1', overload());

		retryNow('s9', 't1');
		expect(processQueuedItem).toHaveBeenCalledTimes(1);

		// The scheduled timer must not also fire.
		vi.advanceTimersByTime(availabilityDelayMs(0));
		expect(processQueuedItem).toHaveBeenCalledTimes(1);
	});

	it('retryNow is a no-op when there is no active retry', () => {
		retryNow('nope', 't1');
		expect(processQueuedItem).not.toHaveBeenCalled();
	});

	// Codify-at-send freezes model/effort onto the QueuedItem so a queued turn
	// runs under what was selected when the user hit Enter. A retry is the one
	// case that must NOT honor that freeze: the whole reason a user touches the
	// model (or the agent's provider) during the countdown is to get out from
	// behind the wall that just failed the turn.
	it('resends under the model and effort the agent carries NOW, not the frozen ones', () => {
		setupSession('s10', 't1', { customModel: 'fable', customEffort: 'low' });
		noteDispatch(
			's10',
			{
				id: 'item-1',
				timestamp: 1,
				tabId: 't1',
				type: 'message',
				text: 'hi',
				turnSettings: { model: 'opus', effort: 'high' },
			},
			deps
		);
		scheduleRetryForError('s10', 't1', quota());

		retryNow('s10', 't1');

		expect(processQueuedItem).toHaveBeenCalledWith(
			's10',
			expect.objectContaining({
				text: 'hi',
				turnSettings: { model: 'fable', effort: 'low' },
			}),
			deps
		);
	});

	it('prefers the tab override over the agent default when re-codifying', () => {
		const tab = createMockAITab({ id: 't1', customModel: 'sonnet', customEffort: 'medium' });
		useSessionStore.setState({
			sessions: [createMockSession({ id: 's11', aiTabs: [tab], activeTabId: 't1' })],
		} as any);
		seedSnapshot('s11', 't1');
		scheduleRetryForError('s11', 't1', quota());

		retryNow('s11', 't1');

		expect(processQueuedItem).toHaveBeenCalledWith(
			's11',
			expect.objectContaining({ turnSettings: { model: 'sonnet', effort: 'medium' } }),
			deps
		);
	});
});

describe('cancel and settle transitions', () => {
	it('cancelRetry removes the entry and stops the timer', () => {
		setupSession('s10', 't1');
		seedSnapshot('s10', 't1');
		scheduleRetryForError('s10', 't1', overload());

		cancelRetry('s10', 't1');
		expect(getRetryEntry('s10', 't1')).toBeUndefined();

		vi.advanceTimersByTime(availabilityDelayMs(0));
		expect(processQueuedItem).not.toHaveBeenCalled();
	});

	// Stopping a countdown ends the turn: nothing is running, so the tab must not
	// keep pulsing (and the Thinking pill must stop counting elapsed time).
	it('cancelRetry settles the tab that was left marked busy', () => {
		setupSession('s10b', 't1', {
			state: 'busy',
			busySource: 'ai',
			thinkingStartTime: NOW - 60_000,
			aiTabs: [createMockAITab({ id: 't1', state: 'busy', thinkingStartTime: NOW - 60_000 })],
		});
		seedSnapshot('s10b', 't1');
		scheduleRetryForError('s10b', 't1', overload());

		cancelRetry('s10b', 't1');

		const session = useSessionStore.getState().sessions[0];
		expect(session.aiTabs[0].state).toBe('idle');
		expect(session.aiTabs[0].thinkingStartTime).toBeUndefined();
		expect(session.state).toBe('idle');
		expect(session.busySource).toBeUndefined();
		expect(session.thinkingStartTime).toBeUndefined();
	});

	// An in-flight resend is a REAL running process - the exit listener owns its
	// busy state, so cancelling must not idle a tab that is still working.
	it('cancelRetry leaves an in-flight resend busy', () => {
		setupSession('s10c', 't1', {
			state: 'busy',
			busySource: 'ai',
			aiTabs: [createMockAITab({ id: 't1', state: 'busy' })],
		});
		seedSnapshot('s10c', 't1');
		scheduleRetryForError('s10c', 't1', overload());
		retryNow('s10c', 't1'); // → in-flight

		cancelRetry('s10c', 't1');

		const session = useSessionStore.getState().sessions[0];
		expect(session.aiTabs[0].state).toBe('busy');
		expect(session.state).toBe('busy');
	});

	it('clearRetryIfSettled clears an in-flight entry (clean completion)', () => {
		setupSession('s11', 't1');
		seedSnapshot('s11', 't1');
		scheduleRetryForError('s11', 't1', overload());
		retryNow('s11', 't1'); // → in-flight

		clearRetryIfSettled('s11', 't1');
		expect(getRetryEntry('s11', 't1')).toBeUndefined();
	});

	it('clearRetryIfSettled leaves a re-scheduled entry alone', () => {
		setupSession('s12', 't1');
		seedSnapshot('s12', 't1');
		scheduleRetryForError('s12', 't1', overload()); // status: scheduled

		clearRetryIfSettled('s12', 't1');
		expect(getRetryEntry('s12', 't1')?.status).toBe('scheduled');
	});
});

describe('noteDispatch supersession', () => {
	it('a fresh dispatch (new item id) cancels a pending scheduled retry', () => {
		setupSession('s13', 't1');
		seedSnapshot('s13', 't1');
		scheduleRetryForError('s13', 't1', overload());
		expect(getRetryEntry('s13', 't1')?.status).toBe('scheduled');

		// User moves on and sends a different prompt for the same tab.
		noteDispatch(
			's13',
			{ id: 'item-2', timestamp: 2, tabId: 't1', type: 'message', text: 'different' },
			deps
		);
		expect(getRetryEntry('s13', 't1')).toBeUndefined();
	});

	it('does not cancel an in-flight retry (our own resend re-dispatches the same item)', () => {
		setupSession('s14', 't1');
		seedSnapshot('s14', 't1');
		scheduleRetryForError('s14', 't1', overload());
		retryNow('s14', 't1'); // → in-flight, dispatches item-1

		// The resend itself calls noteDispatch for the same item; must not clear.
		noteDispatch(
			's14',
			{ id: 'item-1', timestamp: 1, tabId: 't1', type: 'message', text: 'hi' },
			deps
		);
		expect(getRetryEntry('s14', 't1')?.status).toBe('in-flight');
	});

	// Superseding drops the entry, which also kills the timer. If the outage
	// record stayed 'active' the transcript card would tick "Failing for" upward
	// forever on a retry that is never coming, show "Next attempt: now…", and its
	// Stop button would be inert (cancelRetry early-returns without an entry).
	it('freezes the outage card when a fresh dispatch supersedes the retry', () => {
		setupSession('s15', 't1');
		seedSnapshot('s15', 't1');
		scheduleRetryForError('s15', 't1', quota());
		const outageId = getRetryEntry('s15', 't1')!.outageId;
		expect(getOutage(outageId)?.status).toBe('active');

		noteDispatch(
			's15',
			{ id: 'item-2', timestamp: 2, tabId: 't1', type: 'message', text: 'different' },
			deps
		);

		expect(getOutage(outageId)?.status).toBe('stopped');
		expect(getOutage(outageId)?.resolvedAt).toBe(NOW);
	});
});

// The green "Connection recovered" card and the red error banner were both on
// screen at once: the error listener deliberately keeps `tab.agentError` set
// during a retry so Stop can surface it, and nothing cleared it on success.
describe('clearing the error banner on recovery', () => {
	/** Put an error on the tab the way the agent-error listener does. */
	function setTabError(id: string, tabId: string, message: string) {
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s: any) =>
				s.id !== id
					? s
					: {
							...s,
							aiTabs: s.aiTabs.map((t: any) =>
								t.id === tabId ? { ...t, agentError: err({ message }) } : t
							),
						}
			),
		} as any);
	}

	const tabError = (id: string, tabId: string) =>
		useSessionStore
			.getState()
			.sessions.find((s: any) => s.id === id)
			?.aiTabs.find((t: any) => t.id === tabId)?.agentError;

	it('clears the tab error when the resend settles', () => {
		setupSession('s17', 't1');
		seedSnapshot('s17', 't1');
		scheduleRetryForError('s17', 't1', quota());
		setTabError('s17', 't1', quota().message);
		retryNow('s17', 't1');

		clearRetryIfSettled('s17', 't1');

		expect(getRetryEntry('s17', 't1')).toBeUndefined();
		expect(tabError('s17', 't1')).toBeUndefined();
	});

	it('keeps a DIFFERENT error that arrived on the resend', () => {
		setupSession('s18', 't1');
		seedSnapshot('s18', 't1');
		scheduleRetryForError('s18', 't1', quota());
		retryNow('s18', 't1');
		// agent-error fires before process-exit, so a non-retryable failure on the
		// resend is already on the tab when the exit lands. It must survive.
		setTabError('s18', 't1', 'Permission denied');

		clearRetryIfSettled('s18', 't1');

		expect(tabError('s18', 't1')?.message).toBe('Permission denied');
	});

	it('leaves the tab alone when a retry is still scheduled', () => {
		setupSession('s19', 't1');
		seedSnapshot('s19', 't1');
		scheduleRetryForError('s19', 't1', quota());
		setTabError('s19', 't1', quota().message);

		// Still counting down - not settled, so nothing is cleared.
		clearRetryIfSettled('s19', 't1');

		expect(getRetryEntry('s19', 't1')?.status).toBe('scheduled');
		expect(tabError('s19', 't1')).toBeDefined();
	});
});

// Every outage resolution - recovered, stopped, or superseded - must persist
// exactly one resilience_events row for the Usage Dashboard. The funnel is
// resolveOutage, so all three paths are asserted through the public API.
describe('resilience event recording', () => {
	const recordMock = () =>
		(window as any).maestro.stats.recordResilience as ReturnType<typeof vi.fn>;

	beforeEach(() => recordMock().mockClear());

	it('records a recovered outage when the resend settles', () => {
		setupSession('s20', 't1');
		seedSnapshot('s20', 't1');
		scheduleRetryForError('s20', 't1', quota());
		const outageId = getRetryEntry('s20', 't1')!.outageId;
		retryNow('s20', 't1');
		expect(recordMock()).not.toHaveBeenCalled(); // never while live

		clearRetryIfSettled('s20', 't1');

		expect(recordMock()).toHaveBeenCalledTimes(1);
		expect(recordMock()).toHaveBeenCalledWith(
			expect.objectContaining({
				id: outageId,
				sessionId: 's20',
				strategy: 'token-exhaustion',
				outcome: 'recovered',
				retries: 1,
			})
		);
	});

	it('records a stopped outage when the user cancels', () => {
		setupSession('s21', 't1');
		seedSnapshot('s21', 't1');
		scheduleRetryForError('s21', 't1', overload());

		cancelRetry('s21', 't1');

		expect(recordMock()).toHaveBeenCalledTimes(1);
		expect(recordMock()).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'stopped', strategy: 'availability', retries: 0 })
		);
	});

	it('records a stopped outage when a new prompt supersedes the retry', () => {
		setupSession('s22', 't1');
		seedSnapshot('s22', 't1');
		scheduleRetryForError('s22', 't1', quota());

		noteDispatch(
			's22',
			{ id: 'item-2', timestamp: 2, tabId: 't1', type: 'message', text: 'moved on' },
			deps
		);

		expect(recordMock()).toHaveBeenCalledTimes(1);
		expect(recordMock()).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'stopped' }));
	});

	it('does not record on a reschedule (outage continues)', () => {
		setupSession('s23', 't1');
		seedSnapshot('s23', 't1');
		scheduleRetryForError('s23', 't1', overload());
		scheduleRetryForError('s23', 't1', overload()); // resend failed again

		expect(recordMock()).not.toHaveBeenCalled();
	});
});

describe('hasPendingRetry', () => {
	it('is true for the whole outage, including an in-flight resend', () => {
		setupSession('s16', 't1');
		seedSnapshot('s16', 't1');
		expect(hasPendingRetry('s16', 't1')).toBe(false);

		scheduleRetryForError('s16', 't1', quota());
		expect(hasPendingRetry('s16', 't1')).toBe(true);

		// An in-flight resend holds the queue too. It used to be excluded because
		// a live resend leaves the tab busy and a busy tab blocks the queue on its
		// own - which stops being true the moment the dispatch throws instead of
		// spawning: the tab and session go idle with the outage unresolved, and
		// everything queued behind the failed turn drains into the same wall.
		retryNow('s16', 't1');
		expect(getRetryEntry('s16', 't1')?.status).toBe('in-flight');
		expect(hasPendingRetry('s16', 't1')).toBe(true);

		// The hold ends when the outage does, not before.
		clearRetryIfSettled('s16', 't1');
		expect(hasPendingRetry('s16', 't1')).toBe(false);
	});

	it('is false for a tab with no retry at all', () => {
		expect(hasPendingRetry('nope', 'nope')).toBe(false);
	});
});

describe('batch-resume mode', () => {
	it('schedules without a snapshot and resumes the batch instead of resending', () => {
		const resumer = vi.fn();
		registerBatchResumer(resumer);
		setupSession('s15', 't1');
		// No snapshot - batch resume does not need one.

		expect(scheduleRetryForError('s15', 't1', overload(), { batch: true })).toBe(true);
		expect(getRetryEntry('s15', 't1')?.mode).toBe('batch-resume');

		vi.advanceTimersByTime(availabilityDelayMs(0));
		expect(resumer).toHaveBeenCalledWith('s15');
		expect(processQueuedItem).not.toHaveBeenCalled();
	});

	it('returns false when batch mode is requested but no resumer is registered', () => {
		setupSession('s16', 't1');
		expect(scheduleRetryForError('s16', 't1', overload(), { batch: true })).toBe(false);
	});
});

describe('outage records (transcript status card)', () => {
	it('scheduling creates an active outage keyed to the retry entry', () => {
		setupSession('o1', 't1');
		seedSnapshot('o1', 't1');
		scheduleRetryForError('o1', 't1', overload());

		const entry = getRetryEntry('o1', 't1');
		expect(entry?.outageId).toBeTruthy();
		const outage = getOutage(entry!.outageId);
		expect(outage).toMatchObject({
			sessionId: 'o1',
			tabId: 't1',
			strategy: 'availability',
			status: 'active',
			attempts: 0,
			startedAt: NOW,
		});
		expect(sessionHasActiveOutage('o1')).toBe(true);
	});

	// The outage card is the surface that has to explain WHICH limit was hit, so
	// the structured quota payload has to reach the record. See issue #1472.
	it('carries the provider quota detail onto the outage record', () => {
		setupSession('oq', 't1');
		seedSnapshot('oq', 't1');
		scheduleRetryForError(
			'oq',
			't1',
			err({
				message: "You've hit your session limit · resets 11:40am (America/Chicago)",
				parsedJson: {
					quotaLimits: {
						status: 'rejected',
						resetsAt: 1787416800,
						rateLimitType: 'five_hour',
						overageStatus: 'rejected',
						overageDisabledReason: 'out_of_credits',
					},
				},
			})
		);

		const outage = getOutage(getRetryEntry('oq', 't1')!.outageId)!;
		expect(outage.quota).toMatchObject({
			window: 'five_hour',
			status: 'rejected',
			overageDisabledReason: 'out_of_credits',
		});
	});

	it('leaves quota undefined when the provider sent no quota payload', () => {
		setupSession('oq2', 't1');
		seedSnapshot('oq2', 't1');
		scheduleRetryForError('oq2', 't1', quota());

		expect(getOutage(getRetryEntry('oq2', 't1')!.outageId)!.quota).toBeUndefined();
	});

	// A long outage can cross out of the 5-hour window and into the weekly one; a
	// card still naming the first sends the user to wait out a reset that already
	// happened.
	it('re-reads the quota detail on a reschedule instead of freezing the first one', () => {
		setupSession('oq3', 't1');
		seedSnapshot('oq3', 't1');
		const withWindow = (rateLimitType: string) =>
			err({
				message: "You've hit your session limit",
				parsedJson: { quotaLimits: { rateLimitType, status: 'rejected' } },
			});

		scheduleRetryForError('oq3', 't1', withWindow('five_hour'));
		const outageId = getRetryEntry('oq3', 't1')!.outageId;
		expect(getOutage(outageId)!.quota?.window).toBe('five_hour');

		vi.setSystemTime(NOW + 60_000);
		scheduleRetryForError('oq3', 't1', withWindow('seven_day'));
		expect(getOutage(outageId)!.quota?.window).toBe('seven_day');
	});

	it('preserves outageId and startedAt across backoff continuations, bumping attempts', () => {
		setupSession('o2', 't1');
		seedSnapshot('o2', 't1');
		scheduleRetryForError('o2', 't1', overload());
		const first = getRetryEntry('o2', 't1')!.outageId;

		// Advance time, then a failed resend re-schedules for the same key.
		vi.setSystemTime(NOW + 60_000);
		scheduleRetryForError('o2', 't1', overload());

		const entry = getRetryEntry('o2', 't1')!;
		expect(entry.outageId).toBe(first); // same outage
		expect(entry.startedAt).toBe(NOW); // first-failure time preserved
		const outage = getOutage(first)!;
		expect(outage.attempts).toBe(1);
		expect(outage.startedAt).toBe(NOW);
		expect(outage.status).toBe('active');
	});

	it('clearRetryIfSettled marks the outage recovered with a resolve time', () => {
		setupSession('o3', 't1');
		seedSnapshot('o3', 't1');
		scheduleRetryForError('o3', 't1', overload());
		const outageId = getRetryEntry('o3', 't1')!.outageId;
		retryNow('o3', 't1'); // → in-flight

		vi.setSystemTime(NOW + 5_000);
		clearRetryIfSettled('o3', 't1');

		const outage = getOutage(outageId)!;
		expect(outage.status).toBe('recovered');
		expect(outage.resolvedAt).toBe(NOW + 5_000);
		// Active retry entry is gone, but the outage record persists for the card.
		expect(getRetryEntry('o3', 't1')).toBeUndefined();
		expect(sessionHasActiveOutage('o3')).toBe(false);
	});

	it('cancelRetry marks the outage stopped', () => {
		setupSession('o4', 't1');
		seedSnapshot('o4', 't1');
		scheduleRetryForError('o4', 't1', overload());
		const outageId = getRetryEntry('o4', 't1')!.outageId;

		cancelRetry('o4', 't1');

		const outage = getOutage(outageId)!;
		expect(outage.status).toBe('stopped');
		expect(outage.resolvedAt).toBe(NOW);
		expect(sessionHasActiveOutage('o4')).toBe(false);
	});
});

describe('replayAfterAuth', () => {
	// The user's ask: after re-authenticating once, the work that died on the
	// expired token comes back on its own. `auth_expired` is deliberately
	// non-retryable on a timer (only a human can fix it), so this replay hangs
	// off the human's login instead.
	it('resends the snapshotted turn for each failed tab', () => {
		setupSession('sess-1', 'tab-1');
		seedSnapshot('sess-1', 'tab-1');

		replayAfterAuth('sess-1', ['tab-1']);

		expect(processQueuedItem).toHaveBeenCalledTimes(1);
		expect(processQueuedItem).toHaveBeenCalledWith(
			'sess-1',
			expect.objectContaining({ text: 'hi', tabId: 'tab-1' }),
			deps
		);
	});

	it('replays every failed tab of a multi-tab agent', () => {
		setupSession('sess-1', 'tab-1');
		seedSnapshot('sess-1', 'tab-1');
		noteDispatch(
			'sess-1',
			{ id: 'item-2', timestamp: 2, tabId: 'tab-2', type: 'message', text: 'second' },
			deps
		);

		replayAfterAuth('sess-1', ['tab-1', 'tab-2']);

		expect(processQueuedItem).toHaveBeenCalledTimes(2);
	});

	// Every tab has a snapshot, including ones whose last turn succeeded.
	// Replaying those would put a message the user never asked for on the wire.
	it('replays only the tabs it was given', () => {
		setupSession('sess-1', 'tab-1');
		seedSnapshot('sess-1', 'tab-1');
		noteDispatch(
			'sess-1',
			{ id: 'item-2', timestamp: 2, tabId: 'tab-healthy', type: 'message', text: 'fine' },
			deps
		);

		replayAfterAuth('sess-1', ['tab-1']);

		expect(processQueuedItem).toHaveBeenCalledTimes(1);
		expect(processQueuedItem).not.toHaveBeenCalledWith(
			'sess-1',
			expect.objectContaining({ tabId: 'tab-healthy' }),
			expect.anything()
		);
	});

	// Snapshots are in memory only, so an app restart between the failure and
	// the login leaves nothing to replay. (Distinct ids because the snapshot map
	// is module-scoped and outlives the store resets in beforeEach.)
	it('does nothing for a tab with no snapshot', () => {
		setupSession('sess-fresh', 'tab-fresh');

		expect(() => replayAfterAuth('sess-fresh', ['tab-fresh'])).not.toThrow();
		expect(processQueuedItem).not.toHaveBeenCalled();
	});

	it('replays the remaining tabs when one has no snapshot', () => {
		setupSession('sess-1', 'tab-1');
		seedSnapshot('sess-1', 'tab-1');

		replayAfterAuth('sess-1', ['tab-never-dispatched', 'tab-1']);

		expect(processQueuedItem).toHaveBeenCalledTimes(1);
	});

	it('supersedes a pending auto-retry on the same tab', () => {
		setupSession('sess-1', 'tab-1');
		seedSnapshot('sess-1', 'tab-1');
		scheduleRetryForError('sess-1', 'tab-1', overload());
		expect(getRetryEntry('sess-1', 'tab-1')).toBeDefined();

		replayAfterAuth('sess-1', ['tab-1']);

		// We are dispatching that work right now; the timer must not fire it again.
		expect(getRetryEntry('sess-1', 'tab-1')).toBeUndefined();
		vi.runAllTimers();
		expect(processQueuedItem).toHaveBeenCalledTimes(1);
	});

	it('keeps replaying after a dispatch throws', () => {
		setupSession('sess-1', 'tab-1');
		seedSnapshot('sess-1', 'tab-1');
		noteDispatch(
			'sess-1',
			{ id: 'item-2', timestamp: 2, tabId: 'tab-2', type: 'message', text: 'second' },
			deps
		);
		processQueuedItem.mockRejectedValueOnce(new Error('spawn failed'));

		expect(() => replayAfterAuth('sess-1', ['tab-1', 'tab-2'])).not.toThrow();
		expect(processQueuedItem).toHaveBeenCalledTimes(2);
	});
});

/**
 * The queue is the record of what is still owed.
 *
 * A deep queue that hits a quota wall must finish the turn that failed BEFORE
 * anything behind it runs, and must still be owed that turn after a quit. Both
 * properties come from the failed prompt physically sitting at the head of
 * `executionQueue` while the outage lasts, rather than only in the in-memory
 * snapshot map.
 */
describe('queue durability across an outage', () => {
	const queuedItem = (id: string, tabId: string, text: string) => ({
		id,
		timestamp: 1,
		tabId,
		type: 'message' as const,
		text,
	});

	function sessionQueue(): string[] {
		return (useSessionStore.getState().sessions[0].executionQueue ?? []).map((i: any) => i.id);
	}

	it('puts the failed turn back at the head of its tab queue', () => {
		setupSession('q1', 't1', {
			executionQueue: [queuedItem('item-2', 't1', '2'), queuedItem('item-3', 't1', '3')],
		});
		seedSnapshot('q1', 't1'); // dispatches 'item-1'

		scheduleRetryForError('q1', 't1', quota());

		// Ahead of everything the user queued behind it, in its original order.
		expect(sessionQueue()).toEqual(['item-1', 'item-2', 'item-3']);
	});

	it('does not reorder another tab work', () => {
		setupSession('q2', 't2', {
			executionQueue: [queuedItem('other-1', 'tOther', 'x'), queuedItem('item-2', 't2', '2')],
		});
		noteDispatch('q2', queuedItem('item-1', 't2', '1'), deps);

		scheduleRetryForError('q2', 't2', quota());

		// Inserted at the head of ITS tab's work, not the head of the queue.
		expect(sessionQueue()).toEqual(['other-1', 'item-1', 'item-2']);
	});

	it('takes the held copy back out when the resend goes', () => {
		setupSession('q3', 't1', { executionQueue: [queuedItem('item-2', 't1', '2')] });
		seedSnapshot('q3', 't1');
		scheduleRetryForError('q3', 't1', quota());
		expect(sessionQueue()).toEqual(['item-1', 'item-2']);

		retryNow('q3', 't1');

		// Exactly one copy exists at a time: the queue slot is released the moment
		// the prompt is handed to the dispatcher, or it would be sent twice.
		expect(processQueuedItem).toHaveBeenCalledTimes(1);
		expect(sessionQueue()).toEqual(['item-2']);
	});

	it('re-queues and reschedules when the resend cannot be dispatched', async () => {
		setupSession('q4', 't1', { executionQueue: [queuedItem('item-2', 't1', '2')] });
		seedSnapshot('q4', 't1');
		scheduleRetryForError('q4', 't1', quota());
		processQueuedItem.mockRejectedValueOnce(new Error('Agent process already running'));

		retryNow('q4', 't1');
		await vi.waitFor(() => expect(getRetryEntry('q4', 't1')?.status).toBe('scheduled'));

		// The prompt is back in line and the entry is back on a timer. Leaving it
		// in-flight would strand the turn and, because the queue holds while an
		// entry exists, everything behind it too.
		expect(sessionQueue()).toEqual(['item-1', 'item-2']);
		expect(hasPendingRetry('q4', 't1')).toBe(true);
	});

	it('holds the queue for the whole outage and releases it on recovery', () => {
		setupSession('q5', 't1', { executionQueue: [queuedItem('item-2', 't1', '2')] });
		seedSnapshot('q5', 't1');

		scheduleRetryForError('q5', 't1', quota());
		expect(hasPendingRetry('q5', 't1')).toBe(true);

		retryNow('q5', 't1');
		expect(hasPendingRetry('q5', 't1')).toBe(true); // in-flight still holds

		clearRetryIfSettled('q5', 't1');
		expect(hasPendingRetry('q5', 't1')).toBe(false); // recovered: queue drains
	});

	it('keeps the queue held after the user stops the retry', () => {
		setupSession('q6', 't1', {
			executionQueue: [queuedItem('item-2', 't1', '2')],
			aiTabs: [createMockAITab({ id: 't1', agentError: quota() })],
		});
		seedSnapshot('q6', 't1');
		scheduleRetryForError('q6', 't1', quota());

		cancelRetry('q6', 't1');

		// Stopping hands the failure to the user; their prompt keeps its slot and
		// the session enters the blocking error state, which every dispatch path
		// already refuses to run in. Without that, removing the entry would
		// release the hold and drain the whole queue into the wall they just
		// stopped retrying against.
		const session = useSessionStore.getState().sessions[0];
		expect(session.state).toBe('error');
		expect(session.agentErrorTabId).toBe('t1');
		expect(sessionQueue()).toEqual(['item-1', 'item-2']);
	});
});

/**
 * "I changed the provider - just go."
 *
 * Re-pointing the agent at something that can answer is the user answering the
 * question the countdown is asking, so the retry fires immediately instead of
 * waiting out a reset that no longer applies to it.
 */
describe('provider change during an outage', () => {
	it('fires the waiting retry when the model changes', () => {
		setupSession('p1', 't1', { customModel: 'opus' });
		seedSnapshot('p1', 't1');
		scheduleRetryForError('p1', 't1', quota());
		expect(processQueuedItem).not.toHaveBeenCalled();

		useSessionStore.setState({
			sessions: [{ ...useSessionStore.getState().sessions[0], customModel: 'sonnet' }],
		} as any);

		expect(processQueuedItem).toHaveBeenCalledTimes(1);
	});

	it('fires when the Claude token source changes', () => {
		setupSession('p2', 't1', { enableMaestroP: true, maestroPMode: 'interactive' });
		seedSnapshot('p2', 't1');
		scheduleRetryForError('p2', 't1', quota());

		useSessionStore.setState({
			sessions: [{ ...useSessionStore.getState().sessions[0], enableMaestroP: false }],
		} as any);

		expect(processQueuedItem).toHaveBeenCalledTimes(1);
	});

	it('ignores changes that do not decide who answers', () => {
		setupSession('p3', 't1', { customModel: 'opus' });
		seedSnapshot('p3', 't1');
		scheduleRetryForError('p3', 't1', quota());

		useSessionStore.setState({
			sessions: [{ ...useSessionStore.getState().sessions[0], name: 'renamed' }],
		} as any);

		expect(processQueuedItem).not.toHaveBeenCalled();
	});

	it('stops watching once the outage is over', () => {
		setupSession('p4', 't1', { customModel: 'opus' });
		seedSnapshot('p4', 't1');
		scheduleRetryForError('p4', 't1', quota());
		cancelRetry('p4', 't1');

		useSessionStore.setState({
			sessions: [{ ...useSessionStore.getState().sessions[0], customModel: 'sonnet' }],
		} as any);

		expect(processQueuedItem).not.toHaveBeenCalled();
	});
});

// ============================================================================
// Token exhaustion spins until the quota comes back
// ============================================================================

describe('token-exhaustion outage - spin, not sleep', () => {
	/** The real Claude notice, with an authoritative reset five hours out. */
	function quotaWithReset(resetInMs: number) {
		return err({
			message: "You've hit your session limit · resets 8pm (America/Chicago)",
			parsedJson: {
				error: 'rate_limit',
				quotaLimits: {
					status: 'rejected',
					resetsAt: Math.floor((NOW + resetInMs) / 1000),
					rateLimitType: 'five_hour',
				},
			},
		} as Partial<AgentError> & { message: string });
	}

	/**
	 * Run the outage forward, refusing every probe, and report how many resends
	 * were actually attempted. Mirrors the live loop: the agent-error listener
	 * reschedules on each failure, which is what advances `attempt`.
	 */
	async function spinRefusing(error: AgentError, forMs: number): Promise<number> {
		const step = 5 * 1000;
		for (let elapsed = 0; elapsed < forMs; elapsed += step) {
			const before = processQueuedItem.mock.calls.length;
			await vi.advanceTimersByTimeAsync(step);
			// Every probe that fired is refused again, exactly as the provider does
			// while the quota is still out.
			for (let i = before; i < processQueuedItem.mock.calls.length; i++) {
				scheduleRetryForError('s1', 't1', error);
			}
		}
		return processQueuedItem.mock.calls.length;
	}

	// The observed failure: a 2h26m outage that "cleared after 0 retries" - one
	// attempt, at the very end, with no idea what was true at any point between.
	it('keeps probing all the way through a multi-hour reset window', async () => {
		setupSession('s1', 't1');
		seedSnapshot('s1', 't1');
		const error = quotaWithReset(5 * 60 * 60 * 1000);

		expect(scheduleRetryForError('s1', 't1', error)).toBe(true);
		const probes = await spinRefusing(error, 60 * 60 * 1000);

		// One a minute after the ramp, for an hour - not one at the end of five.
		expect(probes).toBeGreaterThan(50);
		expect(getRetryEntry('s1', 't1')?.status).toBe('scheduled');
		expect(getOutage(getRetryEntry('s1', 't1')!.outageId)?.status).toBe('active');
	});

	it('recovers the moment the quota returns, without waiting for the reset', async () => {
		setupSession('s1', 't1');
		seedSnapshot('s1', 't1');
		const error = quotaWithReset(5 * 60 * 60 * 1000);
		scheduleRetryForError('s1', 't1', error);

		// The account is topped up (or swapped) ten minutes in. The next probe
		// succeeds, and nothing reschedules it.
		await spinRefusing(error, 10 * 60 * 1000);
		const before = processQueuedItem.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60 * 1000);
		expect(processQueuedItem.mock.calls.length).toBeGreaterThan(before);

		// The successful resend settles on process exit, as the exit listener does.
		clearRetryIfSettled('s1', 't1');
		expect(getRetryEntry('s1', 't1')).toBeUndefined();
		// Well inside the five-hour window the notice advertised.
		expect(Date.now()).toBeLessThan(NOW + 30 * 60 * 1000);
	});

	it('goes on probing when the advertised reset comes and goes', async () => {
		setupSession('s1', 't1');
		seedSnapshot('s1', 't1');
		// The provider said two minutes. It lied, or it meant a different window.
		const error = quotaWithReset(2 * 60 * 1000);
		scheduleRetryForError('s1', 't1', error);

		const probes = await spinRefusing(error, 10 * 60 * 1000);

		// A reset in the past is not a reason to stop asking.
		expect(probes).toBeGreaterThan(8);
		expect(getRetryEntry('s1', 't1')?.status).toBe('scheduled');
	});

	it('never sleeps past a reset it can read', () => {
		setupSession('s1', 't1');
		seedSnapshot('s1', 't1');
		// A reset closer than the poll cadence: the probe lands ON it (plus the
		// standard cushion) rather than a cadence tick after it.
		scheduleRetryForError('s1', 't1', quotaWithReset(5 * 1000));

		expect(getRetryEntry('s1', 't1')?.nextRetryAt).toBe(NOW + 5 * 1000 + RESET_TIME_BUFFER_MS);
	});

	it('probes on the poll cadence when no reset can be read at all', () => {
		setupSession('s1', 't1');
		seedSnapshot('s1', 't1');
		// A bare "Usage limit reached" carries no time. This used to mean a blind
		// one-hour sleep.
		scheduleRetryForError('s1', 't1', quota());

		expect(getRetryEntry('s1', 't1')?.nextRetryAt).toBe(NOW + 15 * 1000);
	});

	it('counts every probe on the outage record', async () => {
		setupSession('s1', 't1');
		seedSnapshot('s1', 't1');
		const error = quotaWithReset(60 * 60 * 1000);
		scheduleRetryForError('s1', 't1', error);
		const outageId = getRetryEntry('s1', 't1')!.outageId;

		await spinRefusing(error, 5 * 60 * 1000);

		// The card reads "cleared after N retries"; N is now the truth rather
		// than the 0 a single sleep always reported.
		expect(getOutage(outageId)!.attempts).toBeGreaterThan(3);
	});
});
