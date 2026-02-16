import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAccountUsage, formatTimeRemaining, formatTokenCount, calculatePrediction } from '../../../renderer/hooks/useAccountUsage';

describe('useAccountUsage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns loading true initially and false after fetch', async () => {
		vi.mocked(window.maestro.accounts.getAllUsage).mockResolvedValue({});

		const { result } = renderHook(() => useAccountUsage());

		expect(result.current.loading).toBe(true);

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});
	});

	it('fetches usage data on mount and calculates derived metrics', async () => {
		const now = Date.now();
		vi.mocked(window.maestro.accounts.getAllUsage).mockResolvedValue({
			'acc-1': {
				totalTokens: 142000,
				account: { tokenLimitPerWindow: 220000, status: 'active' },
				usagePercent: 64.5,
				costUsd: 3.47,
				queryCount: 28,
				windowStart: now - 2 * 60 * 60 * 1000, // 2 hours ago
				windowEnd: now + 3 * 60 * 60 * 1000, // 3 hours from now
			},
		});

		const { result } = renderHook(() => useAccountUsage());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const metrics = result.current.metrics['acc-1'];
		expect(metrics).toBeDefined();
		expect(metrics.accountId).toBe('acc-1');
		expect(metrics.totalTokens).toBe(142000);
		expect(metrics.limitTokens).toBe(220000);
		expect(metrics.usagePercent).toBe(64.5);
		expect(metrics.costUsd).toBe(3.47);
		expect(metrics.queryCount).toBe(28);
		expect(metrics.status).toBe('active');
		expect(metrics.burnRatePerHour).toBeGreaterThan(0);
		expect(metrics.timeRemainingMs).toBeGreaterThan(0);
		expect(metrics.estimatedTimeToLimitMs).toBeGreaterThan(0);
	});

	it('handles accounts with no limit configured', async () => {
		const now = Date.now();
		vi.mocked(window.maestro.accounts.getAllUsage).mockResolvedValue({
			'acc-no-limit': {
				totalTokens: 50000,
				account: { tokenLimitPerWindow: 0, status: 'active' },
				usagePercent: null,
				costUsd: 1.23,
				queryCount: 10,
				windowStart: now - 60 * 60 * 1000,
				windowEnd: now + 4 * 60 * 60 * 1000,
			},
		});

		const { result } = renderHook(() => useAccountUsage());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const metrics = result.current.metrics['acc-no-limit'];
		expect(metrics.usagePercent).toBeNull();
		expect(metrics.limitTokens).toBe(0);
		expect(metrics.estimatedTimeToLimitMs).toBeNull();
	});

	it('handles zero tokens used', async () => {
		const now = Date.now();
		vi.mocked(window.maestro.accounts.getAllUsage).mockResolvedValue({
			'acc-zero': {
				totalTokens: 0,
				account: { tokenLimitPerWindow: 220000, status: 'active' },
				usagePercent: 0,
				costUsd: 0,
				queryCount: 0,
				windowStart: now - 30 * 60 * 1000,
				windowEnd: now + 4.5 * 60 * 60 * 1000,
			},
		});

		const { result } = renderHook(() => useAccountUsage());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		const metrics = result.current.metrics['acc-zero'];
		expect(metrics.totalTokens).toBe(0);
		expect(metrics.burnRatePerHour).toBe(0);
		// With 0 burn rate and limit configured, estimatedTimeToLimitMs should be null
		expect(metrics.estimatedTimeToLimitMs).toBeNull();
	});

	it('subscribes to real-time usage updates', async () => {
		const now = Date.now();
		let capturedHandler: ((data: any) => void) | null = null;

		vi.mocked(window.maestro.accounts.onUsageUpdate).mockImplementation((handler) => {
			capturedHandler = handler;
			return () => {};
		});

		vi.mocked(window.maestro.accounts.getAllUsage).mockResolvedValue({});

		const { result } = renderHook(() => useAccountUsage());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(capturedHandler).not.toBeNull();

		// Simulate a real-time update
		act(() => {
			capturedHandler!({
				accountId: 'acc-rt',
				totalTokens: 5000,
				limitTokens: 100000,
				usagePercent: 5,
				costUsd: 0.15,
				queryCount: 3,
				windowStart: now - 30 * 60 * 1000,
				windowEnd: now + 4.5 * 60 * 60 * 1000,
			});
		});

		expect(result.current.metrics['acc-rt']).toBeDefined();
		expect(result.current.metrics['acc-rt'].totalTokens).toBe(5000);
		expect(result.current.metrics['acc-rt'].usagePercent).toBe(5);
	});

	it('cleans up subscription on unmount', async () => {
		const cleanup = vi.fn();
		vi.mocked(window.maestro.accounts.onUsageUpdate).mockReturnValue(cleanup);
		vi.mocked(window.maestro.accounts.getAllUsage).mockResolvedValue({});

		const { unmount } = renderHook(() => useAccountUsage());

		await waitFor(() => {
			expect(window.maestro.accounts.getAllUsage).toHaveBeenCalled();
		});

		unmount();
		expect(cleanup).toHaveBeenCalled();
	});

	it('handles fetch error gracefully', async () => {
		vi.mocked(window.maestro.accounts.getAllUsage).mockRejectedValue(new Error('IPC error'));

		const { result } = renderHook(() => useAccountUsage());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(result.current.metrics).toEqual({});
	});

	it('provides a refresh function', async () => {
		vi.mocked(window.maestro.accounts.getAllUsage).mockResolvedValue({});

		const { result } = renderHook(() => useAccountUsage());

		await waitFor(() => {
			expect(result.current.loading).toBe(false);
		});

		expect(typeof result.current.refresh).toBe('function');
	});
});

