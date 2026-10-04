/**
 * Renaming and deleting agents, and the group actions (AG-5, GR-1, GR-2), as
 * pure state. The overlays that draw these (`ManageOverlays.tsx`) and the App's
 * key handling read this file; every change reaches the host through a named
 * `MaestroClient` method, so the exact calls are what the tests assert.
 *
 * Collapse and expand of a group stay TUI-local (GR-3): nothing here touches
 * them, and the client has no method for it.
 */

import type {
	AgentRecord,
	ClientResult,
	GroupRecord,
	MaestroClient,
} from '../../shared/maestro-lib';
import type { PaneRow } from '../app/agentRows';

/** What the cursor row means to `rename` and `delete`: an agent, a real group, or neither. */
export type ManageTarget =
	| { kind: 'agent'; agent: AgentRecord }
	| { kind: 'group'; groupId: string; name: string; emoji?: string; agentCount: number }
	| { kind: 'none'; reason: string };

export function manageTargetOf(row: PaneRow | undefined): ManageTarget {
	if (!row) return { kind: 'none', reason: 'Nothing is selected.' };
	if (row.kind === 'agent') return { kind: 'agent', agent: row.agent };
	const { section } = row;
	if (section.kind !== 'group' || section.groupId === undefined) {
		return {
			kind: 'none',
			reason: `${section.title} is not a group, so it has nothing to change.`,
		};
	}
	return {
		kind: 'group',
		groupId: section.groupId,
		name: section.title,
		...(section.emoji ? { emoji: section.emoji } : {}),
		agentCount: section.nodes.length,
	};
}

// ---------------------------------------------------------------------------
// Text prompts: rename an agent, rename a group, create a group
// ---------------------------------------------------------------------------

export type PromptKind = 'renameAgent' | 'renameGroup' | 'newGroup';
export type PromptField = 'name' | 'emoji';

export interface PromptState {
	kind: PromptKind;
	/** The agent or group being renamed. Absent when creating. */
	targetId?: string;
	/** The name before the edit, so an unchanged name sends nothing. */
	original: string;
	name: string;
	emoji: string;
	focus: PromptField;
}

export const renameAgentPrompt = (agent: AgentRecord): PromptState => ({
	kind: 'renameAgent',
	targetId: agent.id,
	original: agent.name,
	name: agent.name,
	emoji: '',
	focus: 'name',
});

export const renameGroupPrompt = (
	target: Extract<ManageTarget, { kind: 'group' }>
): PromptState => ({
	kind: 'renameGroup',
	targetId: target.groupId,
	original: target.name,
	name: target.name,
	emoji: '',
	focus: 'name',
});

export const newGroupPrompt = (): PromptState => ({
	kind: 'newGroup',
	original: '',
	name: '',
	emoji: '',
	focus: 'name',
});

export function promptTitle(state: PromptState): string {
	switch (state.kind) {
		case 'renameAgent':
			return `Rename agent: ${state.original}`;
		case 'renameGroup':
			return `Rename group: ${state.original}`;
		case 'newGroup':
			return 'New group';
	}
}

/** The boxes the prompt shows. Only a new group takes an emoji: the host cannot change one afterwards. */
export interface PromptFieldSpec {
	id: PromptField;
	label: string;
	value: string;
	placeholder: string;
}

export function promptFields(state: PromptState): PromptFieldSpec[] {
	const fields: PromptFieldSpec[] = [
		{ id: 'name', label: 'Name', value: state.name, placeholder: '' },
	];
	if (state.kind === 'newGroup') {
		fields.push({ id: 'emoji', label: 'Emoji', value: state.emoji, placeholder: 'optional' });
	}
	return fields;
}

export function typeIntoPrompt(state: PromptState, text: string): PromptState {
	if (!text) return state;
	return state.focus === 'emoji'
		? { ...state, emoji: state.emoji + text }
		: { ...state, name: state.name + text };
}

export function backspacePrompt(state: PromptState): PromptState {
	return state.focus === 'emoji'
		? { ...state, emoji: Array.from(state.emoji).slice(0, -1).join('') }
		: { ...state, name: Array.from(state.name).slice(0, -1).join('') };
}

/** Tab and the arrows walk between boxes; a one-box prompt stays where it is. */
export function movePromptFocus(state: PromptState, delta: number): PromptState {
	const ids = promptFields(state).map((field) => field.id);
	const index = ids.indexOf(state.focus);
	const next = ids[Math.min(ids.length - 1, Math.max(0, index + delta))];
	return next === state.focus ? state : { ...state, focus: next };
}

/** Why the prompt cannot be sent yet, or null. */
export function promptProblem(state: PromptState): string | null {
	return state.name.trim() ? null : 'The name cannot be empty.';
}

const displayGroup = (name: string, emoji?: string): string => (emoji ? `${emoji} ${name}` : name);

