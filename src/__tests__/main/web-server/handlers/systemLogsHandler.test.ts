// Covers the system_logs and system_logs_clear WebSocket messages that back
// `maestro-cli logs`. They validate the query, reach `readSystemLogs()` /
// `clearSystemLogs()`, and ALWAYS answer with the request id, since the CLI
// process blocks on that reply.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

vi.mock('../../../../main/system-logs', () => ({
	readSystemLogs: vi.fn(),
	clearSystemLogs: vi.fn(),
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';
import { clearSystemLogs, readSystemLogs } from '../../../../main/system-logs';

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

describe('system_logs handlers', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		handler.setCallbacks({} as never);
	});

	it('reads with the validated query and answers with the result', async () => {
		const result = { entries: [], matched: 0, sources: [{ id: 'maestro' }] };
		vi.mocked(readSystemLogs).mockResolvedValue(result);

		handler.handleMessage(client, {
			type: 'system_logs',
			requestId: 'req-1',
			query: { sources: ['maestro'], levels: ['error'] },
		} as never);
		await flush();

		expect(readSystemLogs).toHaveBeenCalledWith({ sources: ['maestro'], levels: ['error'] });
		expect(lastResponse(client)).toMatchObject({
			type: 'system_logs_result',
			success: true,
			result,
			requestId: 'req-1',
		});
	});

	it('refuses an unknown source without reading anything', async () => {
		handler.handleMessage(client, {
			type: 'system_logs',
			requestId: 'req-2',
			query: { sources: ['/etc/passwd'] },
		} as never);
		await flush();

		expect(readSystemLogs).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			type: 'system_logs_result',
			success: false,
			error: expect.stringContaining('Unknown log source: /etc/passwd'),
			requestId: 'req-2',
		});
	});

	it('answers a failed read with the reason', async () => {
		vi.mocked(readSystemLogs).mockRejectedValue(new Error('boom'));
		handler.handleMessage(client, { type: 'system_logs', requestId: 'req-3' });
		await flush();
		expect(lastResponse(client)).toMatchObject({
			success: false,
			error: 'Failed to read the system logs: boom',
			requestId: 'req-3',
		});
	});

	it('clears and answers', async () => {
		handler.handleMessage(client, { type: 'system_logs_clear', requestId: 'req-4' });
		await flush();
		expect(clearSystemLogs).toHaveBeenCalledTimes(1);
		expect(lastResponse(client)).toMatchObject({
			type: 'system_logs_clear_result',
			success: true,
			requestId: 'req-4',
		});
	});
});
