// Covers the get_token_usage WebSocket command that backs `maestro-cli
// stats-tokens`: it must validate the range, ask the shared token-usage
// accessor for the same window the dashboard reads, pass `force` through, and
// echo the request id. The accessor is mocked so no transcripts are read.

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

const mockGetTokenUsageAggregate = vi.hoisted(() => vi.fn());
vi.mock('../../../../main/stats/token-usage/token-usage-accessor', () => ({
	getTokenUsageAggregate: mockGetTokenUsageAggregate,
}));

// The stored Encore flags; unset resolves to the defaults (Usage & Stats on).
const flags = vi.hoisted(() => ({ encoreFeatures: undefined as object | undefined }));
vi.mock('../../../../main/stores', () => ({
	getSettingsStore: () => ({
		get: (key: string) => (key === 'encoreFeatures' ? flags.encoreFeatures : undefined),
	}),
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';

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

async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('get_token_usage handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;

	beforeEach(() => {
		vi.clearAllMocks();
		flags.encoreFeatures = undefined;
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		mockGetTokenUsageAggregate.mockResolvedValue({ totals: { sessionCount: 3 } });
	});

	it('returns the aggregate for the range and echoes the request id', async () => {
		handler.handleMessage(client, { type: 'get_token_usage', range: 'week', requestId: 'r1' });
		await flush();

		const [query, force] = mockGetTokenUsageAggregate.mock.calls[0];
		expect(query.granularity).toBe('day');
		expect(Date.now() - query.sinceMs).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);
		expect(force).toBe(false);
		expect(lastResponse(client)).toMatchObject({
			type: 'token_usage',
			requestId: 'r1',
			data: { totals: { sessionCount: 3 } },
		});
	});

	it('reads all time without a lower bound and passes force through', async () => {
		handler.handleMessage(client, { type: 'get_token_usage', range: 'all', force: true });
		await flush();

		expect(mockGetTokenUsageAggregate).toHaveBeenCalledWith({ granularity: 'month' }, true);
	});

	it('rejects an unknown range without reading transcripts', async () => {
		handler.handleMessage(client, { type: 'get_token_usage', range: 'decade' });
		await flush();

		expect(mockGetTokenUsageAggregate).not.toHaveBeenCalled();
		expect(lastResponse(client).type).toBe('error');
	});

	it('refuses without reading transcripts while Usage & Stats is off', async () => {
		flags.encoreFeatures = { usageStats: false };
		handler.handleMessage(client, { type: 'get_token_usage', range: 'week', requestId: 'r9' });
		await flush();

		expect(mockGetTokenUsageAggregate).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({ type: 'error', requestId: 'r9' });
		expect(lastResponse(client).message).toContain('Usage & Stats is turned off');
	});

	it('reports an accessor failure as an error', async () => {
		mockGetTokenUsageAggregate.mockRejectedValueOnce(new Error('disk gone'));
		handler.handleMessage(client, { type: 'get_token_usage', range: 'day' });
		await flush();

		expect(lastResponse(client)).toMatchObject({ type: 'error' });
		expect(lastResponse(client).message).toContain('disk gone');
	});
});