/** Sends the prompt. Resolves to the line the status bar shows. An unchanged name sends nothing. */
export async function submitPrompt(
	client: MaestroClient,
	state: PromptState
): Promise<ClientResult<string>> {
	const name = state.name.trim();
	const problem = promptProblem(state);
	if (problem) {
		return {
			ok: false,
			error: {
				code: 'invalid',
				message: problem,
				method: state.kind === 'newGroup' ? 'groups.create' : 'agents.rename',
			},
		};
	}
	switch (state.kind) {
		case 'renameAgent': {
			if (name === state.original) return { ok: true, value: 'Name unchanged.' };
			const result = await client.agents.rename(state.targetId ?? '', name);
			return result.ok ? { ok: true, value: `Renamed ${state.original} to ${name}.` } : result;
		}
		case 'renameGroup': {
			if (name === state.original) return { ok: true, value: 'Name unchanged.' };
			const result = await client.groups.rename(state.targetId ?? '', name);
			return result.ok
				? { ok: true, value: `Renamed group ${state.original} to ${name}.` }
				: result;
		}
		case 'newGroup': {
			const emoji = state.emoji.trim();
			const result = await client.groups.create({ name, ...(emoji ? { emoji } : {}) });
			return result.ok
				? { ok: true, value: `Created group ${displayGroup(name, emoji || undefined)}.` }
				: result;
		}
	}
}

// ---------------------------------------------------------------------------
// Delete confirmation
// ---------------------------------------------------------------------------

export type ConfirmState =
	| { kind: 'deleteAgent'; agentId: string; name: string; tabCount: number; busy: boolean }
	| { kind: 'deleteGroup'; groupId: string; name: string; emoji?: string; agentCount: number };

export const deleteAgentConfirm = (agent: AgentRecord): ConfirmState => ({
	kind: 'deleteAgent',
	agentId: agent.id,
	name: agent.name,
	tabCount: (agent.aiTabs ?? []).length,
	busy: agent.state === 'busy',
});

export const deleteGroupConfirm = (
	target: Extract<ManageTarget, { kind: 'group' }>
): ConfirmState => ({
	kind: 'deleteGroup',
	groupId: target.groupId,
	name: target.name,
	...(target.emoji ? { emoji: target.emoji } : {}),
	agentCount: target.agentCount,
});

const plural = (count: number, one: string, many = `${one}s`) =>
	`${count} ${count === 1 ? one : many}`;

export interface ConfirmText {
	title: string;
	/** What the delete takes away. */
	removes: string[];
	/** What survives it. */
	keeps: string[];
	/** Something the person should weigh before saying yes. */
	warning?: string;
}

/** The confirmation says what is removed and what is kept (AG-5, GR-1). */
export function confirmText(state: ConfirmState): ConfirmText {
	if (state.kind === 'deleteAgent') {
		return {
			title: `Delete agent: ${state.name}`,
			removes: [
				`The agent ${state.name}`,
				`Its ${plural(state.tabCount, 'tab')} and the transcripts stored in them`,
			],
			keeps: [
				'Its History entries',
				"The provider's own session files",
				'The working directory and its files',
			],
			...(state.busy ? { warning: 'A turn is running. It is stopped first.' } : {}),
		};
	}
	return {
		title: `Delete group: ${displayGroup(state.name, state.emoji)}`,
		removes: [`The group ${state.name}`],
		keeps: [
			state.agentCount === 0
				? 'No agent is in it'
				: `All ${plural(state.agentCount, 'agent')}, which become ungrouped`,
			'Any group nested in it, which moves up a level',
		],
	};
}

export async function submitConfirm(
	client: MaestroClient,
	state: ConfirmState
): Promise<ClientResult<string>> {
	if (state.kind === 'deleteAgent') {
		const result = await client.agents.remove(state.agentId);
		return result.ok
			? {
					ok: true,
					value: `Deleted ${state.name}. Its History and provider session files are kept.`,
				}
			: result;
	}
	const result = await client.groups.remove(state.groupId);
	return result.ok
		? { ok: true, value: `Deleted group ${state.name}. Its agents are ungrouped, none deleted.` }
		: result;
}

// ---------------------------------------------------------------------------
// Move an agent between groups
// ---------------------------------------------------------------------------

export interface GroupChoice {
	/** null is ungrouped. */
	groupId: string | null;
	label: string;
}

/** Ungrouped first, then each group as the Agents pane lists them. */
export function groupChoices(groups: readonly GroupRecord[]): GroupChoice[] {
	return [
		{ groupId: null, label: 'Ungrouped' },
		...groups.map((group) => ({
			groupId: group.id,
			label: displayGroup(group.name, group.emoji),
		})),
	];
}

/** The picker opens on the agent's current group. */
export function pickerStartIndex(choices: readonly GroupChoice[], agent: AgentRecord): number {
	const index = choices.findIndex((choice) => choice.groupId === (agent.groupId ?? null));
	// A group id the host no longer lists means the agent shows as ungrouped.
	return Math.max(0, index);
}

export function moveGroupCursor(cursor: number, delta: number, count: number): number {
	return Math.min(Math.max(0, count - 1), Math.max(0, cursor + delta));
}

/** Files the agent under the chosen row. Choosing where it already is sends nothing. */
export async function submitMoveToGroup(
	client: MaestroClient,
	agent: AgentRecord,
	choices: readonly GroupChoice[],
	index: number
): Promise<ClientResult<string>> {
	const choice = choices[index];
	if (!choice) {
		return {
			ok: false,
			error: { code: 'invalid', message: 'That group is gone.', method: 'groups.moveAgent' },
		};
	}
	if (choices[pickerStartIndex(choices, agent)].groupId === choice.groupId) {
		return { ok: true, value: `${agent.name} is already in ${choice.label}.` };
	}
	const result = await client.groups.moveAgent(agent.id, choice.groupId);
	return result.ok ? { ok: true, value: `Moved ${agent.name} to ${choice.label}.` } : result;
}
