/**
 * retryStore — Agent Resilience auto-retry engine (renderer).
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
 *     `agentStore.processQueuedItem` — same spawn path, so images and slash
 *     commands survive unchanged, across every provider.
 *   - Entry status is its own state machine: `'scheduled'` (timer pending) →
 *     `'in-flight'` (resend dispatched, awaiting outcome). Because agent-error
 *     events arrive before the process-exit event, a failed resend flips the
 *     entry back to `'scheduled'` before exit fires; so the exit listener
 *     clears an entry only when it is still `'in-flight'` (== clean completion).
 *   - Timers live at module scope (not React state) so re-renders never disturb
 *     a pending retry. Retries do NOT survive an app quit — intentional: a
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
import { logger } from '../utils/logger';
import { useSessionStore, selectSessionById } from './sessionStore';
import { useAgentStore, type ProcessQueuedItemDeps } from './agentStore';
import type { AgentError, QueuedItem } from '../types';

// ============================================================================
// Types
// ============================================================================

export type RetryStatus = 'scheduled' | 'in-flight';

/**
 * How the retry re-runs the failed work:
 *  - `resend` — interactive turn: replay the snapshotted QueuedItem through
 *    `processQueuedItem`.
 *  - `batch-resume` — an Auto Run batch owns the turn: the batch loop is parked
 *    at its error-resolution await, so we resume it (goal-based or spec-driven
 *    alike) via the registered resumer instead of resending a prompt.
 */
export type RetryMode = 'resend' | 'batch-resume';

export interface RetryEntry {
	sessionId: string;
	tabId: string;
	/** `${sessionId}:${tabId}` */
	key: string;
	strategy: RetryStrategy;
	mode: RetryMode;
	status: RetryStatus;
	/** 0-indexed count of the NEXT resend (0 = first retry). */
	attempt: number;
	/** Epoch ms when the resend fires (drives the live countdown). */
	nextRetryAt: number;
	/** The failing message, for the countdown UI. */
	lastMessage: string;
}

interface DispatchSnapshot {
	item: QueuedItem;
	deps: ProcessQueuedItemDeps;
}

interface RetryStoreState {
	/** Active retries keyed by `${sessionId}:${tabId}`. */
	retries: Record<string, RetryEntry>;
}

interface RetryStoreActions {
	/** Internal setter — callers use the exported functions below. */
	setEntry: (key: string, entry: RetryEntry | null) => void;
}

export type RetryStore = RetryStoreState & RetryStoreActions;

// ============================================================================
// Store
// ============================================================================

export const useRetryStore = create<RetryStore>()((set) => ({
	retries: {},
	setEntry: (key, entry) =>
		set((state) => {
			const next = { ...state.retries };
			if (entry) next[key] = entry;
			else delete next[key];
			return { retries: next };
		}),
}));

// ============================================================================
// Module-scoped, non-reactive state
// ============================================================================

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const snapshots = new Map<string, DispatchSnapshot>();

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
		removeEntry(key);
	}
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
		// No captured prompt — we can't reliably resend, so let the modal handle it.
		logger.warn('[retry] No prompt snapshot to resend; falling back to modal', undefined, { key });
		return false;
	}
	if (mode === 'batch-resume' && !batchResumer) {
		// No resume hook wired — fall back to the batch's manual error controls.
		logger.warn('[retry] No batch resumer registered; falling back', undefined, { key });
		return false;
	}

	const existing = useRetryStore.getState().retries[key];
	// Continue the existing backoff when a resend failed again; otherwise start
	// at attempt 0. `existing.attempt` was the attempt we just tried, so +1.
	const attempt = existing ? existing.attempt + 1 : 0;

	const now = Date.now();
	const nextRetryAt =
		strategy === 'availability'
			? now + availabilityDelayMs(attempt)
			: tokenExhaustionResetAt(error, now);

	clearTimer(key);
	const entry: RetryEntry = {
		sessionId,
		tabId,
		key,
		strategy,
		mode,
		status: 'scheduled',
		attempt,
		nextRetryAt,
		lastMessage: error.message,
	};
	useRetryStore.getState().setEntry(key, entry);

	const delay = Math.max(0, nextRetryAt - now);
	logger.info('[retry] Scheduled auto-retry', undefined, {
		key,
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
	});

	try {
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
 * User cancelled the auto-retry. Stops retrying and surfaces the original error
 * through the normal recovery path so they can act on it manually.
 */
export function cancelRetry(sessionId: string, tabId: string): void {
	const key = keyFor(sessionId, tabId);
	const entry = useRetryStore.getState().retries[key];
	if (!entry) return;
	logger.info('[retry] User cancelled auto-retry', undefined, { key });
	removeEntry(key);
}

/**
 * Called from the process-exit listener. If the entry is still `'in-flight'` at
 * exit time, no retryable agent-error re-scheduled it, so the resent turn
 * completed (successfully, or with a non-retryable error the modal now owns) —
 * clear it. A rescheduled entry (status back to `'scheduled'`) is left alone.
 */
export function clearRetryIfSettled(sessionId: string, tabId: string): void {
	const key = keyFor(sessionId, tabId);
	const entry = useRetryStore.getState().retries[key];
	if (entry && entry.status === 'in-flight') {
		logger.info('[retry] Resend settled; clearing retry', undefined, { key });
		removeEntry(key);
	}
}

/** Read the active retry for a session+tab (for the countdown UI). */
export function getRetryEntry(sessionId: string, tabId: string): RetryEntry | undefined {
	return useRetryStore.getState().retries[keyFor(sessionId, tabId)];
}
