import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UnifiedHistoryTab } from '../../renderer/components/DirectorNotes/UnifiedHistoryTab';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { logger } from '../../renderer/utils/logger';
import type { Theme } from '../../renderer/types';

const DEFAULT_ACTIVE_FILTERS = ['USER', 'AUTO'];
const DEFAULT_LOOKBACK_HOURS = 168;

vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: (opts: {
		count: number;
		estimateSize: (index: number) => number;
		getScrollElement: () => Element | null;
	}) => {
		opts.getScrollElement();
		return {
			getVirtualItems: () =>
				Array.from({ length: opts.count + 1 }, (_, index) => ({
					index,
					start: index * 80,
					size: opts.estimateSize(index),
					key: `virtual-${index}`,
				})),
			getTotalSize: () => opts.count * 80,
			scrollToIndex: vi.fn(),
			measureElement: vi.fn(),
		};
	},
}));

vi.mock('../../renderer/components/History', () => ({
	ActivityGraph: ({
		entries,
		onBarClick,
		lookbackHours,
		onLookbackChange,
	}: {
		entries: unknown[];
		onBarClick: (start: number, end: number) => void;
		lookbackHours: number | null;
		onLookbackChange: (hours: number | null) => void;
	}) => (
		<div data-testid="activity-graph">
			<span data-testid="activity-entry-count">{entries.length}</span>
			<span data-testid="activity-lookback-hours">{lookbackHours ?? 'null'}</span>
			<button data-testid="bar-click" onClick={() => onBarClick(0, Date.now())}>
				Bar
			</button>
			<button data-testid="lookback-all" onClick={() => onLookbackChange(null)}>
				All time
			</button>
		</div>
	),
	HistoryEntryItem: ({
		entry,
		index,
		isSelected,
		onOpenDetailModal,
		onOpenSessionAsTab,
		showAgentName,
	}: {
		entry: any;
		index: number;
		isSelected: boolean;
		onOpenDetailModal: (entry: any, index: number) => void;
		onOpenSessionAsTab?: (agentSessionId: string) => void;
		showAgentName: boolean;
	}) => (
		<div
			data-testid={`history-entry-${index}`}
			data-selected={isSelected ? 'true' : 'false'}
			data-agent-name={showAgentName ? 'true' : 'false'}
			onClick={() => onOpenDetailModal(entry, index)}
		>
			<span>{entry.summary}</span>
			<span>{entry.agentName}</span>
			{onOpenSessionAsTab && (
				<button
					data-testid={`resume-entry-${index}`}
					onClick={(event) => {
						event.stopPropagation();
						onOpenSessionAsTab(entry.agentSessionId);
					}}
				>
					Resume
				</button>
			)}
		</div>
	),
	HistoryFilterToggle: ({
		activeFilters,
		onToggleFilter,
	}: {
		activeFilters: Set<string>;
		onToggleFilter: (type: string) => void;
	}) => (
		<div data-testid="history-filter-toggle">
			<button
				data-testid="filter-auto"
				data-active={activeFilters.has('AUTO')}
				onClick={() => onToggleFilter('AUTO')}
			>
				AUTO
			</button>
			<button
				data-testid="filter-user"
				data-active={activeFilters.has('USER')}
				onClick={() => onToggleFilter('USER')}
			>
				USER
			</button>
		</div>
	),
	HistoryStatsBar: ({ stats }: { stats: { totalCount: number; agentCount: number } }) => (
		<div data-testid="history-stats-bar">
			<span data-testid="stats-total">{stats.totalCount}</span>
			<span data-testid="stats-agents">{stats.agentCount}</span>
		</div>
	),
	ESTIMATED_ROW_HEIGHT: 80,
	ESTIMATED_ROW_HEIGHT_SIMPLE: 60,
	estimateHistoryRowHeight: () => 80,
	LOOKBACK_OPTIONS: [
		{ label: '24 hours', hours: 24, bucketCount: 24 },
		{ label: '1 week', hours: 168, bucketCount: 28 },
		{ label: '1 month', hours: 720, bucketCount: 30 },
		{ label: 'All time', hours: null, bucketCount: 24 },
	],
}));

vi.mock('../../renderer/components/HistoryDetailModal', () => ({
	HistoryDetailModal: ({
		entry,
		onClose,
		onUpdate,
		onResumeSession,
		onNavigate,
	}: {
		entry: any;
		onClose: () => void;
		onUpdate?: (entryId: string, updates: { validated?: boolean }) => Promise<boolean>;
		onResumeSession?: (agentSessionId: string) => void;
		onNavigate?: (entry: any, index: number) => void;
	}) => (
		<div data-testid="history-detail-modal">
			<span data-testid="detail-summary">{entry.summary}</span>
			<span data-testid="detail-validated">{entry.validated ? 'true' : 'false'}</span>
			<button
				data-testid="detail-update"
				onClick={() => onUpdate?.(entry.id, { validated: !entry.validated })}
			>
				Update
			</button>
			<button
				data-testid="detail-update-missing"
				onClick={() => onUpdate?.('missing-entry', { validated: true })}
			>
				Missing
			</button>
			<button data-testid="detail-resume" onClick={() => onResumeSession?.(entry.agentSessionId)}>
				Resume
			</button>
			<button
				data-testid="detail-navigate"
				onClick={() => onNavigate?.({ ...entry, id: 'entry-next', summary: 'Next entry' }, 1)}
			>
				Next
			</button>
			<button data-testid="detail-close" onClick={onClose}>
				Close
			</button>
		</div>
	),
}));

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#22d3ee',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

