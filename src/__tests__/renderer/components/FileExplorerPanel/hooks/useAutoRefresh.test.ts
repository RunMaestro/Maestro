import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoRefresh } from '../../../../../renderer/components/FileExplorerPanel/hooks/useAutoRefresh';

vi.mock('../../../../../renderer/utils/logger', () => ({
	logger: { error: vi.fn() },
}));

vi.mock('../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

const defaultArgs = {
	sessionId: 'sess-1',
	autoRefreshInterval: 0,
	refreshFileTree: vi.fn().mockResolvedValue({ totalChanges: 0 }),
	onAutoRefreshChange: vi.fn(),
	onShowFlash: vi.fn(),
	setSessions: vi.fn(),
};

describe('useAutoRefresh', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('initialises with isRefreshing = false and overlayOpen = false', () => {
		const { result } = renderHook(() => useAutoRefresh(defaultArgs));
		expect(result.current.isRefreshing).toBe(false);
		expect(result.current.overlayOpen).toBe(false);
	});

	it('handleRefresh calls refreshFileTree and shows flash', async () => {
		const refreshFileTree = vi.fn().mockResolvedValue({ totalChanges: 3 });
		const onShowFlash = vi.fn();
		const { result } = renderHook(() =>
			useAutoRefresh({ ...defaultArgs, refreshFileTree, onShowFlash })
		);
		await act(async () => {
			await result.current.handleRefresh();
			vi.advanceTimersByTime(500);
		});
		expect(refreshFileTree).toHaveBeenCalledWith('sess-1');
		expect(onShowFlash).toHaveBeenCalledWith('Detected 3 changes');
	});

	it('handleRefresh shows "No changes detected" flash when totalChanges is 0', async () => {
		const onShowFlash = vi.fn();
		const { result } = renderHook(() => useAutoRefresh({ ...defaultArgs, onShowFlash }));
		await act(async () => {
			await result.current.handleRefresh();
			vi.advanceTimersByTime(500);
		});
		expect(onShowFlash).toHaveBeenCalledWith('No changes detected');
	});

	it('auto-refresh timer fires after the configured interval', async () => {
		const refreshFileTree = vi.fn().mockResolvedValue(undefined);
		renderHook(() => useAutoRefresh({ ...defaultArgs, autoRefreshInterval: 60, refreshFileTree }));
		await act(async () => {
			vi.advanceTimersByTime(60000);
		});
		expect(refreshFileTree).toHaveBeenCalledTimes(1);
	});

	it('in-flight guard prevents overlapping auto-refresh ticks', async () => {
		const refreshFileTree = vi
			.fn()
			.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100000)));
		renderHook(() => useAutoRefresh({ ...defaultArgs, autoRefreshInterval: 5, refreshFileTree }));
		// Advance two intervals - second tick should be skipped
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(refreshFileTree).toHaveBeenCalledTimes(1);
	});

	it('does not start a timer when autoRefreshInterval is 0', async () => {
		const refreshFileTree = vi.fn().mockResolvedValue(undefined);
		renderHook(() => useAutoRefresh({ ...defaultArgs, autoRefreshInterval: 0, refreshFileTree }));
		await act(async () => {
			vi.advanceTimersByTime(300000);
		});
		expect(refreshFileTree).not.toHaveBeenCalled();
	});

	it('overlay opens after 400ms hover delay on refresh button', () => {
		const { result } = renderHook(() => useAutoRefresh(defaultArgs));
		act(() => {
			result.current.handleRefreshMouseEnter();
		});
		expect(result.current.overlayOpen).toBe(false);
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(result.current.overlayOpen).toBe(true);
	});

	it('overlay stays open when mouse moves onto the overlay panel', () => {
		const { result } = renderHook(() => useAutoRefresh(defaultArgs));
		act(() => {
			result.current.handleRefreshMouseEnter();
			vi.advanceTimersByTime(400);
		});
		act(() => {
			result.current.handleRefreshMouseLeave();
			result.current.handleOverlayMouseEnter();
		});
		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(result.current.overlayOpen).toBe(true);
	});

	it('overlay closes when mouse leaves the overlay panel', () => {
		const { result } = renderHook(() => useAutoRefresh(defaultArgs));
		act(() => {
			result.current.handleRefreshMouseEnter();
			vi.advanceTimersByTime(400);
			result.current.handleOverlayMouseEnter();
		});
		act(() => {
			result.current.handleOverlayMouseLeave();
		});
		expect(result.current.overlayOpen).toBe(false);
	});

	it('handleIntervalSelect calls onAutoRefreshChange and closes the overlay', () => {
		const onAutoRefreshChange = vi.fn();
		const { result } = renderHook(() => useAutoRefresh({ ...defaultArgs, onAutoRefreshChange }));
		act(() => {
			result.current.handleIntervalSelect(30);
		});
		expect(onAutoRefreshChange).toHaveBeenCalledWith(30);
		expect(result.current.overlayOpen).toBe(false);
	});
});