describe('calculatePrediction', () => {
	const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

	it('returns empty prediction with no window history', () => {
		const result = calculatePrediction([], 0, 100_000, FIVE_HOURS_MS);
		expect(result.confidence).toBe('low');
		expect(result.linearTimeToLimitMs).toBeNull();
		expect(result.weightedTimeToLimitMs).toBeNull();
		expect(result.p90TokensPerWindow).toBe(0);
		expect(result.avgTokensPerWindow).toBe(0);
		expect(result.windowsRemainingP90).toBeNull();
	});

	it('returns low confidence with fewer than 5 windows', () => {
		const history = [
			{ totalTokens: 10_000, windowStart: 0, windowEnd: FIVE_HOURS_MS },
			{ totalTokens: 12_000, windowStart: FIVE_HOURS_MS, windowEnd: 2 * FIVE_HOURS_MS },
		];
		const result = calculatePrediction(history, 5_000, 100_000, FIVE_HOURS_MS);
		expect(result.confidence).toBe('low');
	});

	it('returns medium confidence with 5-15 windows', () => {
		const history = Array.from({ length: 8 }, (_, i) => ({
			totalTokens: 10_000 + i * 1000,
			windowStart: i * FIVE_HOURS_MS,
			windowEnd: (i + 1) * FIVE_HOURS_MS,
		}));
		const result = calculatePrediction(history, 5_000, 100_000, FIVE_HOURS_MS);
		expect(result.confidence).toBe('medium');
	});

	it('returns high confidence with more than 15 windows', () => {
		const history = Array.from({ length: 20 }, (_, i) => ({
			totalTokens: 10_000,
			windowStart: i * FIVE_HOURS_MS,
			windowEnd: (i + 1) * FIVE_HOURS_MS,
		}));
		const result = calculatePrediction(history, 5_000, 100_000, FIVE_HOURS_MS);
		expect(result.confidence).toBe('high');
	});

	it('calculates correct average', () => {
		const history = [
			{ totalTokens: 10_000, windowStart: 0, windowEnd: FIVE_HOURS_MS },
			{ totalTokens: 20_000, windowStart: FIVE_HOURS_MS, windowEnd: 2 * FIVE_HOURS_MS },
			{ totalTokens: 30_000, windowStart: 2 * FIVE_HOURS_MS, windowEnd: 3 * FIVE_HOURS_MS },
		];
		const result = calculatePrediction(history, 0, 100_000, FIVE_HOURS_MS);
		expect(result.avgTokensPerWindow).toBe(20_000);
	});

	it('calculates P90 as the 90th percentile', () => {
		const history = Array.from({ length: 10 }, (_, i) => ({
			totalTokens: (i + 1) * 1000,
			windowStart: i * FIVE_HOURS_MS,
			windowEnd: (i + 1) * FIVE_HOURS_MS,
		}));
		const result = calculatePrediction(history, 0, 100_000, FIVE_HOURS_MS);
		// sorted: [1K, 2K, ..., 10K], p90Index = floor(10*0.9) = 9 => 10K
		expect(result.p90TokensPerWindow).toBe(10_000);
	});

	it('P90 prediction is more conservative than linear', () => {
		const history = [
			{ totalTokens: 5_000, windowStart: 0, windowEnd: FIVE_HOURS_MS },
			{ totalTokens: 5_000, windowStart: FIVE_HOURS_MS, windowEnd: 2 * FIVE_HOURS_MS },
			{ totalTokens: 5_000, windowStart: 2 * FIVE_HOURS_MS, windowEnd: 3 * FIVE_HOURS_MS },
			{ totalTokens: 5_000, windowStart: 3 * FIVE_HOURS_MS, windowEnd: 4 * FIVE_HOURS_MS },
			{ totalTokens: 50_000, windowStart: 4 * FIVE_HOURS_MS, windowEnd: 5 * FIVE_HOURS_MS },
		];
		const result = calculatePrediction(history, 10_000, 100_000, FIVE_HOURS_MS);
		expect(result.windowsRemainingP90).not.toBeNull();
		expect(result.linearTimeToLimitMs).not.toBeNull();
		if (result.windowsRemainingP90 !== null && result.linearTimeToLimitMs !== null) {
			const linearWindows = result.linearTimeToLimitMs / FIVE_HOURS_MS;
			expect(result.windowsRemainingP90).toBeLessThanOrEqual(linearWindows);
		}
	});

	it('returns null predictions when no limit is configured', () => {
		const history = [
			{ totalTokens: 10_000, windowStart: 0, windowEnd: FIVE_HOURS_MS },
		];
		const result = calculatePrediction(history, 5_000, 0, FIVE_HOURS_MS);
		expect(result.linearTimeToLimitMs).toBeNull();
		expect(result.weightedTimeToLimitMs).toBeNull();
		expect(result.windowsRemainingP90).toBeNull();
		expect(result.avgTokensPerWindow).toBe(10_000);
	});

	it('recent windows weigh more heavily in weighted average', () => {
		const history = [
			{ totalTokens: 1_000, windowStart: 0, windowEnd: FIVE_HOURS_MS },
			{ totalTokens: 1_000, windowStart: FIVE_HOURS_MS, windowEnd: 2 * FIVE_HOURS_MS },
			{ totalTokens: 1_000, windowStart: 2 * FIVE_HOURS_MS, windowEnd: 3 * FIVE_HOURS_MS },
			{ totalTokens: 50_000, windowStart: 3 * FIVE_HOURS_MS, windowEnd: 4 * FIVE_HOURS_MS },
			{ totalTokens: 50_000, windowStart: 4 * FIVE_HOURS_MS, windowEnd: 5 * FIVE_HOURS_MS },
		];
		const result = calculatePrediction(history, 10_000, 200_000, FIVE_HOURS_MS);
		// Weighted time should be shorter than linear (recent high usage pushes prediction down)
		expect(result.weightedTimeToLimitMs).not.toBeNull();
		expect(result.linearTimeToLimitMs).not.toBeNull();
		if (result.weightedTimeToLimitMs !== null && result.linearTimeToLimitMs !== null) {
			expect(result.weightedTimeToLimitMs).toBeLessThan(result.linearTimeToLimitMs);
		}
	});
});

