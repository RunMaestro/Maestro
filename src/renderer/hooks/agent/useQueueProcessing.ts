/**
 * useQueueProcessing - extracted from App.tsx
 *
 * Handles execution queue processing:
 *   - Delegates queued item execution to agentStore
 *   - Maintains processQueuedItemRef for batch exit handler
 *   - Recovers stuck queued items from previous app session on startup
 *   - Polls a stuck queue back to life (see QUEUE_DRAIN_RECHECK_MS)
 *
 * PERF: Does not subscribe to the full `sessions` array. A compact
 * `idleQueuedSignature` string only changes when an idle session gains or
 * loses a runnable queue item, so MaestroConsoleInner is not re-rendered on
 * log/token/busy streaming updates. Session objects are read via getState()
 * inside effects at event time.
 *
 * Reads from: sessionStore (sessionsLoaded, idle-queue signature), agentStore
 */

import { useEffect, useRef, useCallback } from 'react';
import type {
	SessionState,
	QueuedItem,
	CustomAICommand,
	SpecKitCommand,
	OpenSpecCommand,
	BmadCommand,
	Session,
} from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useAgentStore, type ProcessQueuedItemDeps } from '../../stores/agentStore';
import { markTabRunningQueuedItem, resolveQueuedItemTarget } from '../../utils/tabHelpers';
import {
	hasRunnableQueueItem,
	nextRunnableQueueItem,
	takeNextRunnableQueueItem,
} from '../../utils/executionQueue';
import {
	hasPendingRetry,
	registerDispatchDepsProvider,
	useRetryStore,
} from '../../stores/retryStore';
import { queueIsHeldByRetry } from './internal/helpers/exitDequeue';
import { logger } from '../../utils/logger';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseQueueProcessingDeps {
	/** Conductor profile name for agent config */
	conductorProfile: string;
	/** Ref to current custom AI commands */
	customAICommandsRef: React.RefObject<CustomAICommand[]>;
	/** Ref to current speckit commands */
	speckitCommandsRef: React.RefObject<SpecKitCommand[]>;
	/** Ref to current openspec commands */
	openspecCommandsRef: React.RefObject<OpenSpecCommand[]>;
	/** Ref to current BMAD commands */
	bmadCommandsRef?: React.RefObject<BmadCommand[]>;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseQueueProcessingReturn {
	/** Process a queued item for a session */
	processQueuedItem: (sessionId: string, item: QueuedItem) => Promise<void>;
	/** Ref to the latest processQueuedItem function (for batch exit handler) */
	processQueuedItemRef: React.MutableRefObject<
		((sessionId: string, item: QueuedItem) => Promise<void>) | null
	>;
}

/**
 * How long to wait before looking at an idle-but-still-queued agent again.
 *
 * Every trigger that drains the queue is an EDGE: a process exits, a session
 * flips to idle, a retry clears. Every bail inside `dispatchQueuedItem` is a
 * re-check of live state that changes nothing - so when a pass bails, no edge
 * follows and the queue sits there forever with the agent idle. That is how a
 * user ends up mashing Send (or Recover Session) and watching the queue count
 * climb while nothing runs.
 *
 * So the last word is a poll, not an edge. While any agent is idle holding a
 * runnable item, look again on this interval until it drains or the user
 * removes it. Long enough to be free, short enough that a stall is a blip.
 */
const QUEUE_DRAIN_RECHECK_MS = 4000;

// ============================================================================
// Selectors
// ============================================================================

/**
 * Stable string that changes only when the set of idle sessions with a
 * runnable queue item changes (session id + next runnable item id).
 */
export function selectIdleQueuedSignature(state: { sessions: Session[] }): string {
	return state.sessions
		.filter((sess) => sess.state === 'idle' && hasRunnableQueueItem(sess.executionQueue ?? []))
		.map((sess) => {
			const item = nextRunnableQueueItem(sess.executionQueue ?? []);
			return `${sess.id}:${item?.id ?? ''}`;
		})
		.join('|');
}

/** The deps `processQueuedItem` needs, read from the hook's live refs. */
function buildDispatchDeps(d: UseQueueProcessingDeps): ProcessQueuedItemDeps {
	return {
		conductorProfile: d.conductorProfile,
		customAICommands: d.customAICommandsRef.current ?? [],
		speckitCommands: d.speckitCommandsRef.current ?? [],
		openspecCommands: d.openspecCommandsRef.current ?? [],
		bmadCommands: d.bmadCommandsRef?.current ?? [],
	};
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useQueueProcessing(deps: UseQueueProcessingDeps): UseQueueProcessingReturn {
	const depsRef = useRef(deps);
	depsRef.current = deps;

	// --- Narrow reactive subscriptions (not the full sessions array) ---
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	const idleQueuedSignature = useSessionStore(selectIdleQueuedSignature);
	// Runtime recovery holds the queue while a retry counts down (see
	// dispatchQueuedItem). Subscribing to the retry entries re-runs that effect
	// the moment one clears - cancelled, recovered, or superseded - so a held
	// queue drains then instead of waiting for an unrelated session change.
	const retries = useRetryStore((s) => s.retries);

	// --- Refs ---
	const processQueuedItemRef = useRef<
		((sessionId: string, item: QueuedItem) => Promise<void>) | null
	>(null);

	// Process a queued item - delegates to agentStore action.
	// Stable identity: conductor profile + command refs read from depsRef.
	const processQueuedItem = useCallback(async (sessionId: string, item: QueuedItem) => {
		await useAgentStore
			.getState()
			.processQueuedItem(sessionId, item, buildDispatchDeps(depsRef.current));
	}, []);

	// Agent Resilience replays through processQueuedItem, so a prompt spawned by
	// any OTHER path (the composer's idle send, remote dispatch) needs these same
	// deps on its snapshot. Registering the one builder here keeps every snapshot
	// resolving slash commands exactly as a queued send would.
	useEffect(() => {
		registerDispatchDepsProvider(() => buildDispatchDeps(depsRef.current));
		return () => registerDispatchDepsProvider(null);
	}, []);

	// Update ref for processQueuedItem so batch exit handler can use it
	processQueuedItemRef.current = processQueuedItem;

	// Dequeue the first item from a session and dispatch it for processing.
	// Shared by startup recovery and runtime queue recovery.
	//
	// Returns whether the item was actually taken. Every `return false` below is
	// a bail on live state (a retry hold, a tab that is still mid-turn, a queue
	// another trigger already drained) and none of them mutate anything, so the
	// caller gets no follow-up edge to fire on - it has to schedule its own look
	// back. `drainIdleQueues` does exactly that.
	const dispatchQueuedItem = useCallback(
		(session: { id: string; executionQueue: QueuedItem[] }): boolean => {
			const { setSessions } = useSessionStore.getState();

			// Skip paused items: dispatch the first runnable one. If all items are
			// held, there's nothing to do.
			const firstItem = nextRunnableQueueItem(session.executionQueue);
			if (!firstItem) return false;

			// Agent Resilience owns the queue while a retry counts down. The exit path
			// already holds it (chooseNextQueuedItem returns 'wait'), which leaves the
			// agent idle with items still queued - exactly the shape this recovery
			// effect fires on. Without the same rule here, recovery dispatches ~1s
			// later anyway: the item burns against the wall the provider just put up,
			// AND the dispatch supersedes the pending retry (retryStore.noteDispatch),
			// discarding the prompt that retry was holding. A queue of N items ran the
			// whole agent dry in seconds and left the user re-typing every one of them.
			// Hold instead; the queue drains in order once the retry lands.
			if (queueIsHeldByRetry(session, undefined, (tabId) => hasPendingRetry(session.id, tabId))) {
				return false;
			}

			// Whether the dequeue below actually took the item, and onto which tab.
			// The updater runs exactly once, synchronously, inside the store's `set`
			// (see sessionStore.setSessions), so reading these back after the call is
			// deterministic - and it is the ONLY honest answer to "did we take it?",
			// because every bail below is a data-dependent re-check of live state that
			// the caller's (possibly stale) session snapshot cannot predict.
			let dequeuedOntoTabId: string | null = null;

			// Set session to busy and remove item from queue
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== session.id) return s;
					// Guard: re-check state to prevent double-dispatch from concurrent triggers
					if (s.state !== 'idle') return s;

					const { item: runnable, remaining: remainingQueue } = takeNextRunnableQueueItem(
						s.executionQueue
					);
					if (!runnable) return s;

					// Resolve the item's target tab orphan-aware. A message queued on a
					// tab the user later closed lives in orphanedThinkingTabs - route its
					// busy-state + user log THERE (fire-and-forget background send), never
					// onto whatever tab happens to be active. The user log is appended
					// atomically with the dequeue here; processQueuedItem does not add it.
					const target = resolveQueuedItemTarget(s, firstItem);
					if (!target) return s;

					// A tab runs at most one turn at a time, and the agent process is keyed
					// per tab (`${sessionId}-ai-${tabId}`), so the session-level `state`
					// check above is NOT sufficient: an agent can read idle while this
					// exact tab is still mid-turn. Dispatching there makes main reject the
					// spawn ("Agent process already running for session ...-ai-<tabId>"),
					// and the rejection lands in the catch below - which re-queues into a
					// race it usually loses, so the message is simply gone.
					//
					// Resolved-target lookup rather than `getQueueBusyContext`: that helper
					// keys off `item.tabId` alone, which misses both the active-tab
					// fallback and orphan tabs that `resolveQueuedItemTarget` handles.
					const targetTab =
						s.aiTabs.find((t) => t.id === target.tabId) ??
						s.orphanedThinkingTabs?.find((t) => t.id === target.tabId);
					if (targetTab?.state === 'busy') return s;

					const updatedAiTabs = s.aiTabs.map((tab) =>
						tab.id === target.tabId ? markTabRunningQueuedItem(tab, firstItem, s) : tab
					);

					const updatedOrphans =
						target.location === 'orphan' && s.orphanedThinkingTabs
							? s.orphanedThinkingTabs.map((tab) =>
									tab.id === target.tabId ? markTabRunningQueuedItem(tab, firstItem, s) : tab
								)
							: s.orphanedThinkingTabs;

					dequeuedOntoTabId = target.tabId;
					return {
						...s,
						state: 'busy' as SessionState,
						busySource: 'ai',
						thinkingStartTime: Date.now(),
						currentCycleTokens: 0,
						currentCycleBytes: 0,
						executionQueue: remainingQueue,
						aiTabs: updatedAiTabs,
						...(updatedOrphans !== s.orphanedThinkingTabs && {
							orphanedThinkingTabs: updatedOrphans,
						}),
					};
				})
			);

			// The dequeue bailed on a live re-check (agent busy, tab mid-turn, queue
			// already drained by another trigger). Dispatching anyway would spawn a
			// second turn on a tab that already has one, so the item stays queued and
			// this recovery pass does nothing - the next trigger picks it up.
			const dispatchedOntoTabId: string | null = dequeuedOntoTabId;
			if (!dispatchedOntoTabId) return false;

			// Process the item. Releasing the tab and putting the prompt back is
			// `agentStore.processQueuedItem`'s job - it releases only the tab this
			// dispatch marked busy (the old sweep over every busy tab also cleared
			// tabs running turns of their own, which told this effect the agent was
			// free: it dispatched the next queued item into the same live process,
			// failed the same way, and walked the whole queue into the ground one
			// message per render).
			processQueuedItem(session.id, firstItem).catch((err) => {
				logger.error(
					`[QueueProcessing] Dispatch failed for session ${session.id}, item returned to queue`,
					undefined,
					err
				);
			});
			return true;
		},
		[processQueuedItem]
	);

	// --- Stuck-queue watchdog ---
	//
	// One pass over every agent that is idle while still holding a runnable
	// item, plus a scheduled look back whenever a pass leaves one behind. The
	// look-back is the point: see QUEUE_DRAIN_RECHECK_MS.
	const drainRecheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const drainIdleQueuesRef = useRef<() => void>(() => {});

	// The head item each agent was last reported stuck on, so a queue that is
	// legitimately held (an Agent Resilience countdown, say) is logged once
	// rather than on every poll.
	const loggedStuckHeadRef = useRef<Map<string, string>>(new Map());

	const drainIdleQueues = useCallback(() => {
		let stillStuck = false;

		for (const session of useSessionStore.getState().sessions) {
			if (session.state !== 'idle' || !hasRunnableQueueItem(session.executionQueue ?? [])) continue;
			const head = nextRunnableQueueItem(session.executionQueue);
			if (loggedStuckHeadRef.current.get(session.id) !== head?.id) {
				loggedStuckHeadRef.current.set(session.id, head?.id ?? '');
				logger.info(
					`[QueueProcessing] Draining stuck queue for session ${session.id.substring(0, 8)}`,
					undefined,
					{
						id: head?.id,
						tabId: head?.tabId,
						queueLength: session.executionQueue.length,
					}
				);
			}
			if (!dispatchQueuedItem(session)) stillStuck = true;
		}

		// A bail changes no state, so nothing will call us back. Keep the poll
		// alive until the item runs or the user takes it out of the queue.
		if (stillStuck && !drainRecheckTimerRef.current) {
			drainRecheckTimerRef.current = setTimeout(() => {
				drainRecheckTimerRef.current = null;
				drainIdleQueuesRef.current();
			}, QUEUE_DRAIN_RECHECK_MS);
		}
	}, [dispatchQueuedItem]);

	drainIdleQueuesRef.current = drainIdleQueues;

	useEffect(
		() => () => {
			if (drainRecheckTimerRef.current) clearTimeout(drainRecheckTimerRef.current);
			drainRecheckTimerRef.current = null;
		},
		[]
	);

	// Process any queued items left over from previous session (after app restart)
	// This ensures queued messages aren't stuck forever when app restarts
	const startupRecoveryRan = useRef(false);
	const startupRecoveryComplete = useRef(false);
	useEffect(() => {
		// Only run once after sessions are loaded
		if (!sessionsLoaded || startupRecoveryRan.current) return;
		startupRecoveryRan.current = true;

		// Delay to ensure all refs and handlers are set up, then re-scan at fire
		// time. The scan CANNOT close over the render's `sessions` snapshot and
		// `sessions` CANNOT be a dependency here: an agent streaming output at
		// launch mutates the store many times a second, every one of those re-runs
		// this effect, the cleanup below kills the pending timer, and the guard
		// above returns before a replacement is scheduled. `startupRecoveryComplete`
		// then never flips, which silently disables runtime recovery for the rest of
		// the app's life - queued messages pile up behind an idle agent and only a
		// restart releases them.
		const startupTimerId = setTimeout(() => {
			drainIdleQueuesRef.current();
			startupRecoveryComplete.current = true;
		}, 500);
		return () => clearTimeout(startupTimerId);
	}, [sessionsLoaded]);

	// Runtime queue recovery: process queued items when sessions transition to idle
	// while items remain in the queue. This handles cases where onExit skipped queue
	// processing because the session was in error state (e.g., agent errored then exited,
	// user clears the error → session goes idle but nobody dispatches the queue).
	//
	// This is also the standard-query auto-resume path for a limit pause: the
	// execution queue is preserved and persisted across the pause, so the
	// auto-resume coordinator (Phase 3) only has to clear the paused error and let
	// the session fall back to idle - this effect then re-dispatches the queued
	// item that the limit interrupted. A direct (non-queued) send that hit the
	// limit isn't in the queue, so it's captured separately as
	// `recoveryAction.lastUserPrompt` in useAgentErrorListener for the coordinator
	// to re-fire.
	//
	// Triggered by idleQueuedSignature (not full sessions) so streaming updates
	// do not re-enter this effect or re-render MaestroConsoleInner.
	useEffect(() => {
		if (!sessionsLoaded || !startupRecoveryComplete.current) return;
		drainIdleQueues();
		// Neither `idleQueuedSignature` nor `retries` is read in the body: both are
		// re-run triggers. The signature fires when a session goes idle holding a
		// runnable item, and `retries` fires when a queue held by
		// `dispatchQueuedItem`'s resilience check gets a fresh look because the
		// retry that held it went away - cancelled, recovered, or superseded.
	}, [sessionsLoaded, idleQueuedSignature, retries, drainIdleQueues]);

	return {
		processQueuedItem,
		processQueuedItemRef,
	};
}
