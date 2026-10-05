/**
 * The desktop's library-runtime hosting, as the renderer and the bridge see it.
 *
 * Main hosts the maestro-lib runtime only when the `libraryRuntime` setting is on and the runtime
 * started (`src/main/library-runtime/`). The answer is fixed for the run: the setting is read once at
 * startup (DM2), so flipping it needs a restart and the renderer asks main instead of reading the
 * setting to learn which mode it is in.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` sections 4.1, 4.2 and 5.
 */

import type {
	DesktopCloseTabOptions,
	DesktopCreateTabOptions,
	DesktopFoldResult,
} from './maestro-lib/agents/desktop-fold-types';
import type { AgentRecord, TabRefRecord } from './maestro-lib/store/records';
import type {
	AgentCreateInput,
	AgentPatch,
	ClientResult,
	GroupCreateInput,
	GroupPatch,
	MaestroEvent,
} from './maestro-lib/client/types';

/** The preload namespace `window.maestro.libraryRuntime` and its channels. */
export const LIBRARY_RUNTIME_STATUS_CHANNEL = 'libraryRuntime:status';
/** Runtime events main forwards to every window, as `{ event: MaestroEvent }`. */
export const LIBRARY_RUNTIME_EVENT_CHANNEL = 'libraryRuntime:event';

export interface LibraryRuntimeStatus {
	/** Main runs the runtime and owns agent state this run. */
	hosting: boolean;
	/** Why not, when `hosting` is false: the setting is off, or the runtime refused. */
	reason?: string;
}

/** What a renderer reads when main has no answer: OFF, today's code. */
export const LIBRARY_RUNTIME_OFF: LibraryRuntimeStatus = {
	hosting: false,
	reason: 'The libraryRuntime setting is off.',
};

// ---------------------------------------------------------------------------
// Commands, snapshot, fold (Phase 9, task 3)
// ---------------------------------------------------------------------------

/** The renderer reads the stored state once at start and mirrors it from then on (4.3). */
export const LIBRARY_RUNTIME_SNAPSHOT_CHANNEL = 'libraryRuntime:snapshot';
/** One repository command, answered with the result and the stamped events it caused. */
export const LIBRARY_RUNTIME_COMMAND_CHANNEL = 'libraryRuntime:command';
/** The desktop fold: the renderer's desktop-owned state, batched (4.5). */
export const LIBRARY_RUNTIME_FOLD_CHANNEL = 'libraryRuntime:fold';

/** What main adds to a runtime event for a renderer (DG13). */
export interface LibraryRuntimeStamp {
	/** The agent's revision after the change, for an event about one agent. */
	rev?: number;
	/** The groups revision after the change, for `groups.changed`. */
	groupsRev?: number;
	/** The command that caused the event, so its sender can tell its own echo from a peer's change. */
	origin?: { commandId: string };
	/**
	 * The event is the result of a renderer's fold (an adoption, a landed domain edit, a removal), not
	 * of a command. The side effects of a change (4.9) skip these: the site that folded still does its own.
	 */
	fromFold?: true;
}

/** An event as main forwards it to a window. */
export interface LibraryRuntimeEventMessage extends LibraryRuntimeStamp {
	event: MaestroEvent;
}

/**
 * The repository commands a renderer sends. `id` and `tabId` on a create are client-chosen ids (DG10),
 * so the renderer's optimistic record and the runtime's are the same record.
 */
export type LibraryRuntimeCommand =
	| { method: 'agents.create'; input: AgentCreateInput }
	| { method: 'agents.update'; agentId: string; patch: AgentPatch }
	| { method: 'agents.rename'; agentId: string; name: string }
	| { method: 'agents.remove'; agentId: string }
	| { method: 'groups.create'; input: GroupCreateInput }
	| { method: 'groups.rename'; groupId: string; name: string }
	| { method: 'groups.update'; groupId: string; patch: GroupPatch }
	| { method: 'groups.remove'; groupId: string }
	| { method: 'groups.moveAgent'; agentId: string; groupId: string | null }
	| { method: 'tabs.create'; agentId: string; options?: DesktopCreateTabOptions }
	| { method: 'tabs.rename'; agentId: string; tabId: string; name: string }
	| { method: 'tabs.close'; agentId: string; tabId: string; options?: DesktopCloseTabOptions }
	| { method: 'tabs.star'; agentId: string; tabId: string; starred: boolean }
	| { method: 'tabs.reorder'; agentId: string; ref: TabRefRecord; toIndex: number };

export interface LibraryRuntimeCommandRequest {
	/** Chosen by the caller; stamped on every event the command causes. */
	commandId: string;
	command: LibraryRuntimeCommand;
}

export interface LibraryRuntimeCommandAnswer {
	result: ClientResult<unknown>;
	/**
	 * The stamped events the command caused, so a caller can apply the authoritative records without
	 * waiting for the broadcast (the same events arrive on the event channel first, and the mirror skips
	 * a revision it already holds).
	 */
	changes: LibraryRuntimeEventMessage[];
	/**
	 * Set when the command failed and names an agent the runtime holds: that agent as the runtime has it now
	 * (transcripts left out) and its revision. A window that applied the change optimistically snaps to it,
	 * since a refusal raises no event to correct the screen.
	 */
	authoritative?: { agent: AgentRecord; rev: number };
}

export interface LibraryRuntimeFoldAnswer extends DesktopFoldResult {
	ok: boolean;
}
