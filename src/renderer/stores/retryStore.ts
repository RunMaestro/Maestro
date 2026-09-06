/**
 * retryStore - Agent Resilience auto-retry engine (renderer).
 *
 * When an agent turn fails with a recoverable upstream error and the agent has
 * resilience enabled, this store schedules an automatic resend of the exact
 * prompt instead of making the user re-type it. Two strategies (see
 * `shared/retryClassification.ts`):
 *   - availability  → exponential backoff 30s→30m, then every 30m.
 *   - token-exhaustion → wait until the parsed reset time, else 1h, then hourly.
 *
 * Design notes:
 *   - Keyed per `${sessionId}:${tabId}` so parallel tabs retry independently.
 *   - The prompt to resend is the exact `QueuedItem` + `ProcessQueuedItemDeps`
 *     snapshotted at dispatch time (see `noteDispatch`) and replayed through
 *     `agentStore.processQueuedItem` - same spawn path, so images and slash
 *     commands survive unchanged, across every provider.
 *   - Entry status is its own state machine: `'scheduled'` (timer pending) →
 *     `'in-flight'` (resend dispatched, awaiting outcome). Because agent-error
 *     events arrive before the process-exit event, a failed resend flips the
 *     entry back to `'scheduled'` before exit fires; so the exit listener
 *     clears an entry only when it is still `'in-flight'` (== clean completion).
 *   - Timers live at module scope (not React state) so re-renders never disturb
 *     a pending retry. Retries do NOT survive an app quit - intentional: a
 *     closed app should not silently burn quota/hours in the background.
 */

import { create } from 'zustand';

import {
	classifyRetryableError,
	availabilityDelayMs,
	tokenExhaustionResetAt,
	type RetryStrategy,
	type ClassifiableError,
} from '../../shared/retryClassification';
import { resilienceEnabled } from '../../shared/agentConstants';
import { failoverArmed, selectNextEndpoint } from '../../shared/providerFailover';
import { switchToNextEndpoint, useFailoverStore } from './failoverStore';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';
import { useSessionStore, selectSessionById, updateSessionWith } from './sessionStore';
import { notifyToast } from './notificationStore';
import { useAgentStore, type ProcessQueuedItemDeps } from './agentStore';
import type { AgentError, QueuedItem } from '../types';

// ============================================================================
// Types
// ============================================================================

export type RetryStatus = 'scheduled' | 'in-flight';

/**
 * How the retry re-runs the failed work:
 *  - `resend` - interactive turn: replay the snapshotted QueuedItem through
 *    `processQueuedItem`.
 *  - `batch-resume` - an Auto Run batch owns the turn: the batch loop is parked
 *    at its error-resolution await, so we resume it (goal-based or spec-driven
 *    alike) via the registered resumer instead of resending a prompt.
 */
export type RetryMode = 'resend' | 'batch-resume';

export interface RetryEntry {
	sessionId: string;
	tabId: string;
	/** `${sessionId}:${tabId}` */
	key: string;
	/** Links this active retry to its persistent `OutageRecord` (transcript card). */
	outageId: string;
	strategy: RetryStrategy;
	mode: RetryMode;
	status: RetryStatus;
	/** 0-indexed count of the NEXT resend (0 = first retry). */
	attempt: number;
	/** Epoch ms of the FIRST failure in this outage (preserved across reschedules). */
	startedAt: number;
	/** Epoch ms when the resend fires (drives the live countdown). */
	nextRetryAt: number;
	/** The failing message, for the countdown UI. */
	lastMessage: string;
	/**
	 * Provider Failover: this retry will first swap the agent onto its next backup
	 * endpoint (see `failoverStore.switchToNextEndpoint`), so it fires after a short
	 * handover delay instead of the strategy's wait. The actual switch happens in
	 * `fireRetry` - deciding here and acting there keeps `scheduleRetryForError`
	 * synchronous for its callers.
	 */
	failingOver?: boolean;
}

/**
 * Handover delay before a failover retry fires. Short by design: the whole point
 * of having a spare tire is not waiting out the primary's reset window. Not zero,
 * so the countdown banner renders and the user gets a beat to cancel before their
 * prompt goes to a different provider.
 */
