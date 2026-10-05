import { describe, expect, it } from 'vitest';
import {
	makeGroupChatLine,
	type AgentRecord,
	type GroupChatRecord,
} from '../../shared/maestro-lib';
import { initialMentionUi, acceptMention } from '../composer/mentions';
import { chatMentionItems, resolveChatMentionPicker } from '../groupchat/mentions';

const chat = (participants: GroupChatRecord['participants']): GroupChatRecord => ({
	id: 'c1',
	name: 'Room',
	moderatorProvider: 'claude-code',
	participants,
	state: 'idle',
	working: [],
	archived: false,
	lines: [makeGroupChatLine('user', 'hi', 1)],
});

const agent = (id: string, name: string, toolType = 'claude-code'): AgentRecord => ({
	id,
	name,
	toolType,
	aiTabs: [],
});

describe('the group chat @ picker (GC-5)', () => {
	const agents = [
		agent('a1', 'Alpha'),
		agent('a2', 'Beta', 'codex'),
		agent('a3', 'Gamma', 'opencode'),
		agent('a4', 'Shell', 'terminal'),
	];
	const room = chat([
		{ sessionId: 's-a', name: 'Alpha', provider: 'claude-code' },
		{ sessionId: 's-b', name: 'Beta', provider: 'codex' },
	]);

	describe('chatMentionItems', () => {
		it('offers the participants first, then the agents the moderator could add', () => {
			expect(chatMentionItems(room, agents).map((row) => row.displayText)).toEqual([
				'Alpha',
				'Beta',
				'Gamma',
			]);
		});

		it('never offers a terminal, and never offers a participant twice', () => {
			const rows = chatMentionItems(room, agents);
			expect(rows.some((row) => row.displayText === 'Shell')).toBe(false);
			expect(rows.filter((row) => row.displayText === 'Alpha')).toHaveLength(1);
		});

		it('names a participant as it joined, even when its agent was renamed or removed', () => {
			const renamed = chat([{ sessionId: 's-x', name: 'Old Name', provider: 'codex' }]);
			const rows = chatMentionItems(renamed, [agent('a1', 'New Name', 'codex')]);

			expect(rows[0]).toMatchObject({
				displayText: 'Old Name',
				kind: 'agent',
				toolType: 'codex',
				value: '@Old-Name ',
			});
			expect(rows[1].displayText).toBe('New Name');
		});

		it('offers every agent for a chat with no participants yet', () => {
			expect(chatMentionItems(chat([]), agents).map((row) => row.displayText)).toEqual([
				'Alpha',
				'Beta',
				'Gamma',
			]);
		});
	});

	describe('resolveChatMentionPicker', () => {
		const draft = (text: string, cursor = text.length) => ({ text, cursor });

		it('is closed unless the caret is in an @name', () => {
			expect(
				resolveChatMentionPicker(draft('no mention'), room, agents, initialMentionUi('c1'))
			).toBeUndefined();
			expect(
				resolveChatMentionPicker(draft('hi @Alpha there', 3), room, agents, initialMentionUi('c1'))
			).toBeUndefined();
		});

		it('opens on a bare @ with every row, and narrows with what is typed', () => {
			const open = resolveChatMentionPicker(draft('@'), room, agents, initialMentionUi('c1'));
			expect(open?.rows.map((row) => row.displayText)).toEqual(['Alpha', 'Beta', 'Gamma']);

			const narrowed = resolveChatMentionPicker(
				draft('ask @ga'),
				room,
				agents,
				initialMentionUi('c1')
			);
			expect(narrowed?.rows.map((row) => row.displayText)).toEqual(['Gamma']);
		});

		it('inserts the highlighted participant as a mention and leaves the caret after it', () => {
			const picker = resolveChatMentionPicker(draft('@be'), room, agents, initialMentionUi('c1'))!;
			expect(acceptMention(draft('@be'), picker)).toEqual({ text: '@Beta ', cursor: 6 });
		});

		it('stays shut for an @ the person dismissed', () => {
			const ui = { ...initialMentionUi('c1'), dismissedAt: 0 };
			expect(resolveChatMentionPicker(draft('@'), room, agents, ui)).toBeUndefined();
		});
	});
});
