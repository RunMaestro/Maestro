/**
 * Shared types for `useAgentListeners` and its per-channel sub-hooks.
 *
 * Keep this module dependency-light: it should not import any React or
 * Zustand modules so per-listener hooks can pull just the types they need.
 */

import type { LogEntry, QueuedItem, BatchRunState, AgentError, UsageStats } from '../../../types';
import type { HistoryEntryInput } from '../useAgentSessionManagement';
import type { UseAgentExecutionReturn } from '../useAgentExecution';
import type { RightPanelHandle } from '../../../components/RightPanel';

export type ToolProgressState = NonNullable<LogEntry['metadata']>['toolState'];

/** Batched updater interface (subset used by IPC listeners) */
export interface BatchedUpdater {
	appendLog: (
		sessionId: string,
		tabId: string | null,
		isAi: boolean,
		data: string,
		isStderr?: boolean
	) => void;
	markDelivered: (sessionId: string, tabId: string) => void;
	markUnread: (sessionId: string, tabId: string, unread: boolean) => void;
	updateUsage: (sessionId: string, tabId: string | null, usage: UsageStats) => void;
	updateContextUsage: (sessionId: string, percentage: number) => void;
	updateCycleBytes: (sessionId: string, bytes: number) => void;
	updateCycleTokens: (sessionId: string, tokens: number) => void;
	/** Force an immediate flush of pending batched updates (issue #1022). */
	flushNow: () => void;
}

/** Dependencies passed from App.tsx to the hook */
export interface UseAgentListenersDeps {
	/** Batched updater for high-frequency log/usage updates */
	batchedUpdater: BatchedUpdater;

	// --- Callback refs (populated after hook call, read in useEffect) ---

	/** History entry callback (from useAgentSessionManagement) */
	addHistoryEntryRef: React.RefObject<((entry: HistoryEntryInput) => Promise<void>) | null>;
	/** Background synopsis spawner (from useAgentExecution) */
	spawnBackgroundSynopsisRef: React.RefObject<
		UseAgentExecutionReturn['spawnBackgroundSynopsis'] | null
	>;
	/** Batch state lookup for Auto Run integration */
	getBatchStateRef: React.RefObject<((sessionId: string) => BatchRunState) | null>;
	/** Pause batch on error for Auto Run integration */
	pauseBatchOnErrorRef: React.RefObject<
		((sessionId: string, error: AgentError, docIndex: number, context?: string) => void) | null
	>;
	/** Right panel ref for refreshing history */
	rightPanelRef: React.RefObject<RightPanelHandle | null>;
	/** Process queued item callback */
	processQueuedItemRef: React.RefObject<
		((sessionId: string, item: QueuedItem) => Promise<void>) | null
	>;

	// --- Settings ---

	/** Yellow threshold for context warning (from contextManagementSettings) */
	contextWarningYellowThreshold: number;
}
