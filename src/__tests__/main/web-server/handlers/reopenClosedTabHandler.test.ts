// Covers the reopen_closed_tab WebSocket message that backs `maestro-cli tab
// reopen`. The closed-tab history lives only in the renderer, so this hop owes
// the caller three things: refuse an agent that does not exist, read
// `background` as an opt-in only on a literal true, and ALWAYS answer with the
// request id attached - the CLI process on the far end blocks on that reply.

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

describe('reopen_closed_tab handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let reopenClosedTab: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		reopenClosedTab = vi.fn().mockResolvedValue({
			success: true,
			tabId: 'tab-9',
			tabType: 'ai',
			wasDuplicate: false,
			background: false,
		});
		handler.setCallbacks({
			reopenClosedTab,
			getSessionDetail: vi.fn((id: string) => (id === 'session-1' ? { id } : null)),
		} as never);
	});

	it('forwards the agent and echoes the request id with the restored tab', async () => {
		handler.handleMessage(client, {
			type: 'reopen_closed_tab',
			requestId: 'req-1',
			sessionId: 'session-1',
		});
		await flush();

		expect(reopenClosedTab).toHaveBeenCalledWith('session-1', false);
		expect(lastResponse(client)).toMatchObject({
			type: 'reopen_closed_tab_result',
			requestId: 'req-1',
			success: true,
			tabId: 'tab-9',
			sessionId: 'session-1',
		});
	});

	it('treats only a literal true as background', async () => {
		handler.handleMessage(client, {
			type: 'reopen_closed_tab',
			requestId: 'req-2',
			sessionId: 'session-1',
			background: true,
		});
		handler.handleMessage(client, {
			type: 'reopen_closed_tab',
			requestId: 'req-3',
			sessionId: 'session-1',
			background: 'yes' as never,
		});
		await flush();

		expect(reopenClosedTab).toHaveBeenNthCalledWith(1, 'session-1', true);
		expect(reopenClosedTab).toHaveBeenNthCalledWith(2, 'session-1', false);
	});

	it('refuses an unknown agent without reaching the renderer', async () => {
		handler.handleMessage(client, {
			type: 'reopen_closed_tab',
			requestId: 'req-4',
			sessionId: 'nope',
		});
		await flush();

		expect(reopenClosedTab).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			type: 'reopen_closed_tab_result',
			requestId: 'req-4',
			success: false,
			error: 'Session not found: nope',
		});
	});

	it('answers a failure when the renderer callback rejects', async () => {
		reopenClosedTab.mockRejectedValueOnce(new Error('boom'));
		handler.handleMessage(client, {
			type: 'reopen_closed_tab',
			requestId: 'req-5',
			sessionId: 'session-1',
		});
		await flush();

		expect(lastResponse(client)).toMatchObject({
			requestId: 'req-5',
			success: false,
			error: 'Failed to reopen closed tab: boom',
		});
	});
});
