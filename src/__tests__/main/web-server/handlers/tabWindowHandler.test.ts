// Covers the tab_window_command WebSocket message behind `maestro-cli tab
// pop-out`, `tab dock`, and `tab windows` (Tab Windows, TW-12). Nothing is
// decided at this hop: it validates the request, forwards it to the callback,
// and ALWAYS answers with the request id attached, because the CLI process on
// the far end blocks on that reply.

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

/** Flush the promise chain the handler's `.then(...)` reply rides on. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('tab_window_command handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let tabWindowCommand: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		tabWindowCommand = vi.fn().mockResolvedValue({ success: true, windowId: 'tw-1' });
		handler.setCallbacks({ tabWindowCommand } as never);
	});

	it('forwards a pop-out with its agent, tab, and background bit, and echoes the request id', async () => {
		handler.handleMessage(client, {
			type: 'tab_window_command',
			requestId: 'req-1',
			action: 'pop-out',
			sessionId: 'agent-1',
			tabId: ' tab-1 ',
			background: true,
		});
		await flush();

		expect(tabWindowCommand).toHaveBeenCalledWith({
			action: 'pop-out',
			sessionId: 'agent-1',
			tabId: 'tab-1',
			background: true,
		});
		expect(lastResponse(client)).toMatchObject({
			type: 'tab_window_command_result',
			success: true,
			windowId: 'tw-1',
			requestId: 'req-1',
		});
	});

	it('reads only a literal true as background', async () => {
		handler.handleMessage(client, {
			type: 'tab_window_command',
			requestId: 'req-2',
			action: 'pop-out',
			tabId: 'tab-1',
			background: 'yes',
		});
		await flush();
		expect(tabWindowCommand).toHaveBeenCalledWith({
			action: 'pop-out',
			tabId: 'tab-1',
			background: false,
		});
	});

	it('forwards a dock without a background bit and a list with nothing else', async () => {
		handler.handleMessage(client, {
			type: 'tab_window_command',
			requestId: 'req-3',
			action: 'dock',
			tabId: 'tab-1',
			background: true,
		});
		handler.handleMessage(client, {
			type: 'tab_window_command',
			requestId: 'req-4',
			action: 'list',
		});
		await flush();
		expect(tabWindowCommand).toHaveBeenNthCalledWith(1, { action: 'dock', tabId: 'tab-1' });
		expect(tabWindowCommand).toHaveBeenNthCalledWith(2, { action: 'list' });
	});

	it('refuses an unknown action and a missing tab id without calling back', async () => {
		handler.handleMessage(client, { type: 'tab_window_command', requestId: 'r', action: 'fly' });
		expect(lastResponse(client)).toMatchObject({ success: false, requestId: 'r' });
		expect(lastResponse(client).error).toMatch(/pop-out, dock, list/);

		handler.handleMessage(client, { type: 'tab_window_command', requestId: 's', action: 'dock' });
		expect(lastResponse(client)).toMatchObject({
			type: 'tab_window_command_result',
			success: false,
			error: 'tab dock requires a tab id',
			requestId: 's',
		});
		expect(tabWindowCommand).not.toHaveBeenCalled();
	});

	it('answers a rejected callback with the request id', async () => {
		tabWindowCommand.mockRejectedValue(new Error('boom'));
		handler.handleMessage(client, {
			type: 'tab_window_command',
			requestId: 'req-5',
			action: 'pop-out',
			tabId: 'tab-1',
		});
		await flush();
		expect(lastResponse(client)).toMatchObject({
			type: 'tab_window_command_result',
			success: false,
			error: 'Tab pop-out failed: boom',
			requestId: 'req-5',
		});
	});

	it('answers when no callback is configured', () => {
		handler = new WebSocketMessageHandler();
		handler.handleMessage(client, { type: 'tab_window_command', requestId: 'r', action: 'list' });
		expect(lastResponse(client)).toMatchObject({
			success: false,
			error: 'Tab windows are not configured',
			requestId: 'r',
		});
	});
});
