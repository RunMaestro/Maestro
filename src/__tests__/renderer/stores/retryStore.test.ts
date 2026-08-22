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
	getOutage,
	sessionHasActiveOutage,
	registerBatchResumer,
	replayAfterAuth,
	useRetryStore,
	noteAuthBlockedPrompt,
	getBlockedPrompts,
	discardBlockedPrompts,
	resendBlockedPrompts,
} from '../../../renderer/stores/retryStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useAgentStore, type ProcessQueuedItemDeps } from '../../../renderer/stores/agentStore';
import { availabilityDelayMs } from '../../../shared/retryClassification';
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
	useRetryStore.setState({ retries: {}, outages: {}, blocked: {} });
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

describe('auth-blocked prompts (resume after a provider login)', () => {
	/** Put several agents (one AI tab each) into the store at once. */
	function setupSessions(...ids: [string, string][]) {
		useSessionStore.setState({
			sessions: ids.map(([id, tabId]) =>
				createMockSession({
					id,
					name: id,
					aiTabs: [createMockAITab({ id: tabId })],
					activeTabId: tabId,
				})
			),
		} as any);
	}

	/** Dispatch a distinctly-labelled prompt so previews are tellable apart. */
	function dispatch(id: string, tabId: string, itemId: string, text: string) {
		noteDispatch(id, { id: itemId, timestamp: 1, tabId, type: 'message', text }, deps);
	}

	it('parks the prompt an auth failure killed, with a preview of what would be resent', () => {
		setupSessions(['a1', 't1']);
		dispatch('a1', 't1', 'item-a1', 'refactor the parser');

		expect(noteAuthBlockedPrompt('a1', 't1')).toBe(true);

		const [parked] = getBlockedPrompts(['a1']);
		expect(parked).toMatchObject({
			sessionId: 'a1',
			tabId: 't1',
			itemId: 'item-a1',
			failedAt: NOW,
			preview: 'refactor the parser',
		});
	});

	it('parks nothing when the tab has no snapshot to replay', () => {
		setupSessions(['a2', 't1']);
		expect(noteAuthBlockedPrompt('a2', 't1')).toBe(false);
		expect(getBlockedPrompts(['a2'])).toEqual([]);
	});

	it('resends one prompt per blocked agent, in the order they failed', async () => {
		setupSessions(['a3', 't1'], ['a4', 't1'], ['a5', 't1']);
		dispatch('a3', 't1', 'item-a3', 'third to fail');
		dispatch('a4', 't1', 'item-a4', 'first to fail');
		dispatch('a5', 't1', 'item-a5', 'second to fail');

		vi.setSystemTime(NOW + 1_000);
		noteAuthBlockedPrompt('a4', 't1');
		vi.setSystemTime(NOW + 2_000);
		noteAuthBlockedPrompt('a5', 't1');
		vi.setSystemTime(NOW + 3_000);
		noteAuthBlockedPrompt('a3', 't1');

		const resent = await resendBlockedPrompts(['a3', 'a4', 'a5']);

		expect(resent).toEqual(['a4:t1', 'a5:t1', 'a3:t1']);
		expect(processQueuedItem.mock.calls.map((call) => call[0])).toEqual(['a4', 'a5', 'a3']);
		expect(processQueuedItem).toHaveBeenCalledWith(
			'a4',
			expect.objectContaining({ id: 'item-a4' }),
			deps
		);
		// The queue is answered once: a second login must not replay them again.
		expect(getBlockedPrompts(['a3', 'a4', 'a5'])).toEqual([]);
	});

	it('resends nothing for agents on a different credential', async () => {
		setupSessions(['a6', 't1'], ['a7', 't1']);
		dispatch('a6', 't1', 'item-a6', 'mine');
		dispatch('a7', 't1', 'item-a7', 'someone elses');
		noteAuthBlockedPrompt('a6', 't1');
		noteAuthBlockedPrompt('a7', 't1');

		await resendBlockedPrompts(['a6']);

		expect(processQueuedItem).toHaveBeenCalledTimes(1);
		expect(processQueuedItem).toHaveBeenCalledWith('a6', expect.anything(), deps);
		// The other agent's prompt is still parked for ITS login.
		expect(getBlockedPrompts(['a7'])).toHaveLength(1);
	});

	it('fires zero resends when the user declines, and forgets the queue', async () => {
		setupSessions(['a8', 't1']);
		dispatch('a8', 't1', 'item-a8', 'never mind');
		noteAuthBlockedPrompt('a8', 't1');

		discardBlockedPrompts(['a8']);
		expect(getBlockedPrompts(['a8'])).toEqual([]);

		await resendBlockedPrompts(['a8']);
		expect(processQueuedItem).not.toHaveBeenCalled();
	});

	it('drops a prompt already re-sent by other means (a newer dispatch on the tab)', async () => {
		setupSessions(['a9', 't1']);
		dispatch('a9', 't1', 'item-a9', 'original');
		noteAuthBlockedPrompt('a9', 't1');

		// The user typed it again themselves while the login was in progress.
		dispatch('a9', 't1', 'item-a9-again', 'original');

		expect(getBlockedPrompts(['a9'])).toEqual([]);
		await resendBlockedPrompts(['a9']);
		expect(processQueuedItem).not.toHaveBeenCalled();
	});

	it('skips an agent deleted while the user was logging in, without throwing', async () => {
		setupSessions(['a10', 't1'], ['a11', 't1']);
		dispatch('a10', 't1', 'item-a10', 'gone by now');
		dispatch('a11', 't1', 'item-a11', 'still here');
		noteAuthBlockedPrompt('a10', 't1');
		vi.setSystemTime(NOW + 1_000);
		noteAuthBlockedPrompt('a11', 't1');

		// a10 is deleted; its parked prompt has nowhere to land.
		setupSessions(['a11', 't1']);

		const resent = await resendBlockedPrompts(['a10', 'a11']);

		expect(resent).toEqual(['a11:t1']);
		expect(processQueuedItem).toHaveBeenCalledTimes(1);
		expect(processQueuedItem).toHaveBeenCalledWith('a11', expect.anything(), deps);
	});

	it('skips a prompt whose tab is gone even though the agent survives', async () => {
		setupSessions(['a12', 't1']);
		dispatch('a12', 't1', 'item-a12', 'closed tab');
		noteAuthBlockedPrompt('a12', 't1');

		// Same agent, different tab: the failing tab was closed.
		setupSessions(['a12', 't2']);

		expect(getBlockedPrompts(['a12'])).toEqual([]);
		await resendBlockedPrompts(['a12']);
		expect(processQueuedItem).not.toHaveBeenCalled();
	});

	it('keeps going when one resend throws', async () => {
		setupSessions(['a13', 't1'], ['a14', 't1']);
		dispatch('a13', 't1', 'item-a13', 'explodes');
		dispatch('a14', 't1', 'item-a14', 'fine');
		noteAuthBlockedPrompt('a13', 't1');
		vi.setSystemTime(NOW + 1_000);
		noteAuthBlockedPrompt('a14', 't1');

		processQueuedItem.mockImplementation(async (sessionId: string) => {
			if (sessionId === 'a13') throw new Error('spawn failed');
		});

		const resent = await resendBlockedPrompts(['a13', 'a14']);

		expect(resent).toEqual(['a14:t1']);
		expect(processQueuedItem).toHaveBeenCalledTimes(2);
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
