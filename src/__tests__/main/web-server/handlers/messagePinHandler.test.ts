// Covers the message_pin_command WebSocket message behind `maestro-cli tab
// pins`. Pins live on the tab in the renderer, so this hop owes the caller
// three things: refuse a request the renderer would have to guess about,
// refuse an unknown agent by name, and ALWAYS answer with the request id,
// because the CLI blocks on it.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));
import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';
import WebSocket from 'ws';

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

/** Flush the promise chain the handler's `.then(...)` reply rides on. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const PIN = {
	id: 'pin-1',
	label: 'Key decision',
	title: 'Key decision',
	renamed: false,
	source: 'stdout',
	timestamp: 1,
	pinnedAt: 2,
	messageId: 'log-1',
	loaded: true,
};

describe('message_pin_command handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let messagePinCommand: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		messagePinCommand = vi.fn().mockResolvedValue({ success: true, pin: PIN, pins: [PIN] });
		handler.setCallbacks({
			messagePinCommand,
			getSessionDetail: vi.fn(() => ({ id: 'agent-1' })),
		} as never);
	});

	it('forwards a validated add and replies with the pins and the request id', async () => {
		handler.handleMessage(client, {
			type: 'message_pin_command',
			requestId: 'req-1',
			action: 'add',
			sessionId: 'agent-1',
			tabId: 'tab-1',
			last: 'agent',
		});
		await flush();

		expect(messagePinCommand).toHaveBeenCalledWith({
			action: 'add',
			sessionId: 'agent-1',
			tabId: 'tab-1',
			last: 'agent',
		});
		expect(lastResponse(client)).toMatchObject({
			type: 'message_pin_command_result',
			requestId: 'req-1',
			success: true,
			pin: PIN,
			pins: [PIN],
		});
	});

	it('refuses an add that names both a message and --last without reaching the renderer', () => {
		handler.handleMessage(client, {
			type: 'message_pin_command',
			requestId: 'req-2',
			action: 'add',
			sessionId: 'agent-1',
			tabId: 'tab-1',
			messageId: 'log-1',
			last: 'user',
		});

		expect(messagePinCommand).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			type: 'message_pin_command_result',
			requestId: 'req-2',
			success: false,
			error: 'Name the message by id or by --last, not both',
		});
	});

	it('refuses an unknown agent by name', () => {
		handler.setCallbacks({ messagePinCommand, getSessionDetail: vi.fn(() => undefined) } as never);
		handler.handleMessage(client, {
			type: 'message_pin_command',
			requestId: 'req-3',
			action: 'list',
			sessionId: 'ghost-agent',
			tabId: 'tab-1',
		});

		expect(messagePinCommand).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'req-3',
			success: false,
			error: 'Session not found: ghost-agent',
		});
	});

	it('answers when no renderer callback is wired', () => {
		// setCallbacks merges, so start from a handler that never had one.
		handler = new WebSocketMessageHandler();
		handler.setCallbacks({ getSessionDetail: vi.fn(() => ({ id: 'agent-1' })) } as never);
		handler.handleMessage(client, {
			type: 'message_pin_command',
			requestId: 'req-4',
			action: 'list',
			sessionId: 'agent-1',
			tabId: 'tab-1',
		});

		expect(lastResponse(client)).toMatchObject({
			requestId: 'req-4',
			success: false,
			error: 'Message pins are not configured',
		});
	});

	it('answers rather than hanging when the renderer round trip rejects', async () => {
		messagePinCommand.mockRejectedValue(new Error('window closed'));
		handler.handleMessage(client, {
			type: 'message_pin_command',
			requestId: 'req-5',
			action: 'remove',
			sessionId: 'agent-1',
			tabId: 'tab-1',
			pinId: 'pin-1',
		});
		await flush();

		expect(lastResponse(client)).toMatchObject({
			requestId: 'req-5',
			success: false,
			error: 'Pin remove failed: window closed',
		});
	});
});
