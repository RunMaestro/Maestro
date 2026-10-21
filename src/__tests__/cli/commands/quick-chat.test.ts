/**
 * @file quick-chat.test.ts
 * @description `maestro-cli quick-chat font`: the words and sizes it accepts,
 * and the message it hands the desktop.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({ resolveAgentId: vi.fn((id: string) => id) }));

import {
	describeQuickChatNextTarget,
	parseQuickChatFontArg,
	parseQuickChatThinkingArg,
	quickChat,
} from '../../../cli/commands/quick-chat';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { EMPTY_QUICK_CHAT_SNAPSHOT } from '../../../shared/quickChat';

describe('parseQuickChatFontArg', () => {
	it.each([
		['in', { step: 1 }],
		['bigger', { step: 1 }],
		['+', { step: 1 }],
		['out', { step: -1 }],
		['smaller', { step: -1 }],
		['reset', { reset: true }],
		['120%', { scale: 1.2 }],
		['120', { scale: 1.2 }],
		['1.2', { scale: 1.2 }],
		['  OUT ', { step: -1 }],
	])('%s', (arg, expected) => {
		expect(parseQuickChatFontArg(arg)).toEqual(expected);
	});

	it.each(['bigg', '', 'abc%', '0', '-5'])('rejects %j', (arg) => {
		expect(() => parseQuickChatFontArg(arg)).toThrow(/Unknown text size/);
	});

	it('rejects a size outside 70%-200%', () => {
		expect(() => parseQuickChatFontArg('500%')).toThrow(/between 70% and 200%/);
		expect(() => parseQuickChatFontArg('0.5')).toThrow(/between 70% and 200%/);
	});
});

describe('parseQuickChatThinkingArg', () => {
	it.each([
		['off', 'off'],
		['on', 'on'],
		[' Sticky ', 'sticky'],
		['cycle', 'cycle'],
	])('%s', (arg, expected) => {
		expect(parseQuickChatThinkingArg(arg)).toBe(expected);
	});

	it.each(['', 'yes', 'pinned'])('rejects %j', (arg) => {
		expect(() => parseQuickChatThinkingArg(arg)).toThrow(/Unknown thinking mode/);
	});
});

describe('quickChat thinking', () => {
	let sendCommand: ReturnType<typeof vi.fn>;
	let log: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		sendCommand = vi.fn().mockResolvedValue({
			type: 'quick_chat_result',
			success: true,
			status: { fontScale: 1, snapshot: { ...EMPTY_QUICK_CHAT_SNAPSHOT, thinking: 'sticky' } },
		});
		vi.mocked(withMaestroClient).mockImplementation(async (fn) => fn({ sendCommand } as never));
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	it('sends the mode and prints the one now in effect', async () => {
		await quickChat('thinking', { state: 'sticky' }, {});
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'quick_chat', action: 'thinking', mode: 'sticky' },
			'quick_chat_result'
		);
		expect(log).toHaveBeenCalledWith('Thinking: sticky, kept above each answer');
	});

	it('with no mode, only reads it', async () => {
		await quickChat('thinking', {}, {});
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'quick_chat', action: 'thinking' },
			'quick_chat_result'
		);
	});
});

describe('quickChat tab', () => {
	let sendCommand: ReturnType<typeof vi.fn>;
	let log: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		sendCommand = vi.fn().mockResolvedValue({
			type: 'quick_chat_result',
			success: true,
			status: { fontScale: 1, snapshot: { ...EMPTY_QUICK_CHAT_SNAPSHOT, next: { kind: 'new' } } },
		});
		vi.mocked(withMaestroClient).mockImplementation(async (fn) => fn({ sendCommand } as never));
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	it('sends the target and prints where the next message goes', async () => {
		await quickChat('tab', { state: 'new' }, {});
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'quick_chat', action: 'tab', tab: 'new' },
			'quick_chat_result'
		);
		expect(log).toHaveBeenCalledWith('Next message goes to: a new tab');
	});

	it('with no target, only reads it', async () => {
		await quickChat('tab', {}, {});
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'quick_chat', action: 'tab' },
			'quick_chat_result'
		);
	});
});

describe('describeQuickChatNextTarget', () => {
	it('names a tab with its id, and says when it was chosen', () => {
		expect(
			describeQuickChatNextTarget({ kind: 'tab', tabId: 't1', name: 'Build', chosen: true })
		).toBe('tab "Build" (t1), chosen');
		expect(describeQuickChatNextTarget({ kind: 'auto' })).toMatch(/^any tab/);
	});
});

describe('quickChat font', () => {
	let sendCommand: ReturnType<typeof vi.fn>;
	let log: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		sendCommand = vi.fn().mockResolvedValue({
			type: 'quick_chat_result',
			success: true,
			status: { fontScale: 1.2, snapshot: EMPTY_QUICK_CHAT_SNAPSHOT },
		});
		vi.mocked(withMaestroClient).mockImplementation(async (fn) => fn({ sendCommand } as never));
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	it('sends the parsed request and prints the new size', async () => {
		await quickChat('font', { state: 'in' }, {});
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'quick_chat', action: 'font', fontScale: { step: 1 } },
			'quick_chat_result'
		);
		expect(log).toHaveBeenCalledWith('Text size: 120%');
	});

	it('with no size, only reads it', async () => {
		await quickChat('font', {}, {});
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'quick_chat', action: 'font' },
			'quick_chat_result'
		);
	});
});

describe('quickChat routing verbs', () => {
	let sendCommand: ReturnType<typeof vi.fn>;
	let log: MockInstance;

	const route = {
		status: 'queued' as const,
		tabId: 'tab-1',
		tabName: 'CI Build',
		origin: 'open' as const,
		tabOpen: true,
		since: null,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		sendCommand = vi.fn().mockResolvedValue({
			type: 'quick_chat_result',
			success: true,
			status: {
				enabled: true,
				visible: true,
				hotkey: [],
				hotkeyRegistered: true,
				bounds: null,
				pinned: true,
				fontScale: 1,
				snapshot: {
					...EMPTY_QUICK_CHAT_SNAPSHOT,
					messages: [
						{ id: 'm7', role: 'user', text: 'one more thing', timestamp: 0, route },
						{ id: 'r1', role: 'assistant', text: 'ok', timestamp: 0 },
					],
				},
			},
		});
		vi.mocked(withMaestroClient).mockImplementation(async (fn) => fn({ sendCommand } as never));
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	it('status names where each message went, with the id the other verbs take', async () => {
		await quickChat('status', {}, {});
		const printed = log.mock.calls.map(([line]) => line).join('\n');
		expect(printed).toContain('You [m7] (queued for open tab "CI Build"): one more thing');
		expect(printed).toContain('Agent: ok');
	});

	it('new-tab moves the named message, or the latest queued one', async () => {
		await quickChat('new-tab', { messageId: 'm7' }, {});
		expect(sendCommand).toHaveBeenLastCalledWith(
			{ type: 'quick_chat', action: 'new-tab', messageId: 'm7' },
			'quick_chat_result'
		);
		await quickChat('new-tab', {}, {});
		expect(sendCommand).toHaveBeenLastCalledWith(
			{ type: 'quick_chat', action: 'new-tab' },
			'quick_chat_result'
		);
	});

	it('steer hands the named message, or the latest steerable one, to the running reply', async () => {
		await quickChat('steer', { messageId: 'm7' }, {});
		expect(sendCommand).toHaveBeenLastCalledWith(
			{ type: 'quick_chat', action: 'steer', messageId: 'm7' },
			'quick_chat_result'
		);
		await quickChat('steer', {}, {});
		expect(sendCommand).toHaveBeenLastCalledWith(
			{ type: 'quick_chat', action: 'steer' },
			'quick_chat_result'
		);
	});

	it('reveal opens the tab a message went to', async () => {
		await quickChat('reveal', { messageId: 'm7' }, {});
		expect(sendCommand).toHaveBeenLastCalledWith(
			{ type: 'quick_chat', action: 'reveal', messageId: 'm7' },
			'quick_chat_result'
		);
	});
});

describe('quickChat send', () => {
	let sendCommand: ReturnType<typeof vi.fn>;
	let exit: MockInstance;
	let dir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		sendCommand = vi.fn().mockResolvedValue({
			type: 'quick_chat_result',
			success: true,
			status: { fontScale: 1, snapshot: EMPTY_QUICK_CHAT_SNAPSHOT },
		});
		vi.mocked(withMaestroClient).mockImplementation(async (fn) => fn({ sendCommand } as never));
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-chat-send-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('sends --image files as data URLs with the message', async () => {
		const shot = path.join(dir, 'shot.png');
		fs.writeFileSync(shot, Buffer.from('png-bytes'));
		await quickChat('send', { text: 'what is this?' }, { image: [shot] });
		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'quick_chat',
				action: 'send',
				text: 'what is this?',
				images: [`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`],
			},
			'quick_chat_result'
		);
	});

	it('sends images with no text', async () => {
		const shot = path.join(dir, 'shot.webp');
		fs.writeFileSync(shot, Buffer.from('webp'));
		await quickChat('send', { text: '' }, { image: [shot] });
		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ text: '', images: [expect.stringMatching(/^data:image\/webp;/)] }),
			'quick_chat_result'
		);
	});

	it('refuses a file that is not an image before sending anything', async () => {
		const notes = path.join(dir, 'notes.txt');
		fs.writeFileSync(notes, 'hi');
		await quickChat('send', { text: 'look' }, { image: [notes], json: true });
		expect(exit).toHaveBeenCalledWith(1);
		expect(sendCommand).not.toHaveBeenCalled();
	});

	it('status says how many images a message carried', async () => {
		const log = vi.mocked(console.log);
		sendCommand.mockResolvedValue({
			type: 'quick_chat_result',
			success: true,
			status: {
				enabled: true,
				visible: true,
				hotkey: [],
				hotkeyRegistered: true,
				bounds: null,
				pinned: true,
				fontScale: 1,
				snapshot: {
					...EMPTY_QUICK_CHAT_SNAPSHOT,
					messages: [
						{ id: 'm1', role: 'user', text: 'see these', timestamp: 0, images: ['a', 'b'] },
					],
				},
			},
		});
		await quickChat('status', {}, {});
		const printed = log.mock.calls.map(([line]) => line).join('\n');
		expect(printed).toContain('You [2 images]: see these');
	});

	it('refuses a message with neither text nor images', async () => {
		await quickChat('send', { text: '  ' }, { json: true });
		expect(exit).toHaveBeenCalledWith(1);
		expect(sendCommand).not.toHaveBeenCalled();
	});
});

describe('quickChat history and recall', () => {
	let sendCommand: ReturnType<typeof vi.fn>;
	let log: MockInstance;
	let exit: MockInstance;

	const recent = {
		id: 'chat-abc',
		agentId: 'agent-1',
		agentName: 'Pedsidian',
		title: 'what is on my calendar',
		tabName: 'Calendar',
		persistent: false,
		createdAt: 0,
		updatedAt: Date.now(),
		messageCount: 3,
		searchText: 'what is on my calendar',
	};

	beforeEach(() => {
		vi.clearAllMocks();
		sendCommand = vi.fn().mockResolvedValue({
			type: 'quick_chat_result',
			success: true,
			recents: [recent],
			status: {
				enabled: true,
				visible: true,
				hotkey: [],
				hotkeyRegistered: true,
				bounds: null,
				pinned: true,
				fontScale: 1,
				snapshot: { ...EMPTY_QUICK_CHAT_SNAPSHOT, chatId: 'chat-abc' },
			},
		});
		vi.mocked(withMaestroClient).mockImplementation(async (fn) => fn({ sendCommand } as never));
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
	});

	it('history numbers the chats as recall takes them, and marks the one in the window', async () => {
		await quickChat('history', {}, {});
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'quick_chat', action: 'history' },
			'quick_chat_result'
		);
		const printed = log.mock.calls.map(([line]) => line).join('\n');
		expect(printed).toContain('1. what is on my calendar (in the window now)');
		expect(printed).toContain('Pedsidian, 3 messages');
		expect(printed).toContain('[chat-abc]');
	});

	it('history --json prints the list', async () => {
		await quickChat('history', {}, { json: true });
		const printed = JSON.parse(log.mock.calls[0][0] as string);
		expect(printed).toMatchObject({ success: true, recents: [{ id: 'chat-abc' }] });
	});

	it('recall sends the reference as given', async () => {
		await quickChat('recall', { chatId: ' 1 ' }, {});
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'quick_chat', action: 'recall', chatId: '1' },
			'quick_chat_result'
		);
	});

	it('recall refuses an empty reference before sending anything', async () => {
		await quickChat('recall', { chatId: '  ' }, { json: true });
		expect(exit).toHaveBeenCalledWith(1);
		expect(sendCommand).not.toHaveBeenCalled();
	});
});
