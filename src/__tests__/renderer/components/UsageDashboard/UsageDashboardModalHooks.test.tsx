import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatsAggregation } from '../../../../shared/stats-types';
import { useCodexUsageStore } from '../../../../renderer/stores/codexUsageStore';
import { useClaudeUsageStore } from '../../../../renderer/stores/claudeUsageStore';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import {
	useQuotaTabDiscovery,
	useUsageDashboardData,
	useUsageDashboardExport,
	useUsageDashboardLayout,
	useUsageDashboardTabs,
} from '../../../../renderer/components/UsageDashboard/UsageDashboardModal/hooks';

const sampleAggregation: StatsAggregation = {
	totalQueries: 2,
	totalDuration: 1000,
	avgDuration: 500,
	queryDurationPercentiles: { count: 0, min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0 },
	queryDurationPercentilesByAgent: {},
	autoRunTaskDurationPercentiles: {
		count: 0,
		min: 0,
		p50: 0,
		p75: 0,
		p90: 0,
		p95: 0,
		p99: 0,
		max: 0,
	},
	byAgent: { codex: { count: 2, duration: 1000 } },
	bySource: { user: 1, auto: 1 },
	byLocation: { local: 2, remote: 0 },
	byDay: [],
	byHour: [],
	totalSessions: 1,
	sessionsByAgent: { codex: 1 },
	sessionsByDay: [],
	avgSessionDuration: 1000,
	byAgentByDay: {},
	bySessionByDay: {},
	bySessionSource: {},
	worktreeQueries: 0,
	parentQueries: 2,
	byWorktreeStatus: {
		worktree: { count: 0, duration: 0 },
		parent: { count: 2, duration: 1000 },
	},
	imageAnnotations: 0,
};

const mockGetAggregation = vi.fn();
const mockGetDatabaseSize = vi.fn();
const mockOnStatsUpdate = vi.fn();
const mockCueAggregation = vi.fn();
const mockSaveFile = vi.fn();
const mockExportCsv = vi.fn();
const mockWriteFile = vi.fn();
const mockRefreshClaudeUsageSnapshots = vi.fn();
const mockRefreshCodexUsageSnapshots = vi.fn();

async function flushPromises() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

function installMaestroMock() {
	let statsUpdateHandler: (() => void) | undefined;
	mockOnStatsUpdate.mockImplementation((handler: () => void) => {
		statsUpdateHandler = handler;
		return vi.fn();
	});

	Object.defineProperty(window, 'maestro', {
		value: {
			stats: {
				getAggregation: mockGetAggregation,
				getDatabaseSize: mockGetDatabaseSize,
				onStatsUpdate: mockOnStatsUpdate,
				exportCsv: mockExportCsv,
			},
			cueStats: {
				getAggregation: mockCueAggregation,
			},
			dialog: {
				saveFile: mockSaveFile,
			},
			fs: {
				writeFile: mockWriteFile,
			},
			agents: {
				refreshClaudeUsageSnapshots: mockRefreshClaudeUsageSnapshots,
				refreshCodexUsageSnapshots: mockRefreshCodexUsageSnapshots,
			},
		},
		writable: true,
	});

	return {
		emitStatsUpdate: () => statsUpdateHandler?.(),
	};
}

