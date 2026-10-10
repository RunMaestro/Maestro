// Covers the quick_chat WebSocket message that backs `maestro-cli quick-chat`.
// The handler decides nothing: it maps a CLI action onto the same controller
// call the Quick Chat window's buttons make, and ALWAYS answers with the
// request id attached so the CLI on the far end never hangs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
	snapshot: EMPTY_QUICK_CHAT_SNAPSHOT,
};
const controller = {
	init: vi.fn(),
	runCommand: vi.fn(),
	windowAction: vi.fn(),
	getStatus: vi.fn(),
};
let activeController: typeof controller | null = controller;

vi.mock('../../../../main/quick-chat', () => ({
	getQuickChatController: () => activeController,
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';

function createMockClient(): WebClient {
	return {
		socket: { send: vi.fn() } as unknown as WebClient['socket'],
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
		controller.runCommand.mockResolvedValue({ ok: true, snapshot: EMPTY_QUICK_CHAT_SNAPSHOT });
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

	it.each(['show', 'hide', 'toggle'] as const)('runs the %s window action', (action) => {
		handler.handleMessage(client, { type: 'quick_chat', action, requestId: 'r2' });
		expect(controller.windowAction).toHaveBeenCalledWith(action);
		expect(lastResponse(client)).toMatchObject({ success: true, requestId: 'r2' });
	});

	it('fails show when the feature is off', () => {
		controller.windowAction.mockReturnValue({ ...status, enabled: false });
		handler.handleMessage(client, { type: 'quick_chat', action: 'show', requestId: 'r3' });
		expect(lastResponse(client)).toMatchObject({ success: false, requestId: 'r3' });
	});

	it.each([
		[
			{ action: 'send', text: 'hello' },
			{ type: 'send', text: 'hello' },
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
	])('maps %o onto the engine command %o', async (message, command) => {
		handler.handleMessage(client, { type: 'quick_chat', requestId: 'r4', ...message });
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

	it('answers when the controller does not exist yet', () => {
		activeController = null;
		handler.handleMessage(client, { type: 'quick_chat', action: 'status', requestId: 'r8' });
		expect(lastResponse(client)).toMatchObject({ success: false, requestId: 'r8' });
	});
});