export const FAILOVER_HANDOVER_DELAY_MS = 3 * 1000;

/** Lifecycle of an outage as shown on its transcript status card. */
export type OutageStatus = 'active' | 'recovered' | 'stopped';

/**
 * Persistent record of a single Agent Resilience outage, powering the collapsed
 * status card in the transcript. Unlike `RetryEntry` (which exists only while a
 * retry is pending and is keyed per tab), an `OutageRecord` is keyed by a stable
 * `outageId` and survives resolution - so the card can show a final "recovered"
 * or "stopped" summary, and multiple historical outages on the same tab each
 * keep their own card. Kept in the reactive store so the card ticks live.
 */
export interface OutageRecord {
	outageId: string;
	sessionId: string;
	tabId: string;
	strategy: RetryStrategy;
	/** Epoch ms of the first failure. */
	startedAt: number;
	/** Number of auto-retries dispatched so far (0 while the first is pending). */
	attempts: number;
	/** Epoch ms the next resend fires (meaningful only while `status==='active'`). */
	nextRetryAt: number;
	status: OutageStatus;
	/** Epoch ms the outage resolved (set when status leaves 'active'). */
	resolvedAt?: number;
	/** Latest failing message, for the card subtitle. */
	lastMessage: string;
}

interface DispatchSnapshot {
	item: QueuedItem;
	deps: ProcessQueuedItemDeps;
}

interface RetryStoreState {
	/** Active retries keyed by `${sessionId}:${tabId}`. */
	retries: Record<string, RetryEntry>;
	/** Persistent per-outage records keyed by `outageId` (drives transcript cards). */
	outages: Record<string, OutageRecord>;
}

interface RetryStoreActions {
	/** Internal setter - callers use the exported functions below. */
	setEntry: (key: string, entry: RetryEntry | null) => void;
	/** Internal upsert/patch for an outage record - callers use exported helpers. */
	patchOutage: (outageId: string, patch: Partial<OutageRecord> | null) => void;
}

export type RetryStore = RetryStoreState & RetryStoreActions;

// ============================================================================
// Store
// ============================================================================

export const useRetryStore = create<RetryStore>()((set) => ({
	retries: {},
	outages: {},
	setEntry: (key, entry) =>
		set((state) => {
			const next = { ...state.retries };
			if (entry) next[key] = entry;
			else delete next[key];
			return { retries: next };
		}),
	patchOutage: (outageId, patch) =>
		set((state) => {
			const next = { ...state.outages };
			if (patch === null) delete next[outageId];
			else next[outageId] = { ...next[outageId], ...patch } as OutageRecord;
			return { outages: next };
		}),
}));

// ============================================================================
// Module-scoped, non-reactive state
// ============================================================================

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const snapshots = new Map<string, DispatchSnapshot>();

/**
 * Dispatch snapshots that must survive an app restart, keyed the same way.
 *
 * Re-authenticating means leaving Maestro - often to a terminal, often quitting
 * on the way back - and the in-memory `snapshots` map dies with the process. So
 * "Resume Agent" found nothing to replay in exactly the flow it exists for.
 *
 * Only auth outages are persisted, and only at the moment one is reported. A
 * write per dispatch would put every prompt in the app on disk to serve a case
 * that almost never fires; a write per auth failure is rare and is precisely
 * when the data is about to be needed.
 *
 * The whole `DispatchSnapshot` is stored, not a reconstruction of it.
 * `ProcessQueuedItemDeps` is plain data (command lists and a profile string) and
 * `QueuedItem` carries the text, images, and settings codified at send time - so
 * the replay puts the EXACT message back on the wire. Rebuilding it from the
 * transcript instead would drop attachments and slash-command expansion and
 * resend something the user never typed, against a provider they just signed
 * back into.
 */
const PERSISTED_SNAPSHOTS_KEY = 'authReplaySnapshots';

/**
 * How long a persisted snapshot stays replayable. Long enough to cover a login
 * that involves a browser, a password manager and a restart; short enough that
 * a prompt abandoned days ago is never silently resent.
 */
