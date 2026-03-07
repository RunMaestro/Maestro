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
	});

	describe('return value shape', () => {
		it('should return all expected properties', async () => {
			const { result } = await renderAndSettle();

			expect(result.current.loading).toBe(false);
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