describe('UsageDashboardModal hooks', () => {
	beforeEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		useUIStore.setState({ usageDashboardViewMode: 'overview' });
		// Virtuosos tab only exists while the Encore flag is on
		useSettingsStore.setState((s) => ({
			encoreFeatures: { ...s.encoreFeatures, virtuosos: true },
		}));
		useClaudeUsageStore.getState().__resetForTests();
		useCodexUsageStore.getState().__resetForTests();
		mockGetAggregation.mockResolvedValue(sampleAggregation);
		mockGetDatabaseSize.mockResolvedValue(4096);
		mockCueAggregation.mockResolvedValue({
			totals: { occurrences: 3, totalDurationMs: 1200 },
		});
		mockSaveFile.mockResolvedValue('/tmp/usage.csv');
		mockExportCsv.mockResolvedValue('a,b\n1,2');
		mockWriteFile.mockResolvedValue(undefined);
		mockRefreshClaudeUsageSnapshots.mockResolvedValue({ refreshed: 1 });
		mockRefreshCodexUsageSnapshots.mockResolvedValue({ refreshed: 1 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('loads usage data, Cue totals, and debounces realtime refresh indicators', async () => {
		vi.useFakeTimers();
		const controls = installMaestroMock();

		const { result } = renderHook(() =>
			useUsageDashboardData({
				isOpen: true,
				timeRange: 'week',
				cueTabEnabled: true,
			})
		);

		await flushPromises();
		expect(result.current.loading).toBe(false);
		expect(result.current.data).toBe(sampleAggregation);
		expect(result.current.databaseSize).toBe(4096);
		expect(result.current.cueSourceTotals).toEqual({
			occurrences: 3,
			totalDurationMs: 1200,
		});

		mockGetAggregation.mockClear();
		act(() => controls.emitStatsUpdate());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(999);
		});
		expect(mockGetAggregation).not.toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		await flushPromises();
		expect(mockGetAggregation).toHaveBeenCalledTimes(1);
		expect(result.current.showNewDataIndicator).toBe(true);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(result.current.showNewDataIndicator).toBe(false);
	});

	it('clears realtime indicator timers on unmount', async () => {
		vi.useFakeTimers();
		const controls = installMaestroMock();

		const { unmount } = renderHook(() =>
			useUsageDashboardData({
				isOpen: true,
				timeRange: 'week',
				cueTabEnabled: true,
			})
		);

		await flushPromises();
		act(() => controls.emitStatsUpdate());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		await flushPromises();
		expect(vi.getTimerCount()).toBe(1);

		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('persists tabs, appends dynamic tabs, and falls back from disabled tabs', async () => {
		installMaestroMock();
		useUIStore.setState({ usageDashboardViewMode: 'cue' });
		const content = document.createElement('div');
		content.scrollTop = 24;
		const onViewModeChanged = vi.fn();

		const { result } = renderHook(() =>
			useUsageDashboardTabs({
				cueTabEnabled: false,
				hasAnthropicUsageDetails: true,
				hasCodexUsageDetails: true,
				contentRef: { current: content },
				onViewModeChanged,
			})
		);

		await waitFor(() => expect(result.current.viewMode).toBe('overview'));
		expect(result.current.viewModeTabs.map((tab) => tab.value)).toEqual([
			'overview',
			'agent-overview',
			'agents',
			'activity',
			'autorun',
			'accounts',
			'shortcuts',
			'anthropic-usage',
			'codex-usage',
		]);

		act(() => result.current.switchViewMode('activity'));
		expect(useUIStore.getState().usageDashboardViewMode).toBe('activity');
		expect(content.scrollTop).toBe(0);
		expect(onViewModeChanged).toHaveBeenCalled();
	});

	it('derives responsive layout columns from ResizeObserver width', async () => {
		installMaestroMock();
		let observerCallback: ResizeObserverCallback | undefined;
		const disconnect = vi.fn();
		const observe = vi.fn();
		const originalResizeObserver = globalThis.ResizeObserver;
		class MockResizeObserver {
			constructor(callback: ResizeObserverCallback) {
				observerCallback = callback;
			}

			observe = observe;
			disconnect = disconnect;
		}
		globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

		const content = document.createElement('div');
		Object.defineProperty(content, 'offsetWidth', { value: 580, configurable: true });

		const { result, unmount } = renderHook(() =>
			useUsageDashboardLayout(true, { current: content })
		);

		await waitFor(() => expect(result.current.chartGridCols).toBe(1));
		expect(result.current.summaryCardsCols).toBe(2);

		Object.defineProperty(content, 'offsetWidth', { value: 920, configurable: true });
		act(() => observerCallback?.([], {} as ResizeObserver));
		await waitFor(() => expect(result.current.autoRunStatsCols).toBe(6));

		unmount();
		expect(disconnect).toHaveBeenCalled();
		globalThis.ResizeObserver = originalResizeObserver;
	});

	it('exports CSV through dialog and filesystem APIs', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-01T12:00:00.000Z'));
		installMaestroMock();
		const { result } = renderHook(() => useUsageDashboardExport('month'));

		await act(async () => {
			await result.current.handleExport();
		});

		expect(mockSaveFile).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultPath: 'maestro-usage-month-2026-07-01.csv',
			})
		);
		expect(mockExportCsv).toHaveBeenCalledWith('month');
		expect(mockWriteFile).toHaveBeenCalledWith('/tmp/usage.csv', 'a,b\n1,2');
		expect(result.current.isExporting).toBe(false);

		mockSaveFile.mockResolvedValueOnce(null);
		await act(async () => {
			await result.current.handleExport();
		});
		expect(mockExportCsv).toHaveBeenCalledTimes(1);
	});

	it('samples quota tabs once per open and skips when disabled', async () => {
		installMaestroMock();
		const { rerender } = renderHook(
			({ isOpen, enabled }) => useQuotaTabDiscovery(isOpen, enabled),
			{ initialProps: { isOpen: true, enabled: true } }
		);

		await waitFor(() => expect(mockRefreshClaudeUsageSnapshots).toHaveBeenCalledTimes(1));
		expect(mockRefreshCodexUsageSnapshots).toHaveBeenCalledTimes(1);

		rerender({ isOpen: true, enabled: true });
		expect(mockRefreshClaudeUsageSnapshots).toHaveBeenCalledTimes(1);

		rerender({ isOpen: false, enabled: true });
		rerender({ isOpen: true, enabled: false });
		expect(mockRefreshCodexUsageSnapshots).toHaveBeenCalledTimes(1);
	});
});
