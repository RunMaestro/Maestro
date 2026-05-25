import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	statsInstances: [] as Array<{
		initialize: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	}>,
	perfMetrics: {
		setEnabled: vi.fn(),
		isEnabled: vi.fn(),
		getMetrics: vi.fn(),
		clearMetrics: vi.fn(),
	},
	logger: {
		info: vi.fn(),
	},
}));

vi.mock('../../../main/stats/stats-db', () => ({
	StatsDB: vi.fn(function MockStatsDB() {
		const instance = {
			initialize: vi.fn(),
			close: vi.fn(),
		};
		mocks.statsInstances.push(instance);
		return instance;
	}),
}));

vi.mock('../../../main/stats/utils', () => ({
	LOG_CONTEXT: '[StatsDB]',
	perfMetrics: mocks.perfMetrics,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

async function importSingleton() {
	return import('../../../main/stats/singleton');
}

describe('stats singleton facade', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		mocks.statsInstances.length = 0;
		mocks.perfMetrics.isEnabled.mockReturnValue(false);
		mocks.perfMetrics.getMetrics.mockReturnValue([{ label: 'query', durationMs: 12 }]);
	});

	it('creates one StatsDB instance, initializes it, and resets after close', async () => {
		const { getStatsDB, initializeStatsDB, closeStatsDB } = await importSingleton();

		closeStatsDB();
		expect(mocks.statsInstances).toHaveLength(0);

		initializeStatsDB();
		const first = getStatsDB();
		const second = getStatsDB();

		expect(first).toBe(second);
		expect(mocks.statsInstances).toHaveLength(1);
		expect(mocks.statsInstances[0].initialize).toHaveBeenCalledTimes(1);

		closeStatsDB();
		expect(mocks.statsInstances[0].close).toHaveBeenCalledTimes(1);

		const afterClose = getStatsDB();
		expect(afterClose).not.toBe(first);
		expect(mocks.statsInstances).toHaveLength(2);
	});

	it('proxies performance metric controls and logs enabled state changes', async () => {
		const {
			setPerformanceLoggingEnabled,
			isPerformanceLoggingEnabled,
			getPerformanceMetrics,
			clearPerformanceMetrics,
		} = await importSingleton();

		setPerformanceLoggingEnabled(true);
		setPerformanceLoggingEnabled(false);

		mocks.perfMetrics.isEnabled.mockReturnValue(true);
		expect(isPerformanceLoggingEnabled()).toBe(true);
		expect(getPerformanceMetrics()).toEqual([{ label: 'query', durationMs: 12 }]);
		clearPerformanceMetrics();

		expect(mocks.perfMetrics.isEnabled).toHaveBeenCalledTimes(1);
		expect(mocks.perfMetrics.getMetrics).toHaveBeenCalledTimes(1);
		expect(mocks.perfMetrics.setEnabled).toHaveBeenNthCalledWith(1, true);
		expect(mocks.perfMetrics.setEnabled).toHaveBeenNthCalledWith(2, false);
		expect(mocks.logger.info).toHaveBeenNthCalledWith(
			1,
			'Performance metrics logging enabled',
			'[StatsDB]'
		);
		expect(mocks.logger.info).toHaveBeenNthCalledWith(
			2,
			'Performance metrics logging disabled',
			'[StatsDB]'
		);
		expect(mocks.perfMetrics.clearMetrics).toHaveBeenCalledTimes(1);
	});
});
