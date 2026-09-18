// Covers the snooze_command WebSocket message that backs `maestro-cli snooze`.
// Nothing about a snooze is DECIDED here - the authoritative state lives in the
// renderer's session store - so what this hop owes the caller is: validate the
// request before it can park a tab with a wake instant that never comes due,
// refuse an agent that does not exist rather than letting the renderer answer
// "not found" for a request that was never addressable, and ALWAYS answer with
// the request id attached. The CLI process on the far end blocks on that reply,
// so a dropped or unlabeled answer is a command that hangs.

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
import type { SnoozeCommandRequest } from '../../../../shared/snoozeCommands';

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

describe('snooze_command handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let snoozeCommand: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		snoozeCommand = vi.fn().mockResolvedValue({ success: true, snoozes: [] });
		handler.setCallbacks({
			snoozeCommand: snoozeCommand as unknown as (
				request: SnoozeCommandRequest
			) => Promise<{ success: boolean }>,
			getSessionDetail: vi.fn(() => ({ id: 'session-1' })),
		} as never);
	});

	it('forwards a valid request and echoes the request id', async () => {
		handler.handleMessage(client, {
			type: 'snooze_command',
			requestId: 'req-1',
			action: 'snooze',
			sessionId: 'session-1',
			targetId: 'tab-1',
			wakeAt: 1893456000000,
		});
		await flush();

		expect(snoozeCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				action: 'snooze',
				sessionId: 'session-1',
				targetId: 'tab-1',
				wakeAt: 1893456000000,
			})
		);
		expect(lastResponse(client)).toMatchObject({
			type: 'snooze_command_result',
			requestId: 'req-1',
			success: true,
		});
	});

	it('rejects a malformed request without reaching the renderer', () => {
		// `snooze` with no wakeAt: parking a tab with no wake instant would hide
		// it with nothing scheduled to bring it back.
		handler.handleMessage(client, {
			type: 'snooze_command',
			requestId: 'req-2',
			action: 'snooze',
			sessionId: 'session-1',
			targetId: 'tab-1',
		});

		expect(snoozeCommand).not.toHaveBeenCalled();
		const response = lastResponse(client);
		expect(response).toMatchObject({
			type: 'snooze_command_result',
			requestId: 'req-2',
			success: false,
		});
		expect(response.error).toBeTruthy();
	});

	it('refuses an unknown agent by name', () => {
		handler.setCallbacks({ getSessionDetail: vi.fn(() => undefined) } as never);

		handler.handleMessage(client, {
			type: 'snooze_command',
			requestId: 'req-3',
			action: 'list',
			sessionId: 'ghost-agent',
		});

		expect(snoozeCommand).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'req-3',
			success: false,
			error: 'Session not found: ghost-agent',
		});
	});

	it('allows an agent-less read through (list and history are app-wide)', async () => {
		handler.handleMessage(client, {
			type: 'snooze_command',
			requestId: 'req-4',
			action: 'list',
		});
		await flush();

		expect(snoozeCommand).toHaveBeenCalledWith(expect.objectContaining({ action: 'list' }));
		expect(lastResponse(client)).toMatchObject({ requestId: 'req-4', success: true });
	});

	it('answers rather than hanging when the renderer round trip rejects', async () => {
		snoozeCommand.mockRejectedValue(new Error('window closed'));

		handler.handleMessage(client, {
			type: 'snooze_command',
			requestId: 'req-5',
			action: 'list',
		});
		await flush();

		expect(lastResponse(client)).toMatchObject({
			requestId: 'req-5',
			success: false,
			error: 'Snooze list failed: window closed',
		});
	});
});