const PERSISTED_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

interface PersistedSnapshot extends DispatchSnapshot {
	savedAt: number;
}

/** Mirror of what is on disk, hydrated once on first use. */
let persistedSnapshots: Record<string, PersistedSnapshot> | null = null;

async function loadPersistedSnapshots(): Promise<Record<string, PersistedSnapshot>> {
	if (persistedSnapshots) return persistedSnapshots;
	try {
		const raw = (await window.maestro.settings.get(PERSISTED_SNAPSHOTS_KEY)) as
			| Record<string, PersistedSnapshot>
			| undefined;
		const cutoff = Date.now() - PERSISTED_SNAPSHOT_TTL_MS;
		persistedSnapshots = Object.fromEntries(
			Object.entries(raw ?? {}).filter(([, v]) => (v?.savedAt ?? 0) > cutoff)
		);
	} catch {
		// A settings read failure costs the restart-resume, not the app - and it is
		// deliberately NOT cached. Caching the empty result would turn one transient
		// read failure (settings not ready yet, IPC blip) into a permanently dead
		// restart-resume for the rest of the process, long after the read would
		// have succeeded.
		return {};
	}
	return persistedSnapshots;
}

function writePersistedSnapshots(next: Record<string, PersistedSnapshot>): void {
	persistedSnapshots = next;
	void window.maestro.settings.set(PERSISTED_SNAPSHOTS_KEY, next);
}

/**
 * Persist this tab's dispatch snapshot so it survives a restart during re-auth.
 * Called when an auth outage is reported - see `useAgentErrorListener`.
 */
export async function persistDispatchSnapshotForAuth(
	sessionId: string,
	tabId: string
): Promise<void> {
	const key = keyFor(sessionId, tabId);
	const snapshot = snapshots.get(key);
	if (!snapshot) return;
	const store = await loadPersistedSnapshots();
	writePersistedSnapshots({ ...store, [key]: { ...snapshot, savedAt: Date.now() } });
}

/** Drop a persisted snapshot once it has been replayed or is no longer wanted. */
async function forgetPersistedSnapshot(key: string): Promise<void> {
	const store = await loadPersistedSnapshots();
	if (!(key in store)) return;
	const next = { ...store };
	delete next[key];
	writePersistedSnapshots(next);
}

/**
 * Resumer for Auto Run batches, registered once by App. Resolves the batch's
 * error-resolution promise with 'resume' so the loop re-reads the doc and
 * re-dispatches the current task. Null until registered (e.g. in tests).
 */
let batchResumer: ((sessionId: string) => void) | null = null;

/** Wire the Auto Run resume callback so batch retries can continue the run. */
export function registerBatchResumer(fn: ((sessionId: string) => void) | null): void {
	batchResumer = fn;
}

function keyFor(sessionId: string, tabId: string): string {
	return `${sessionId}:${tabId}`;
}

function clearTimer(key: string): void {
	const timer = timers.get(key);
	if (timer) {
		clearTimeout(timer);
		timers.delete(key);
	}
}

