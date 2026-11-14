// Covers the WebSocket commands behind the `maestro-cli stats-*` Usage
// Dashboard reads and `stats-export`: each one calls the shared main-process
// function and echoes the request id, and a failure is an error frame that
// carries the request id so the CLI fails fast instead of timing out.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
	app: { getVersion: () => '9.9.9', getAppPath: () => '/repo', getPath: () => '/tmp' },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
}));

const settingsStore = { get: vi.fn() };
vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => settingsStore,
}));

const reads = {
	getDelegationStats: vi.fn(),
	getUsageDashboardCueStats: vi.fn(),
	getPlanUsageReport: vi.fn(),
	getAgentCountStats: vi.fn(),
	getUsageActivityStats: vi.fn(),
};
vi.mock('../../../../main/stats/usage-dashboard-reads', () => ({
	getDelegationStats: (...args: unknown[]) => reads.getDelegationStats(...args),
	getUsageDashboardCueStats: (...args: unknown[]) => reads.getUsageDashboardCueStats(...args),
	getPlanUsageReport: (...args: unknown[]) => reads.getPlanUsageReport(...args),
	getAgentCountStats: (...args: unknown[]) => reads.getAgentCountStats(...args),
	getUsageActivityStats: (...args: unknown[]) => reads.getUsageActivityStats(...args),
}));

const mockExportUsageData = vi.fn();
vi.mock('../../../../main/stats/usage-export', () => ({
	exportUsageData: (...args: unknown[]) => mockExportUsageData(...args),
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

function lastResponse(client: WebClient) {
	const calls = (client.socket.send as ReturnType<typeof vi.fn>).mock.calls;
	return JSON.parse(calls[calls.length - 1][0]);
}

async function send(message: Record<string, unknown>) {
	const client = createMockClient();
	new WebSocketMessageHandler().handleMessage(client, { requestId: 'r1', ...message } as never);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return lastResponse(client);
}

describe('Usage Dashboard bridge handlers', () => {
	beforeEach(() => vi.clearAllMocks());

	it('get_delegation_stats answers with the shared read for the range', async () => {
		reads.getDelegationStats.mockReturnValue({ percent: 40 });
		const response = await send({ type: 'get_delegation_stats', range: 'month' });
		expect(reads.getDelegationStats).toHaveBeenCalledWith('month');
		expect(response).toMatchObject({
			type: 'delegation_stats',
			requestId: 'r1',
			data: { percent: 40 },
		});
	});

	it('rejects an invalid range with an error frame carrying the request id', async () => {
		const response = await send({ type: 'get_activity_stats', range: 'fortnight' });
		expect(response).toMatchObject({ type: 'error', requestId: 'r1' });
		expect(reads.getUsageActivityStats).not.toHaveBeenCalled();
	});

	it('get_cue_stats passes the trigger filter and the settings store', async () => {
		reads.getUsageDashboardCueStats.mockResolvedValue({ totals: { occurrences: 3 } });
		const response = await send({
			type: 'get_cue_stats',
			range: 'week',
			excludeTriggerTypes: ['time.heartbeat', 7, ''],
		});
		expect(reads.getUsageDashboardCueStats).toHaveBeenCalledWith('week', settingsStore, {
			excludeTriggerTypes: ['time.heartbeat'],
		});
		expect(response).toMatchObject({ type: 'cue_stats', data: { totals: { occurrences: 3 } } });
	});

	it('get_cue_stats says so when Cue stats are off', async () => {
		reads.getUsageDashboardCueStats.mockResolvedValue(null);
		const response = await send({ type: 'get_cue_stats' });
		expect(response.type).toBe('error');
		expect(response.message).toContain('Cue statistics are off');
	});

	it('get_plan_usage, get_agent_count_stats and get_activity_stats answer with their reads', async () => {
		reads.getPlanUsageReport.mockResolvedValue({ claude: [], codex: [] });
		reads.getAgentCountStats.mockReturnValue({ liveAgents: 4 });
		reads.getUsageActivityStats.mockReturnValue({ totals: {} });

		expect(await send({ type: 'get_plan_usage' })).toMatchObject({
			type: 'plan_usage',
			data: { claude: [], codex: [] },
		});
		expect(await send({ type: 'get_agent_count_stats', range: 'year' })).toMatchObject({
			type: 'agent_count_stats',
			data: { liveAgents: 4 },
		});
		expect(reads.getAgentCountStats).toHaveBeenCalledWith('year');
		expect(await send({ type: 'get_activity_stats' })).toMatchObject({ type: 'activity_stats' });
		expect(reads.getUsageActivityStats).toHaveBeenCalledWith('week');
	});

	it('stats_export runs the same export the dashboard button does', async () => {
		mockExportUsageData.mockResolvedValue({ path: '/tmp/u.zip', format: 'csv', rowCounts: {} });
		const response = await send({
			type: 'stats_export',
			range: 'all',
			format: 'csv',
			path: '/tmp/u.zip',
		});
		expect(mockExportUsageData).toHaveBeenCalledWith({
			range: 'all',
			format: 'csv',
			filePath: '/tmp/u.zip',
			settingsStore,
			appVersion: '9.9.9',
		});
		expect(response).toMatchObject({ type: 'stats_export_result', data: { path: '/tmp/u.zip' } });
	});

	it('stats_export reports a failure as an error frame', async () => {
		mockExportUsageData.mockRejectedValue(new Error('Export path must be absolute'));
		const response = await send({ type: 'stats_export', format: 'json', path: 'x.json' });
		expect(response).toMatchObject({
			type: 'error',
			requestId: 'r1',
			message: 'Export failed: Export path must be absolute',
		});
	});
});
