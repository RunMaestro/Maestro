/**
 * Tests for `readModelUsage`: the one read the Models tab's IPC channel and
 * `maestro-cli stats models` share. It checks the range, and hands the stats
 * aggregation the names only the running app knows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getModelUsage = vi.fn();
vi.mock('../../../main/stats/singleton', () => ({
	getStatsDB: () => ({ getModelUsage }),
}));

const endpoints = [
	{
		id: 'ep-ollama',
		name: 'Ollama',
		kind: 'ollama',
		baseUrl: 'http://localhost:11434',
		enabled: true,
	},
];
vi.mock('../../../main/local-models/endpoint-service', () => ({
	getConfiguredLocalModelEndpoints: () => endpoints,
}));

const storedAgentRecord = vi.fn();
vi.mock('../../../main/local-models/run-on', () => ({
	storedAgentRecord: (id: string) => storedAgentRecord(id),
}));

const readSystemOneSettings = vi.fn();
vi.mock('../../../main/local-models/system-one/config-store', () => ({
	readSystemOneSettings: (dir: string) => readSystemOneSettings(dir),
}));
vi.mock('../../../main/local-models/system-one/service', () => ({
	systemOneDataDir: () => '/data/models',
}));

import { MODEL_USAGE_DEFAULT_RANGE, readModelUsage } from '../../../main/local-models/model-usage';
import type { ModelUsageNames } from '../../../shared/local-models/model-usage';

describe('readModelUsage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getModelUsage.mockImplementation((range: string) => ({ range }));
		readSystemOneSettings.mockResolvedValue({ openJevUrl: 'http://jev.lan:8080' });
		storedAgentRecord.mockImplementation((id: string) =>
			id === 'agent-a' ? { id, name: 'Alpha' } : id === 'agent-blank' ? { id, name: '' } : undefined
		);
	});

	it('reads the range it is given, and the week when none is named', async () => {
		await expect(readModelUsage('quarter')).resolves.toEqual({ range: 'quarter' });
		expect(getModelUsage).toHaveBeenLastCalledWith('quarter', expect.any(Object));

		expect(MODEL_USAGE_DEFAULT_RANGE).toBe('week');
		await readModelUsage();
		expect(getModelUsage).toHaveBeenLastCalledWith('week', expect.any(Object));
		await readModelUsage(null);
		expect(getModelUsage).toHaveBeenLastCalledWith('week', expect.any(Object));
	});

	it('rejects a range that is not one of the six, and reads nothing', async () => {
		for (const range of ['fortnight', '', 7, {}, 'WEEK']) {
			await expect(readModelUsage(range)).rejects.toThrow(
				'Invalid range. Must be one of: day, week, month, quarter, year, all'
			);
		}
		expect(getModelUsage).not.toHaveBeenCalled();
		expect(readSystemOneSettings).not.toHaveBeenCalled();
	});

	it('hands the aggregation the saved endpoints, the OpenJev server and the agent names', async () => {
		await readModelUsage('day');

		expect(readSystemOneSettings).toHaveBeenCalledWith('/data/models');
		const names = getModelUsage.mock.calls[0][1] as ModelUsageNames;
		expect(names.endpoints).toBe(endpoints);
		expect(names.openJevUrl).toBe('http://jev.lan:8080');
		expect(names.agentName?.('agent-a')).toBe('Alpha');
		// An agent that no longer exists, or has no name, has none to show.
		expect(names.agentName?.('agent-gone')).toBeUndefined();
		expect(names.agentName?.('agent-blank')).toBeUndefined();
	});
});
