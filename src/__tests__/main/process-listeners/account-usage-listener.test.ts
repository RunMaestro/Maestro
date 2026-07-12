/**
 * Tests for the account usage listener: per-account window aggregation,
 * limit warning/reached thresholds, and throttle auto-recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupAccountUsageListener } from '../../../main/process-listeners/account-usage-listener';
import type { ProcessManager } from '../../../main/process-manager';
import type { AccountRegistry } from '../../../main/accounts/account-registry';
import type { StatsDB } from '../../../main/stats';
import { ACCOUNT_SWITCH_DEFAULTS, DEFAULT_TOKEN_WINDOW_MS } from '../../../shared/account-types';

function makeAccount(overrides: Record<string, unknown> = {}) {
	return {
		id: 'acct-1',
		name: 'Account One',
		email: 'one@test.com',
		configDir: '/home/u/.claude-one',
		agentType: 'claude-code',
		status: 'active',
		authMethod: 'oauth',
		addedAt: 0,
		lastUsedAt: 0,
		lastThrottledAt: 0,
		tokenLimitPerWindow: 0,
		tokenWindowMs: DEFAULT_TOKEN_WINDOW_MS,
		isDefault: true,
		autoSwitchEnabled: true,
		...overrides,
	};
}

const USAGE = {
	inputTokens: 100,
	outputTokens: 50,
	cacheReadInputTokens: 10,
	cacheCreationInputTokens: 5,
	totalCostUsd: 0.02,
};

describe('Account Usage Listener', () => {
	let eventHandlers: Map<string, (...args: unknown[]) => void>;
	let mockProcessManager: ProcessManager;
	let mockSafeSend: ReturnType<typeof vi.fn>;
	let mockLogger: {
		info: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
		debug: ReturnType<typeof vi.fn>;
	};
	let mockRegistry: {
		getAssignment: ReturnType<typeof vi.fn>;
		get: ReturnType<typeof vi.fn>;
		getSwitchConfig: ReturnType<typeof vi.fn>;
		setStatus: ReturnType<typeof vi.fn>;
		touchLastUsed: ReturnType<typeof vi.fn>;
	};
	let mockStatsDb: {
		isReady: ReturnType<typeof vi.fn>;
		upsertAccountUsageWindow: ReturnType<typeof vi.fn>;
		getAccountUsageInWindow: ReturnType<typeof vi.fn>;
	};

	function setup(opts: { registry?: boolean } = { registry: true }) {
		setupAccountUsageListener(mockProcessManager, {
			getAccountRegistry: () =>
				opts.registry === false ? null : (mockRegistry as unknown as AccountRegistry),
			getStatsDB: () => mockStatsDb as unknown as StatsDB,
			safeSend: mockSafeSend,
			logger: mockLogger,
		});
		return eventHandlers.get('usage')!;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();
		mockSafeSend = vi.fn();
		mockLogger = { info: vi.fn(), error: vi.fn(), debug: vi.fn() };
		mockRegistry = {
			getAssignment: vi.fn().mockReturnValue({ sessionId: 's1', accountId: 'acct-1' }),
			get: vi.fn().mockReturnValue(makeAccount()),
			getSwitchConfig: vi.fn().mockReturnValue({ ...ACCOUNT_SWITCH_DEFAULTS }),
			setStatus: vi.fn(),
			touchLastUsed: vi.fn(),
		};
		mockStatsDb = {
			isReady: vi.fn().mockReturnValue(true),
			upsertAccountUsageWindow: vi.fn(),
			getAccountUsageInWindow: vi.fn().mockReturnValue({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: 0,
				queryCount: 0,
			}),
		};
		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('registers the usage event listener', () => {
		setup();
		expect(mockProcessManager.on).toHaveBeenCalledWith('usage', expect.any(Function));
	});

	it('aggregates usage into the account window and touches lastUsedAt', () => {
		const handler = setup();
		handler('s1-ai-tab1', USAGE);

		expect(mockStatsDb.upsertAccountUsageWindow).toHaveBeenCalledWith(
			'acct-1',
			expect.any(Number),
			expect.any(Number),
			{
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 10,
				cacheCreationTokens: 5,
				costUsd: 0.02,
			}
		);
		expect(mockRegistry.touchLastUsed).toHaveBeenCalledWith('acct-1');
	});

	it('skips sessions without an account assignment', () => {
		mockRegistry.getAssignment.mockReturnValue(null);
		const handler = setup();
		handler('s1', USAGE);

		expect(mockStatsDb.upsertAccountUsageWindow).not.toHaveBeenCalled();
		expect(mockSafeSend).not.toHaveBeenCalled();
	});

	it('skips when the account registry is not initialized', () => {
		const handler = setup({ registry: false });
		handler('s1', USAGE);

		expect(mockStatsDb.upsertAccountUsageWindow).not.toHaveBeenCalled();
	});

	it('skips when the stats DB is not ready', () => {
		mockStatsDb.isReady.mockReturnValue(false);
		const handler = setup();
		handler('s1', USAGE);

		expect(mockStatsDb.upsertAccountUsageWindow).not.toHaveBeenCalled();
	});

	it('skips when the assigned account was deleted', () => {
		mockRegistry.get.mockReturnValue(null);
		const handler = setup();
		handler('s1', USAGE);

		expect(mockStatsDb.upsertAccountUsageWindow).not.toHaveBeenCalled();
	});

	describe('with a configured token limit', () => {
		function setWindowUsage(totalTokens: number) {
			mockStatsDb.getAccountUsageInWindow.mockReturnValue({
				inputTokens: totalTokens,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: 0,
				queryCount: 1,
			});
		}

		beforeEach(() => {
			mockRegistry.get.mockReturnValue(makeAccount({ tokenLimitPerWindow: 1000 }));
		});

		it('broadcasts a usage-update with the computed percentage', () => {
			setWindowUsage(500);
			const handler = setup();
			handler('s1', USAGE);

			expect(mockSafeSend).toHaveBeenCalledWith(
				'account:usage-update',
				expect.objectContaining({ accountId: 'acct-1', usagePercent: 50, limitTokens: 1000 })
			);
		});

		it('emits limit-warning between warning and auto-switch thresholds', () => {
			setWindowUsage(850); // 85% — between 80 (warning) and 95 (auto-switch)
			const handler = setup();
			handler('s1', USAGE);

			expect(mockSafeSend).toHaveBeenCalledWith(
				'account:limit-warning',
				expect.objectContaining({ accountId: 'acct-1', usagePercent: 85 })
			);
			expect(mockSafeSend).not.toHaveBeenCalledWith('account:limit-reached', expect.anything());
		});

		it('emits limit-reached at the auto-switch threshold (not limit-warning)', () => {
			setWindowUsage(960); // 96% ≥ 95
			const handler = setup();
			handler('s1', USAGE);

			expect(mockSafeSend).toHaveBeenCalledWith(
				'account:limit-reached',
				expect.objectContaining({ accountId: 'acct-1', usagePercent: 96 })
			);
			expect(mockSafeSend).not.toHaveBeenCalledWith('account:limit-warning', expect.anything());
		});

		it('caps usagePercent at 100', () => {
			setWindowUsage(5000); // 500% of limit
			const handler = setup();
			handler('s1', USAGE);

			expect(mockSafeSend).toHaveBeenCalledWith(
				'account:usage-update',
				expect.objectContaining({ usagePercent: 100 })
			);
		});

		it('emits neither threshold event below the warning threshold', () => {
			setWindowUsage(100); // 10%
			const handler = setup();
			handler('s1', USAGE);

			expect(mockSafeSend).not.toHaveBeenCalledWith('account:limit-warning', expect.anything());
			expect(mockSafeSend).not.toHaveBeenCalledWith('account:limit-reached', expect.anything());
		});
	});

	describe('throttle auto-recovery', () => {
		it('reactivates a throttled account once a full window has passed', () => {
			const now = Date.now();
			mockRegistry.get.mockReturnValue(
				makeAccount({
					status: 'throttled',
					lastThrottledAt: now - DEFAULT_TOKEN_WINDOW_MS - 1000,
				})
			);
			const handler = setup();
			handler('s1', USAGE);

			expect(mockRegistry.setStatus).toHaveBeenCalledWith('acct-1', 'active');
			expect(mockSafeSend).toHaveBeenCalledWith(
				'account:status-changed',
				expect.objectContaining({ oldStatus: 'throttled', newStatus: 'active' })
			);
		});

		it('leaves a recently-throttled account throttled', () => {
			mockRegistry.get.mockReturnValue(
				makeAccount({ status: 'throttled', lastThrottledAt: Date.now() - 1000 })
			);
			const handler = setup();
			handler('s1', USAGE);

			expect(mockRegistry.setStatus).not.toHaveBeenCalled();
		});
	});

	it('logs errors without throwing when the stats DB write fails', () => {
		mockStatsDb.upsertAccountUsageWindow.mockImplementation(() => {
			throw new Error('disk full');
		});
		const handler = setup();

		expect(() => handler('s1', USAGE)).not.toThrow();
		expect(mockLogger.error).toHaveBeenCalledWith(
			'Failed to track account usage',
			'account-usage-listener',
			expect.objectContaining({ sessionId: 's1' })
		);
	});
});
