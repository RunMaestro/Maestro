// Covers the quick_chat WebSocket message that backs `maestro-cli quick-chat`.
// The handler decides nothing: it maps a CLI action onto the same controller
// call the Quick Chat window's buttons make, and ALWAYS answers with the
// request id attached so the CLI on the far end never hangs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { EMPTY_QUICK_CHAT_SNAPSHOT } from '../../../../shared/quickChat';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

const status = {
	enabled: true,
	visible: true,
	hotkey: ['Alt', 'Space'],
	hotkeyRegistered: true,
	bounds: null,
	pinned: true,
	fontScale: 1,
	snapshot: EMPTY_QUICK_CHAT_SNAPSHOT,
};
const controller = {
	init: vi.fn(),
	runCommand: vi.fn(),
	windowAction: vi.fn(),
	setBounds: vi.fn(),
	setPinned: vi.fn(),
	setFontScale: vi.fn(),
	getStatus: vi.fn(),
	getRecents: vi.fn(),
	recall: vi.fn(),
};
let activeController: typeof controller | null = controller;

vi.mock('../../../../main/quick-chat', () => ({
	getQuickChatController: () => activeController,
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type {
	WebClient,
	WebClientMessage,
} from '../../../../main/web-server/handlers/messageHandlers';

function createMockClient(): WebClient {
	return {
		socket: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
	};
}

function lastResponse(client: WebClient): Record<string, unknown> {
	const calls = (client.socket.send as ReturnType<typeof vi.fn>).mock.calls;
	return JSON.parse(calls[calls.length - 1][0] as string);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('quick_chat handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;

	beforeEach(() => {
		vi.clearAllMocks();
		activeController = controller;
		controller.getStatus.mockReturnValue(status);
		controller.windowAction.mockReturnValue(status);
		controller.setBounds.mockReturnValue(status);
		controller.setPinned.mockReturnValue(status);
		controller.setFontScale.mockReturnValue(status);
		controller.runCommand.mockResolvedValue({ ok: true, snapshot: EMPTY_QUICK_CHAT_SNAPSHOT });
		controller.getRecents.mockReturnValue([]);
		controller.recall.mockResolvedValue({ ok: true, snapshot: EMPTY_QUICK_CHAT_SNAPSHOT });
		handler = new WebSocketMessageHandler();
		client = createMockClient();
	});

	it('reports status with the request id', () => {
		handler.handleMessage(client, { type: 'quick_chat', action: 'status', requestId: 'r1' });
		expect(lastResponse(client)).toMatchObject({
			type: 'quick_chat_result',
			success: true,
			requestId: 'r1',
			status: { hotkey: ['Alt', 'Space'] },
		});
	});

	it.each(['show', 'hide', 'toggle', 'return'] as const)('runs the %s window action', (action) => {
		handler.handleMessage(client, { type: 'quick_chat', action, requestId: 'r2' });
		expect(controller.windowAction).toHaveBeenCalledWith(action);
		expect(lastResponse(client)).toMatchObject({ success: true, requestId: 'r2' });
	});

	it('fails show when the feature is off', () => {
		controller.windowAction.mockReturnValue({ ...status, enabled: false });
		handler.handleMessage(client, { type: 'quick_chat', action: 'show', requestId: 'r3' });
		expect(lastResponse(client)).toMatchObject({ success: false, requestId: 'r3' });
	});

	it.each(['hide', 'return'] as const)('still succeeds at %s when the feature is off', (action) => {
		controller.windowAction.mockReturnValue({ ...status, enabled: false });
		handler.handleMessage(client, { type: 'quick_chat', action, requestId: 'r3b' });
		expect(controller.windowAction).toHaveBeenCalledWith(action);
		expect(lastResponse(client)).toMatchObject({ success: true, requestId: 'r3b' });
	});

	it.each([
		[
			{ action: 'send', text: 'hello' },
			{ type: 'send', text: 'hello' },
		],
		[
			{ action: 'send', text: 'look', images: ['data:image/png;base64,AAAA'] },
			{ type: 'send', text: 'look', images: ['data:image/png;base64,AAAA'] },
		],
		[
			{ action: 'send', images: ['data:image/webp;base64,BBBB'] },
			{ type: 'send', text: '', images: ['data:image/webp;base64,BBBB'] },
		],
		[{ action: 'new' }, { type: 'new' }],
		[{ action: 'keep' }, { type: 'setPersistent', persistent: true }],
		[
			{ action: 'keep', persistent: false },
			{ type: 'setPersistent', persistent: false },
		],
		[
			{ action: 'agent', agentId: 'a1' },
			{ type: 'setAgent', agentId: 'a1' },
		],
		[{ action: 'reveal' }, { type: 'reveal' }],
		[{ action: 'stop' }, { type: 'stop' }],
		[
			{ action: 'tab', tab: 'new' },
			{ type: 'setTab', choice: { kind: 'new' } },
		],
		[
			{ action: 'tab', tab: ' AUTO ' },
			{ type: 'setTab', choice: { kind: 'auto' } },
		],
		[
			{ action: 'tab', tab: 'tab-7' },
			{ type: 'setTab', choice: { kind: 'tab', tabId: 'tab-7' } },
		],
		[
			{ action: 'thinking', mode: 'sticky' },
			{ type: 'setThinking', mode: 'sticky' },
		],
		[
			{ action: 'thinking', mode: 'cycle' },
			{ type: 'setThinking', mode: 'cycle' },
		],
	])('maps %o onto the engine command %o', async (message, command) => {
		handler.handleMessage(client, {
			type: 'quick_chat',
			requestId: 'r4',
			...message,
		} as WebClientMessage);
		await flush();
		expect(controller.runCommand).toHaveBeenCalledWith(command);
		expect(lastResponse(client)).toMatchObject({ success: true, requestId: 'r4' });
	});

	it('passes the engine error through', async () => {
		controller.runCommand.mockResolvedValue({
			ok: false,
			error: 'Wait for the reply',
			snapshot: EMPTY_QUICK_CHAT_SNAPSHOT,
		});
		handler.handleMessage(client, {
			type: 'quick_chat',
			action: 'send',
			text: 'x',
			requestId: 'r5',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			success: false,
			error: 'Wait for the reply',
			requestId: 'r5',
		});
	});

	it('rejects an empty message and an unknown action without calling the engine', () => {
		handler.handleMessage(client, {
			type: 'quick_chat',
			action: 'send',
			text: ' ',
			requestId: 'r6',
		});
		expect(lastResponse(client)).toMatchObject({ success: false, requestId: 'r6' });
		handler.handleMessage(client, { type: 'quick_chat', action: 'bogus', requestId: 'r7' });
		expect(lastResponse(client)).toMatchObject({ success: false, requestId: 'r7' });
		expect(controller.runCommand).not.toHaveBeenCalled();
	});

	it('rejects images that are not data:image URLs without calling the engine', () => {
		handler.handleMessage(client, {
			type: 'quick_chat',
			action: 'send',
			text: 'look',
			images: ['/tmp/shot.png'],
			requestId: 'r8',
		});
		expect(lastResponse(client)).toMatchObject({
			success: false,
			error: 'Images must be data:image URLs',
			requestId: 'r8',
		});
		expect(controller.runCommand).not.toHaveBeenCalled();
	});

	it('answers when the controller does not exist yet', () => {
		activeController = null;
		handler.handleMessage(client, { type: 'quick_chat', action: 'status', requestId: 'r8' });
		expect(lastResponse(client)).toMatchObject({ success: false, requestId: 'r8' });
	});

	it('moves and resizes the window through the controller', () => {
		handler.handleMessage(client, {
			type: 'quick_chat',
			action: 'bounds',
			x: 100,
			y: 50,
			width: 700,
			requestId: 'r9',
		});
		expect(controller.setBounds).toHaveBeenCalledWith({ x: 100, y: 50, width: 700 });
		expect(lastResponse(client)).toMatchObject({ success: true, requestId: 'r9' });
	});

	it('refuses bounds a drag could not produce, without touching the window', () => {
		handler.handleMessage(client, {
			type: 'quick_chat',
			action: 'bounds',
			width: 10,
			requestId: 'r10',
		});
		expect(controller.setBounds).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({ success: false, requestId: 'r10' });
	});

	it('pins and unpins the window through the controller', () => {
		handler.handleMessage(client, {
			type: 'quick_chat',
			action: 'pin',
			pinned: false,
			requestId: 'r11',
		});
		expect(controller.setPinned).toHaveBeenCalledWith(false);
		expect(lastResponse(client)).toMatchObject({ success: true, requestId: 'r11' });

		handler.handleMessage(client, { type: 'quick_chat', action: 'pin', requestId: 'r12' });
		expect(controller.setPinned).toHaveBeenLastCalledWith(true);
	});

	it('changes the text zoom through the controller, and reads it with no request', () => {
		handler.handleMessage(client, {
			type: 'quick_chat',
			action: 'font',
			fontScale: { step: 1 },
			requestId: 'r13',
		});
		expect(controller.setFontScale).toHaveBeenCalledWith({ step: 1 });
		expect(lastResponse(client)).toMatchObject({ success: true, requestId: 'r13' });

		handler.handleMessage(client, { type: 'quick_chat', action: 'font', requestId: 'r14' });
		expect(controller.setFontScale).toHaveBeenCalledTimes(1);
		expect(lastResponse(client)).toMatchObject({ success: true, requestId: 'r14' });
		expect(lastResponse(client).status).toMatchObject({ fontScale: 1 });
	});

	it('rejects a malformed text zoom request instead of ignoring it', () => {
		handler.handleMessage(client, {
			type: 'quick_chat',
			action: 'font',
			fontScale: { step: 3 },
			requestId: 'r15',
		});
		expect(controller.setFontScale).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({ success: false, requestId: 'r15' });
	});

	it.each(['tab', 'thinking'] as const)(
		'reads the current setting for a bare %s without calling the engine',
		(action) => {
			handler.handleMessage(client, { type: 'quick_chat', action, requestId: 'r20' });
			expect(controller.runCommand).not.toHaveBeenCalled();
			expect(lastResponse(client)).toMatchObject({
				success: true,
				requestId: 'r20',
				status: { snapshot: { thinking: 'off', next: { kind: 'auto' } } },
			});
		}
	);

	it.each([
		{ action: 'tab', tab: '  ' },
		{ action: 'thinking', mode: 'loud' },
	])('rejects %o without calling the engine', (message) => {
		handler.handleMessage(client, {
			type: 'quick_chat',
			requestId: 'r21',
			...message,
		} as WebClientMessage);
		expect(controller.runCommand).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({ success: false, requestId: 'r21' });
	});

	it('opens the tab a named message went to', async () => {
		handler.handleMessage(client, {
			type: 'quick_chat',
			action: 'reveal',
			messageId: 'm1',
			requestId: 'r16',
		});
		await flush();
		expect(controller.runCommand).toHaveBeenCalledWith({ type: 'reveal', messageId: 'm1' });
		expect(lastResponse(client)).toMatchObject({ success: true, requestId: 'r16' });
	});

	it('moves a queued message to a new tab, the latest when none is named', async () => {
		handler.handleMessage(client, { type: 'quick_chat', action: 'new-tab', requestId: 'r17' });
		await flush();
		expect(controller.runCommand).toHaveBeenLastCalledWith({ type: 'moveToNewTab' });

		handler.handleMessage(client, {
			type: 'quick_chat',
			action: 'new-tab',
			messageId: 'm7',
			requestId: 'r18',
		});
		await flush();
		expect(controller.runCommand).toHaveBeenLastCalledWith({
			type: 'moveToNewTab',
			messageId: 'm7',
		});
	});

	it('reports why a message could not be moved', async () => {
		controller.runCommand.mockResolvedValue({
			ok: false,
			error: 'That message is no longer waiting: it already started',
			snapshot: EMPTY_QUICK_CHAT_SNAPSHOT,
		});
		handler.handleMessage(client, { type: 'quick_chat', action: 'new-tab', requestId: 'r19' });
		await flush();
		expect(lastResponse(client)).toMatchObject({
			success: false,
			error: 'That message is no longer waiting: it already started',
		});
	});

	it('lists the recent chats with the status', () => {
		const recents = [{ id: 'c1', title: 'hello', messageCount: 1 }];
		controller.getRecents.mockReturnValue(recents);
		handler.handleMessage(client, { type: 'quick_chat', action: 'history', requestId: 'r20' });
		expect(lastResponse(client)).toMatchObject({
			success: true,
			requestId: 'r20',
			recents,
			status: { hotkey: ['Alt', 'Space'] },
		});
	});

	it('recalls a chat by the reference the CLI gave', async () => {
		handler.handleMessage(client, {
			type: 'quick_chat',
			action: 'recall',
			chatId: '2',
			requestId: 'r21',
		});
		await flush();
		expect(controller.recall).toHaveBeenCalledWith('2');
		expect(lastResponse(client)).toMatchObject({ success: true, requestId: 'r21' });
	});

	it('reports why a chat could not be recalled', async () => {
		controller.recall.mockResolvedValue({
			ok: false,
			error: 'No recent chat zz',
			snapshot: EMPTY_QUICK_CHAT_SNAPSHOT,
		});
		handler.handleMessage(client, {
			type: 'quick_chat',
			action: 'recall',
			chatId: 'zz',
			requestId: 'r22',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			success: false,
			error: 'No recent chat zz',
			requestId: 'r22',
		});
	});
});
