// Covers the app_stats WebSocket message that backs `maestro-cli app-stats`.
// The snapshot is `collectAppStats()`, the function the Application Stats modal
// reads; this hop hands it the process manager the app runs and ALWAYS answers
// with the request id, since the CLI process blocks on that reply.

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

vi.mock('../../../../main/app-stats', () => ({
	collectAppStats: vi.fn(),
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';
import { collectAppStats } from '../../../../main/app-stats';

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

describe('app_stats handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	const processManager = { getAll: () => [] };

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		handler.setCallbacks({
			getDebugPackageDeps: () => ({ getProcessManager: () => processManager }),
		} as never);
	});

	it('answers with the snapshot, built over the app process manager', async () => {
		vi.mocked(collectAppStats).mockResolvedValue({ timestamp: 42 } as never);

		handler.handleMessage(client, { type: 'app_stats', requestId: 'req-1' });
		await flush();

		const deps = vi.mocked(collectAppStats).mock.calls[0][0];
		expect(deps.getProcessManager()).toBe(processManager);
		expect(lastResponse(client)).toEqual({
			type: 'app_stats_result',
			success: true,
			snapshot: { timestamp: 42 },
			requestId: 'req-1',
		});
	});

	it('answers with the failure, never silence', async () => {
		vi.mocked(collectAppStats).mockRejectedValue(new Error('ps exploded'));

		handler.handleMessage(client, { type: 'app_stats', requestId: 'req-2' });
		await flush();

		expect(lastResponse(client)).toMatchObject({
			type: 'app_stats_result',
			success: false,
			requestId: 'req-2',
		});
		expect(String(lastResponse(client).error)).toContain('ps exploded');
	});
});
