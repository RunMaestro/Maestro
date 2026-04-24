/**
 * Tests for useCue hook
 *
 * This hook manages Cue state for the renderer, including session status,
 * active runs, and activity log. Tests verify data fetching, actions,
 * event subscriptions, and cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCue } from '../../../renderer/hooks/useCue';

// Mock Cue API
const mockGetStatus = vi.fn();
const mockGetActiveRuns = vi.fn();
const mockGetActivityLog = vi.fn();
const mockGetQueueStatus = vi.fn();
const mockEnable = vi.fn();
const mockDisable = vi.fn();
const mockStopRun = vi.fn();
const mockStopAll = vi.fn();
const mockOnActivityUpdate = vi.fn();

const mockUnsubscribe = vi.fn();

// Mock setInterval/clearInterval to prevent polling during tests
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

beforeEach(() => {
	vi.clearAllMocks();

	globalThis.setInterval = vi.fn(
		() => 999 as unknown as ReturnType<typeof setInterval>
	) as unknown as typeof setInterval;
	globalThis.clearInterval = vi.fn() as unknown as typeof clearInterval;

	mockGetStatus.mockResolvedValue([]);
	mockGetActiveRuns.mockResolvedValue([]);
	mockGetActivityLog.mockResolvedValue([]);
	mockGetQueueStatus.mockResolvedValue({});
	mockEnable.mockResolvedValue(undefined);
	mockDisable.mockResolvedValue(undefined);
	mockStopRun.mockResolvedValue(true);
	mockStopAll.mockResolvedValue(undefined);
	mockOnActivityUpdate.mockReturnValue(mockUnsubscribe);

	(window as any).maestro = {
		...(window as any).maestro,
		cue: {
			getStatus: mockGetStatus,
			getActiveRuns: mockGetActiveRuns,
			getActivityLog: mockGetActivityLog,
			getQueueStatus: mockGetQueueStatus,
			enable: mockEnable,
			disable: mockDisable,
			stopRun: mockStopRun,
			stopAll: mockStopAll,
			onActivityUpdate: mockOnActivityUpdate,
		},
	};
});

afterEach(() => {
	globalThis.setInterval = originalSetInterval;
	globalThis.clearInterval = originalClearInterval;
	vi.restoreAllMocks();
});

const mockSession = {
	sessionId: 'sess-1',
	sessionName: 'Test Session',
	toolType: 'claude-code',
	enabled: true,
	subscriptionCount: 3,
	activeRuns: 1,
	lastTriggered: '2026-03-01T00:00:00Z',
};

const mockRun = {
	runId: 'run-1',
	sessionId: 'sess-1',
	sessionName: 'Test Session',
	subscriptionName: 'on-save',
	event: {
		id: 'evt-1',
		type: 'file.changed' as const,
		timestamp: '2026-03-01T00:00:00Z',
		triggerName: 'on-save',
		payload: { file: '/src/index.ts' },
	},
	status: 'completed' as const,
	stdout: 'Done',
	stderr: '',
	exitCode: 0,
	durationMs: 5000,
	startedAt: '2026-03-01T00:00:00Z',
	endedAt: '2026-03-01T00:00:05Z',
};

// Helper: render hook and flush all pending microtasks so state settles
async function renderAndSettle() {
	let hookResult: ReturnType<typeof renderHook<ReturnType<typeof useCue>, unknown>>;
	await act(async () => {
		hookResult = renderHook(() => useCue());
		// Allow microtasks (Promise.all resolution) to complete
		await Promise.resolve();
	});
	return hookResult!;
}

describe('useCue', () => {
	describe('initial fetch', () => {
		it('should fetch status, active runs, and activity log on mount', async () => {
			mockGetStatus.mockResolvedValue([mockSession]);
			mockGetActiveRuns.mockResolvedValue([]);
			mockGetActivityLog.mockResolvedValue([mockRun]);

			const { result } = await renderAndSettle();

			expect(result.current.loading).toBe(false);
			expect(result.current.sessions).toEqual([mockSession]);
			expect(result.current.activeRuns).toEqual([]);
			expect(result.current.activityLog).toEqual([mockRun]);
			expect(mockGetActivityLog).toHaveBeenCalledWith(100);
		});

		it('should set loading to false even if fetch fails', async () => {
			mockGetStatus.mockRejectedValue(new Error('Network error'));

			const { result } = await renderAndSettle();

			expect(result.current.loading).toBe(false);
		});
	});

	describe('actions', () => {
		it('should call enable and refresh', async () => {
			const { result } = await renderAndSettle();

			expect(result.current.loading).toBe(false);

			await act(async () => {
				await result.current.enable();
			});

			expect(mockEnable).toHaveBeenCalledOnce();
			expect(mockGetStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
		});

		it('should call disable and refresh', async () => {
			const { result } = await renderAndSettle();

			await act(async () => {
				await result.current.disable();
			});

			expect(mockDisable).toHaveBeenCalledOnce();
		});

		it('should call stopRun with runId and refresh', async () => {
			const { result } = await renderAndSettle();

			await act(async () => {
				await result.current.stopRun('run-1');
			});

			expect(mockStopRun).toHaveBeenCalledWith('run-1');
		});

		it('should call stopAll and refresh', async () => {
			const { result } = await renderAndSettle();

			await act(async () => {
				await result.current.stopAll();
			});

			expect(mockStopAll).toHaveBeenCalledOnce();
		});
	});

	describe('event subscription', () => {
		it('should subscribe to activity updates on mount', async () => {
			await renderAndSettle();

			expect(mockOnActivityUpdate).toHaveBeenCalledOnce();
		});

		it('should unsubscribe on unmount', async () => {
			const { unmount } = await renderAndSettle();

			expect(mockOnActivityUpdate).toHaveBeenCalledOnce();

			unmount();

			expect(mockUnsubscribe).toHaveBeenCalledOnce();
		});

		it('should refresh when activity update is received', async () => {
			const { result } = await renderAndSettle();

			expect(result.current.loading).toBe(false);

			const activityCallback = mockOnActivityUpdate.mock.calls[0][0];
			mockGetStatus.mockClear();

			await act(async () => {
				activityCallback(mockRun);
				await Promise.resolve();
			});

			expect(mockGetStatus).toHaveBeenCalled();
		});
	});

	describe('polling setup', () => {
		it('should set up interval on mount', async () => {
			await renderAndSettle();

			expect(globalThis.setInterval).toHaveBeenCalledWith(expect.any(Function), 10_000);
		});

		it('should clear interval on unmount', async () => {
			const { unmount } = await renderAndSettle();

			expect(globalThis.setInterval).toHaveBeenCalled();

			unmount();

			expect(globalThis.clearInterval).toHaveBeenCalled();
		});

		// Phase 14A — visibility-aware polling
		it('honors a custom pollIntervalMs override', async () => {
			await act(async () => {
				renderHook(() => useCue({ pollIntervalMs: 30_000 }));
				await Promise.resolve();
			});
			expect(globalThis.setInterval).toHaveBeenCalledWith(expect.any(Function), 30_000);
		});

		it('skips refresh when document.visibilityState is hidden', async () => {
			// Capture the tick callback passed to setInterval so we can invoke it
			// synchronously with a stubbed visibility state.
			let capturedTick: (() => void) | null = null;
			(globalThis.setInterval as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
				(fn: () => void) => {
					capturedTick = fn;
					return 999 as unknown as ReturnType<typeof setInterval>;
				}
			);
			await renderAndSettle();

			// Initial fetch already happened; clear to observe tick-driven refresh alone.
			mockGetStatus.mockClear();
			const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

			capturedTick?.();
			await Promise.resolve();

			expect(mockGetStatus).not.toHaveBeenCalled();
			visibilitySpy.mockRestore();
		});

		// Phase 12B — queueOverflow activity payload triggers a toast
		it('fires a warning toast when a queueOverflow activity payload is received', async () => {
			// Capture the onActivityUpdate callback so we can deliver a payload.
			let activityCallback: ((p: unknown) => void) | null = null;
			mockOnActivityUpdate.mockImplementation((cb: (p: unknown) => void) => {
				activityCallback = cb;
				return mockUnsubscribe;
			});
			const notificationStore = await import('../../../renderer/stores/notificationStore');
			const notifySpy = vi.spyOn(notificationStore, 'notifyToast').mockReturnValue(undefined);

			await renderAndSettle();
			expect(activityCallback).not.toBeNull();

			act(() => {
				activityCallback?.({
					type: 'queueOverflow',
					sessionId: 's-1',
					sessionName: 'Sess A',
					subscriptionName: 'sub-x',
					queuedAt: 1_700_000_000_000,
				});
			});

			expect(notifySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'warning',
					title: expect.stringContaining('Sess A'),
					message: expect.stringContaining('sub-x'),
				})
			);
			notifySpy.mockRestore();
		});

		it('does not fire a toast for runFinished payloads', async () => {
			let activityCallback: ((p: unknown) => void) | null = null;
			mockOnActivityUpdate.mockImplementation((cb: (p: unknown) => void) => {
				activityCallback = cb;
				return mockUnsubscribe;
			});
			const notificationStore = await import('../../../renderer/stores/notificationStore');
			const notifySpy = vi.spyOn(notificationStore, 'notifyToast').mockReturnValue(undefined);

			await renderAndSettle();

			act(() => {
				activityCallback?.({
					type: 'runFinished',
					runId: 'r-1',
					sessionId: 's-1',
					subscriptionName: 'sub-x',
					status: 'completed',
				});
			});

			expect(notifySpy).not.toHaveBeenCalled();
			notifySpy.mockRestore();
		});

		it('runs refresh on tick when document.visibilityState is visible', async () => {
			let capturedTick: (() => void) | null = null;
			(globalThis.setInterval as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
				(fn: () => void) => {
					capturedTick = fn;
					return 999 as unknown as ReturnType<typeof setInterval>;
				}
			);
			await renderAndSettle();
			mockGetStatus.mockClear();
			const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

			await act(async () => {
				capturedTick?.();
				await Promise.resolve();
			});

			expect(mockGetStatus).toHaveBeenCalled();
			visibilitySpy.mockRestore();
		});
	});

	describe('error state', () => {
		it('error is null on successful refresh', async () => {
			const { result } = await renderAndSettle();
			expect(result.current.error).toBeNull();
		});

		it('error is set when refresh fails', async () => {
			mockGetStatus.mockRejectedValue(new Error('Network error'));
			const { result } = await renderAndSettle();
			expect(result.current.error).toBe('Network error');
		});

		it('error clears on successful retry', async () => {
			mockGetStatus.mockRejectedValue(new Error('Network error'));
			const { result } = await renderAndSettle();
			expect(result.current.error).toBe('Network error');

			mockGetStatus.mockResolvedValue([]);
			await act(async () => {
				await result.current.refresh();
			});
			expect(result.current.error).toBeNull();
		});

		it('error captures message from Error objects', async () => {
			mockGetStatus.mockRejectedValue(new Error('IPC channel closed'));
			const { result } = await renderAndSettle();
			expect(result.current.error).toBe('IPC channel closed');
		});

		it('error uses fallback for non-Error rejections', async () => {
			mockGetStatus.mockRejectedValue('string rejection');
			const { result } = await renderAndSettle();
			expect(result.current.error).toBe('Failed to fetch Cue status');
		});
	});

	describe('return value shape', () => {
		it('should return all expected properties', async () => {
			const { result } = await renderAndSettle();

			expect(result.current.loading).toBe(false);
			expect(result.current.error).toBeNull();
			expect(Array.isArray(result.current.sessions)).toBe(true);
			expect(Array.isArray(result.current.activeRuns)).toBe(true);
			expect(Array.isArray(result.current.activityLog)).toBe(true);
			expect(typeof result.current.queueStatus).toBe('object');
			expect(typeof result.current.enable).toBe('function');
			expect(typeof result.current.disable).toBe('function');
			expect(typeof result.current.stopRun).toBe('function');
			expect(typeof result.current.stopAll).toBe('function');
			expect(typeof result.current.refresh).toBe('function');
		});
	});
});
