// Covers the get_stats_indexing WebSocket command behind `maestro-cli
// stats-indexing`: it answers straight from the main-process registry, with the
// request id echoed so the CLI can match the reply.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('electron', () => ({
	app: { getVersion: () => '9.9.9', getAppPath: () => '/repo', getPath: () => '/tmp' },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';
import {
	beginStatsIndexing,
	resetStatsIndexingForTest,
} from '../../../../main/stats/stats-indexing';

function createMockClient(): WebClient {
	return {
		socket: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
	};
}

function lastResponse(client: WebClient) {
	const calls = (client.socket.send as ReturnType<typeof vi.fn>).mock.calls;
	return JSON.parse(calls[calls.length - 1][0]);
}

describe('get_stats_indexing handler', () => {
	beforeEach(() => {
		resetStatsIndexingForTest();
	});

	it('returns the live registry state and echoes the request id', () => {
		const handle = beginStatsIndexing({
			id: 'global-stats',
			label: 'Usage totals',
			reason: 'upgrade',
		});
		handle.addWork(40, 4000);
		handle.advance(10, 1000);

		const client = createMockClient();
		new WebSocketMessageHandler().handleMessage(client, {
			type: 'get_stats_indexing',
			requestId: 'r1',
		});

		const response = lastResponse(client);
		expect(response.type).toBe('stats_indexing');
		expect(response.requestId).toBe('r1');
		expect(response.data.jobs[0]).toMatchObject({
			id: 'global-stats',
			doneFiles: 10,
			totalFiles: 40,
		});
		handle.end();
	});

	it('returns no jobs when nothing is scanning', () => {
		const client = createMockClient();
		new WebSocketMessageHandler().handleMessage(client, { type: 'get_stats_indexing' });
		expect(lastResponse(client).data).toEqual({ jobs: [] });
	});
});
