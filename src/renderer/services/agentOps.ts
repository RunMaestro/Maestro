/**
 * Domain operations on agents and groups for a window whose runtime is hosted (4.3 of the migration plan).
 *
 * Each function is one change a person can make: create, rename, or remove an agent; create, rename,
 * restyle, move, or remove a group. With the `libraryRuntime` setting on, that change is a repository
 * command: main validates it, writes it, and answers with the events it caused, which this window
 * applies to its store (`runtimeMirror.ts`). Nothing here edits the store directly, and nothing here
 * runs with the setting off: a caller checks `isLibraryRuntimeHosting()` and keeps its own path when
 * the answer is no, so the flag decision is one call at each entry point and the OFF code is untouched.
 *
 * These are the modal-style flows: they wait for the answer, as they already waited on validation and
 * git probes. A failure raises the runtime's own message as a toast and changes nothing on screen.
 *
 * The tab operations at the end are the other kind (DM11): keyboard-driven, so the CALLER applies the change
 * to its store first with the renderer's own helper and these send the matching command. The keystroke after
 * Cmd+T therefore reaches the new tab, not the old one. The runtime's answer then snaps the domain keys to
 * its own result, which the parity tests keep equal to the local one, and a refusal puts the agent back to
 * what the runtime holds.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` sections 4.3 and 7 (task 3).
 */

import type {
	AgentCreateInput,
	AgentPatch,
	AgentUpdateReceipt,
	ClientResult,
	GroupCreateInput,
	GroupPatch,
} from '../../shared/maestro-lib/client/types';
import type { DesktopCloseTabOptions } from '../../shared/maestro-lib/agents/desktop-fold-types';
import type { TabRefRecord } from '../../shared/maestro-lib/store/records';
import type { LibraryRuntimeCommand } from '../../shared/libraryRuntime';
import { notifyToast } from '../stores/notificationStore';
import type { Session } from '../types';
import { sendRuntimeCommand } from './runtimeMirror';

export type AgentOpResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

function failureMessage(result: ClientResult<unknown>): string {
	return result.ok ? '' : result.error.message;
}

/** Send a command, toast the runtime's message when it refuses, and say what happened. */
async function run<T>(
	command: LibraryRuntimeCommand,
	options: {
		agentIds?: readonly string[];
		creating?: Session;
		title: string;
		quiet?: boolean;
		/** The change is already true when the thing it names is gone (closing a tab that is not there). */
		missingIsDone?: boolean;
	}
): Promise<AgentOpResult<T>> {
	try {
		const answer = await sendRuntimeCommand(command, {
			...(options.agentIds ? { agentIds: options.agentIds } : {}),
			...(options.creating ? { creating: options.creating } : {}),
		});
		if (answer.result.ok) return { ok: true, value: answer.result.value as T };
		if (options.missingIsDone && answer.result.error.code === 'not-found') {
			return { ok: true, value: undefined as T };
		}
		const message = failureMessage(answer.result);
		if (!options.quiet) notifyToast({ type: 'error', title: options.title, message });
		return { ok: false, message };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!options.quiet) notifyToast({ type: 'error', title: options.title, message });
		return { ok: false, message };
	}
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * Create an agent. `local` is the agent as this window will hold it, with the id the command carries
 * (a client-chosen id, DG10): it becomes the window's copy when the runtime accepts, with the runtime's
 * domain keys taken onto it, so nothing the runtime does not model (the file tree, the shell log) is lost.
 */
export function createAgent(
	input: AgentCreateInput & { id: string },
	local: Session
): Promise<AgentOpResult<{ agentId: string }>> {
	return run(
		{ method: 'agents.create', input },
		{
			agentIds: [input.id],
			creating: local,
			title: 'Agent Creation Failed',
		}
	);
}

export function renameAgent(agentId: string, name: string): Promise<AgentOpResult> {
	return run(
		{ method: 'agents.rename', agentId, name },
		{ agentIds: [agentId], title: 'Rename Failed' }
	);
}

/**
 * Remove an agent. The runtime stops every process the agent runs (its tabs, the legacy ids, its
 * terminals), deletes its playbooks and its closed-tab archive, and records the lifecycle row, so the
 * caller does none of that.
 */