function removeEntry(key: string): void {
	clearTimer(key);
	useRetryStore.getState().setEntry(key, null);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Snapshot the prompt being dispatched so it can be replayed later. Called from
 * `agentStore.processQueuedItem` for every dispatch. If a NEW item (different
 * id) is dispatched for a key that has an active retry, that supersedes the
 * retry (the user moved on) and it is cancelled.
 */
export function noteDispatch(
	sessionId: string,
	item: QueuedItem,
	deps: ProcessQueuedItemDeps
): void {
	const key = keyFor(sessionId, item.tabId);
	snapshots.set(key, { item, deps });

	// A scheduled retry means the timer is still pending; a fresh dispatch for
	// this tab is the user moving on, so cancel it (we don't fight the user).
	// Our own resend flips the entry to 'in-flight' first, so it's left alone.
	const active = useRetryStore.getState().retries[key];
	if (active && active.status === 'scheduled') {
		logger.info('[retry] New dispatch supersedes pending retry', undefined, { key });
		// Resolve the outage BEFORE dropping the entry. `removeEntry` alone only
		// clears the timer, leaving the outage record `active` with a nextRetryAt
		// in the past - the transcript card then ticks "Failing for" upward
		// forever, reads "Next attempt: now…", and its Stop button is inert
		// (cancelRetry early-returns on the missing entry). Superseding is a real
		// end to the outage, so it freezes the card like a user cancel does.
		resolveOutage(active.outageId, 'stopped');
		removeEntry(key);
	}
}

/**
 * Whether this tab has a retry timer still counting down. Distinct from "has an
 * entry": an `'in-flight'` entry is a resend already dispatched and awaiting its
 * outcome, which must NOT block anything.
 *
 * Callers use this to keep a scheduled retry from being trampled - most
 * importantly the exit listener, which would otherwise drain the execution queue
 * into the same provider that just refused the turn.
 */
export function hasPendingRetry(sessionId: string, tabId: string): boolean {
	return useRetryStore.getState().retries[keyFor(sessionId, tabId)]?.status === 'scheduled';
}

/**
 * Whether the given agent+error should be auto-retried, honoring the per-agent
 * resilience toggles. Returns the strategy, or null to fall back to the modal.
 */
function resolveStrategy(sessionId: string, error: ClassifiableError): RetryStrategy | null {
	const strategy = classifyRetryableError(error);
	if (!strategy) return null;

	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!session) return null;

	if (strategy === 'availability' && !resilienceEnabled(session.retryOnAvailabilityErrors)) {
		return null;
	}
	if (strategy === 'token-exhaustion' && !resilienceEnabled(session.retryOnTokenExhaustion)) {
		return null;
	}
	return strategy;
}

/**
 * Whether this agent has an armed failover config with at least one endpoint it
 * hasn't already burned during the current outage. Pure store reads, so it can be
 * called from the synchronous scheduling path.
 */
function canFailover(sessionId: string): boolean {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const config = session?.failoverConfig;
	if (!failoverArmed(config)) return false;
	const state = useFailoverStore.getState().states[sessionId];
	return selectNextEndpoint(config, state) !== null;
}

/**
 * Try to take over an agent error with an automatic retry. Returns `true` if a
 * retry was scheduled (the caller should then suppress the error modal), or
 * `false` if the error is not auto-retryable / resilience is off / we have no
 * prompt snapshot to resend (the caller falls back to normal recovery).
 */
export function scheduleRetryForError(
	sessionId: string,
	tabId: string,
	error: AgentError,
	opts?: { batch?: boolean }
): boolean {
	const strategy = resolveStrategy(sessionId, error);
	if (!strategy) return false;

	const mode: RetryMode = opts?.batch ? 'batch-resume' : 'resend';
	const key = keyFor(sessionId, tabId);

	if (mode === 'resend' && !snapshots.has(key)) {
		// No captured prompt - we can't reliably resend, so let the modal handle it.
		logger.warn('[retry] No prompt snapshot to resend; falling back to modal', undefined, { key });
		return false;
	}
	if (mode === 'batch-resume' && !batchResumer) {
		// No resume hook wired - fall back to the batch's manual error controls.
		logger.warn('[retry] No batch resumer registered; falling back', undefined, { key });
		return false;
	}

	const existing = useRetryStore.getState().retries[key];
	// Continue the existing backoff when a resend failed again; otherwise start
	// at attempt 0. `existing.attempt` was the attempt we just tried, so +1.
	const attempt = existing ? existing.attempt + 1 : 0;

	const now = Date.now();
	// Preserve the outage identity + first-failure time across reschedules so the
	// transcript card counts one continuous outage instead of restarting.
	const outageId = existing?.outageId ?? generateId();
	const startedAt = existing?.startedAt ?? now;

	// Provider Failover: if this agent carries an untried backup endpoint, hand the
	// turn over to it instead of waiting out the primary. This is the whole value of
	// the feature for token-exhaustion, where the strategy wait can be hours. We only
	// DECIDE here (a pure store read); `fireRetry` performs the async switch.
	const failingOver = canFailover(sessionId);
	const nextRetryAt = failingOver
		? now + FAILOVER_HANDOVER_DELAY_MS
		: strategy === 'availability'
			? now + availabilityDelayMs(attempt)
			: tokenExhaustionResetAt(error, now);

	clearTimer(key);
	const entry: RetryEntry = {
		sessionId,
		tabId,
		key,
		outageId,
		strategy,
		mode,
		status: 'scheduled',
		attempt,
		startedAt,
		nextRetryAt,
		lastMessage: error.message,
		failingOver,
	};
	useRetryStore.getState().setEntry(key, entry);

	// Mirror the live state into the persistent outage record the card reads.
	useRetryStore.getState().patchOutage(outageId, {
		outageId,
		sessionId,
		tabId,
		strategy,
		startedAt,
		attempts: attempt,
		nextRetryAt,
		status: 'active',
		resolvedAt: undefined,
		lastMessage: error.message,
	});

	const delay = Math.max(0, nextRetryAt - now);
	logger.info('[retry] Scheduled auto-retry', undefined, {
		key,
		outageId,
		strategy,
		attempt,
		delayMs: delay,
	});
	timers.set(
		key,
		setTimeout(() => {
			timers.delete(key);
			void fireRetry(key);
		}, delay)
	);
	return true;
}

