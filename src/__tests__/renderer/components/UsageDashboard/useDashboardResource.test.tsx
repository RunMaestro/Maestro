/**
 * Tests for useDashboardResource: table-filtered, debounced refetch on
 * `stats:updated`, and the { data, loading, error, refresh } shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useDashboardResource,
	statsUpdateConcerns,
	DASHBOARD_RESOURCE_DEBOUNCE_MS,
} from '../../../../renderer/components/UsageDashboard/useDashboardResource';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';

vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

type StatsListener = (table?: string) => void;

let listeners: StatsListener[] = [];

function emit(table?: string) {
	for (const listener of listeners) listener(table);
}

/** Let the fetch promise chain settle under fake timers. */
async function flush() {
	await act(async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	});
}

describe('statsUpdateConcerns', () => {
	it('treats an unnamed table or an unfiltered panel as relevant', () => {
		expect(statsUpdateConcerns(undefined, ['auto_run'])).toBe(true);
		expect(statsUpdateConcerns('query_events', undefined)).toBe(true);
	});

	it('matches only the listed tables', () => {
		expect(statsUpdateConcerns('auto_run', ['auto_run'])).toBe(true);
		expect(statsUpdateConcerns('shortcut_usage', ['auto_run'])).toBe(false);
	});
});

describe('useDashboardResource', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		clearCachedResources();
		listeners = [];
		vi.mocked(window.maestro.stats.onStatsUpdate).mockImplementation(((cb: StatsListener) => {
			listeners.push(cb);
			return () => {
				listeners = listeners.filter((l) => l !== cb);
			};
		}) as never);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.mocked(window.maestro.stats.onStatsUpdate).mockReturnValue(() => {});
	});

	it('returns data, loading, error and refresh', async () => {
		const fetcher = vi.fn().mockResolvedValue([1, 2]);
		const { result } = renderHook(() => useDashboardResource('k:shape', fetcher, 'op'));
		expect(result.current.loading).toBe(true);
		await flush();
		expect(result.current.data).toEqual([1, 2]);
		expect(result.current.loading).toBe(false);
		expect(result.current.error).toBeNull();
		expect(typeof result.current.refresh).toBe('function');
	});

	it('reports a failed fetch as an error', async () => {
		const fetcher = vi.fn().mockRejectedValue(new Error('db locked'));
		const { result } = renderHook(() => useDashboardResource('k:error', fetcher, 'op'));
		await flush();
		expect(result.current.error).toBe('db locked');
		expect(result.current.data).toBeUndefined();
	});

	it('ignores updates to tables the panel does not read', async () => {
		const fetcher = vi.fn().mockResolvedValue(1);
		renderHook(() => useDashboardResource('k:filter', fetcher, 'op', { tables: ['auto_run'] }));
		await flush();
		expect(fetcher).toHaveBeenCalledTimes(1);

		act(() => emit('shortcut_usage'));
		await act(async () => {
			vi.advanceTimersByTime(DASHBOARD_RESOURCE_DEBOUNCE_MS + 10);
		});
		await flush();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('collapses a burst of relevant updates into one trailing refetch', async () => {
		const fetcher = vi.fn().mockResolvedValue(1);
		renderHook(() => useDashboardResource('k:burst', fetcher, 'op', { tables: ['auto_run'] }));
		await flush();
		expect(fetcher).toHaveBeenCalledTimes(1);

		act(() => {
			emit('auto_run');
			emit('auto_run');
			emit(undefined);
		});
		await act(async () => {
			vi.advanceTimersByTime(DASHBOARD_RESOURCE_DEBOUNCE_MS - 50);
		});
		expect(fetcher).toHaveBeenCalledTimes(1);

		await act(async () => {
			vi.advanceTimersByTime(100);
		});
		await flush();
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('refetches on any table when no tables are given', async () => {
		const fetcher = vi.fn().mockResolvedValue(1);
		renderHook(() => useDashboardResource('k:any', fetcher, 'op', { debounceMs: 10 }));
		await flush();

		act(() => emit('wizard_runs'));
		await act(async () => {
			vi.advanceTimersByTime(20);
		});
		await flush();
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('cancels a pending refetch and unsubscribes on unmount', async () => {
		const fetcher = vi.fn().mockResolvedValue(1);
		const { unmount } = renderHook(() => useDashboardResource('k:unmount', fetcher, 'op'));
		await flush();

		act(() => emit('query_events'));
		unmount();
		expect(listeners).toHaveLength(0);
		await act(async () => {
			vi.advanceTimersByTime(DASHBOARD_RESOURCE_DEBOUNCE_MS + 10);
		});
		await flush();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
