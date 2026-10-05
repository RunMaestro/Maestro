import { describe, expect, it } from 'vitest';
import type { AgentRecord, AgentTreeSection } from '../../../shared/maestro-lib';
import { composerFrom } from '../draft';
import {
	MENTION_PICKER_ROWS,
	acceptMention,
	dismissMentionPicker,
	groupsOfSections,
	initialMentionUi,
	mentionItemsFor,
	mentionPickerHeight,
	resolveMentionPicker,
	stepMentionCursor,
	visibleMentionRows,
} from '../mentions';

const AGENTS: AgentRecord[] = [
	{ id: 'me', name: 'Frontend', toolType: 'claude-code', groupId: 'g1' },
	{ id: 'be', name: 'Backend', toolType: 'codex', groupId: 'g1' },
	{ id: 'dw', name: 'Docs Writer', toolType: 'claude-code', groupId: 'g1' },
	{ id: 'ops', name: 'Ops', toolType: 'claude-code' },
	{ id: 'sh', name: 'Shell', toolType: 'terminal' },
];
const SECTIONS: AgentTreeSection[] = [
	{
		key: 'group:g1',
		kind: 'group',
		title: 'Core',
		groupId: 'g1',
		collapsedByDefault: false,
		nodes: [],
	},
	{ key: 'ungrouped', kind: 'ungrouped', title: 'Ungrouped', collapsedByDefault: false, nodes: [] },
];

const items = () => mentionItemsFor(AGENTS, SECTIONS, 'me');
const ui = initialMentionUi('me:t1');

describe('the composer @ picker (XM-1)', () => {
	it("offers the agent tree's groups and the other agents, not the asker or a terminal", () => {
		expect(groupsOfSections(SECTIONS)).toEqual([{ id: 'g1', name: 'Core' }]);
		expect(items().map((row) => row.displayText)).toEqual([
			'Core',
			'Backend',
			'Docs Writer',
			'Ops',
		]);
	});

	it('opens on an @ at a word start, filters as the name is typed, and is shut anywhere else', () => {
		expect(resolveMentionPicker(composerFrom('hello'), items(), ui)).toBeUndefined();
		expect(resolveMentionPicker(composerFrom('mail a@b'), items(), ui)).toBeUndefined();
		const open = resolveMentionPicker(composerFrom('ask @'), items(), ui);
		expect(open?.rows).toHaveLength(4);
		const narrowed = resolveMentionPicker(composerFrom('ask @doc'), items(), ui);
		expect(narrowed?.rows.map((row) => row.displayText)).toEqual(['Docs Writer']);
		expect(resolveMentionPicker(composerFrom('ask @zzz'), items(), ui)).toBeUndefined();
	});

	it('follows the caret: an @ the caret has left does not keep the picker open', () => {
		expect(
			resolveMentionPicker({ text: 'ask @Ba and more', cursor: 16 }, items(), ui)
		).toBeUndefined();
		expect(
			resolveMentionPicker({ text: 'ask @Ba and more', cursor: 7 }, items(), ui)?.rows[0]
				?.displayText
		).toBe('Backend');
	});

	it('moves the highlighted row within the list and resets it when the filter changes', () => {
		const picker = resolveMentionPicker(composerFrom('@'), items(), ui)!;
		const down = stepMentionCursor(ui, picker, 1);
		const second = resolveMentionPicker(composerFrom('@'), items(), down)!;
		expect(second.cursor).toBe(1);
		expect(stepMentionCursor(down, second, -5).cursor).toBe(0);
		expect(stepMentionCursor(down, second, 99).cursor).toBe(3);
		// A different filter starts at the top again.
		expect(resolveMentionPicker(composerFrom('@o'), items(), down)?.cursor).toBe(0);
	});

	it('inserts an agent as its own token', () => {
		const picker = resolveMentionPicker(composerFrom('ask @back'), items(), ui)!;
		expect(acceptMention(composerFrom('ask @back'), picker)).toEqual({
			text: 'ask @Backend ',
			cursor: 13,
		});
	});

	it('expands a group into its member agents, never a group token (XM-1)', () => {
		const picker = resolveMentionPicker(composerFrom('@core'), items(), ui)!;
		expect(picker.rows[0]?.kind).toBe('group');
		const accepted = acceptMention(composerFrom('@core'), picker);
		expect(accepted.text).toBe('@Backend @Docs-Writer ');
		expect(accepted.text).not.toContain('@Core');
	});

	it('stays shut for an @ Esc closed, until that @ is gone', () => {
		const draft = composerFrom('ask @b');
		const picker = resolveMentionPicker(draft, items(), ui)!;
		const dismissed = dismissMentionPicker(ui, picker);
		expect(resolveMentionPicker(draft, items(), dismissed)).toBeUndefined();
		// A different @ opens it again.
		expect(resolveMentionPicker(composerFrom('ask @b and @'), items(), dismissed)).toBeDefined();
	});

	it('draws at most five rows and scrolls to keep the highlighted one in view', () => {
		const many: AgentRecord[] = [
			{ id: 'me', name: 'Me', toolType: 'codex' },
			...Array.from({ length: 9 }, (_, i) => ({
				id: `a${i}`,
				name: `Agent ${i}`,
				toolType: 'codex',
			})),
		];
		const all = mentionItemsFor(many, [], 'me');
		let state = initialMentionUi('k');
		let picker = resolveMentionPicker(composerFrom('@'), all, state)!;
		expect(visibleMentionRows(picker).rows).toHaveLength(MENTION_PICKER_ROWS);
		expect(mentionPickerHeight(picker)).toBe(1 + MENTION_PICKER_ROWS);
		for (let i = 0; i < 7; i += 1) {
			state = stepMentionCursor(state, picker, 1);
			picker = resolveMentionPicker(composerFrom('@'), all, state)!;
		}
		const window = visibleMentionRows(picker);
		expect(picker.cursor).toBe(7);
		expect(window.start).toBeLessThanOrEqual(7);
		expect(window.start + window.rows.length).toBeGreaterThan(7);
	});
});
