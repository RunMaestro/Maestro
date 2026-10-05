import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { render } from 'ink-testing-library';
import {
	makeGroupChatLine,
	type AgentRecord,
	type GroupChatEvent,
	type GroupChatRecord,
} from '../../shared/maestro-lib';
import { App } from '../App';
import { createFakeClient, type FakeClientOptions } from './fakeClient';
import {
	RECORDED_CHAT_ID,
	recordedChatBefore,
	recordedRound,
	recordedRoundUntil,
} from './fixtures/groupChatReplay';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const ENTER = '\r';
const ESC = '\u001B';
const TAB = '\t';
const CTRL_S = '\u0013';
const CTRL_X = '\u0018';
const CTRL_C = '\u0003';
const SPACE = ' ';
const BASE = Date.now();

const AGENTS = (): AgentRecord[] => [
	{
		id: 'a1',
		name: 'Alpha',
		toolType: 'claude-code',
		state: 'idle',
		aiTabs: [{ id: 't1', name: 'one' }],
	},
	{ id: 'a2', name: 'Beta', toolType: 'codex', state: 'idle', aiTabs: [{ id: 't2', name: 'two' }] },
	{ id: 'a3', name: 'Shell', toolType: 'terminal', state: 'idle', aiTabs: [] },
];

describe('group chats in the TUI (GC-1 to GC-4)', () => {
	let dir: string;

	const mount = async (options: FakeClientOptions = {}, withClient = true) => {
		const fake = createFakeClient({
			agents: AGENTS(),
			groupChats: [recordedChatBefore(BASE)],
			...options,
		});
		const instance = render(
			<App
				paths={{
					userDataDir: dir,
					sessionsFile: path.join(dir, 'maestro-sessions.json'),
					groupsFile: path.join(dir, 'maestro-groups.json'),
					settingsFile: path.join(dir, 'maestro-settings.json'),
					agentConfigsFile: path.join(dir, 'maestro-agent-configs.json'),
					historyDir: path.join(dir, 'history'),
				}}
				client={withClient ? fake.client : undefined}
			/>
		);
		await tick();
		const stdout = instance.stdout as unknown as { emit: (event: string) => boolean };
		Object.defineProperty(stdout, 'columns', { value: 140, configurable: true });
		Object.defineProperty(stdout, 'rows', { value: 40, configurable: true });
		stdout.emit('resize');
		await tick();
		const press = async (...keys: string[]) => {
			for (const key of keys) {
				instance.stdin.write(key);
				await tick();
			}
		};
		/** Delivers chat events the way the client does: as `groupChat` events for the chat. */
		const replay = async (events: GroupChatEvent[], chatId = RECORDED_CHAT_ID) => {
			for (const event of events) fake.push({ type: 'groupChat', chatId, event });
			await tick();
		};
		return { ...instance, fake, press, replay, frame: () => instance.lastFrame() ?? '' };
	};

	const sends = (m: Awaited<ReturnType<typeof mount>>, method: string) =>
		m.fake.requests.filter((request) => request.method === method);

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-tui-groupchat-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('the list', () => {
		it('opens on c and shows each chat with its moderator, roster, and status', async () => {
			const m = await mount();
			await m.press('c');
			expect(m.frame()).toContain('Group chats');
			expect(m.frame()).toContain('Release review');
			expect(m.frame()).toContain('Claude Code: Alpha, Beta');
			expect(m.frame()).toContain('idle');
			m.unmount();
		});

		it('is in the command palette, and says so when no desktop is attached', async () => {
			const withHost = await mount();
			await withHost.press('\u000b');
			for (const letter of 'group chats') await withHost.press(letter);
			expect(withHost.frame()).toContain('Group chats');
			withHost.unmount();

			const m = await mount({}, false);
			await m.press('c');
			expect(m.frame()).toContain('read-only');
			expect(m.frame()).not.toContain('Release review');
			m.unmount();
		});

		it('shows a chat that starts working while the list is open', async () => {
			const m = await mount();
			await m.press('c');
			await m.replay(recordedRoundUntil(BASE, 6));
			expect(m.frame()).toContain('2 working');
			await m.replay(recordedRound(BASE));
			expect(m.frame()).toContain('idle');
			m.unmount();
		});

		it('says why the list could not load', async () => {
			const m = await mount({ failures: { 'groupChats.list': 'host-lost' } });
			await m.press('c');
			expect(m.frame()).toContain('fake host-lost');
			expect(m.frame()).not.toContain('Group chats');
			m.unmount();
		});

		it('lists a chat that is working first, and an empty list points at n', async () => {
			const busy: GroupChatRecord = {
				...recordedChatBefore(BASE),
				id: 'busy-1',
				name: 'Zulu',
				state: 'agent-working',
			};
			const m = await mount({ groupChats: [recordedChatBefore(BASE), busy] });
			await m.press('c');
			expect(m.frame().indexOf('Zulu')).toBeLessThan(m.frame().indexOf('Release review'));
			m.unmount();

			const empty = await mount({ groupChats: [] });
			await empty.press('c');
			expect(empty.frame()).toContain('No group chats yet. n creates one.');
			empty.unmount();
		});
	});

	describe('an open chat: addressing a participant (GC-5)', () => {
		const GAMMA: AgentRecord = {
			id: 'a4',
			name: 'Gamma',
			toolType: 'opencode',
			state: 'idle',
			aiTabs: [{ id: 't4', name: 'four' }],
		};
		const DOWN = '\u001B[B';

		/** The picker's rows, without the Agents pane drawn beside them. */
		const pickerRows = (frame: string): string => {
			const lines = frame.split('\n').map((line) => line.slice(28));
			const start = lines.findIndex((line) => line.includes('Address a participant'));
			const end = lines.findIndex((line, index) => index > start && line.includes('Enter send'));
			return lines.slice(start + 1, end).join('\n');
		};

		const openChat = async () => {
			const m = await mount({ agents: [...AGENTS(), GAMMA] });
			await m.press('c', ENTER);
			return m;
		};

		it('opens on @ with the participants first, then the agents the moderator could add', async () => {
			const m = await openChat();
			await m.press('@');
			expect(m.frame()).toContain('Address a participant, or add an agent');
			const rows = pickerRows(m.frame());
			expect(rows.indexOf('Alpha')).toBeGreaterThanOrEqual(0);
			expect(rows.indexOf('Alpha')).toBeLessThan(rows.indexOf('Gamma'));
			expect(rows.indexOf('Beta')).toBeLessThan(rows.indexOf('Gamma'));
			// A terminal is never a candidate.
			expect(rows).not.toContain('Shell');
			m.unmount();
		});

		it('narrows as you type, and Tab inserts the name and carries on typing', async () => {
			const m = await openChat();
			await m.press('@', 'b', 'e');
			expect(pickerRows(m.frame())).toContain('Beta');
			expect(pickerRows(m.frame())).not.toContain('Gamma');
			await m.press(TAB);
			expect(m.frame()).toContain('@Beta');
			expect(m.frame()).not.toContain('Address a participant');
			await m.press('p', 'l', 'e', 'a', 's', 'e');
			await m.press(ENTER);
			expect(sends(m, 'groupChats.send').map((request) => request.args)).toEqual([
				[RECORDED_CHAT_ID, '@Beta please'],
			]);
			m.unmount();
		});

		it('takes Enter as insert, not send, while the picker is open', async () => {
			const m = await openChat();
			await m.press('@', 'a');
			await m.press(ENTER);
			expect(sends(m, 'groupChats.send')).toEqual([]);
			expect(m.frame()).toContain('@Alpha');
			m.unmount();
		});

		it('moves the highlight with the arrows', async () => {
			const m = await openChat();
			await m.press('@', DOWN, TAB);
			expect(m.frame()).toContain('@Beta');
			m.unmount();
		});

		it('closes on Esc keeping the text, and the next Esc leaves the chat', async () => {
			const m = await openChat();
			await m.press('h', 'i', SPACE, '@');
			expect(m.frame()).toContain('Address a participant');
			await m.press(ESC);
			expect(m.frame()).not.toContain('Address a participant');
			expect(m.frame()).toContain('Group chat: Release review');
			expect(m.frame()).toContain('hi @');
			await m.press(ESC);
			expect(m.frame()).toContain('Group chats');
			m.unmount();
		});
	});

	describe('an open chat: watching a round (GC-2, GC-3)', () => {
		const openChat = async (m: Awaited<ReturnType<typeof mount>>) => {
			await m.press('c', ENTER);
		};

		it('opens on the log, with the roster', async () => {
			const m = await mount();
			await openChat(m);
			expect(m.frame()).toContain('Group chat: Release review');
			expect(m.frame()).toContain('Is the changelog ready?');
			expect(m.frame()).toContain('Yes, the changelog is ready.');
			expect(m.frame()).toContain('Moderator');
			expect(m.frame()).toContain('○ Alpha');
			expect(m.frame()).toContain('○ Beta');
			expect(m.frame()).toContain('Idle: send a message to start a round.');
			m.unmount();
		});

		it('replays a recorded round: routing, per-participant status, replies, and the synthesis', async () => {
			const m = await mount();
			await openChat(m);

			await m.replay(recordedRoundUntil(BASE, 4));
			expect(m.frame()).toContain('Can we ship 1.4 today?');
			expect(m.frame()).toContain('Asking @Alpha and @Beta.');

			// Both participants are working.
			await m.replay(recordedRound(BASE).slice(4, 6));
			expect(m.frame()).toContain('● Alpha');
			expect(m.frame()).toContain('● Beta');
			expect(m.frame()).toContain('Waiting on Alpha, Beta.');

			// Alpha replies first; Beta is still working.
			await m.replay(recordedRound(BASE).slice(6, 8));
			expect(m.frame()).toContain('Tests are green on main.');
			expect(m.frame()).toContain('○ Alpha');
			expect(m.frame()).toContain('● Beta');
			expect(m.frame()).toContain('Waiting on Beta.');

			await m.replay(recordedRound(BASE).slice(8));
			expect(m.frame()).toContain('The migration still needs a review.');
			expect(m.frame()).toContain('Not yet: review the migration first, then ship.');
			expect(m.frame()).toContain('○ Beta');
			expect(m.frame()).toContain('Idle: send a message to start a round.');
			m.unmount();
		});

		it('sends a message to the moderator while the chat is idle', async () => {
			const m = await mount();
			await openChat(m);
			for (const letter of 'Ship it?') await m.press(letter === ' ' ? SPACE : letter);
			expect(m.frame()).toContain('Ship it?');
			await m.press(ENTER);
			expect(sends(m, 'groupChats.send').map((request) => request.args)).toEqual([
				[RECORDED_CHAT_ID, 'Ship it?'],
			]);
			// Sent: the box is empty again.
			expect(m.frame()).toContain('Type a message');
			m.unmount();
		});

		it('keeps the draft and sends nothing while a round is running', async () => {
			const m = await mount();
			await openChat(m);
			await m.replay(recordedRoundUntil(BASE, 5));
			await m.press('h', 'i', ENTER);
			expect(sends(m, 'groupChats.send')).toEqual([]);
			expect(m.frame()).toContain('The chat is working');
			expect(m.frame()).toContain('hi');
			// Once the round ends the same draft goes.
			await m.replay(recordedRound(BASE).slice(5));
			await m.press(ENTER);
			expect(sends(m, 'groupChats.send').map((request) => request.args)).toEqual([
				[RECORDED_CHAT_ID, 'hi'],
			]);
			m.unmount();
		});

		it('puts the draft back and shows the host words when the send is refused', async () => {
			const m = await mount({ failures: { 'groupChats.send': 'rejected' } });
			await openChat(m);
			await m.press('o', 'k', ENTER);
			expect(sends(m, 'groupChats.send')).toHaveLength(1);
			expect(m.frame()).toContain('fake rejected');
			expect(m.frame()).toMatch(/›\s+ok/);
			m.unmount();
		});

		it('stops the round with Ctrl-X, and says there is nothing to stop when idle', async () => {
			const m = await mount();
			await openChat(m);
			await m.press(CTRL_X);
			expect(sends(m, 'groupChats.stop')).toEqual([]);
			expect(m.frame()).toContain('The chat is not running.');

			await m.replay(recordedRoundUntil(BASE, 6));
			expect(m.frame()).toContain('Ctrl-X stop the round');
			await m.press(CTRL_X);
			expect(sends(m, 'groupChats.stop').map((request) => request.args)).toEqual([
				[RECORDED_CHAT_ID],
			]);
			expect(m.frame()).toContain('Stopped Release review.');
			m.unmount();
		});

		it('stops the round with Ctrl-C while it runs', async () => {
			const m = await mount();
			await openChat(m);
			await m.replay(recordedRoundUntil(BASE, 6));
			await m.press(CTRL_C);
			expect(sends(m, 'groupChats.stop')).toHaveLength(1);
			expect(m.frame()).toContain('Stopped Release review.');
			m.unmount();
		});

		it('reads the chat again when events were missed, and shows what it had not heard', async () => {
			const m = await mount();
			await openChat(m);
			expect(m.fake.chatReads).toEqual([RECORDED_CHAT_ID]);
			// The host has a line this client never heard.
			m.fake.groupChats[0].lines = [
				...m.fake.groupChats[0].lines,
				makeGroupChatLine('Beta', 'I finished while you were away.', BASE),
			];
			await m.replay([{ kind: 'gap', at: Date.now() }]);
			await tick(60);
			expect(m.fake.chatReads).toEqual([RECORDED_CHAT_ID, RECORDED_CHAT_ID]);
			expect(m.frame()).toContain('I finished while you were away.');
			m.unmount();
		});

		it('goes back to the list on Esc', async () => {
			const m = await mount();
			await openChat(m);
			await m.press(ESC);
			expect(m.frame()).toContain('Group chats');
			expect(m.frame()).not.toContain('Group chat: Release review');
			await m.press(ESC);
			expect(m.frame()).not.toContain('Group chats');
			m.unmount();
		});
	});

	describe('creating a chat (GC-1)', () => {
		it('names the chat, picks participants in order, and creates it with the right call', async () => {
			const m = await mount();
			await m.press('c', 'n');
			expect(m.frame()).toContain('New group chat');
			// Two rows to pick: the terminal agent cannot join.
			expect(m.frame().match(/\[ \]/g)).toHaveLength(2);
			for (const letter of 'Planning') await m.press(letter);
			await m.press(TAB);
			for (const letter of 'Plan') await m.press(letter);
			// Moderator, then the first participant row.
			await m.press(TAB, TAB);
			// Pick Beta first, then Alpha: the order picked.
			await m.press('\u001B[B');
			await m.press(SPACE);
			await m.press('\u001B[A');
			await m.press(SPACE);
			expect(m.frame()).toContain('2 picked');
			await m.press(CTRL_S);
			await tick(60);

			expect(sends(m, 'groupChats.create').map((request) => request.args)).toEqual([
				[{ name: 'Planning', participantIds: ['a2', 'a1'], message: 'Plan' }],
			]);
			// The new chat opens, running.
			expect(m.frame()).toContain('Group chat: Planning');
			expect(m.frame()).toContain('The moderator is reading the message and routing it.');
			m.unmount();
		});

		it('sends the moderator agent chosen with the arrow keys', async () => {
			const m = await mount();
			await m.press('c', 'n', 'x', TAB, TAB);
			expect(m.frame()).toContain('first participant');
			await m.press('\u001B[C');
			expect(m.frame()).toContain('Alpha (Claude Code)');
			await m.press(TAB, SPACE, CTRL_S);
			await tick(60);
			expect(sends(m, 'groupChats.create')[0].args).toEqual([
				{ name: 'x', moderatorAgentId: 'a1', participantIds: ['a1'] },
			]);
			m.unmount();
		});

		it('refuses a form with no name or no participant, and shows the host refusal', async () => {
			const m = await mount({ failures: { 'groupChats.create': 'rejected' } });
			await m.press('c', 'n', CTRL_S);
			expect(m.frame()).toContain('The chat needs a name.');
			await m.press('x', CTRL_S);
			expect(m.frame()).toContain('Pick at least one participant.');
			expect(sends(m, 'groupChats.create')).toEqual([]);

			await m.press(TAB, TAB, TAB, SPACE, CTRL_S);
			await tick(60);
			expect(sends(m, 'groupChats.create')).toHaveLength(1);
			expect(m.frame()).toContain('fake rejected');
			expect(m.frame()).toContain('New group chat');
			m.unmount();
		});

		it('opens the form from the palette with no list open yet', async () => {
			const m = await mount();
			await m.press('\u000b');
			for (const letter of 'new group chat') await m.press(letter);
			await m.press(ENTER);
			await tick(60);
			expect(m.frame()).toContain('New group chat');
			m.unmount();
		});
	});

	describe('renaming and deleting (GC-1)', () => {
		it('renames the highlighted chat and returns to the list under its new name', async () => {
			const m = await mount();
			await m.press('c', 'R');
			expect(m.frame()).toContain('Rename group chat: Release review');
			for (let i = 0; i < 'Release review'.length; i += 1) await m.press('\u007f');
			for (const letter of 'Shipping') await m.press(letter);
			await m.press(ENTER);
			await tick(60);
			expect(sends(m, 'groupChats.rename').map((request) => request.args)).toEqual([
				[RECORDED_CHAT_ID, 'Shipping'],
			]);
			expect(m.frame()).toContain('Group chats');
			expect(m.frame()).toContain('Shipping');
			expect(m.frame()).toContain('Renamed group chat Release review to Shipping.');
			m.unmount();
		});

		it('says what a delete removes and keeps, and returns to the list afterwards', async () => {
			const m = await mount();
			await m.press('c', 'X');
			expect(m.frame()).toContain('Delete group chat: Release review');
			expect(m.frame()).toContain('Its log and the images in it');
			expect(m.frame()).toContain('All 2 agents that took part');
			await m.press('y');
			await tick(60);
			expect(sends(m, 'groupChats.remove').map((request) => request.args)).toEqual([
				[RECORDED_CHAT_ID],
			]);
			expect(m.frame()).toContain('Group chats');
			expect(m.frame()).toContain('No group chats yet.');
			expect(m.frame()).toContain('Deleted group chat Release review.');
			m.unmount();
		});

		it('warns when a round is running, and Esc goes back to the list with nothing deleted', async () => {
			const busy: GroupChatRecord = { ...recordedChatBefore(BASE), state: 'agent-working' };
			const m = await mount({ groupChats: [busy] });
			await m.press('c', 'X');
			expect(m.frame()).toContain('A round is running. It is stopped first.');
			await m.press(ESC);
			expect(sends(m, 'groupChats.remove')).toEqual([]);
			expect(m.frame()).toContain('Group chats');
			expect(m.frame()).toContain('Release review');
			m.unmount();
		});
	});
});
