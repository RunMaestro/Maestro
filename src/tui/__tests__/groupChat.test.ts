import { describe, expect, it } from 'vitest';
import type { AgentRecord, GroupChatRecord } from '../../shared/maestro-lib';
import { emptyGroupChat, makeGroupChatLine } from '../../shared/maestro-lib';
import { EMPTY_COMPOSER, composerFrom } from '../composer/draft';
import { groupChatEntries, groupChatStyle, participantColor } from '../groupchat/entries';
import {
	CHAT_BUSY_MESSAGE,
	backspaceChatForm,
	chatActivityLine,
	chatCandidates,
	chatFormProblem,
	chatStatusLabel,
	cycleChatChoice,
	initialChatForm,
	liveChatOf,
	moveChatFormFocus,
	moveGroupChatCursor,
	openGroupChatList,
	orderGroupChats,
	participantRows,
	pressChatFormEnter,
	stopChat,
	submitChatForm,
	submitChatMessage,
	typeIntoChatForm,
} from '../groupchat/state';
import { applyLiveEvent, seedLiveChat } from '../groupchat/useGroupChats';
import { createFakeClient } from './fakeClient';

const agent = (id: string, name: string, toolType: string): AgentRecord => ({
	id,
	name,
	toolType,
	aiTabs: [],
});
const AGENTS = [
	agent('a1', 'Alpha', 'claude-code'),
	agent('a2', 'Beta', 'codex'),
	agent('a3', 'Shell', 'terminal'),
];

const chat = (fields: Partial<GroupChatRecord> = {}): GroupChatRecord => ({
	...emptyGroupChat('c1'),
	name: 'Review',
	participants: [
		{ sessionId: 's1', name: 'Alpha', provider: 'claude-code' },
		{ sessionId: 's2', name: 'Beta', provider: 'codex' },
	],
	...fields,
});

describe('the list', () => {
	it('puts running chats first, then idle ones by name, and archived chats last', () => {
		const ordered = orderGroupChats([
			chat({ id: 'a', name: 'Zed' }),
			chat({ id: 'b', name: 'Old', archived: true }),
			chat({ id: 'c', name: 'Beta', state: 'agent-working' }),
			chat({ id: 'd', name: 'Alpha' }),
		]);
		expect(ordered.map((item) => item.name)).toEqual(['Beta', 'Alpha', 'Zed', 'Old']);
	});

	it('keeps the cursor on a chat across a reload, and clamps a move to the ends', () => {
		const list = openGroupChatList([chat({ id: 'a', name: 'A' }), chat({ id: 'b', name: 'B' })], {
			cursorOn: 'b',
			message: 'Renamed.',
		});
		expect(list.cursor).toBe(1);
		expect(list.message).toBe('Renamed.');
		expect(moveGroupChatCursor(list, 5).cursor).toBe(1);
		expect(moveGroupChatCursor(list, -5).cursor).toBe(0);
		expect(openGroupChatList([chat()], { cursorOn: 'gone' }).cursor).toBe(0);
	});

	it('lays the live state over what the list read, and keeps the list when nothing live exists', () => {
		const listed = chat({ state: 'idle' });
		expect(liveChatOf(listed, undefined)).toBe(listed);
		const live = chat({ state: 'agent-working', working: ['Alpha'] });
		expect(liveChatOf(listed, live)).toMatchObject({ state: 'agent-working', working: ['Alpha'] });
	});

	it('says what a chat is doing, and who it is waiting on', () => {
		expect(chatStatusLabel(chat())).toBe('idle');
		expect(chatStatusLabel(chat({ state: 'moderator-thinking' }))).toBe('moderating');
		expect(chatStatusLabel(chat({ state: 'agent-working', working: ['A', 'B'] }))).toBe(
			'2 working'
		);
		expect(chatActivityLine(chat({ state: 'agent-working', working: ['Alpha'] }))).toBe(
			'Waiting on Alpha.'
		);
		expect(participantRows(chat({ working: ['Beta'] }))).toEqual([
			{ name: 'Alpha', provider: 'Claude Code', working: false },
			{ name: 'Beta', provider: 'Codex', working: true },
		]);
	});
});