describe('formatTimeRemaining', () => {
	it('returns "—" for zero or negative values', () => {
		expect(formatTimeRemaining(0)).toBe('—');
		expect(formatTimeRemaining(-1000)).toBe('—');
	});

	it('formats hours and minutes', () => {
		expect(formatTimeRemaining(2 * 60 * 60 * 1000 + 34 * 60 * 1000)).toBe('2h 34m');
		expect(formatTimeRemaining(1 * 60 * 60 * 1000)).toBe('1h 0m');
	});

	it('formats minutes only', () => {
		expect(formatTimeRemaining(45 * 60 * 1000)).toBe('45m');
		expect(formatTimeRemaining(5 * 60 * 1000)).toBe('5m');
	});

	it('formats sub-5-minute with seconds', () => {
		expect(formatTimeRemaining(4 * 60 * 1000 + 32 * 1000)).toBe('4m 32s');
		expect(formatTimeRemaining(1 * 60 * 1000 + 15 * 1000)).toBe('1m 15s');
	});

	it('returns "< 1m" for very small values', () => {
		expect(formatTimeRemaining(30 * 1000)).toBe('< 1m');
		expect(formatTimeRemaining(500)).toBe('< 1m');
	});
});

describe('formatTokenCount', () => {
	it('returns raw number for small values', () => {
		expect(formatTokenCount(0)).toBe('0');
		expect(formatTokenCount(856)).toBe('856');
		expect(formatTokenCount(999)).toBe('999');
	});

	it('formats thousands with K suffix', () => {
		expect(formatTokenCount(1000)).toBe('1.0K');
		expect(formatTokenCount(1500)).toBe('1.5K');
		expect(formatTokenCount(9999)).toBe('10.0K');
	});

	it('formats tens of thousands with K suffix (no decimal)', () => {
		expect(formatTokenCount(10000)).toBe('10K');
		expect(formatTokenCount(142000)).toBe('142K');
		expect(formatTokenCount(999999)).toBe('1000K');
	});

	it('formats millions with M suffix', () => {
		expect(formatTokenCount(1000000)).toBe('1.0M');
		expect(formatTokenCount(1200000)).toBe('1.2M');
		expect(formatTokenCount(15000000)).toBe('15.0M');
	});
});
