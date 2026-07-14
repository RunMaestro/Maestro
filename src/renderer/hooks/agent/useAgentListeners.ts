/**
 * useAgentListeners — coordinator for the 11 IPC process event listeners that
 * route agent lifecycle events (data, exit, error, usage, etc.) into the
 * correct session and tab state.
 *
 * Each listener now lives in its own hook under `./internal/` (one per IPC
 * channel — strict SRP). This file is the orchestration layer:
 *  - Hoists the cross-listener `activeHiddenToolRef` so the three consumers
 *    (`onData`, `onExit`, `onAgentError`) all read/delete from one Map.
 *  - Composes the 11 per-channel hooks in the same registration order as
 *    the original monolithic useEffect — React mounts sibling useEffects in
 *    declaration order, so this preserves any cross-listener event timing
 *    the existing test suite depends on.
 *  - Pure logic for `onExit` (queue dequeue, git refresh, synopsis spawn)
 *    is encoded as named functions in `./internal/helpers/exit*.ts`.
 */

import { useEffect, useRef } from 'react';
import type { ToolProgressState, UseAgentListenersDeps } from './internal/types';
import { useAgentSlashCommandsListener } from './internal/useAgentSlashCommandsListener';
import { useAgentStderrListener } from './internal/useAgentStderrListener';
import { useAgentCommandExitListener } from './internal/useAgentCommandExitListener';
import { useAgentUsageListener } from './internal/useAgentUsageListener';
import { useAgentSessionIdListener } from './internal/useAgentSessionIdListener';
import { useAgentThinkingListener } from './internal/useAgentThinkingListener';
import { useThoughtStreamCaptureListener } from './internal/useThoughtStreamCaptureListener';
import { useAgentSshRemoteListener } from './internal/useAgentSshRemoteListener';
import { useAgentClaudeModeResolvedListener } from './internal/useAgentClaudeModeResolvedListener';
import { useAgentToolExecutionListener } from './internal/useAgentToolExecutionListener';
import { useAgentDataListener } from './internal/useAgentDataListener';
import { useAgentUserInputListener } from './internal/useAgentUserInputListener';
import { useAgentErrorListener } from './internal/useAgentErrorListener';
import { useAgentExitListener } from './internal/useAgentExitListener';
import { useRuntimeFeaturesListener } from './internal/useRuntimeFeaturesListener';

export type { BatchedUpdater, UseAgentListenersDeps } from './internal/types';
export { getErrorTitleForType } from './internal/helpers/errorTitles';
export {
	loadAgentListenersPrompts,
	getAutorunSynopsisPrompt,
} from './internal/helpers/autorunSynopsisPrompt';

// ============================================================================
// Hook
// ============================================================================

/**
 * Registers all IPC process event listeners for agent lifecycle management.
 *
 * Handles: onData, onExit, onSessionId, onSlashCommands, onStderr,
 * onCommandExit, onUsage, onAgentError, onThinkingChunk, onSshRemote,
 * onToolExecution.
 *
 * Call once in App.tsx. Empty dependency array — runs on mount, cleans up on unmount.
 */
export function useAgentListeners(deps: UseAgentListenersDeps): void {
	// Shared ref — written by `onToolExecution`, deleted by `onData` and
	// `onAgentError`. Hoisted to the coordinator so per-channel hooks operate
	// on the same Map. Inner listeners that don't read this ref shouldn't
	// receive it.
	const activeHiddenToolRef = useRef<
		Map<string, { toolName: string; toolState?: ToolProgressState }>
	>(new Map());

	// ----------------------------------------------------------------
	// Per-channel listener hooks
	//
	// Order MUST match the original single-effect registration order so that
	// React mounts the underlying useEffects in the same sequence — this
	// preserves any cross-listener event ordering the existing tests depend on.
	// ----------------------------------------------------------------
	useAgentDataListener({ batchedUpdater: deps.batchedUpdater, activeHiddenToolRef });
	useAgentUserInputListener();
	useAgentExitListener({
		getBatchStateRef: deps.getBatchStateRef,
		processQueuedItemRef: deps.processQueuedItemRef,
		addHistoryEntryRef: deps.addHistoryEntryRef,
		spawnBackgroundSynopsisRef: deps.spawnBackgroundSynopsisRef,
		rightPanelRef: deps.rightPanelRef,
		batchedUpdater: deps.batchedUpdater,
		activeHiddenToolRef,
	});
	useAgentSessionIdListener({ batchedUpdater: deps.batchedUpdater });
	useAgentSlashCommandsListener();
	useAgentStderrListener({ batchedUpdater: deps.batchedUpdater });
	useAgentCommandExitListener();
	useAgentUsageListener({
		batchedUpdater: deps.batchedUpdater,
		contextWarningYellowThreshold: deps.contextWarningYellowThreshold,
	});
	useAgentErrorListener({
		getBatchStateRef: deps.getBatchStateRef,
		pauseBatchOnErrorRef: deps.pauseBatchOnErrorRef,
		addHistoryEntryRef: deps.addHistoryEntryRef,
		activeHiddenToolRef,
	});
	useAgentThinkingListener();
	useThoughtStreamCaptureListener();
	useAgentSshRemoteListener();
	useAgentClaudeModeResolvedListener();
	useAgentToolExecutionListener();
	useRuntimeFeaturesListener();

	// Coordinator-level cleanup: clear the shared ref Map on unmount so any
	// orphan tool entries are released for GC.
	useEffect(() => {
		const activeHiddenTools = activeHiddenToolRef.current;
		return () => {
			activeHiddenTools.clear();
		};
	}, []);
}
