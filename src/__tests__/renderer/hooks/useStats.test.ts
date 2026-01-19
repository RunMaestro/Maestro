import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useStats, useComputedStats } from '../../../renderer/hooks';
import type { StatsAggregation } from '../../../renderer/hooks';

describe('useStats', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('initialization and data fetching', () => {
		it('should initialize with loading state', () => {
			const { result } = renderHook(() => useStats('week'));
			expect(result.current.loading).toBe(true);
			expect(result.current.data).toBe(null);
			expect(result.current.error).toBe(null);
		});

		it('should fetch stats and set data on mount', async () => {
			const mockData: StatsAggregation = {
				totalQueries: 100,
				totalDuration: 3600000,
				avgDuration: 36000,
				byAgent: { 'claude-code': { count: 80, duration: 2880000 } },
				bySource: { user: 60, auto: 40 },
				byDay: [{ date: '2024-01-01', count: 10, duration: 360000 }],
			};

			vi.mocked(window.maestro.stats.getAggregation).mockResolvedValue(mockData);

			const { result } = renderHook(() => useStats('week'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.data).toEqual(mockData);
			expect(result.current.error).toBe(null);
			expect(window.maestro.stats.getAggregation).toHaveBeenCalledWith('week');
		});

		it('should set error state when fetch fails', async () => {
			vi.mocked(window.maestro.stats.getAggregation).mockRejectedValue(new Error('Network error'));

			const { result } = renderHook(() => useStats('week'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.data).toBe(null);
			expect(result.current.error).toBe('Network error');
		});

		it('should refetch when time range changes', async () => {
			const weekData: StatsAggregation = {
				totalQueries: 100,
				totalDuration: 3600000,
				avgDuration: 36000,
				byAgent: {},
				bySource: { user: 60, auto: 40 },
				byDay: [],
			};

			const monthData: StatsAggregation = {
				totalQueries: 500,
				totalDuration: 18000000,
				avgDuration: 36000,
				byAgent: {},
				bySource: { user: 300, auto: 200 },
				byDay: [],
			};

			vi.mocked(window.maestro.stats.getAggregation)
				.mockResolvedValueOnce(weekData)
				.mockResolvedValueOnce(monthData);

			const { result, rerender } = renderHook(({ range }) => useStats(range), {
				initialProps: { range: 'week' as const },
			});

			await waitFor(() => {
				expect(result.current.data?.totalQueries).toBe(100);
			});

			// Change range to month
			rerender({ range: 'month' });

			await waitFor(() => {
				expect(result.current.data?.totalQueries).toBe(500);
			});

			expect(window.maestro.stats.getAggregation).toHaveBeenCalledTimes(2);
			expect(window.maestro.stats.getAggregation).toHaveBeenLastCalledWith('month');
		});
	});

	describe('enabled parameter', () => {
		it('should not fetch when enabled is false', async () => {
			const { result } = renderHook(() => useStats('week', false));

			// Give time for any potential async operation
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
			});

			expect(window.maestro.stats.getAggregation).not.toHaveBeenCalled();
			expect(result.current.loading).toBe(true);
			expect(result.current.data).toBe(null);
		});

		it('should fetch when enabled changes from false to true', async () => {
			const mockData: StatsAggregation = {
				totalQueries: 50,
				totalDuration: 1800000,
				avgDuration: 36000,
				byAgent: {},
				bySource: { user: 30, auto: 20 },
				byDay: [],
			};

			vi.mocked(window.maestro.stats.getAggregation).mockResolvedValue(mockData);

			const { result, rerender } = renderHook(({ enabled }) => useStats('week', enabled), {
				initialProps: { enabled: false },
			});

			expect(window.maestro.stats.getAggregation).not.toHaveBeenCalled();

			// Enable fetching
			rerender({ enabled: true });

			await waitFor(() => {
				expect(result.current.data?.totalQueries).toBe(50);
			});

			expect(window.maestro.stats.getAggregation).toHaveBeenCalledWith('week');
		});
	});

	describe('real-time updates subscription', () => {
		it('should subscribe to stats updates on mount', async () => {
			const mockData: StatsAggregation = {
				totalQueries: 10,
				totalDuration: 360000,
				avgDuration: 36000,
				byAgent: {},
				bySource: { user: 5, auto: 5 },
				byDay: [],
			};

			vi.mocked(window.maestro.stats.getAggregation).mockResolvedValue(mockData);

			renderHook(() => useStats('week'));

			await waitFor(() => {
				expect(window.maestro.stats.onStatsUpdate).toHaveBeenCalled();
			});
		});

		it('should unsubscribe from stats updates on unmount', async () => {
			const unsubscribe = vi.fn();
			vi.mocked(window.maestro.stats.onStatsUpdate).mockReturnValue(unsubscribe);

			const mockData: StatsAggregation = {
				totalQueries: 10,
				totalDuration: 360000,
				avgDuration: 36000,
				byAgent: {},
				bySource: { user: 5, auto: 5 },
				byDay: [],
			};

			vi.mocked(window.maestro.stats.getAggregation).mockResolvedValue(mockData);

			const { unmount } = renderHook(() => useStats('week'));

			await waitFor(() => {
				expect(window.maestro.stats.onStatsUpdate).toHaveBeenCalled();
			});

			unmount();

			expect(unsubscribe).toHaveBeenCalled();
		});
	});

	describe('debounce behavior', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('should debounce real-time updates by 1 second', async () => {
			let updateCallback: (() => void) | null = null;
			vi.mocked(window.maestro.stats.onStatsUpdate).mockImplementation((callback) => {
				updateCallback = callback;
				return () => {};
			});

			const mockData: StatsAggregation = {
				totalQueries: 10,
				totalDuration: 360000,
				avgDuration: 36000,
				byAgent: {},
				bySource: { user: 5, auto: 5 },
				byDay: [],
			};

			vi.mocked(window.maestro.stats.getAggregation).mockResolvedValue(mockData);

			await act(async () => {
				renderHook(() => useStats('week'));
				// Flush promises to complete initial fetch
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(updateCallback).not.toBe(null);

			// Initial fetch
			expect(window.maestro.stats.getAggregation).toHaveBeenCalledTimes(1);

			// Trigger multiple updates in quick succession
			act(() => {
				updateCallback!();
				updateCallback!();
				updateCallback!();
			});

			// Advance time by 500ms - should not have refetched yet (still within debounce window)
			await act(async () => {
				vi.advanceTimersByTime(500);
				await Promise.resolve();
			});

			// Still only the initial fetch
			expect(window.maestro.stats.getAggregation).toHaveBeenCalledTimes(1);

			// Advance time to complete the 1 second debounce
			await act(async () => {
				vi.advanceTimersByTime(600);
				await Promise.resolve();
				await Promise.resolve();
			});

			// Now should have fetched again
			expect(window.maestro.stats.getAggregation).toHaveBeenCalledTimes(2);
		});
	});

	describe('refresh function', () => {
		it('should manually trigger a refresh', async () => {
			const mockData: StatsAggregation = {
				totalQueries: 10,
				totalDuration: 360000,
				avgDuration: 36000,
				byAgent: {},
				bySource: { user: 5, auto: 5 },
				byDay: [],
			};

			vi.mocked(window.maestro.stats.getAggregation).mockResolvedValue(mockData);

			const { result } = renderHook(() => useStats('week'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(window.maestro.stats.getAggregation).toHaveBeenCalledTimes(1);

			// Trigger manual refresh
			await act(async () => {
				await result.current.refresh();
			});

			expect(window.maestro.stats.getAggregation).toHaveBeenCalledTimes(2);
		});

		it('should provide a refresh function', async () => {
			const mockData: StatsAggregation = {
				totalQueries: 10,
				totalDuration: 360000,
				avgDuration: 36000,
				byAgent: {},
				bySource: { user: 5, auto: 5 },
				byDay: [],
			};

			vi.mocked(window.maestro.stats.getAggregation).mockResolvedValue(mockData);

			const { result } = renderHook(() => useStats('week'));

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(typeof result.current.refresh).toBe('function');
		});
	});

	describe('time range options', () => {
		it.each(['day' as const, 'week' as const, 'month' as const, 'year' as const, 'all' as const])(
			'should support %s time range',
			async (range) => {
				const mockData: StatsAggregation = {
					totalQueries: 10,
					totalDuration: 360000,
					avgDuration: 36000,
					byAgent: {},
					bySource: { user: 5, auto: 5 },
					byDay: [],
				};

				vi.mocked(window.maestro.stats.getAggregation).mockResolvedValue(mockData);

				const { result } = renderHook(() => useStats(range));

				await waitFor(() => {
					expect(result.current.loading).toBe(false);
				});

				expect(window.maestro.stats.getAggregation).toHaveBeenCalledWith(range);
			}
		);
	});
});

describe('useComputedStats', () => {
	it('should return empty values when data is null', () => {
		const { result } = renderHook(() => useComputedStats(null));

		expect(result.current.mostActiveAgent).toBe(null);
		expect(result.current.interactiveVsAutoRatio).toBe('N/A');
		expect(result.current.totalSources).toBe(0);
		expect(result.current.hasData).toBe(false);
	});

	it('should calculate most active agent correctly', () => {
		const data: StatsAggregation = {
			totalQueries: 100,
			totalDuration: 3600000,
			avgDuration: 36000,
			byAgent: {
				'claude-code': { count: 80, duration: 2880000 },
				opencode: { count: 20, duration: 720000 },
			},
			bySource: { user: 60, auto: 40 },
			byDay: [],
		};

		const { result } = renderHook(() => useComputedStats(data));

		expect(result.current.mostActiveAgent).toEqual([
			'claude-code',
			{ count: 80, duration: 2880000 },
		]);
	});

	it('should calculate interactive vs auto ratio correctly', () => {
		const data: StatsAggregation = {
			totalQueries: 100,
			totalDuration: 3600000,
			avgDuration: 36000,
			byAgent: {},
			bySource: { user: 75, auto: 25 },
			byDay: [],
		};

		const { result } = renderHook(() => useComputedStats(data));

		expect(result.current.interactiveVsAutoRatio).toBe('75%');
		expect(result.current.totalSources).toBe(100);
	});

	it('should return N/A when no sources', () => {
		const data: StatsAggregation = {
			totalQueries: 0,
			totalDuration: 0,
			avgDuration: 0,
			byAgent: {},
			bySource: { user: 0, auto: 0 },
			byDay: [],
		};

		const { result } = renderHook(() => useComputedStats(data));

		expect(result.current.interactiveVsAutoRatio).toBe('N/A');
		expect(result.current.totalSources).toBe(0);
	});

	it('should correctly determine hasData', () => {
		// No data
		const noData: StatsAggregation = {
			totalQueries: 0,
			totalDuration: 0,
			avgDuration: 0,
			byAgent: {},
			bySource: { user: 0, auto: 0 },
			byDay: [],
		};

		const { result: noDataResult } = renderHook(() => useComputedStats(noData));
		expect(noDataResult.current.hasData).toBe(false);

		// Has queries
		const hasQueries: StatsAggregation = {
			totalQueries: 10,
			totalDuration: 0,
			avgDuration: 0,
			byAgent: {},
			bySource: { user: 0, auto: 0 },
			byDay: [],
		};

		const { result: hasQueriesResult } = renderHook(() => useComputedStats(hasQueries));
		expect(hasQueriesResult.current.hasData).toBe(true);

		// Has user source
		const hasUser: StatsAggregation = {
			totalQueries: 0,
			totalDuration: 0,
			avgDuration: 0,
			byAgent: {},
			bySource: { user: 5, auto: 0 },
			byDay: [],
		};

		const { result: hasUserResult } = renderHook(() => useComputedStats(hasUser));
		expect(hasUserResult.current.hasData).toBe(true);

		// Has auto source
		const hasAuto: StatsAggregation = {
			totalQueries: 0,
			totalDuration: 0,
			avgDuration: 0,
			byAgent: {},
			bySource: { user: 0, auto: 3 },
			byDay: [],
		};

		const { result: hasAutoResult } = renderHook(() => useComputedStats(hasAuto));
		expect(hasAutoResult.current.hasData).toBe(true);
	});

	it('should handle empty byAgent object', () => {
		const data: StatsAggregation = {
			totalQueries: 100,
			totalDuration: 3600000,
			avgDuration: 36000,
			byAgent: {},
			bySource: { user: 60, auto: 40 },
			byDay: [],
		};

		const { result } = renderHook(() => useComputedStats(data));

		expect(result.current.mostActiveAgent).toBe(null);
	});

	it('should memoize computed values', () => {
		const data: StatsAggregation = {
			totalQueries: 100,
			totalDuration: 3600000,
			avgDuration: 36000,
			byAgent: { 'claude-code': { count: 80, duration: 2880000 } },
			bySource: { user: 60, auto: 40 },
			byDay: [],
		};

		const { result, rerender } = renderHook(() => useComputedStats(data));

		const firstResult = result.current;
		rerender();
		const secondResult = result.current;

		// Same data reference should yield same computed result
		expect(firstResult).toBe(secondResult);
	});
});
