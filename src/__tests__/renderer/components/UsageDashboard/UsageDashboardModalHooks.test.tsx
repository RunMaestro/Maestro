import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatsAggregation } from '../../../../shared/stats-types';
import { useCodexUsageStore } from '../../../../renderer/stores/codexUsageStore';
import { useClaudeUsageStore } from '../../../../renderer/stores/claudeUsageStore';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import {
	useQuotaTabDiscovery,
	useUsageDashboardData,
	useUsageDashboardExport,
	useUsageDashboardKeyboard,
	useUsageDashboardLayout,
	useUsageDashboardTabs,
} from '../../../../renderer/components/UsageDashboard/UsageDashboardModal/hooks';
import { emptyPromptCadence } from '../../../../shared/promptCadence';

const mockNotifyToast = vi.hoisted(() => vi.fn());
vi.mock('../../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/stores/notificationStore')>()),
	notifyToast: mockNotifyToast,
}));

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
	byDayHour: [],
	window: { startYmd: '2026-07-04', endYmd: '2026-07-10' },
	earliestQueryAt: null,
	streak: { current: 0, longest: 0 },
	byHour: [],
	totalSessions: 1,
	byAgentByDay: {},
	bySessionByDay: {},
	bySessionSource: {},
	worktreeQueries: 0,
	parentQueries: 2,
	byAgentWorktree: {},
	imageAnnotations: 0,
	prompts: emptyPromptCadence(),
};

