import { describe, expect, it } from 'vitest';
import {
	GROUP_CHAT_MAX_LINES,
	emptyGroupChat,
	foldGroupChat,
	groupChatActivity,
	isGroupChatBusy,
	makeGroupChatLine,
	mergeGroupChatLines,
	parseGroupChatFrame,
	parseGroupChatLine,
	parseGroupChatRecord,
	reduceGroupChat,
	speakerOf,
	validateGroupChatCreate,
	type GroupChatEvent,
} from '../chat';

const CHAT = '5f1c2a9e-0b7d-4c1e-9a55-3d7f2c0b6a11';
const ISO = '2026-10-04T15:00:00.000Z';
const AT = Date.parse(ISO);

describe('parsing the host wire forms', () => {
	it('names who a line is from: the room voices, or a participant', () => {
		expect(['user', 'moderator', 'system', 'Alpha'].map(speakerOf)).toEqual([
			'user',
			'moderator',
			'system',
			'participant',
		]);
	});

	it('reads a pushed line (ISO time, `from`) and a snapshot line (epoch ms, `participantName`)', () => {
		expect(parseGroupChatLine({ timestamp: ISO, from: 'moderator', content: 'Routing.' })).toEqual({
			id: `${AT}|moderator|Routing.`,
			from: 'moderator',
			speaker: 'moderator',
			text: 'Routing.',
			at: AT,
		});
		const snapshot = parseGroupChatLine({
			id: 'x',
			participantId: 'Alpha',
			participantName: 'Alpha',
			content: 'Looks fine.',
			timestamp: AT,
			role: 'assistant',
		});
		// The same line read two ways is the same id, which is what lets a re-read and a push merge.
		expect(snapshot?.id).toBe(`${AT}|Alpha|Looks fine.`);
		expect(snapshot?.speaker).toBe('participant');
	});

	it('strips terminal escapes from a line and drops a malformed one', () => {
		expect(
			parseGroupChatLine({ timestamp: ISO, from: 'Alpha', content: '\u001b[31mred\u001b[0m' })?.text
		).toBe('red');
		expect(parseGroupChatLine({ from: 'Alpha' })).toBeUndefined();
		expect(parseGroupChatLine('text')).toBeUndefined();
	});

	it('reads a chat from the list and from `get`, with the provider under either name', () => {
		const chat = parseGroupChatRecord({
			id: CHAT,
			topic: 'Release review',
			participants: [
				{ sessionId: 's-1', name: 'Alpha', toolType: 'claude-code' },
				{ sessionId: 's-2', name: 'Beta', agentId: 'codex' },
				{ sessionId: 's-3' },
			],
			messages: [
				{ participantName: 'user', content: 'Ship it?', timestamp: AT, role: 'user' },
				{
					participantName: 'moderator',
					content: 'Asking.',
					timestamp: AT + 1000,
					role: 'assistant',
				},
			],
			isActive: true,
			state: 'agent-working',
			moderatorAgentId: 'claude-code',
			archived: true,
		});
		expect(chat).toMatchObject({
			id: CHAT,
			name: 'Release review',
			moderatorProvider: 'claude-code',
			state: 'agent-working',
			working: [],
			archived: true,
			participants: [
				{ name: 'Alpha', provider: 'claude-code' },
				{ name: 'Beta', provider: 'codex' },
			],
		});
		expect(chat?.lines.map((line) => line.speaker)).toEqual(['user', 'moderator']);
	});

	it('falls back to `isActive` for a build that predates the turn state', () => {
		expect(parseGroupChatRecord({ id: CHAT, topic: 'x', isActive: true })?.state).toBe(
			'agent-working'
		);
		expect(parseGroupChatRecord({ id: CHAT, topic: 'x', isActive: false })?.state).toBe('idle');
		expect(parseGroupChatRecord({ topic: 'no id' })).toBeUndefined();
	});

	it('reads each groupChat channel, and nothing else', () => {
		expect(parseGroupChatFrame('groupChat:stateChange', [CHAT, 'moderator-thinking'], 5)).toEqual({
			chatId: CHAT,
			event: { kind: 'state', at: 5, state: 'moderator-thinking' },
		});
		expect(
			parseGroupChatFrame('groupChat:participantState', [CHAT, 'Alpha', 'working'], 6)
		).toEqual({
			chatId: CHAT,
			event: { kind: 'participant', at: 6, name: 'Alpha', working: true },
		});
		expect(
			parseGroupChatFrame(
				'groupChat:participantsChanged',
				[CHAT, [{ name: 'Alpha', agentId: 'codex', sessionId: 's-1' }]],
				7
			)
		).toEqual({
			chatId: CHAT,
			event: {
				kind: 'participants',
				at: 7,
				participants: [{ name: 'Alpha', provider: 'codex', sessionId: 's-1' }],
			},
		});
		expect(
			parseGroupChatFrame(
				'groupChat:message',
				[CHAT, { timestamp: ISO, from: 'user', content: 'hi' }],
				8
			)
		).toMatchObject({ chatId: CHAT, event: { kind: 'message', line: { text: 'hi' } } });

		// Channels a client has no use for, a bad state word, and a missing chat id.
		expect(parseGroupChatFrame('groupChat:queueState', [CHAT, {}], 1)).toBeNull();
		expect(parseGroupChatFrame('groupChat:moderatorUsage', [CHAT, {}], 1)).toBeNull();
		expect(parseGroupChatFrame('groupChat:stateChange', [CHAT, 'asleep'], 1)).toBeNull();
		expect(
			parseGroupChatFrame('groupChat:participantState', [CHAT, 'Alpha', 'sulking'], 1)
		).toBeNull();
		expect(parseGroupChatFrame('groupChat:stateChange', [], 1)).toBeNull();
		expect(parseGroupChatFrame('process:data', [CHAT, 'x'], 1)).toBeNull();
	});
});

