/**
 * useQueueProcessing - extracted from App.tsx
 *
 * Handles execution queue processing:
 *   - Delegates queued item execution to agentStore
 *   - Maintains processQueuedItemRef for batch exit handler
 *   - Recovers stuck queued items from previous app session on startup
 *
 * Reads from: sessionStore (sessionsLoaded, sessions), agentStore, settingsStore
 */

import { useEffect, useRef, useCallback } from 'react';
import type {
	SessionState,
	QueuedItem,
	CustomAICommand,
	SpecKitCommand,
	OpenSpecCommand,
	BmadCommand,
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
// Hook implementation
// ============================================================================

export function useQueueProcessing(deps: UseQueueProcessingDeps): UseQueueProcessingReturn {
	const {
		conductorProfile,
		customAICommandsRef,
		speckitCommandsRef,
		openspecCommandsRef,
		bmadCommandsRef,
	} = deps;

	// --- Reactive subscriptions ---
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	const sessions = useSessionStore((s) => s.sessions);

	// --- Store actions (stable via getState) ---
	const { setSessions } = useSessionStore.getState();

	// --- Refs ---
	const processQueuedItemRef = useRef<
		((sessionId: string, item: QueuedItem) => Promise<void>) | null
	>(null);
	const skipRuntimeRecoveryOnceRef = useRef<Set<string>>(new Set());

	// Process a queued item - delegates to agentStore action
	const processQueuedItem = useCallback(
		async (sessionId: string, item: QueuedItem) => {
			await useAgentStore.getState().processQueuedItem(sessionId, item, {
				conductorProfile,
				customAICommands: customAICommandsRef.current ?? [],
				speckitCommands: speckitCommandsRef.current ?? [],
				openspecCommands: openspecCommandsRef.current ?? [],
				bmadCommands: bmadCommandsRef?.current ?? [],
			});
		},
		[conductorProfile, bmadCommandsRef]
	);

	// Update ref for processQueuedItem so batch exit handler can use it
	processQueuedItemRef.current = processQueuedItem;

	// Dequeue the first item from a session and dispatch it for processing.
	// Shared by startup recovery and runtime queue recovery.
	const dispatchQueuedItem = useCallback(
		(
			session: { id: string; executionQueue: QueuedItem[] },
			options?: { skipNextRuntimeRecoveryOnFailure?: boolean }
		) => {
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
			return processQueuedItem(session.id, firstItem).catch((err) => {
				console.error(`[QueueProcessing] Failed for session ${session.id}:`, err);
				if (options?.skipNextRuntimeRecoveryOnFailure) {
					skipRuntimeRecoveryOnceRef.current.add(session.id);
				}
				// Reset session busy state and re-queue the failed item so it isn't lost
				setSessions((prev) =>
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
		[processQueuedItem, setSessions]
	);

	// Process any queued items left over from previous session (after app restart)
	// This ensures queued messages aren't stuck forever when app restarts
	const startupRecoveryRan = useRef(false);
	const startupRecoveryComplete = useRef(false);
	useEffect(() => {
		// Only run once after sessions are loaded
		if (!sessionsLoaded || startupRecoveryRan.current) return;
		startupRecoveryRan.current = true;

		const sessionsWithQueuedItems = sessions.filter(
			(s) => s.state === 'idle' && hasRunnableQueueItem(s.executionQueue ?? [])
		);

		if (sessionsWithQueuedItems.length > 0) {
			logger.info(
				`[QueueProcessing] Found ${sessionsWithQueuedItems.length} session(s) with leftover queued items from previous session`
			);

			// Delay to ensure all refs and handlers are set up
			const startupTimerId = setTimeout(() => {
				const startupDispatches = sessionsWithQueuedItems.map((session) => {
					logger.info(
						`[QueueProcessing] Startup recovery for session ${session.id.substring(0, 8)}:`,
						undefined,
						{
							id: nextRunnableQueueItem(session.executionQueue)?.id,
							tabId: nextRunnableQueueItem(session.executionQueue)?.tabId,
							queueLength: session.executionQueue.length,
						}
					);
					return dispatchQueuedItem(session, { skipNextRuntimeRecoveryOnFailure: true });
				});
				Promise.all(startupDispatches).finally(() => {
					startupRecoveryComplete.current = true;
				});
			}, 500);
			return () => clearTimeout(startupTimerId);
		} else {
			// No startup items to process - runtime recovery can start immediately
			startupRecoveryComplete.current = true;
		}
	}, [sessionsLoaded, sessions, dispatchQueuedItem]);

	// Runtime queue recovery: process queued items when sessions transition to idle
	// while items remain in the queue. This handles cases where onExit skipped queue
	// processing because the session was in error state (e.g., agent errored then exited,
	// user clears the error → session goes idle but nobody dispatches the queue).
	useEffect(() => {
		if (!sessionsLoaded || !startupRecoveryComplete.current) return;

		for (const session of sessions) {
			if (session.state === 'idle' && hasRunnableQueueItem(session.executionQueue ?? [])) {
				if (skipRuntimeRecoveryOnceRef.current.delete(session.id)) continue;
				console.log(
					`[QueueProcessing] Runtime recovery - dispatching stuck item for session ${session.id.substring(0, 8)}, queue depth: ${session.executionQueue.length}`
				);
				dispatchQueuedItem(session);
			}
		}
	}, [sessionsLoaded, sessions, dispatchQueuedItem]);

	return {
		processQueuedItem,
		processQueuedItemRef,
	};
}
