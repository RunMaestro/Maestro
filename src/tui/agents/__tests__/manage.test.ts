import { describe, expect, it } from 'vitest';
import { buildAgentTree, type AgentRecord, type GroupRecord } from '../../../shared/maestro-lib';
import { createFakeClient } from '../../__tests__/fakeClient';
import { buildPaneRows } from '../../app/agentRows';
import {
	backspacePrompt,
	confirmText,
	deleteAgentConfirm,
	deleteGroupConfirm,
	groupChoices,
	manageTargetOf,
	moveGroupCursor,
	movePromptFocus,
	newGroupPrompt,
	pickerStartIndex,
	promptFields,
	promptProblem,
	promptTitle,
	renameAgentPrompt,
	renameGroupPrompt,
	submitConfirm,
	submitMoveToGroup,
	submitPrompt,
	typeIntoPrompt,
} from '../manage';

const GROUPS: GroupRecord[] = [
	{ id: 'g1', name: 'Core', emoji: '🎼' },
	{ id: 'g2', name: 'Empty' },
];

const agents = (): AgentRecord[] => [
	{
		id: 'a1',
		name: 'Alpha',
		toolType: 'codex',
		groupId: 'g1',
		aiTabs: [{ id: 't1' }, { id: 't2' }],
	},
	{ id: 'a2', name: 'Beta', toolType: 'codex', state: 'busy', aiTabs: [{ id: 't3' }] },
];

const rows = () => buildPaneRows(buildAgentTree(agents(), GROUPS), {});

describe('manageTargetOf', () => {
	it('reads an agent row, a group header, and refuses the synthetic sections', () => {
		const all = rows();
		const core = all.find((row) => row.key === 'group:g1');
		const alpha = all.find((row) => row.kind === 'agent' && row.agent.id === 'a1');
		const ungrouped = all.find((row) => row.key === 'ungrouped');

		expect(manageTargetOf(core)).toEqual({
			kind: 'group',
			groupId: 'g1',
			name: 'Core',
			emoji: '🎼',
			agentCount: 1,
		});
		expect(manageTargetOf(alpha)).toMatchObject({ kind: 'agent', agent: { id: 'a1' } });
		expect(manageTargetOf(ungrouped)).toEqual({
			kind: 'none',
			reason: 'Ungrouped is not a group, so it has nothing to change.',
		});
		expect(manageTargetOf(undefined).kind).toBe('none');
	});

	it('counts the agents of an empty group as zero', () => {
		const empty = rows().find((row) => row.key === 'group:g2');
		expect(manageTargetOf(empty)).toMatchObject({ kind: 'group', name: 'Empty', agentCount: 0 });
	});
});

describe('prompts', () => {
	it('opens a rename on the current name and a new group on empty boxes', () => {
		const [alpha] = agents();
		expect(renameAgentPrompt(alpha)).toMatchObject({
			kind: 'renameAgent',
			targetId: 'a1',
			name: 'Alpha',
		});
		expect(promptTitle(renameAgentPrompt(alpha))).toBe('Rename agent: Alpha');
		expect(promptTitle(newGroupPrompt())).toBe('New group');
		expect(newGroupPrompt()).toMatchObject({ name: '', emoji: '', focus: 'name' });
	});

	it('offers the emoji box only when creating a group', () => {
		expect(promptFields(newGroupPrompt()).map((field) => field.id)).toEqual(['name', 'emoji']);
		expect(promptFields(renameAgentPrompt(agents()[0])).map((field) => field.id)).toEqual(['name']);
		const group = manageTargetOf(rows().find((row) => row.key === 'group:g1'));
		if (group.kind !== 'group') throw new Error('expected a group');
		expect(promptFields(renameGroupPrompt(group)).map((field) => field.id)).toEqual(['name']);
	});

	it('types and deletes in the focused box, by character rather than by code unit', () => {
		let state = newGroupPrompt();
		state = typeIntoPrompt(state, 'Ops');
		state = movePromptFocus(state, 1);
		expect(state.focus).toBe('emoji');
		state = typeIntoPrompt(state, '🚀🔥');
		state = backspacePrompt(state);
		expect(state).toMatchObject({ name: 'Ops', emoji: '🚀' });
		// Back to the name box, and the ends hold.
		state = movePromptFocus(movePromptFocus(state, -1), -1);
		expect(state.focus).toBe('name');
		expect(typeIntoPrompt(state, '')).toBe(state);
	});

	it('keeps focus in a one-box prompt', () => {
		const state = renameAgentPrompt(agents()[0]);
		expect(movePromptFocus(state, 1)).toBe(state);
	});

	it('flags a blank name', () => {
		expect(promptProblem(newGroupPrompt())).toBe('The name cannot be empty.');
		expect(promptProblem(typeIntoPrompt(newGroupPrompt(), '   '))).toBe(
			'The name cannot be empty.'
		);
		expect(promptProblem(typeIntoPrompt(newGroupPrompt(), 'Ops'))).toBeNull();
	});
});