describe('the create form', () => {
	it('offers every agent but a terminal', () => {
		expect(chatCandidates(AGENTS).map((item) => item.name)).toEqual(['Alpha', 'Beta']);
	});

	it('types into the focused text box, and a space picks on a participant row', () => {
		let form = typeIntoChatForm(initialChatForm(), 'Plan');
		expect(form.name).toBe('Plan');
		form = backspaceChatForm(form);
		expect(form.name).toBe('Pla');
		form = moveChatFormFocus(AGENTS, form, 1);
		form = typeIntoChatForm(form, 'Go');
		expect(form.message).toBe('Go');
		// Moderator, then the first participant.
		form = moveChatFormFocus(AGENTS, form, 2);
		expect(form.focus).toBe('participant:a1');
		form = typeIntoChatForm(form, 'x');
		expect(form.picked).toEqual([]);
		form = typeIntoChatForm(form, ' ');
		expect(form.picked).toEqual(['a1']);
	});

	it('keeps the order participants were picked in, and drops one on a second pick', () => {
		let form = { ...initialChatForm(), focus: 'participant:a2' };
		form = pressChatFormEnter(AGENTS, form);
		form = moveChatFormFocus(AGENTS, { ...form, focus: 'participant:a1' }, 0);
		form = cycleChatChoice(AGENTS, form, 1);
		expect(form.picked).toEqual(['a2', 'a1']);
		form = cycleChatChoice(AGENTS, { ...form, focus: 'participant:a2' }, 1);
		expect(form.picked).toEqual(['a1']);
	});

	it('steps the moderator through the agents and back to the first participant', () => {
		let form = { ...initialChatForm(), focus: 'moderator' };
		form = cycleChatChoice(AGENTS, form, 1);
		expect(form.moderator).toBe('a1');
		form = cycleChatChoice(AGENTS, form, 1);
		expect(form.moderator).toBe('a2');
		form = cycleChatChoice(AGENTS, form, 1);
		expect(form.moderator).toBe('');
		form = cycleChatChoice(AGENTS, form, -1);
		expect(form.moderator).toBe('a2');
	});

	it('does not pass the ends of the field list, and Enter on a text box steps on', () => {
		const first = initialChatForm();
		expect(moveChatFormFocus(AGENTS, first, -1)).toBe(first);
		expect(pressChatFormEnter(AGENTS, first).focus).toBe('message');
		const last = { ...first, focus: 'participant:a2' };
		expect(moveChatFormFocus(AGENTS, last, 1)).toBe(last);
	});

	it('needs a name and a participant, and calls the client with only what was chosen', async () => {
		expect(chatFormProblem(initialChatForm())).toBe('The chat needs a name.');
		expect(chatFormProblem({ ...initialChatForm(), name: 'x' })).toBe(
			'Pick at least one participant.'
		);
		const fake = createFakeClient({ agents: AGENTS });
		const refused = await submitChatForm(fake.client, initialChatForm());
		expect(refused).toMatchObject({ ok: false, error: { code: 'invalid' } });
		expect(fake.requests).toEqual([]);

		const done = await submitChatForm(fake.client, {
			...initialChatForm(),
			name: 'Plan',
			picked: ['a1'],
		});
		expect(done).toEqual({ ok: true, value: { chatId: 'new-chat-1' } });
		expect(fake.requests).toEqual([
			{ method: 'groupChats.create', args: [{ name: 'Plan', participantIds: ['a1'] }] },
		]);
	});
});