/** Fire a scheduled retry now: mark in-flight and re-run the failed work. */
async function fireRetry(key: string): Promise<void> {
	const entry = useRetryStore.getState().retries[key];
	if (!entry) {
		removeEntry(key);
		return;
	}

	// Flip to in-flight BEFORE dispatching so noteDispatch recognizes our own
	// resend (same item id) and doesn't cancel the entry, and so the exit
	// listener can tell a settled resend from a re-scheduled one.
	useRetryStore.getState().setEntry(key, { ...entry, status: 'in-flight' });

	logger.info('[retry] Re-running failed work', undefined, {
		key,
		mode: entry.mode,
		strategy: entry.strategy,
		attempt: entry.attempt,
		failingOver: entry.failingOver,
	});

	try {
		// Provider Failover: swap the agent onto its next backup endpoint before the
		// resend. Awaited so main holds the new env by the time we spawn. A null
		// result means the config changed under us (endpoint deleted, failover
		// disarmed) - harmless, we just resend on whatever endpoint is live.
		//
		// Contained in its own try: a failed overlay write must degrade to "retry on
		// the current endpoint", never swallow the retry itself. Letting it escape to
		// the outer catch would skip the resend and strand the entry in-flight, which
		// is strictly worse than not failing over.
		if (entry.failingOver) {
			try {
				await switchToNextEndpoint(entry.sessionId);
			} catch (error) {
				logger.error('[retry] Failover switch failed; retrying on current endpoint', undefined, {
					key,
					error,
				});
			}
		}

		if (entry.mode === 'batch-resume') {
			// The batch loop is parked at its error-resolution await; resuming it
			// re-reads the doc and re-dispatches the current task itself. Works for
			// goal-based and spec-driven runs alike.
			if (batchResumer) batchResumer(entry.sessionId);
			else removeEntry(key);
			return;
		}
		const snapshot = snapshots.get(key);
		if (!snapshot) {
			removeEntry(key);
			return;
		}
		await useAgentStore.getState().processQueuedItem(entry.sessionId, snapshot.item, snapshot.deps);
	} catch (error) {
		// A dispatch-time throw is itself a failure; leave the entry in-flight so
		// the incoming agent-error (or a manual action) drives the next step.
		logger.error('[retry] Retry dispatch threw', undefined, error);
	}
}

/** User asked to retry immediately: cancel the timer and fire now. */
export function retryNow(sessionId: string, tabId: string): void {
	const key = keyFor(sessionId, tabId);
	if (!useRetryStore.getState().retries[key]) return;
	clearTimer(key);
	void fireRetry(key);
}