describe('submitPrompt', () => {
	it('renames an agent with the trimmed name', async () => {
		const fake = createFakeClient({ agents: agents(), groups: GROUPS });
		const state = typeIntoPrompt(renameAgentPrompt(agents()[0]), ' Two ');
		const result = await submitPrompt(fake.client, state);
		expect(result).toEqual({ ok: true, value: 'Renamed Alpha to Alpha Two.' });
		expect(fake.requests).toEqual([{ method: 'agents.rename', args: ['a1', 'Alpha Two'] }]);
	});

	it('sends nothing for an unchanged name', async () => {
		const fake = createFakeClient({ agents: agents(), groups: GROUPS });
		const result = await submitPrompt(fake.client, renameAgentPrompt(agents()[0]));
		expect(result).toEqual({ ok: true, value: 'Name unchanged.' });
		expect(fake.requests).toEqual([]);
	});

	it('refuses a blank name without calling the host', async () => {
		const fake = createFakeClient({ agents: agents(), groups: GROUPS });
		const result = await submitPrompt(fake.client, newGroupPrompt());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('invalid');
		expect(fake.requests).toEqual([]);
	});

	it('renames a group and creates one with and without an emoji', async () => {
		const fake = createFakeClient({ agents: agents(), groups: GROUPS });
		const group = manageTargetOf(rows().find((row) => row.key === 'group:g1'));
		if (group.kind !== 'group') throw new Error('expected a group');
		await submitPrompt(fake.client, typeIntoPrompt(renameGroupPrompt(group), '!'));
		await submitPrompt(fake.client, typeIntoPrompt(newGroupPrompt(), 'Ops'));
		const withEmoji = movePromptFocus(typeIntoPrompt(newGroupPrompt(), 'Lab'), 1);
		const created = await submitPrompt(fake.client, typeIntoPrompt(withEmoji, ' 🧪 '));
		expect(created).toEqual({ ok: true, value: 'Created group 🧪 Lab.' });
		expect(fake.requests).toEqual([
			{ method: 'groups.rename', args: ['g1', 'Core!'] },
			{ method: 'groups.create', args: [{ name: 'Ops' }] },
			{ method: 'groups.create', args: [{ name: 'Lab', emoji: '🧪' }] },
		]);
	});

	it('passes the host refusal through', async () => {
		const fake = createFakeClient({
			agents: agents(),
			failures: { 'agents.rename': 'rejected' },
		});
		const result = await submitPrompt(
			fake.client,
			typeIntoPrompt(renameAgentPrompt(agents()[0]), 'x')
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('rejected');
	});
});

describe('delete confirmation', () => {
	it('says what an agent delete removes and what it keeps', () => {
		const text = confirmText(deleteAgentConfirm(agents()[0]));
		expect(text.title).toBe('Delete agent: Alpha');
		expect(text.removes).toEqual([
			'The agent Alpha',
			'Its 2 tabs and the transcripts stored in them',
		]);
		expect(text.keeps).toEqual([
			'Its History entries',
			"The provider's own session files",
			'The working directory and its files',
		]);
		expect(text.warning).toBeUndefined();
	});

	it('warns that a running turn is stopped, and counts one tab in the singular', () => {
		const text = confirmText(deleteAgentConfirm(agents()[1]));
		expect(text.removes[1]).toBe('Its 1 tab and the transcripts stored in them');
		expect(text.warning).toBe('A turn is running. It is stopped first.');
	});

	it('says a group delete keeps every agent', () => {
		const target = manageTargetOf(rows().find((row) => row.key === 'group:g1'));
		if (target.kind !== 'group') throw new Error('expected a group');
		const text = confirmText(deleteGroupConfirm(target));
		expect(text.title).toBe('Delete group: 🎼 Core');
		expect(text.removes).toEqual(['The group Core']);
		expect(text.keeps[0]).toBe('All 1 agent, which become ungrouped');
		const empty = manageTargetOf(rows().find((row) => row.key === 'group:g2'));
		if (empty.kind !== 'group') throw new Error('expected a group');
		expect(confirmText(deleteGroupConfirm(empty)).keeps[0]).toBe('No agent is in it');
	});

	it('calls remove on the right entity', async () => {
		const fake = createFakeClient({ agents: agents(), groups: GROUPS });
		await submitConfirm(fake.client, deleteAgentConfirm(agents()[0]));
		const target = manageTargetOf(rows().find((row) => row.key === 'group:g2'));
		if (target.kind !== 'group') throw new Error('expected a group');
		await submitConfirm(fake.client, deleteGroupConfirm(target));
		expect(fake.requests).toEqual([
			{ method: 'agents.remove', args: ['a1'] },
			{ method: 'groups.remove', args: ['g2'] },
		]);
	});
});

describe('moving an agent between groups', () => {
	const choices = groupChoices(GROUPS);

	it('lists ungrouped first, then each group', () => {
		expect(choices).toEqual([
			{ groupId: null, label: 'Ungrouped' },
			{ groupId: 'g1', label: '🎼 Core' },
			{ groupId: 'g2', label: 'Empty' },
		]);
	});

	it('starts on the current group, and on ungrouped for an agent whose group is gone', () => {
		const [alpha, beta] = agents();
		expect(pickerStartIndex(choices, alpha)).toBe(1);
		expect(pickerStartIndex(choices, beta)).toBe(0);
		expect(pickerStartIndex(choices, { ...beta, groupId: 'deleted' })).toBe(0);
	});

	it('clamps the cursor at both ends', () => {
		expect(moveGroupCursor(0, -1, 3)).toBe(0);
		expect(moveGroupCursor(2, 1, 3)).toBe(2);
		expect(moveGroupCursor(1, 1, 3)).toBe(2);
	});

	it('moves to a group and to ungrouped, and sends nothing when the agent is already there', async () => {
		const fake = createFakeClient({ agents: agents(), groups: GROUPS });
		const [alpha] = agents();
		const toEmpty = await submitMoveToGroup(fake.client, alpha, choices, 2);
		expect(toEmpty).toEqual({ ok: true, value: 'Moved Alpha to Empty.' });
		await submitMoveToGroup(fake.client, alpha, choices, 0);
		const same = await submitMoveToGroup(fake.client, alpha, choices, 1);
		expect(same).toEqual({ ok: true, value: 'Alpha is already in 🎼 Core.' });
		expect(fake.requests).toEqual([
			{ method: 'groups.moveAgent', args: ['a1', 'g2'] },
			{ method: 'groups.moveAgent', args: ['a1', null] },
		]);
	});

	it('refuses a row that no longer exists', async () => {
		const fake = createFakeClient({ agents: agents(), groups: GROUPS });
		const result = await submitMoveToGroup(fake.client, agents()[0], choices, 9);
		expect(result.ok).toBe(false);
		expect(fake.requests).toEqual([]);
	});
});
