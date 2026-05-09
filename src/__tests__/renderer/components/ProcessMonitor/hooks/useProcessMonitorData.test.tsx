import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCaptureException = vi.fn();
vi.mock('../../../../../renderer/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { useProcessMonitorData } from '../../../../../renderer/components/ProcessMonitor/hooks/useProcessMonitorData';

const setHidden = (hidden: boolean) => {
	Object.defineProperty(document, 'hidden', {
		configurable: true,
		get: () => hidden,
	});
};

const fireVisibilityChange = () => {
	document.dispatchEvent(new Event('visibilitychange'));
};

describe('useProcessMonitorData', () => {
	let getActive: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		// shouldAdvanceTime: true keeps real time moving so waitFor() (which uses
		// real-timer setTimeouts internally) does not deadlock against frozen fake
		// timers. This mirrors the existing ProcessMonitor.test.tsx setup.
		vi.useFakeTimers({ shouldAdvanceTime: true });
		mockCaptureException.mockClear();
		setHidden(false);
		getActive = vi.fn().mockResolvedValue([]);
		(window as unknown as { maestro: unknown }).maestro = {
			process: { getActiveProcesses: getActive },
		};
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('fetches once on mount and clears isLoading', async () => {
		const { result } = renderHook(() => useProcessMonitorData());
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(getActive).toHaveBeenCalledTimes(1);
	});

	it('polls every 2 seconds while the document is visible', async () => {
		renderHook(() => useProcessMonitorData());
		await waitFor(() => expect(getActive).toHaveBeenCalledTimes(1));
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		await waitFor(() => expect(getActive).toHaveBeenCalledTimes(2));
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		await waitFor(() => expect(getActive).toHaveBeenCalledTimes(3));
	});

	it('pauses polling when document.hidden flips true', async () => {
		renderHook(() => useProcessMonitorData());
		await waitFor(() => expect(getActive).toHaveBeenCalledTimes(1));
		act(() => {
			setHidden(true);
			fireVisibilityChange();
		});
		await act(async () => {
			vi.advanceTimersByTime(10_000);
		});
		// After hidden, no further polls should fire even after 5x the interval.
		expect(getActive).toHaveBeenCalledTimes(1);
	});

	it('resumes polling and immediately catches up when visibility returns', async () => {
		renderHook(() => useProcessMonitorData());
		await waitFor(() => expect(getActive).toHaveBeenCalledTimes(1));
		act(() => {
			setHidden(true);
			fireVisibilityChange();
		});
		await act(async () => {
			vi.advanceTimersByTime(10_000);
		});
		expect(getActive).toHaveBeenCalledTimes(1);
		act(() => {
			setHidden(false);
			fireVisibilityChange();
		});
		await waitFor(() => expect(getActive).toHaveBeenCalledTimes(2));
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		await waitFor(() => expect(getActive).toHaveBeenCalledTimes(3));
	});

	it('keeps polling after a fetch error and reports it to Sentry', async () => {
		const error = new Error('boom');
		getActive.mockRejectedValueOnce(error);
		renderHook(() => useProcessMonitorData());
		await waitFor(() => expect(getActive).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(mockCaptureException).toHaveBeenCalledWith(error));
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		await waitFor(() => expect(getActive).toHaveBeenCalledTimes(2));
	});

	it('refresh() shows the spinner for at least 500ms', async () => {
		const { result } = renderHook(() => useProcessMonitorData());
		await waitFor(() => expect(result.current.isLoading).toBe(false));
		await act(async () => {
			void result.current.refresh();
			await Promise.resolve();
		});
		expect(result.current.isRefreshing).toBe(true);
		await act(async () => {
			vi.advanceTimersByTime(499);
		});
		expect(result.current.isRefreshing).toBe(true);
		await act(async () => {
			vi.advanceTimersByTime(2);
		});
		await waitFor(() => expect(result.current.isRefreshing).toBe(false));
	});

	it('clears the polling interval on unmount', async () => {
		const { unmount } = renderHook(() => useProcessMonitorData());
		await waitFor(() => expect(getActive).toHaveBeenCalledTimes(1));
		unmount();
		await act(async () => {
			vi.advanceTimersByTime(10_000);
		});
		expect(getActive).toHaveBeenCalledTimes(1);
	});

	it('exposes the latest activeProcesses array', async () => {
		const sample = [
			{
				sessionId: 's-1-ai',
				toolType: 'claude-code',
				pid: 1,
				cwd: '/',
				isTerminal: false,
				isBatchMode: false,
			},
		];
		getActive.mockResolvedValueOnce(sample);
		const { result } = renderHook(() => useProcessMonitorData());
		await waitFor(() => expect(result.current.activeProcesses).toEqual(sample));
	});
});
