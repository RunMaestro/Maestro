/**
 * collectActiveOperations.ts
 *
 * Single source of truth for "is Maestro busy right now?" across every kind of
 * in-flight work: thinking AI agents, Auto Run batches, running terminal tasks,
 * Maestro Cue runs, and active group chats.
 *
 * Used both by the quit-confirmation check (decide whether to warn) and by the
 * "Quit when idle" watcher (decide when everything has finally gone quiet).
 *
 * Feedback drafts are reported but deliberately NOT counted as an "operation" -
 * a draft never finishes on its own, so it must not block an idle-quit. It's a
 * data-loss warning, surfaced separately.
 */

import { useSessionStore } from '../stores/sessionStore';
import { useBatchStore, selectActiveBatchSessionIds } from '../stores/batchStore';
import { useGroupChatStore } from '../stores/groupChatStore';
import { useFeedbackDraftStore } from '../stores/feedbackDraftStore';

export interface ActiveOperationsSnapshot {
	/** Number of AI agents currently thinking (busySource 'ai', non-terminal). */
	busyAgentCount: number;
	/** Session IDs with an Auto Run batch in progress. */
	activeBatchSessionIds: string[];
	/** Human-readable running terminal tasks, e.g. "rc: npm test". */
	activeTerminalTasks: string[];
	/** Count of in-flight Maestro Cue runs (agent + shell + cli). */
	activeCueRunCount: number;
	/** Count of group chats that aren't idle (moderator thinking or agents working). */
	activeGroupChatCount: number;
	/** True when the Feedback window has an unsent draft. Not an "operation". */
	hasFeedbackDraft: boolean;
	/**
	 * True when at least one real operation is in flight. Excludes feedback
	 * drafts. This is the gate the idle-quit watcher waits to clear.
	 */
	hasActiveOperations: boolean;
}

/**
 * Snapshots every active-operation source. Reads stores synchronously via
 * getState() and queries the main process for terminal/Cue activity. Never
 * throws - IPC failures degrade to "nothing running" for that source.
 */
export async function collectActiveOperations(): Promise<ActiveOperationsSnapshot> {
	const sessions = useSessionStore.getState().sessions;

	// Thinking AI agents (terminal-driven busy state doesn't count here).
	const busyAgents = sessions.filter(
		(s) => s.state === 'busy' && s.busySource === 'ai' && s.toolType !== 'terminal'
	);

	// Auto Run batches in progress (processor may sit between tasks with the
	// agent momentarily idle, so this is tracked independently of busy state).
	const activeBatchSessionIds = selectActiveBatchSessionIds(useBatchStore.getState());

	// Running terminal child processes (long builds, test runs, etc.).
	let activeTerminalTasks: string[] = [];
	try {
		const activeProcesses = await window.maestro.process.getActiveProcesses();
		activeTerminalTasks = activeProcesses
			.filter((p) => p.isTerminal && p.childProcesses && p.childProcesses.length > 0)
			.flatMap((p) => {
				const session = sessions.find((s) => p.sessionId.startsWith(s.id));
				const agentName = session?.name ?? 'Terminal';
				return p.childProcesses!.map((child) => {
					const cmdBasename = child.command.split('/').pop() || child.command;
					return `${agentName}: ${cmdBasename}`;
				});
			});
	} catch {
		// If we can't fetch processes, treat as no terminal tasks.
	}

	// In-flight Maestro Cue runs across all executors.
	let activeCueRunCount = 0;
	try {
		const runs = await window.maestro.cue.getActiveRuns();
		activeCueRunCount = runs.length;
	} catch {
		// Cue may be disabled or the engine not started; treat as none.
	}

	// Active group chats: any room whose state isn't idle. groupChatStates tracks
	// every known room; fall back to the live active-room state if the map is
	// empty but the active chat is busy.
	const gcStore = useGroupChatStore.getState();
	let activeGroupChatCount = 0;
	for (const roomState of gcStore.groupChatStates.values()) {
		if (roomState !== 'idle') {
			activeGroupChatCount++;
		}
	}
	if (activeGroupChatCount === 0 && gcStore.groupChatState !== 'idle') {
		activeGroupChatCount = 1;
	}

	const hasFeedbackDraft = useFeedbackDraftStore.getState().hasDraft;

	const hasActiveOperations =
		busyAgents.length > 0 ||
		activeBatchSessionIds.length > 0 ||
		activeTerminalTasks.length > 0 ||
		activeCueRunCount > 0 ||
		activeGroupChatCount > 0;

	return {
		busyAgentCount: busyAgents.length,
		activeBatchSessionIds,
		activeTerminalTasks,
		activeCueRunCount,
		activeGroupChatCount,
		hasFeedbackDraft,
		hasActiveOperations,
	};
}