function entry(overrides: Record<string, unknown> = {}) {
	return {
		id: 'entry-1',
		type: 'USER',
		timestamp: Date.now() - 1000,
		summary: 'User shipped a feature',
		sourceSessionId: 'source-session-1',
		agentSessionId: 'agent-session-1',
		agentName: 'Claude Code',
		projectPath: '/repo',
		validated: false,
		...overrides,
	};
}

function response(entries: any[], hasMore = false, total = entries.length) {
	return {
		entries,
		total,
		limit: 100,
		offset: 0,
		hasMore,
		stats: {
			agentCount: 2,
			sessionCount: 3,
			autoCount: entries.filter((item) => item.type === 'AUTO').length,
			userCount: entries.filter((item) => item.type === 'USER').length,
			totalCount: total,
		},
	};
}

function getHistoryMock() {
	return (window.maestro as any).directorNotes.getUnifiedHistory as ReturnType<typeof vi.fn>;
}

function updateHistoryMock() {
	return (window.maestro as any).history.update as ReturnType<typeof vi.fn>;
}

describe('UnifiedHistoryTab integration', () => {
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame;

	beforeEach(() => {
		vi.clearAllMocks();
		originalRequestAnimationFrame = globalThis.requestAnimationFrame;
		errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		Object.assign(window.maestro, {
			directorNotes: {
				getUnifiedHistory: vi.fn().mockResolvedValue(
					response([
						entry(),
						entry({
							id: 'entry-2',
							type: 'AUTO',
							summary: 'Auto repaired a branch',
							sourceSessionId: 'source-session-2',
							agentSessionId: 'agent-session-2',
							agentName: 'Codex',
							elapsedTimeMs: 2500,
							usageStats: { totalCostUsd: 0.5 },
						}),
					])
				),
				getGraphData: vi.fn().mockResolvedValue({
					buckets: [],
					earliestTimestamp: null,
					latestTimestamp: null,
				}),
				getOffsetForTimestamp: vi.fn().mockResolvedValue(0),
				onHistoryEntryAdded: vi.fn(() => vi.fn()),
			},
			history: {
				update: vi.fn().mockResolvedValue(true),
			},
		});
		useSettingsStore.setState({
			directorNotesSettings: {
				provider: 'claude-code',
				defaultLookbackDays: 7,
			},
		});
		globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		};
	});

	afterEach(() => {
		cleanup();
		globalThis.requestAnimationFrame = originalRequestAnimationFrame;
		vi.restoreAllMocks();
	});

	it('loads unified history, filters/searches, resumes entries, and updates detail state', async () => {
		const onResumeSession = vi.fn();
		render(
			<UnifiedHistoryTab
				theme={theme}
				onResumeSession={onResumeSession}
				lookbackHours={DEFAULT_LOOKBACK_HOURS}
				onLookbackChange={vi.fn()}
			/>
		);

		await waitFor(() =>
			expect(getHistoryMock()).toHaveBeenCalledWith({
				lookbackDays: 7,
				filter: DEFAULT_ACTIVE_FILTERS,
				limit: 100,
				offset: 0,
			})
		);
		expect(await screen.findByText('User shipped a feature')).toBeInTheDocument();
		expect(await screen.findByText('Auto repaired a branch')).toBeInTheDocument();
		expect(screen.getByTestId('history-stats-bar')).toBeInTheDocument();
		expect(screen.getByTestId('activity-graph')).toBeInTheDocument();
		const scroller = screen.getByTestId('history-entry-0').closest('[tabindex="0"]') as HTMLElement;

		fireEvent.scroll(scroller);
		expect(getHistoryMock()).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(scroller, { key: 'f', ctrlKey: true });
		fireEvent.keyDown(scroller, { key: 'f', ctrlKey: true });
		fireEvent.change(screen.getByPlaceholderText('Filter by summary or agent name...'), {
			target: { value: 'codex' },
		});
		expect(screen.getByText('Auto repaired a branch')).toBeInTheDocument();
		expect(screen.queryByText('User shipped a feature')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Close search (Esc)'));
		fireEvent.click(screen.getByTestId('filter-auto'));
		expect(screen.queryByText('Auto repaired a branch')).not.toBeInTheDocument();
		fireEvent.click(screen.getByTestId('filter-auto'));

		fireEvent.click(screen.getByTestId('bar-click'));
		await waitFor(() =>
			expect(screen.getByTestId('history-entry-0')).toHaveAttribute('data-selected', 'true')
		);
		fireEvent.keyDown(scroller, { key: 'Enter' });
		expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('detail-close'));

		fireEvent.click(screen.getByTestId('resume-entry-0'));
		expect(onResumeSession).toHaveBeenCalledWith('source-session-1', 'agent-session-1');

		fireEvent.click(screen.getByTestId('history-entry-0'));
		expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('detail-update'));
		await waitFor(() =>
			expect(updateHistoryMock()).toHaveBeenCalledWith(
				'entry-1',
				{ validated: true },
				'source-session-1'
			)
		);
		expect(screen.getByTestId('detail-validated')).toHaveTextContent('true');
		fireEvent.click(screen.getByTestId('detail-update-missing'));
		expect(updateHistoryMock()).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByTestId('detail-resume'));
		expect(onResumeSession).toHaveBeenCalledWith('source-session-1', 'agent-session-1');
		fireEvent.click(screen.getByTestId('detail-navigate'));
		expect(screen.getByTestId('detail-summary')).toHaveTextContent('Next entry');
		fireEvent.click(screen.getByTestId('detail-close'));
		expect(screen.queryByTestId('history-detail-modal')).not.toBeInTheDocument();
	});

	it('loads additional pages on near-bottom scroll and refreshes for lookback changes', async () => {
		getHistoryMock()
			.mockResolvedValueOnce(response([entry()], true, 2))
			.mockResolvedValueOnce(
				response(
					[entry({ id: 'entry-2', summary: 'Older entry', sourceSessionId: 'source-2' })],
					false,
					2
				)
			)
			.mockResolvedValueOnce(response([], false, 0));

		const onLookbackChange = vi.fn();
		const { rerender } = render(
			<UnifiedHistoryTab
				theme={theme}
				lookbackHours={DEFAULT_LOOKBACK_HOURS}
				onLookbackChange={onLookbackChange}
			/>
		);

		await waitFor(() => expect(screen.getByText('User shipped a feature')).toBeInTheDocument());
		const scroller = screen.getByTestId('history-entry-0').closest('[tabindex="0"]') as HTMLElement;
		Object.defineProperties(scroller, {
			scrollTop: { configurable: true, value: 900 },
			scrollHeight: { configurable: true, value: 1000 },
			clientHeight: { configurable: true, value: 200 },
		});
		fireEvent.scroll(scroller);

		await waitFor(() =>
			expect(getHistoryMock()).toHaveBeenLastCalledWith({
				lookbackDays: 7,
				filter: DEFAULT_ACTIVE_FILTERS,
				limit: 100,
				offset: 1,
			})
		);
		expect(screen.getByText('Older entry')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('lookback-all'));
		expect(onLookbackChange).toHaveBeenCalledWith(null);
		rerender(
			<UnifiedHistoryTab theme={theme} lookbackHours={null} onLookbackChange={onLookbackChange} />
		);
		await waitFor(() =>
			expect(getHistoryMock()).toHaveBeenLastCalledWith({
				lookbackDays: 0,
				filter: DEFAULT_ACTIVE_FILTERS,
				limit: 100,
				offset: 0,
			})
		);
	});

	it('maps all-time lookback props to all-time requests', async () => {
		getHistoryMock().mockResolvedValueOnce(response([], false, 0));
		render(<UnifiedHistoryTab theme={theme} lookbackHours={null} onLookbackChange={vi.fn()} />);

		await waitFor(() =>
			expect(getHistoryMock()).toHaveBeenCalledWith({
				lookbackDays: 0,
				filter: DEFAULT_ACTIVE_FILTERS,
				limit: 100,
				offset: 0,
			})
		);
		expect(screen.getByTestId('activity-lookback-hours')).toHaveTextContent('null');
		expect(screen.getByText('No history entries found across any agents.')).toBeInTheDocument();
	});

	it('exposes focus and escape handlers and handles load failures', async () => {
		getHistoryMock().mockRejectedValueOnce(new Error('history unavailable'));
		const ref = React.createRef<{ focus: () => void; onEscape: () => boolean }>();

		render(
			<UnifiedHistoryTab
				ref={ref}
				theme={theme}
				lookbackHours={DEFAULT_LOOKBACK_HOURS}
				onLookbackChange={vi.fn()}
			/>
		);

		await waitFor(() =>
			expect(errorSpy).toHaveBeenCalledWith(
				'Initial page load failed',
				'useHistoryPagination',
				expect.any(Error)
			)
		);
		expect(
			screen.getByText('No history entries in this time range. Try expanding the lookback period.')
		).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Search entries (⌘F)'));
		expect(screen.getByPlaceholderText('Filter by summary or agent name...')).toBeInTheDocument();
		let handledEscape = false;
		await act(async () => {
			handledEscape = ref.current?.onEscape() ?? false;
		});
		expect(handledEscape).toBe(true);
		await waitFor(() =>
			expect(
				screen.queryByPlaceholderText('Filter by summary or agent name...')
			).not.toBeInTheDocument()
		);
		expect(ref.current?.onEscape()).toBe(false);
		ref.current?.focus();
	});
});