/**
 * Replay the turns an agent lost to expired credentials, after the user has
 * re-authenticated the provider.
 *
 * This is deliberately NOT part of the auto-retry machinery above.
 * `auth_expired` is in `NON_RETRYABLE_TYPES` because a timer can never fix it -
 * only a human logging in can, and retrying on a schedule would loop forever.
 * But once that human HAS logged in, the exact prompts are still sitting in the
 * dispatch snapshots, and making the user find and retype them is the thing
 * this whole feature exists to avoid. So the replay reuses the snapshots on a
 * human-driven trigger instead of a timed one.
 *
 * Each replay goes through `processQueuedItem`, the same path a normal send
 * takes, so images and slash commands survive intact. Anything the user queued
 * behind the failed turn is untouched here: it drains on its own when the
 * replayed turn exits.
 *
 * @param tabIds - Only the tabs that actually failed. A tab whose last turn
 *   succeeded also has a snapshot, and resending it would put a message the
 *   user never asked for back on the wire.
 */
/**
 * The tab's most recent user message, read from the transcript. Used only to
 * TELL the user what is waiting when the in-memory snapshot is gone - never to
 * rebuild a dispatch, which would drop attachments and codified settings.
 */
function lastUserPromptFor(sessionId: string, tabId: string): string | undefined {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const tab = session?.aiTabs?.find((t) => t.id === tabId);
	if (!tab) return undefined;
	return (
		[...tab.logs]
			.reverse()
			.find((l) => l.source === 'user')
			?.text?.trim() || undefined
	);
}

/** Keep a recalled prompt to one readable line inside a toast. */
function truncateForToast(text: string, max = 80): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * Restart path: the in-memory snapshot is gone, so look for the copy written to
 * disk when the outage was reported. Async because it reads settings; the
 * common in-memory case above stays synchronous.
 */
async function replayPersistedSnapshot(
	sessionId: string,
	tabId: string,
	key: string
): Promise<void> {
	const persisted = (await loadPersistedSnapshots())[key];
	if (persisted) {
		// Consume it: a replayed prompt must never be resent twice, and a stale
		// entry outliving its outage is how the wrong message reaches the wire later.
		void forgetPersistedSnapshot(key);
		logger.info('[retry] Replaying a turn from the persisted snapshot', undefined, { key });
		void useAgentStore
			.getState()
			.processQueuedItem(sessionId, persisted.item, persisted.deps)
			.catch((error: unknown) => {
				logger.error('[retry] Replay after re-auth threw', undefined, error);
			});
		return;
	}

	// Neither memory nor disk has it: the outage predates snapshot persistence,
	// the TTL expired, or the turn never went through noteDispatch. Say so rather
	// than logging a line and returning - a silent no-op looks exactly like a
	// resume that worked, and the user walks away believing their prompt is
	// running again.
	//
	// Still NOT reconstructed from the transcript. A log entry has lost the
	// attachments, the slash-command expansion and the settings codified at send
	// time, so rebuilding from it resends something the user never typed. The
	// session_not_found path next door has the same constraint and resolves it
	// the same way: surface the prompt and let the human press send.
	logger.info('[retry] No dispatch snapshot to replay after re-auth', undefined, { key });
	const lastPrompt = lastUserPromptFor(sessionId, tabId);
	notifyToast({
		color: 'yellow',
		title: 'Nothing to resend',
		message: lastPrompt
			? `Your last message is still in the transcript - press send to run it again: "${truncateForToast(lastPrompt)}"`
			: 'The prompt that failed was lost when the app restarted. Send it again to continue.',
		...(lastPrompt ? { sessionId, tabId } : {}),
	});
}

export function replayAfterAuth(sessionId: string, tabIds: string[]): void {
	for (const tabId of tabIds) {
		const key = keyFor(sessionId, tabId);

		// A pending auto-retry for this tab (e.g. an availability blip that landed
		// on the same tab) is superseded: we are dispatching that work right now.
		removeEntry(key);

		// The in-memory snapshot is the common case (the app never restarted) and
		// stays SYNCHRONOUS on purpose: callers dispatch in order, and deferring
		// this to a microtask changes when the turn goes out. Only the restart
		// case - where memory is empty and the copy has to come off disk - is
		// async, and it ends in the same dispatch.
		const snapshot = snapshots.get(key);
		if (!snapshot) {
			void replayPersistedSnapshot(sessionId, tabId, key);
			continue;
		}
		void forgetPersistedSnapshot(key);

		logger.info('[retry] Replaying a turn lost to expired credentials', undefined, { key });
		void useAgentStore
			.getState()
			.processQueuedItem(sessionId, snapshot.item, snapshot.deps)
			.catch((error: unknown) => {
				// A dispatch-time throw surfaces through the normal agent-error path;
				// it must not abort the replay of the remaining tabs.
				logger.error('[retry] Replay after re-auth threw', undefined, error);
			});
	}
}

