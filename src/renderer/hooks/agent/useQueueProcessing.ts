/**
 * useQueueProcessing — extracted from App.tsx
 *
 * Handles execution queue processing:
 *   - Delegates queued item execution to agentStore
 *   - Maintains processQueuedItemRef for batch exit handler
 *   - Recovers stuck queued items from previous app session on startup
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
import { useAgentStore } from '../../stores/agentStore';
import { markTabRunningQueuedItem, resolveQueuedItemTarget } from '../../utils/tabHelpers';
import {
	hasRunnableQueueItem,
	nextRunnableQueueItem,
	takeNextRunnableQueueItem,
} from '../../utils/executionQueue';
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

// ============================================================================
// Hook implementation
// ============================================================================

export function useQueueProcessing(deps: UseQueueProcessingDeps): UseQueueProcessingReturn {
	const depsRef = useRef(deps);
	depsRef.current = deps;

	// --- Narrow reactive subscriptions (not the full sessions array) ---
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	const idleQueuedSignature = useSessionStore(selectIdleQueuedSignature);

	// --- Refs ---
	const processQueuedItemRef = useRef<
		((sessionId: string, item: QueuedItem) => Promise<void>) | null
	>(null);

	// Process a queued item - delegates to agentStore action.
	// Stable identity: conductor profile + command refs read from depsRef.
	const processQueuedItem = useCallback(async (sessionId: string, item: QueuedItem) => {
		const d = depsRef.current;
		await useAgentStore.getState().processQueuedItem(sessionId, item, {
			conductorProfile: d.conductorProfile,
			customAICommands: d.customAICommandsRef.current ?? [],
			speckitCommands: d.speckitCommandsRef.current ?? [],
			openspecCommands: d.openspecCommandsRef.current ?? [],
			bmadCommands: d.bmadCommandsRef?.current ?? [],
		});
	}, []);

	// Update ref for processQueuedItem so batch exit handler can use it
	processQueuedItemRef.current = processQueuedItem;

	// Dequeue the first item from a session and dispatch it for processing.
	// Shared by startup recovery and runtime queue recovery.
	const dispatchQueuedItem = useCallback(
		(session: { id: string; executionQueue: QueuedItem[] }) => {
			const { setSessions } = useSessionStore.getState();

			// Skip paused items: dispatch the first runnable one. If all items are
			// held, there's nothing to do.
			const firstItem = nextRunnableQueueItem(session.executionQueue);
			if (!firstItem) return;

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

					const updatedAiTabs = s.aiTabs.map((tab) =>
						tab.id === target.tabId ? markTabRunningQueuedItem(tab, firstItem) : tab
					);

					const updatedOrphans =
						target.location === 'orphan' && s.orphanedThinkingTabs
							? s.orphanedThinkingTabs.map((tab) =>
									tab.id === target.tabId ? markTabRunningQueuedItem(tab, firstItem) : tab
								)
							: s.orphanedThinkingTabs;

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

			// Process the item
			processQueuedItem(session.id, firstItem).catch((err) => {
				console.error(`[QueueProcessing] Failed for session ${session.id}:`, err);
				// Reset session busy state and re-queue the failed item so it isn't lost
				useSessionStore.getState().setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== session.id) return s;
						return {
							...s,
							state: 'idle',
							busySource: undefined,
							thinkingStartTime: undefined,
							executionQueue: [firstItem, ...s.executionQueue],
							aiTabs: s.aiTabs.map((tab) =>
								tab.state === 'busy'
									? {
											...tab,
											state: 'idle' as const,
											thinkingStartTime: undefined,
										}
									: tab
							),
						};
					})
				);
			});
		},
		[processQueuedItem]
	);

	// Process any queued items left over from previous session (after app restart)
	// This ensures queued messages aren't stuck forever when app restarts
	const startupRecoveryRan = useRef(false);
	const startupRecoveryComplete = useRef(false);
	useEffect(() => {
		// Only run once after sessions are loaded
		if (!sessionsLoaded || startupRecoveryRan.current) return;
		startupRecoveryRan.current = true;

		const sessions = useSessionStore.getState().sessions;
		const hasStartupItems = sessions.some(
			(s) => s.state === 'idle' && hasRunnableQueueItem(s.executionQueue ?? [])
		);

		if (hasStartupItems) {
			logger.info(
				`[QueueProcessing] Found idle session(s) with leftover queued items from previous session`
			);

			// Delay to ensure all refs and handlers are set up. Re-scan at fire
			// time (do not close over the mount-time list): a session can become
			// idle+runnable during the 500ms window, and the runtime-recovery
			// effect may have already bailed while startupRecoveryComplete was
			// false with a settled signature, so it would never retry. The old
			// full-sessions subscription masked that; the narrow signature does not.
			const startupTimerId = setTimeout(() => {
				const toRecover = useSessionStore
					.getState()
					.sessions.filter(
						(s) => s.state === 'idle' && hasRunnableQueueItem(s.executionQueue ?? [])
					);
				toRecover.forEach((session) => {
					logger.info(
						`[QueueProcessing] Startup recovery for session ${session.id.substring(0, 8)}:`,
						undefined,
						{
							id: nextRunnableQueueItem(session.executionQueue)?.id,
							tabId: nextRunnableQueueItem(session.executionQueue)?.tabId,
							queueLength: session.executionQueue.length,
						}
					);
					dispatchQueuedItem(session);
				});
				startupRecoveryComplete.current = true;
			}, 500);
			return () => clearTimeout(startupTimerId);
		} else {
			// No startup items to process — runtime recovery can start immediately
			startupRecoveryComplete.current = true;
		}
	}, [sessionsLoaded, dispatchQueuedItem]);

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

		const sessions = useSessionStore.getState().sessions;
		for (const session of sessions) {
			if (session.state === 'idle' && hasRunnableQueueItem(session.executionQueue ?? [])) {
				console.log(
					`[QueueProcessing] Runtime recovery — dispatching stuck item for session ${session.id.substring(0, 8)}, queue depth: ${session.executionQueue.length}`
				);
				dispatchQueuedItem(session);
			}
		}
	}, [sessionsLoaded, idleQueuedSignature, dispatchQueuedItem]);

	return {
		processQueuedItem,
		processQueuedItemRef,
	};
}
