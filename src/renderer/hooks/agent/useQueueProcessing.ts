/**
 * useQueueProcessing — extracted from App.tsx
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
import { getActiveTab } from '../../utils/tabHelpers';
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
		(session: { id: string; executionQueue: QueuedItem[] }) => {
			const firstItem = session.executionQueue[0];

			// Set session to busy and remove item from queue
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== session.id) return s;
					// Guard: re-check state to prevent double-dispatch from concurrent triggers
					if (s.state !== 'idle' || !s.executionQueue?.length) return s;

					const [, ...remainingQueue] = s.executionQueue;
					const targetTab = s.aiTabs.find((tab) => tab.id === firstItem.tabId) || getActiveTab(s);

					const updatedAiTabs = s.aiTabs.map((tab) =>
						tab.id === targetTab?.id
							? {
									...tab,
									state: 'busy' as const,
									thinkingStartTime: Date.now(),
								}
							: tab
					);

					return {
						...s,
						state: 'busy' as SessionState,
						busySource: 'ai',
						thinkingStartTime: Date.now(),
						currentCycleTokens: 0,
						currentCycleBytes: 0,
						executionQueue: remainingQueue,
						aiTabs: updatedAiTabs,
					};
				})
			);

			// Process the item
			processQueuedItem(session.id, firstItem).catch((err) => {
				console.error(`[QueueProcessing] Failed for session ${session.id}:`, err);
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
			(s) => s.state === 'idle' && s.executionQueue && s.executionQueue.length > 0
		);

		if (sessionsWithQueuedItems.length > 0) {
			logger.info(
				`[QueueProcessing] Found ${sessionsWithQueuedItems.length} session(s) with leftover queued items from previous session`
			);

			// Delay to ensure all refs and handlers are set up
			const startupTimerId = setTimeout(() => {
				sessionsWithQueuedItems.forEach((session) => {
					logger.info(
						`[QueueProcessing] Startup recovery for session ${session.id.substring(0, 8)}:`,
						undefined,
						{
							id: session.executionQueue[0].id,
							tabId: session.executionQueue[0].tabId,
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
	}, [sessionsLoaded, sessions, dispatchQueuedItem]);

	// Runtime queue recovery: process queued items when sessions transition to idle
	// while items remain in the queue. This handles cases where onExit skipped queue
	// processing because the session was in error state (e.g., agent errored then exited,
	// user clears the error → session goes idle but nobody dispatches the queue).
	useEffect(() => {
		if (!sessionsLoaded || !startupRecoveryComplete.current) return;

		for (const session of sessions) {
			if (session.state === 'idle' && session.executionQueue?.length > 0) {
				console.log(
					`[QueueProcessing] Runtime recovery — dispatching stuck item for session ${session.id.substring(0, 8)}, queue depth: ${session.executionQueue.length}`
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
