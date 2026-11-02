// Covers the closed_tab_command WebSocket message behind `maestro-cli tab
// closed` and `tab reopen`. The stack lives in the renderer, so this hop owes
// the caller three things: refuse a request the renderer would have to guess
// about (both an index and a tab id, a negative index), refuse an unknown agent
// by name, and ALWAYS answer with the request id, because the CLI blocks on it.

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
import {
	normalizeClosedTabCommandResult,
	parseClosedTabCommandRequest,
} from '../../../../shared/closedTabCommands';

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

describe('closed_tab_command handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let closedTabCommand: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		closedTabCommand = vi.fn().mockResolvedValue({
			success: true,
			tabId: 'new-tab',
			tabType: 'ai',
			reopened: { index: 0, type: 'ai', label: 'Chat', tabId: 'old-tab', closedAt: 1 },
			content: 'loaded',
		});
		handler.setCallbacks({
			closedTabCommand,
			getSessionDetail: vi.fn(() => ({ id: 'session-1' })),
		} as never);
	});

	it('forwards a reopen and replies with the restored tab id and the request id', async () => {
		handler.handleMessage(client, {
			type: 'closed_tab_command',
			requestId: 'req-1',
			action: 'reopen',
			sessionId: 'session-1',
			index: 0,
			background: true,
		});
		await flush();

		expect(closedTabCommand).toHaveBeenCalledWith({
			action: 'reopen',
			sessionId: 'session-1',
			index: 0,
			background: true,
		});
		expect(lastResponse(client)).toMatchObject({
			type: 'closed_tab_command_result',
			requestId: 'req-1',
			success: true,
			tabId: 'new-tab',
			tabType: 'ai',
		});
	});

	it('forwards a list without reopen-only fields', async () => {
		closedTabCommand.mockResolvedValue({ success: true, closedTabs: [] });
		handler.handleMessage(client, {
			type: 'closed_tab_command',
			requestId: 'req-2',
			action: 'list',
			sessionId: 'session-1',
			index: 3,
		});
		await flush();

		expect(closedTabCommand).toHaveBeenCalledWith({ action: 'list', sessionId: 'session-1' });
		expect(lastResponse(client)).toMatchObject({ requestId: 'req-2', closedTabs: [] });
	});

	it('refuses an index together with a tab id without reaching the renderer', () => {
		handler.handleMessage(client, {
			type: 'closed_tab_command',
			requestId: 'req-3',
			action: 'reopen',
			sessionId: 'session-1',
			index: 1,
			tabId: 'abc',
		});

		expect(closedTabCommand).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			type: 'closed_tab_command_result',
			requestId: 'req-3',
			success: false,
			error: 'Name the closed tab by index or by tab id, not both',
		});
	});

	it('refuses an unknown agent by name', () => {
		handler.setCallbacks({ getSessionDetail: vi.fn(() => undefined) } as never);
		handler.handleMessage(client, {
			type: 'closed_tab_command',
			requestId: 'req-4',
			action: 'list',
			sessionId: 'ghost-agent',
		});

		expect(closedTabCommand).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'req-4',
			success: false,
			error: 'Session not found: ghost-agent',
		});
	});

	it('answers rather than hanging when the renderer round trip rejects', async () => {
		closedTabCommand.mockRejectedValue(new Error('window closed'));
		handler.handleMessage(client, {
			type: 'closed_tab_command',
			requestId: 'req-5',
			action: 'reopen',
			sessionId: 'session-1',
		});
		await flush();

		expect(lastResponse(client)).toMatchObject({
			requestId: 'req-5',
			success: false,
			error: 'Closed-tab reopen failed: window closed',
		});
	});
});

describe('parseClosedTabCommandRequest', () => {
	it('requires a known action and a sessionId', () => {
		expect(parseClosedTabCommandRequest({ action: 'nope', sessionId: 's' }).ok).toBe(false);
		expect(parseClosedTabCommandRequest({ action: 'list' })).toEqual({
			ok: false,
			error: 'Closed-tab list requires a sessionId',
		});
	});

	it('refuses a negative or fractional index', () => {
		for (const index of [-1, 1.5, '2']) {
			expect(parseClosedTabCommandRequest({ action: 'reopen', sessionId: 's', index })).toEqual({
				ok: false,
				error: 'index must be a non-negative integer',
			});
		}
	});

	it('treats only a literal true as background', () => {
		const parsed = parseClosedTabCommandRequest({
			action: 'reopen',
			sessionId: 's',
			background: 'yes',
		});
		expect(parsed).toEqual({ ok: true, request: { action: 'reopen', sessionId: 's' } });
	});
});

describe('normalizeClosedTabCommandResult', () => {
	it('turns a malformed reply into a failure', () => {
		expect(normalizeClosedTabCommandResult(null)).toEqual({
			success: false,
			error: 'Invalid closed-tab response',
		});
		expect(normalizeClosedTabCommandResult({ success: 'yes' })).toEqual({
			success: false,
			error: 'Closed-tab command failed',
		});
	});

	it('keeps known fields and drops unknown values', () => {
		expect(
			normalizeClosedTabCommandResult({
				success: true,
				tabId: 't',
				tabType: 'spaceship',
				content: 'pending',
				wasDuplicate: false,
				extra: 1,
			})
		).toEqual({ success: true, tabId: 't', content: 'pending' });
	});
});
