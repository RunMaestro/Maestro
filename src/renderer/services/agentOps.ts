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
 * Design: `Plans/maestro-tui-desktop-migration.md` sections 4.3 and 7 (task 3).
 */

import type {
	AgentCreateInput,
	AgentPatch,
	ClientResult,
	GroupCreateInput,
	GroupPatch,
} from '../../shared/maestro-lib/client/types';
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
	options: { agentIds?: readonly string[]; creating?: Session; title: string; quiet?: boolean }
): Promise<AgentOpResult<T>> {
	try {
		const answer = await sendRuntimeCommand(command, {
			...(options.agentIds ? { agentIds: options.agentIds } : {}),
			...(options.creating ? { creating: options.creating } : {}),
		});
		if (answer.result.ok) return { ok: true, value: answer.result.value as T };
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

export function updateAgent(agentId: string, patch: AgentPatch): Promise<AgentOpResult> {
	return run(
		{ method: 'agents.update', agentId, patch },
		{ agentIds: [agentId], title: 'Update Failed' }
	);
}

export function setAgentBookmarked(agentId: string, bookmarked: boolean): Promise<AgentOpResult> {
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