const mockGetAggregation = vi.fn();
const mockGetDelegationTotals = vi.fn().mockResolvedValue({
	interactive: { count: 0, durationMs: 0 },
	autoRun: { count: 0, durationMs: 0 },
	cue: { count: 0, durationMs: 0 },
});
const mockGetDelegationByDay = vi.fn().mockResolvedValue([]);
const mockGetDatabaseSize = vi.fn();
const mockOnStatsUpdate = vi.fn();
const mockCueSourceTotals = vi.fn();
const mockSaveFile = vi.fn();
const mockExportUsage = vi.fn();
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
	let statsUpdateHandler: ((table?: string) => void) | undefined;
	mockOnStatsUpdate.mockImplementation((handler: (table?: string) => void) => {
		statsUpdateHandler = handler;
		return vi.fn();
	});

	Object.defineProperty(window, 'maestro', {
		value: {
			stats: {
				getAggregation: mockGetAggregation,
				getDelegationTotals: mockGetDelegationTotals,
				getDelegationByDay: mockGetDelegationByDay,
				getDatabaseSize: mockGetDatabaseSize,
				onStatsUpdate: mockOnStatsUpdate,
				exportUsage: mockExportUsage,
			},
			cueStats: {
				getSourceTotals: mockCueSourceTotals,
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
		emitStatsUpdate: (table?: string) => statsUpdateHandler?.(table),
	};
}

describe('UsageDashboardModal hooks', () => {
	beforeEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		useUIStore.setState({ usageDashboardViewMode: 'overview' });
		useClaudeUsageStore.getState().__resetForTests();
		useCodexUsageStore.getState().__resetForTests();
		mockGetAggregation.mockResolvedValue(sampleAggregation);
		mockGetDelegationTotals.mockResolvedValue({
			interactive: { count: 4, durationMs: 40000 },
			autoRun: { count: 2, durationMs: 30000 },
			cue: { count: 1, durationMs: 30000 },
		});
		mockGetDelegationByDay.mockResolvedValue([]);
		mockGetDatabaseSize.mockResolvedValue(4096);
		mockCueSourceTotals.mockResolvedValue({ occurrences: 3, totalDurationMs: 1200, tokens: 0 });
		mockSaveFile.mockResolvedValue('/tmp/usage.json');
		mockExportUsage.mockResolvedValue({
			path: '/tmp/usage.json',
			format: 'json',
			rowCounts: { 'query-events': 2, 'wizard-runs': 1 },
			notes: [],
		});
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
				needsCueTotals: true,
			})
		);

		await flushPromises();
		expect(result.current.loading).toBe(false);
		expect(result.current.data).toBe(sampleAggregation);
		expect(result.current.databaseSize).toBe(4096);
		expect(result.current.cueSourceTotals).toEqual({
			occurrences: 3,
			totalDurationMs: 1200,
			// Cue token totals feed the Source Distribution chart's Tokens mode; this
			// fixture's Cue aggregate reports none.
			tokens: 0,
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
		// The Overview is showing, so its Cue slice refreshes with the payload.
		expect(mockCueSourceTotals).toHaveBeenCalledTimes(2);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(result.current.showNewDataIndicator).toBe(false);
	});

	it('fetches the Cue aggregate only while a tab needs the Cue totals', async () => {
		vi.useFakeTimers();
		const controls = installMaestroMock();

		const { result, rerender } = renderHook(
			({ needsCueTotals }) =>
				useUsageDashboardData({
					isOpen: true,
					timeRange: 'quarter',
					cueTabEnabled: true,
					needsCueTotals,
				}),
			{ initialProps: { needsCueTotals: false } }
		);
		await flushPromises();
		expect(result.current.data).toBe(sampleAggregation);
		expect(mockCueSourceTotals).not.toHaveBeenCalled();
		expect(result.current.cueSourceTotals).toBeNull();

		// A stats update on a non-Overview tab refreshes the payload, not Cue.
		act(() => controls.emitStatsUpdate('query_events'));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		await flushPromises();
		expect(mockCueSourceTotals).not.toHaveBeenCalled();

		rerender({ needsCueTotals: true });
		await flushPromises();
		expect(mockCueSourceTotals).toHaveBeenCalledWith('quarter');
		expect(result.current.cueSourceTotals).toEqual({
			occurrences: 3,
			totalDurationMs: 1200,
			tokens: 0,
		});
	});

	it('never fetches Cue totals with the Cue tab off', async () => {
		installMaestroMock();
		const { result } = renderHook(() =>
			useUsageDashboardData({
				isOpen: true,
				timeRange: 'year',
				cueTabEnabled: false,
				needsCueTotals: true,
			})
		);
		await flushPromises();
		expect(result.current.data).toBe(sampleAggregation);
		expect(mockCueSourceTotals).not.toHaveBeenCalled();
		expect(result.current.cueSourceTotals).toBeNull();
	});

	it('refetches only for the tables the payload reads', async () => {
		vi.useFakeTimers();
		const controls = installMaestroMock();

		renderHook(() =>
			useUsageDashboardData({ isOpen: true, timeRange: 'day', cueTabEnabled: false })
		);
		await flushPromises();
		mockGetAggregation.mockClear();

		for (const table of ['shortcut_usage', 'resilience', 'wizard_runs', 'session_lifecycle']) {
			act(() => controls.emitStatsUpdate(table));
		}
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		await flushPromises();
		expect(mockGetAggregation).not.toHaveBeenCalled();

		// A burst across the tables it does read collapses into one refetch, and
		// an unnamed update (older main, bulk clear) counts as relevant.
		act(() => {
			controls.emitStatsUpdate('query_events');
			controls.emitStatsUpdate('image_annotations');
			controls.emitStatsUpdate('auto_run');
			controls.emitStatsUpdate();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		await flushPromises();
		expect(mockGetAggregation).toHaveBeenCalledTimes(1);
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

	it('renders the cached payload on reopen and refreshes it in place', async () => {
		installMaestroMock();
		const options = { isOpen: true, timeRange: 'week' as const, cueTabEnabled: true };

		const first = renderHook(() => useUsageDashboardData(options));
		await flushPromises();
		expect(first.result.current.data).toBe(sampleAggregation);
		first.unmount();

		// The second open must not start from a skeleton: the last result is on
		// the first render, while a fresh fetch replaces it underneath.
		const refreshed = { ...sampleAggregation, totalQueries: 7 };
		let resolveRefresh: (value: StatsAggregation) => void = () => {};
		mockGetAggregation.mockReturnValueOnce(
			new Promise<StatsAggregation>((resolve) => {
				resolveRefresh = resolve;
			})
		);

		const second = renderHook(() => useUsageDashboardData(options));
		expect(second.result.current.loading).toBe(false);
		expect(second.result.current.data).toBe(sampleAggregation);

		await act(async () => {
			resolveRefresh(refreshed);
		});
		await flushPromises();
		expect(second.result.current.data).toBe(refreshed);
	});

	it('keeps the last good payload when a refresh fails', async () => {
		installMaestroMock();
		const options = { isOpen: true, timeRange: 'month' as const, cueTabEnabled: false };

		const { result, rerender } = renderHook(() => useUsageDashboardData(options));
		await flushPromises();
		expect(result.current.data).toBe(sampleAggregation);

		mockGetAggregation.mockRejectedValueOnce(new Error('db locked'));
		await act(async () => {
			await result.current.fetchStats();
		});
		rerender();
		expect(result.current.data).toBe(sampleAggregation);
		expect(result.current.error).toBeNull();
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
			'groups',
			'tokens',
			'models',
			'activity',
			'autorun',
			'shortcuts',
			'anthropic-usage',
			'codex-usage',
		]);

		act(() => result.current.switchViewMode('activity'));
		expect(useUIStore.getState().usageDashboardViewMode).toBe('activity');
		expect(content.scrollTop).toBe(0);
		expect(onViewModeChanged).toHaveBeenCalled();

		// A deep link to the open dashboard (`open usage-dashboard --tab`) writes
		// the store; the open dashboard must follow it.
		onViewModeChanged.mockClear();
		content.scrollTop = 120;
		act(() => useUIStore.getState().setUsageDashboardViewMode('tokens'));
		await waitFor(() => expect(result.current.viewMode).toBe('tokens'));
		expect(onViewModeChanged).toHaveBeenCalled();
		expect(content.scrollTop).toBe(0);
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
		expect(result.current.isTiny).toBe(false);

		// Phone width: a rung below `isNarrow`. Two metric cards in a ~340px
		// column leave each about 90px of text, and the Auto Run tiles TRUNCATE
		// their value rather than wrapping it ("4h 3…").
		Object.defineProperty(content, 'offsetWidth', { value: 340, configurable: true });
		act(() => observerCallback?.([], {} as ResizeObserver));
		await waitFor(() => expect(result.current.isTiny).toBe(true));
		expect(result.current.summaryCardsCols).toBe(1);
		expect(result.current.autoRunStatsCols).toBe(1);

		Object.defineProperty(content, 'offsetWidth', { value: 920, configurable: true });
		act(() => observerCallback?.([], {} as ResizeObserver));
		await waitFor(() => expect(result.current.autoRunStatsCols).toBe(7));

		unmount();
		expect(disconnect).toHaveBeenCalled();
		globalThis.ResizeObserver = originalResizeObserver;
	});

	it('exports through the save dialog and reports where the file went', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 6, 1, 12, 0, 0));
		installMaestroMock();
		const { result } = renderHook(() => useUsageDashboardExport('month'));

		await act(async () => {
			await result.current.handleExport('json');
		});

		expect(mockSaveFile).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultPath: 'maestro-usage-month-20260701-120000.json',
				filters: [{ name: 'JSON', extensions: ['json'] }],
			})
		);
		expect(mockExportUsage).toHaveBeenCalledWith('month', 'json', '/tmp/usage.json');
		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'green', message: '3 rows saved to /tmp/usage.json.' })
		);
		expect(result.current.isExporting).toBe(false);

		mockSaveFile.mockResolvedValueOnce(null);
		await act(async () => {
			await result.current.handleExport('csv');
		});
		expect(mockSaveFile).toHaveBeenLastCalledWith(
			expect.objectContaining({ filters: [{ name: 'Zip of CSV files', extensions: ['zip'] }] })
		);
		expect(mockExportUsage).toHaveBeenCalledTimes(1);
	});

	it('reports a failed export instead of failing silently', async () => {
		installMaestroMock();
		mockExportUsage.mockRejectedValueOnce(new Error('disk full'));
		const { result } = renderHook(() => useUsageDashboardExport('week'));

		await act(async () => {
			await result.current.handleExport('csv');
		});

		expect(mockNotifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', message: 'disk full' })
		);
		expect(result.current.isExporting).toBe(false);
	});

	describe('useUsageDashboardKeyboard', () => {
		const tabs = [
			{ value: 'overview', label: 'Overview' },
			{ value: 'agents', label: 'Agents' },
			{ value: 'activity', label: 'Activity' },
		];

		function setup(currentSections: string[], mounted: string[]) {
			const switchViewMode = vi.fn();
			const setFocusedSection = vi.fn();
			const tabsEl = document.createElement('div');
			tabsEl.focus = vi.fn();
			const sectionRefs = { current: new Map<string, HTMLDivElement>() };
			const elements: Record<string, HTMLDivElement> = {};
			for (const id of mounted) {
				const el = document.createElement('div');
				el.focus = vi.fn();
				el.scrollIntoView = vi.fn();
				elements[id] = el;
				sectionRefs.current.set(id, el);
			}
			const hook = renderHook(() =>
				useUsageDashboardKeyboard({
					isOpen: true,
					viewMode: 'overview',
					viewModeRef: { current: 'overview' },
					viewModeTabs: tabs,
					switchViewMode,
					currentSections,
					tabsRef: { current: tabsEl },
					sectionRefs,
					setFocusedSection,
				} as never)
			);
			return { ...hook, switchViewMode, setFocusedSection, elements, tabsEl };
		}

		function keyEvent(key: string, opts: { shiftKey?: boolean; fromChild?: boolean } = {}) {
			const currentTarget = document.createElement('div');
			const target = opts.fromChild ? document.createElement('button') : currentTarget;
			return {
				key,
				shiftKey: !!opts.shiftKey,
				target,
				currentTarget,
				preventDefault: vi.fn(),
			};
		}

		it('cycles tabs with Ctrl+Shift+[ / ] as well as Cmd', () => {
			const { switchViewMode, unmount } = setup(['summary-cards'], ['summary-cards']);

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', { key: ']', ctrlKey: true, shiftKey: true })
				);
			});
			expect(switchViewMode).toHaveBeenLastCalledWith('agents');

			act(() => {
				window.dispatchEvent(
					new KeyboardEvent('keydown', { key: '[', metaKey: true, shiftKey: true })
				);
			});
			expect(switchViewMode).toHaveBeenLastCalledWith('activity');
			unmount();
		});

		it('ignores section keys that come from a control inside the section', () => {
			const { result, setFocusedSection } = setup(
				['summary-cards', 'token-speed'],
				['summary-cards', 'token-speed']
			);
			const event = keyEvent('Tab', { fromChild: true });
			act(() => result.current.handleSectionKeyDown(event as never, 'summary-cards' as never));
			expect(event.preventDefault).not.toHaveBeenCalled();
			expect(setFocusedSection).not.toHaveBeenCalled();

			const arrow = keyEvent('ArrowDown', { fromChild: true });
			act(() => result.current.handleSectionKeyDown(arrow as never, 'summary-cards' as never));
			expect(arrow.preventDefault).not.toHaveBeenCalled();
		});

		it('moves between sections when the section itself is focused, skipping unmounted ones', () => {
			const { result, setFocusedSection, elements, tabsEl } = setup(
				['summary-cards', 'token-speed', 'radial-activity'],
				['summary-cards', 'radial-activity']
			);
			const down = keyEvent('ArrowDown');
			act(() => result.current.handleSectionKeyDown(down as never, 'summary-cards' as never));
			expect(down.preventDefault).toHaveBeenCalled();
			expect(setFocusedSection).toHaveBeenLastCalledWith('radial-activity');
			expect(elements['radial-activity'].focus).toHaveBeenCalled();

			const up = keyEvent('Tab', { shiftKey: true });
			act(() => result.current.handleSectionKeyDown(up as never, 'summary-cards' as never));
			expect(setFocusedSection).toHaveBeenLastCalledWith(null);
			expect(tabsEl.focus).toHaveBeenCalled();
		});

		it('redirects Tab from the tab strip only when a section is on screen', () => {
			const empty = setup(['summary-cards'], []);
			const noSection = keyEvent('Tab');
			act(() => empty.result.current.handleTabKeyDown(noSection as never));
			expect(noSection.preventDefault).not.toHaveBeenCalled();
			expect(empty.setFocusedSection).not.toHaveBeenCalled();
			empty.unmount();

			const ready = setup(['year-in-pixels', 'summary-cards'], ['summary-cards']);
			const tab = keyEvent('Tab');
			act(() => ready.result.current.handleTabKeyDown(tab as never));
			expect(tab.preventDefault).toHaveBeenCalled();
			expect(ready.setFocusedSection).toHaveBeenLastCalledWith('summary-cards');
		});
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

	describe('Grok quota unavailable', () => {
		const mockGetClaudeUsageSnapshots = vi.fn();
		const mockGetCodexUsageSnapshots = vi.fn();
		// A guessed Grok sampler must never be reached: no qualified Grok quota API exists.
		const mockRefreshGrokUsageSnapshots = vi.fn();
		const mockGetGrokUsageSnapshots = vi.fn();
		let fetchSpy: ReturnType<typeof vi.spyOn>;

		function installQuotaMock() {
			installMaestroMock();
			Object.assign(window.maestro.agents, {
				getClaudeUsageSnapshots: mockGetClaudeUsageSnapshots,
				getCodexUsageSnapshots: mockGetCodexUsageSnapshots,
				refreshGrokUsageSnapshots: mockRefreshGrokUsageSnapshots,
				getGrokUsageSnapshots: mockGetGrokUsageSnapshots,
			});
		}

		const claudeAccount = {
			sampledAt: '2026-11-01T10:00:00.000Z',
			configDirKey: '/home/user/.claude-work',
			authState: 'authenticated' as const,
			session: { percent: 40, resetsAt: '2026-11-01T15:00:00.000Z' },
			weekAllModels: { percent: 10, resetsAt: '2026-11-07T00:00:00.000Z' },
			weekSonnetOnly: { percent: 0 },
		};

		beforeEach(() => {
			mockGetClaudeUsageSnapshots.mockReset().mockResolvedValue({});
			mockGetCodexUsageSnapshots.mockReset().mockResolvedValue({});
			mockRefreshGrokUsageSnapshots.mockReset();
			mockGetGrokUsageSnapshots.mockReset();
			fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
		});

		afterEach(() => {
			fetchSpy.mockRestore();
		});

		it('samples only the qualified providers and never reaches a Grok quota call', async () => {
			installQuotaMock();
			renderHook(() => useQuotaTabDiscovery(true, true));

			await waitFor(() => expect(mockRefreshCodexUsageSnapshots).toHaveBeenCalledTimes(1));
			expect(mockRefreshClaudeUsageSnapshots).toHaveBeenCalledTimes(1);
			expect(mockRefreshGrokUsageSnapshots).not.toHaveBeenCalled();
			expect(mockGetGrokUsageSnapshots).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(Object.keys(useClaudeUsageStore.getState().snapshots)).toEqual([]);
			expect(Object.keys(useCodexUsageStore.getState().snapshots)).toEqual([]);
		});

		it('keeps a cached account-scoped snapshot and samples only the provider without one', async () => {
			installQuotaMock();
			mockGetClaudeUsageSnapshots.mockResolvedValue({
				[claudeAccount.configDirKey]: claudeAccount,
			});
			renderHook(() => useQuotaTabDiscovery(true, true));

			await waitFor(() => expect(mockRefreshCodexUsageSnapshots).toHaveBeenCalledTimes(1));
			expect(mockRefreshClaudeUsageSnapshots).not.toHaveBeenCalled();
			expect(useClaudeUsageStore.getState().snapshots).toEqual({
				[claudeAccount.configDirKey]: claudeAccount,
			});
			expect(mockRefreshGrokUsageSnapshots).not.toHaveBeenCalled();
		});

		it('treats zero, unbounded and auth-stub windows as unknown, not as a quota reading', async () => {
			installQuotaMock();
			mockGetClaudeUsageSnapshots.mockResolvedValue({
				zero: {
					...claudeAccount,
					configDirKey: 'zero',
					session: { percent: 0 },
					weekAllModels: { percent: 0 },
				},
				unbounded: {
					...claudeAccount,
					configDirKey: 'unbounded',
					session: { percent: Number.POSITIVE_INFINITY, resetsAt: 'later' },
					weekAllModels: { percent: Number.NaN, resetsAt: 'later' },
				},
				loggedOut: { ...claudeAccount, configDirKey: 'loggedOut', authState: 'unauthenticated' },
			});
			mockGetCodexUsageSnapshots.mockResolvedValue({
				stub: { sampledAt: 'x', codexHomeKey: 'stub', authState: 'missing_auth' },
			});
			renderHook(() => useQuotaTabDiscovery(true, true));

			// None of those snapshots counts as quota data, so both providers re-sample.
			await waitFor(() => expect(mockRefreshClaudeUsageSnapshots).toHaveBeenCalledTimes(1));
			await waitFor(() => expect(mockRefreshCodexUsageSnapshots).toHaveBeenCalledTimes(1));
			expect(mockRefreshGrokUsageSnapshots).not.toHaveBeenCalled();
		});

		it('survives an auth or permission refusal from one sampler without blocking the other', async () => {
			installQuotaMock();
			mockRefreshClaudeUsageSnapshots.mockRejectedValueOnce(new Error('401 unauthenticated'));
			mockRefreshCodexUsageSnapshots.mockRejectedValueOnce(new Error('EACCES permission denied'));

			const { result } = renderHook(() => {
				useQuotaTabDiscovery(true, true);
				return useUsageDashboardData({ isOpen: true, timeRange: 'week', cueTabEnabled: false });
			});

			await waitFor(() => expect(mockRefreshCodexUsageSnapshots).toHaveBeenCalledTimes(1));
			expect(mockRefreshClaudeUsageSnapshots).toHaveBeenCalledTimes(1);
			await flushPromises();
			// Known usage stays available while quota is unavailable.
			await waitFor(() => expect(result.current.data).toBe(sampleAggregation));
			expect(result.current.error).toBeNull();
			expect(mockNotifyToast).not.toHaveBeenCalled();
		});

		it('offers no quota tab without details and keeps the usage views', async () => {
			installQuotaMock();
			useUIStore.setState({ usageDashboardViewMode: 'codex-usage' });
			const { result } = renderHook(() =>
				useUsageDashboardTabs({
					cueTabEnabled: false,
					hasAnthropicUsageDetails: false,
					hasCodexUsageDetails: false,
					contentRef: { current: null },
					onViewModeChanged: vi.fn(),
				})
			);

			await waitFor(() => expect(result.current.viewMode).toBe('overview'));
			const values = result.current.viewModeTabs.map((tab) => tab.value);
			expect(values).toContain('tokens');
			expect(values).toContain('agents');
			expect(values).not.toContain('anthropic-usage');
			expect(values).not.toContain('codex-usage');
			expect(values.some((value) => /grok|xai/i.test(value))).toBe(false);
			expect(result.current.viewModeTabs.some((tab) => /grok|xai/i.test(tab.label))).toBe(false);
		});
	});
});