export function removeAgent(agentId: string): Promise<AgentOpResult> {
	return run({ method: 'agents.remove', agentId }, { agentIds: [agentId], title: 'Delete Failed' });
}

export function updateAgent(
	agentId: string,
	patch: AgentPatch
): Promise<AgentOpResult<AgentUpdateReceipt>> {
	return run(
		{ method: 'agents.update', agentId, patch },
		{ agentIds: [agentId], title: 'Update Failed' }
	);
}

export function setAgentBookmarked(
	agentId: string,
	bookmarked: boolean
): Promise<AgentOpResult<AgentUpdateReceipt>> {
	return updateAgent(agentId, { bookmarked });
}

/** `groupId` null ungroups. Worktree children follow their parent. */
export function moveAgentToGroup(agentId: string, groupId: string | null): Promise<AgentOpResult> {
	return run(
		{ method: 'groups.moveAgent', agentId, groupId },
		{ agentIds: [agentId], title: 'Move Failed' }
	);
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export function createGroup(input: GroupCreateInput): Promise<AgentOpResult<{ groupId: string }>> {
	return run({ method: 'groups.create', input }, { title: 'Group Creation Failed' });
}

export function renameGroup(groupId: string, name: string): Promise<AgentOpResult> {
	return run({ method: 'groups.rename', groupId, name }, { title: 'Rename Failed' });
}

/** Name, emoji, icon, color, or parent: whatever the patch names. */
export function updateGroup(groupId: string, patch: GroupPatch): Promise<AgentOpResult> {
	return run({ method: 'groups.update', groupId, patch }, { title: 'Group Update Failed' });
}

/** Members become ungrouped and child groups move up a level. No agent is deleted. */
export function removeGroup(groupId: string): Promise<AgentOpResult> {
	return run({ method: 'groups.remove', groupId }, { title: 'Delete Failed' });
}

// ---------------------------------------------------------------------------
// Tabs (optimistic: the caller has already applied the change locally)
// ---------------------------------------------------------------------------

/**
 * A new AI tab the caller already put in its store under `tabId` (DG10). `placeAfter` is where it put the
 * tab in its own strip, in the runtime's terms (`runtimeAnchorFor`), so the runtime's order is the one the
 * window already shows.
 */
export function createAiTab(
	agentId: string,
	tabId: string,
	placeAfter?: TabRefRecord | null
): Promise<AgentOpResult<{ tabId: string }>> {
	return run(
		{
			method: 'tabs.create',
			agentId,
			options: { tabId, ...(placeAfter !== undefined ? { placeAfter } : {}) },
		},
		{ agentIds: [agentId], title: 'New Tab Failed' }
	);
}

/** An empty name clears it, so the tab shows its session id label again. */
export function renameAiTab(agentId: string, tabId: string, name: string): Promise<AgentOpResult> {
	return run(
		{ method: 'tabs.rename', agentId, tabId, name },
		{ agentIds: [agentId], title: 'Rename Failed' }
	);
}

/**
 * Close an AI tab. A turn still running is left to finish (`orphan`, DM18): closing must not become
 * "stop the agent". A tab the runtime no longer holds is already closed, which is not a failure.
 */
export function closeAiTab(
	agentId: string,
	tabId: string,
	options: Pick<DesktopCloseTabOptions, 'freshTabId'> = {}
): Promise<AgentOpResult> {
	return run(
		{ method: 'tabs.close', agentId, tabId, options: { busy: 'orphan', ...options } },
		{ agentIds: [agentId], title: 'Close Tab Failed', missingIsDone: true }
	);
}

export function setAiTabStarred(
	agentId: string,
	tabId: string,
	starred: boolean
): Promise<AgentOpResult> {
	return run(
		{ method: 'tabs.star', agentId, tabId, starred },
		{ agentIds: [agentId], title: 'Star Failed' }
	);
}

/** `toIndex` counts the refs the runtime also holds (`runtimeTabIndexFor`), any kind of tab. */
export function reorderTab(
	agentId: string,
	ref: TabRefRecord,
	toIndex: number
): Promise<AgentOpResult> {
	return run(
		{ method: 'tabs.reorder', agentId, ref, toIndex },
		{ agentIds: [agentId], title: 'Reorder Failed' }
	);
}