/**
 * User cancelled the auto-retry. Stops retrying and surfaces the original error
 * through the normal recovery path so they can act on it manually.
 */
export function cancelRetry(sessionId: string, tabId: string): void {
	const key = keyFor(sessionId, tabId);
	const entry = useRetryStore.getState().retries[key];
	if (!entry) return;
	logger.info('[retry] User cancelled auto-retry', undefined, { key });
	resolveOutage(entry.outageId, 'stopped');
	removeEntry(key);
}

/**
 * Stamp an outage record as resolved so its transcript card freezes into a final
 * "recovered" / "stopped" summary. No-op if the record is already gone.
 */
function resolveOutage(outageId: string, status: Exclude<OutageStatus, 'active'>): void {
	const record = useRetryStore.getState().outages[outageId];
	if (!record || record.status !== 'active') return;
	const resolvedAt = Date.now();
	useRetryStore.getState().patchOutage(outageId, { status, resolvedAt });

	// Usage Dashboard: persist the resolved outage (one row per outage, keyed on
	// outageId so a double-resolve upserts instead of double-counting). This is
	// the single funnel every resolution passes through - recovered, stopped,
	// and superseded-by-a-new-prompt alike - and it deliberately fires only when
	// the outage LEAVES 'active', so live countdowns are never recorded and a
	// quit mid-outage records nothing. Fire-and-forget: analytics must never
	// block or fail the resolution itself; optional-chained because unit tests
	// (and headless spawns) run this store without the preload bridge.
	const session = selectSessionById(record.sessionId)(useSessionStore.getState());
	void window.maestro?.stats
		?.recordResilience({
			id: record.outageId,
			sessionId: record.sessionId,
			agentType: session?.toolType ?? 'unknown',
			strategy: record.strategy,
			outcome: status,
			startedAt: record.startedAt,
			resolvedAt,
			// `attempts` counts RESCHEDULES (0 while the first resend is pending), so
			// a recovered outage's successful resend is not in it - add it back. A
			// stopped outage's pending resend never fired, so it stays uncounted.
			retries: record.attempts + (status === 'recovered' ? 1 : 0),
		})
		.catch(() => {});
}

/**
 * Called from the process-exit listener. If the entry is still `'in-flight'` at
 * exit time, no retryable agent-error re-scheduled it, so the resent turn
 * completed (successfully, or with a non-retryable error the modal now owns) -
 * clear it. A rescheduled entry (status back to `'scheduled'`) is left alone.
 */
export function clearRetryIfSettled(sessionId: string, tabId: string): void {
	const key = keyFor(sessionId, tabId);
	const entry = useRetryStore.getState().retries[key];
	if (entry && entry.status === 'in-flight') {
		logger.info('[retry] Resend settled; clearing retry', undefined, { key });
		resolveOutage(entry.outageId, 'recovered');
		removeEntry(key);
		clearTabAgentError(sessionId, tabId, entry.lastMessage);
	}
}

/**
 * Drop the tab's `agentError` after a retry succeeds.
 *
 * The error listener deliberately KEEPS `tab.agentError` set while a retry is
 * counting down, so that pressing Stop still leaves the user with the original
 * failure to act on (see `cancelRetry`). Nothing cleared it on the way back out,
 * so a recovered outage left the red error banner and the tab's ERR badge on
 * screen indefinitely - directly contradicting the green "Connection recovered"
 * card sitting right below them.
 *
 * Only the retryable error is cleared: if the resend came back with a DIFFERENT
 * failure (a non-retryable one the modal now owns), that error is the current
 * truth and must survive.
 */
