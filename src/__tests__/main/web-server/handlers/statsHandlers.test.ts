// Source: src/__tests__/main/web-server/handlers/statsIndexingHandler.test.ts
// Source: src/__tests__/main/web-server/handlers/tokenUsageHandler.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import {
	WebSocketMessageHandler,
	type WebClient,
} from '../../../../main/web-server/handlers/messageHandlers';
import {
	beginStatsIndexing,
	resetStatsIndexingForTest,
} from '../../../../main/stats/stats-indexing';
import { getTimeRangeStart } from '../../../../shared/statsTimeRange';
const mockGetTokenUsageAggregate = vi.hoisted(() => vi.fn());
const flags = vi.hoisted(() => ({ encoreFeatures: undefined as object | undefined }));
vi.mock('electron', () => ({
	app: { getVersion: () => '9.9.9', getAppPath: () => '/repo', getPath: () => '/tmp' },
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
}));
vi.mock('../../../../main/stats/token-usage/token-usage-accessor', () => ({
	getTokenUsageAggregate: mockGetTokenUsageAggregate,
}));
vi.mock('../../../../main/stores', () => ({
	getSettingsStore: () => ({
		get: (key: string) => (key === 'encoreFeatures' ? flags.encoreFeatures : undefined),
	}),
}));
describe('statsIndexingHandler', () => {
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
});
describe('tokenUsageHandler', () => {
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
		afterEach(() => {
			flags.encoreFeatures = undefined;
		});
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
			// The same calendar-aligned window as the dashboard: local midnight six
			// days before today. The granularity is left to the accessor, which picks
			// it from the window's span.
			expect(query).toEqual({ sinceMs: getTimeRangeStart('week') });
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

			expect(mockGetTokenUsageAggregate).toHaveBeenCalledWith({}, true);
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
});
