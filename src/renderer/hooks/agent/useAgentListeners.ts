import { useOwnedSideEffectGate } from './internal/useOwnedSessionGate';
import { subscribeRelayConversations } from '../../services/relayConversations';
/**
 * useAgentListeners - coordinator for the 11 IPC process event listeners that
 * route agent lifecycle events (data, exit, error, usage, etc.) into the
 * correct session and tab state.
 *
 * Each listener now lives in its own hook under `./internal/` (one per IPC
 * channel - strict SRP). This file is the orchestration layer:
 *  - Hoists the cross-listener `activeHiddenToolRef` so the three consumers
 *    (`onData`, `onExit`, `onAgentError`) all read/delete from one Map.
 *  - Composes the 11 per-channel hooks in the same registration order as
 *    the original monolithic useEffect - React mounts sibling useEffects in
 *    declaration order, so this preserves any cross-listener event timing
 *    the existing test suite depends on.
 *  - Pure logic for `onExit` (queue dequeue, git refresh, synopsis spawn)
 *    is encoded as named functions in `./internal/helpers/exit*.ts`.
 */

import { subscribeHeadlessActivity } from '../../stores/headlessActivityStore';
import { useEffect, useRef } from 'react';
import type { ToolProgressState, UseAgentListenersDeps } from './internal/types';
import { useAgentSlashCommandsListener } from './internal/useAgentSlashCommandsListener';
import { useAgentStderrListener } from './internal/useAgentStderrListener';
import { useAgentCommandExitListener } from './internal/useAgentCommandExitListener';
import { useAgentUsageListener } from './internal/useAgentUsageListener';
import { useAgentSessionIdListener } from './internal/useAgentSessionIdListener';
import { useAgentThinkingListener } from './internal/useAgentThinkingListener';
import { useThoughtStreamCaptureListener } from './internal/useThoughtStreamCaptureListener';
import { useThoughtStreamToolListener } from './internal/useThoughtStreamToolListener';
import { useSteeringVerdictListener } from './internal/useSteeringVerdictListener';
import { useAgentSshRemoteListener } from './internal/useAgentSshRemoteListener';
import { useAgentClaudeModeResolvedListener } from './internal/useAgentClaudeModeResolvedListener';
import { useAgentToolExecutionListener } from './internal/useAgentToolExecutionListener';
import { useAgentDataListener } from './internal/useAgentDataListener';
import { useAgentUserInputListener } from './internal/useAgentUserInputListener';
import { useAgentErrorListener } from './internal/useAgentErrorListener';
import { useAgentExitListener } from './internal/useAgentExitListener';
import { registerContextCompactionSpawner } from '../../services/contextCompaction';

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
 * onToolExecution, onSteeringVerdict.
 *
 * Call once in App.tsx. Empty dependency array - runs on mount, cleans up on unmount.
 */
export function useAgentListeners(deps: UseAgentListenersDeps): void {
	// Shared ref - written by `onToolExecution`, deleted by `onData` and
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
	// React mounts the underlying useEffects in the same sequence - this
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
		batchedUpdater: deps.batchedUpdater,
		activeHiddenToolRef,
	});
	useEffect(subscribeHeadlessActivity, []);
	const relayOwner = useOwnedSideEffectGate();
	useEffect(
		() => subscribeRelayConversations((id) => relayOwner.current?.(id) === true),
		[relayOwner]
	);
	useAgentThinkingListener();
	useThoughtStreamCaptureListener();
	useAgentSshRemoteListener();
	useAgentClaudeModeResolvedListener();
	useAgentToolExecutionListener();
	// Second subscriber to the same tool stream. The transcript listener above
	// writes into a tab's logs and so can only serve tab-shaped spawns; this one
	// feeds the Thought Stream's action feed for Auto Run batch spawns too.
	useThoughtStreamToolListener();
	// Chat steering: settles a steer the queue already let go of, re-queueing it
	// when claude never took it.
	useSteeringVerdictListener();

	// Coordinator-level cleanup: clear the shared ref Map on unmount so any
	// orphan tool entries are released for GC.
	useEffect(() => {
		const activeHiddenTools = activeHiddenToolRef.current;
		return () => {
			activeHiddenTools.clear();
		};
	}, []);

	// Automatic context compaction runs its hidden turn through the synopsis
	// spawner. The retry engine that drives it lives outside React, so the
	// spawner is handed across here. Read through the ref at call time: it is
	// populated after this hook runs.
	const spawnBackgroundSynopsisRef = deps.spawnBackgroundSynopsisRef;
	useEffect(() => {
		registerContextCompactionSpawner(async (...args) => {
			const spawn = spawnBackgroundSynopsisRef.current;
			if (!spawn) return { success: false, error: 'Agent execution is not ready.' };
			return spawn(...args);
		});
		return () => registerContextCompactionSpawner(null);
	}, [spawnBackgroundSynopsisRef]);
}