function clearTabAgentError(sessionId: string, tabId: string, retriedMessage: string): void {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const tab = session?.aiTabs?.find((t) => t.id === tabId);
	if (!tab?.agentError) return;

	// agent-error fires BEFORE process-exit, so if the resend failed with a
	// non-retryable error the tab already carries that NEW error by the time we
	// get here. Clearing it would swallow the failure the user still has to deal
	// with. A repeat of the same retryable error reschedules instead of settling,
	// so a mismatch here means a genuinely different failure - leave it alone.
	if (tab.agentError.message !== retriedMessage) return;

	updateSessionWith(sessionId, (s) => ({
		...s,
		// The blocking session-level error state belongs to the modal path; a
		// recovered outage never entered it, but clear it defensively so a stale
		// banner can't outlive the outage that raised it.
		...(s.state === 'error' ? { state: 'idle' as const, agentError: undefined } : {}),
		aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, agentError: undefined } : t)),
	}));
}

/** Read the active retry for a session+tab (for the countdown UI). */
export function getRetryEntry(sessionId: string, tabId: string): RetryEntry | undefined {
	return useRetryStore.getState().retries[keyFor(sessionId, tabId)];
}

/** Read an outage record by id (for the transcript status card). */
export function getOutage(outageId: string): OutageRecord | undefined {
	return useRetryStore.getState().outages[outageId];
}

/** Whether a session has any active outage across its tabs (for filters/lights). */
export function sessionHasActiveOutage(sessionId: string): boolean {
	const { outages } = useRetryStore.getState();
	for (const id in outages) {
		const o = outages[id];
		if (o.sessionId === sessionId && o.status === 'active') return true;
	}
	return false;
}

/**
 * Collect the agent ids that currently have at least one active outage. Shared
 * by the reactive signature and the non-reactive event-time getter so the two
 * never diverge.
 */
function collectActiveOutageSessionIds(outages: Record<string, OutageRecord>): Set<string> {
	const ids = new Set<string>();
	for (const id in outages) {
		const o = outages[id];
		if (o.status === 'active') ids.add(o.sessionId);
	}
	return ids;
}

/**
 * Non-reactive: all agent ids with at least one active outage. For event-time
 * reads (e.g. keyboard cycling) that need the set outside React; the reactive
 * `useActiveOutageSessionSignature` covers render-time subscribers.
 */
export function getActiveOutageSessionIds(): Set<string> {
	return collectActiveOutageSessionIds(useRetryStore.getState().outages);
}

/** Reactive: whether a specific agent currently has an active outage (Left Bar light). */
export function useSessionHasActiveOutage(sessionId: string): boolean {
	return useRetryStore((s) => {
		for (const id in s.outages) {
			const o = s.outages[id];
			if (o.sessionId === sessionId && o.status === 'active') return true;
		}
		return false;
	});
}

/** Reactive: whether a specific tab currently has an active outage (tab light). */
export function useTabHasActiveOutage(sessionId: string, tabId: string): boolean {
	return useRetryStore((s) => {
		for (const id in s.outages) {
			const o = s.outages[id];
			if (o.sessionId === sessionId && o.tabId === tabId && o.status === 'active') return true;
		}
		return false;
	});
}

/**
 * Reactive: a stable, comma-joined signature of all agent ids that currently
 * have an active outage. Primitive return → referential stability, so the Left
 * Bar filter memo only recomputes when the set of stuck agents actually changes.
 */
export function useActiveOutageSessionSignature(): string {
	return useRetryStore((s) =>
		Array.from(collectActiveOutageSessionIds(s.outages)).sort().join(',')
	);
}

/**
 * Reactive: comma-joined signature of the TAB ids that currently have an active
 * outage within a given agent. Drives the tab-level unread filter (stuck tabs
 * surface alongside unread ones). Primitive return for referential stability.
 */
export function useStuckTabSignature(sessionId: string): string {
	return useRetryStore((s) => {
		const ids: string[] = [];
		for (const id in s.outages) {
			const o = s.outages[id];
			if (o.sessionId === sessionId && o.status === 'active') ids.push(o.tabId);
		}
		return ids.sort().join(',');
	});
}