describe('lines', () => {
	it('merges oldest first, keeps a line seen twice once, and keeps arrival order within a millisecond', () => {
		const a = makeGroupChatLine('Alpha', 'first', 100);
		const b = makeGroupChatLine('Beta', 'second', 100);
		const c = makeGroupChatLine('Alpha', 'older', 50);
		const merged = mergeGroupChatLines([a], [b, a, c]);
		expect(merged.map((line) => line.text)).toEqual(['older', 'first', 'second']);
	});

	it('returns the same array when nothing is new', () => {
		const a = makeGroupChatLine('Alpha', 'only', 1);
		const held = [a];
		expect(mergeGroupChatLines(held, [a])).toBe(held);
		expect(mergeGroupChatLines(held, [])).toBe(held);
	});

	it('keeps the newest lines when a chat runs past the cap', () => {
		const lines = Array.from({ length: GROUP_CHAT_MAX_LINES + 5 }, (_, index) =>
			makeGroupChatLine('Alpha', `line ${index}`, index)
		);
		const merged = mergeGroupChatLines([], lines);
		expect(merged).toHaveLength(GROUP_CHAT_MAX_LINES);
		expect(merged[0].text).toBe('line 5');
		expect(merged.at(-1)?.text).toBe(`line ${GROUP_CHAT_MAX_LINES + 4}`);
	});
});

describe('reduceGroupChat', () => {
	const start = emptyGroupChat(CHAT);

	it('follows the moderator state, and an idle moderator ends the round for everyone', () => {
		let chat = reduceGroupChat(start, { kind: 'state', at: 1, state: 'agent-working' });
		chat = reduceGroupChat(chat, { kind: 'participant', at: 2, name: 'Alpha', working: true });
		chat = reduceGroupChat(chat, { kind: 'participant', at: 3, name: 'Beta', working: true });
		expect(chat.working).toEqual(['Alpha', 'Beta']);
		expect(groupChatActivity(chat)).toEqual({ kind: 'working', names: ['Alpha', 'Beta'] });
		expect(isGroupChatBusy(chat)).toBe(true);

		chat = reduceGroupChat(chat, { kind: 'participant', at: 4, name: 'Alpha', working: false });
		expect(chat.working).toEqual(['Beta']);
		chat = reduceGroupChat(chat, { kind: 'state', at: 5, state: 'idle' });
		expect(chat.working).toEqual([]);
		expect(groupChatActivity(chat)).toEqual({ kind: 'idle' });
		expect(isGroupChatBusy(chat)).toBe(false);
	});

	it('does not change the chat for a repeated participant state or a gap', () => {
		const working = reduceGroupChat(start, {
			kind: 'participant',
			at: 1,
			name: 'Alpha',
			working: true,
		});
		expect(
			reduceGroupChat(working, { kind: 'participant', at: 2, name: 'Alpha', working: true })
		).toBe(working);
		expect(reduceGroupChat(working, { kind: 'gap', at: 3 })).toBe(working);
		expect(
			reduceGroupChat(start, { kind: 'participant', at: 1, name: 'Alpha', working: false })
		).toBe(start);
	});

	it('takes a new roster, and ignores a line it already holds', () => {
		const line = makeGroupChatLine('moderator', 'hello', 10);
		let chat = reduceGroupChat(start, { kind: 'message', at: 10, line });
		expect(reduceGroupChat(chat, { kind: 'message', at: 11, line })).toBe(chat);
		chat = reduceGroupChat(chat, {
			kind: 'participants',
			at: 12,
			participants: [{ name: 'Alpha', provider: 'codex', sessionId: 's-1' }],
		});
		expect(chat.participants).toEqual([{ name: 'Alpha', provider: 'codex', sessionId: 's-1' }]);
	});

	it('lays buffered events over a snapshot, so a read that raced a push loses nothing', () => {
		const snapshot = {
			...emptyGroupChat(CHAT),
			name: 'Release review',
			lines: [makeGroupChatLine('user', 'Ship it?', 1)],
		};
		const events: GroupChatEvent[] = [
			{ kind: 'message', at: 1, line: makeGroupChatLine('user', 'Ship it?', 1) },
			{ kind: 'state', at: 2, state: 'moderator-thinking' },
			{ kind: 'message', at: 3, line: makeGroupChatLine('moderator', 'Asking.', 3) },
		];
		const chat = foldGroupChat(snapshot, events);
		expect(chat.lines.map((line) => line.text)).toEqual(['Ship it?', 'Asking.']);
		expect(chat.state).toBe('moderator-thinking');
		expect(chat.name).toBe('Release review');
	});
});

describe('validateGroupChatCreate', () => {
	it('trims, drops repeats and blanks, and omits an empty message', () => {
		expect(
			validateGroupChatCreate({
				name: ' Review ',
				participantIds: ['a', 'b', 'a', ''],
				message: ' ',
			})
		).toEqual({ ok: true, value: { name: 'Review', participantIds: ['a', 'b'] } });
		expect(
			validateGroupChatCreate({ name: 'Review', participantIds: ['a'], message: ' Go ' })
		).toEqual({ ok: true, value: { name: 'Review', participantIds: ['a'], message: 'Go' } });
	});

	it('needs a name and a participant', () => {
		expect(validateGroupChatCreate({ name: ' ', participantIds: ['a'] })).toMatchObject({
			ok: false,
			reason: expect.stringContaining('name'),
		});
		expect(validateGroupChatCreate({ name: 'x', participantIds: [] })).toMatchObject({
			ok: false,
			reason: expect.stringContaining('participant'),
		});
	});
});