describe('sending and stopping', () => {
	it('sends a draft to the moderator, trimmed, and nothing for a blank one', async () => {
		const fake = createFakeClient();
		expect(await submitChatMessage(fake.client, chat(), EMPTY_COMPOSER)).toEqual({
			status: 'empty',
		});
		expect(await submitChatMessage(fake.client, chat(), composerFrom('go\n\n'))).toEqual({
			status: 'sent',
		});
		expect(fake.requests).toEqual([{ method: 'groupChats.send', args: ['c1', 'go'] }]);
	});

	it('refuses a busy chat without a call, since the host does not queue', async () => {
		const fake = createFakeClient();
		const outcome = await submitChatMessage(
			fake.client,
			chat({ state: 'moderator-thinking' }),
			composerFrom('hi')
		);
		expect(outcome).toEqual({ status: 'busy', message: CHAT_BUSY_MESSAGE });
		expect(fake.requests).toEqual([]);
	});

	it('reports the host refusal', async () => {
		const fake = createFakeClient({ failures: { 'groupChats.send': 'rejected' } });
		expect(await submitChatMessage(fake.client, chat(), composerFrom('hi'))).toEqual({
			status: 'failed',
			message: 'fake rejected',
		});
	});

	it('stops only a chat that is running', async () => {
		const fake = createFakeClient();
		expect(await stopChat(fake.client, chat())).toEqual({
			ok: true,
			value: 'The chat is not running.',
		});
		expect(fake.requests).toEqual([]);
		expect(await stopChat(fake.client, chat({ state: 'agent-working' }))).toEqual({
			ok: true,
			value: 'Stopped Review.',
		});
		expect(fake.requests).toEqual([{ method: 'groupChats.stop', args: ['c1'] }]);
	});
});

describe('the live store', () => {
	it('folds events into a chat that has not been read yet, and a gap marks it stale', () => {
		let live = applyLiveEvent(undefined, 'c1', { kind: 'state', at: 5, state: 'agent-working' });
		expect(live).toMatchObject({ eventAt: 5, stale: false, chat: { state: 'agent-working' } });
		live = applyLiveEvent(live, 'c1', { kind: 'gap', at: 6 });
		expect(live.stale).toBe(true);
		expect(live.eventAt).toBe(5);
	});

	it('takes a read as the base, and lets events newer than the read keep their state', () => {
		const heard = applyLiveEvent(undefined, 'c1', {
			kind: 'state',
			at: 100,
			state: 'agent-working',
		});
		const withLine = applyLiveEvent(heard, 'c1', {
			kind: 'message',
			at: 100,
			line: makeGroupChatLine('Alpha', 'heard live', 100),
		});
		const snapshot = chat({
			state: 'idle',
			lines: [makeGroupChatLine('user', 'earlier', 10)],
		});

		// The read began before the events: their state is newer, and both lines are kept.
		const newer = seedLiveChat(withLine, snapshot, 50);
		expect(newer.chat.state).toBe('agent-working');
		expect(newer.chat.name).toBe('Review');
		expect(newer.chat.lines.map((line) => line.text)).toEqual(['earlier', 'heard live']);

		// The read began after the events: the snapshot's state is the newer one.
		expect(seedLiveChat(withLine, snapshot, 200).chat.state).toBe('idle');
		expect(seedLiveChat(undefined, snapshot, 0)).toEqual({
			chat: snapshot,
			eventAt: 0,
			stale: false,
		});
		expect(seedLiveChat({ ...withLine, stale: true }, snapshot, 200).stale).toBe(false);
	});
});

describe('entries', () => {
	it('draws each speaker under its own name and color', () => {
		const [user, moderator, system, alpha] = groupChatEntries([
			makeGroupChatLine('user', 'q', 1),
			makeGroupChatLine('moderator', 'a', 2),
			makeGroupChatLine('system', 's', 3),
			makeGroupChatLine('Alpha', 'r', 4),
		]);
		expect(groupChatStyle(user)).toEqual({ label: 'You', color: 'green' });
		expect(groupChatStyle(moderator)).toMatchObject({ label: 'Moderator' });
		expect(groupChatStyle(system)).toMatchObject({ label: 'System', dimColor: true });
		expect(groupChatStyle(alpha)).toEqual({ label: 'Alpha', color: participantColor('Alpha') });
		// A participant keeps its color, and an ordinary transcript entry is none of this view's business.
		expect(participantColor('Alpha')).toBe(participantColor('Alpha'));
		expect(groupChatStyle({ id: 'x', timestamp: 0, source: 'ai', text: '' })).toBeUndefined();
	});
});
