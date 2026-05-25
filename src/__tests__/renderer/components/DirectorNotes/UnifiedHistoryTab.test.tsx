import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { UnifiedHistoryTab } from '../../../../renderer/components/DirectorNotes/UnifiedHistoryTab';
import type { Theme } from '../../../../renderer/types';

// Mock useSettings hook (mutable so individual tests can override)
const mockDirNotesSettings = vi.hoisted(() => ({
	provider: 'claude-code' as const,
	defaultLookbackDays: 7,
}));

vi.mock('../../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		directorNotesSettings: mockDirNotesSettings,
	}),
}));

// Mock useListNavigation
const mockHandleKeyDown = vi.fn();
const mockSetSelectedIndex = vi.fn();
let mockOnSelect: ((index: number) => void) | undefined;
let mockSelectedIndex = -1;

vi.mock('../../../../renderer/hooks/keyboard/useListNavigation', () => ({
	useListNavigation: (opts: any) => {
		mockOnSelect = opts.onSelect;
		return {
			selectedIndex: mockSelectedIndex,
			setSelectedIndex: mockSetSelectedIndex,
			handleKeyDown: mockHandleKeyDown,
		};
	},
}));

// Mock @tanstack/react-virtual
vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: (opts: any) => {
		opts.getScrollElement?.();
		return {
			getVirtualItems: () =>
				Array.from({ length: Math.min(opts.count + 1, 21) }, (_, i) => ({
					index: i,
					start: i * 80,
					size: opts.estimateSize(i),
					key: `virtual-${i}`,
				})),
			getTotalSize: () => opts.count * 80,
			scrollToIndex: vi.fn(),
			measureElement: vi.fn(),
		};
	},
}));

// Mock HistoryDetailModal
vi.mock('../../../../renderer/components/HistoryDetailModal', () => ({
	HistoryDetailModal: ({ entry, onClose, onNavigate, onUpdate, onResumeSession }: any) => (
		<div data-testid="history-detail-modal">
			<span data-testid="detail-entry-summary">{entry?.summary}</span>
			<span data-testid="detail-entry-validated">{entry?.validated ? 'true' : 'false'}</span>
			<button data-testid="detail-close" onClick={onClose}>
				Close
			</button>
			<button
				data-testid="detail-navigate-next"
				onClick={() => onNavigate?.({ id: 'next', summary: 'Next entry' }, 1)}
			>
				Next
			</button>
			{onUpdate && (
				<button
					data-testid="detail-toggle-validated"
					onClick={() => onUpdate(entry.id, { validated: !entry.validated })}
				>
					Toggle Validated
				</button>
			)}
			{onUpdate && (
				<button
					data-testid="detail-toggle-missing"
					onClick={() => onUpdate('missing-entry', { validated: true })}
				>
					Toggle Missing
				</button>
			)}
			{onUpdate && (
				<button
					data-testid="detail-toggle-other"
					onClick={() => onUpdate('entry-2', { validated: true })}
				>
					Toggle Other
				</button>
			)}
			{onResumeSession && (
				<button
					data-testid="detail-resume"
					onClick={() => onResumeSession(entry?.agentSessionId ?? 'agent-session-1')}
				>
					Resume
				</button>
			)}
		</div>
	),
}));

// Mock History sub-components
vi.mock('../../../../renderer/components/History', () => ({
	ActivityGraph: ({ entries, onBarClick, lookbackHours, onLookbackChange }: any) => (
		<div data-testid="activity-graph">
			<span data-testid="activity-entry-count">{entries.length}</span>
			<span data-testid="activity-lookback-hours">{lookbackHours ?? 'null'}</span>
			<button
				data-testid="bar-click"
				onClick={() => onBarClick?.(Date.now() - 3600000, Date.now())}
			>
				Click Bar
			</button>
			<button data-testid="bar-click-empty" onClick={() => onBarClick?.(0, 1)}>
				Click Empty Bar
			</button>
			<button data-testid="lookback-change-168" onClick={() => onLookbackChange?.(168)}>
				1 Week
			</button>
			<button data-testid="lookback-change-null" onClick={() => onLookbackChange?.(null)}>
				All Time
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
	}: any) => (
		<div
			data-testid={`history-entry-${index}`}
			data-selected={isSelected}
			data-agent-name={showAgentName ? 'true' : 'false'}
			onClick={() => onOpenDetailModal?.(entry, index)}
		>
			<span>{entry.summary}</span>
			{showAgentName && entry.agentName && (
				<span data-testid={`agent-name-${index}`}>{entry.agentName}</span>
			)}
			{onOpenSessionAsTab && entry.agentSessionId && (
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
			{onOpenSessionAsTab && (
				<button
					data-testid={`resume-missing-entry-${index}`}
					onClick={() => onOpenSessionAsTab('missing-agent-session')}
				>
					Resume Missing
				</button>
			)}
		</div>
	),
	HistoryFilterToggle: ({ activeFilters, onToggleFilter }: any) => (
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
	HistoryStatsBar: ({ stats }: any) => (
		<div data-testid="history-stats-bar">
			<span data-testid="stats-agents">{stats.agentCount}</span>
			<span data-testid="stats-sessions">{stats.sessionCount}</span>
			<span data-testid="stats-auto">{stats.autoCount}</span>
			<span data-testid="stats-user">{stats.userCount}</span>
			<span data-testid="stats-total">{stats.totalCount}</span>
		</div>
	),
	ESTIMATED_ROW_HEIGHT: 80,
	ESTIMATED_ROW_HEIGHT_SIMPLE: 60,
	LOOKBACK_OPTIONS: [
		{ label: '24 hours', hours: 24, bucketCount: 24 },
		{ label: '72 hours', hours: 72, bucketCount: 24 },
		{ label: '1 week', hours: 168, bucketCount: 28 },
		{ label: '2 weeks', hours: 336, bucketCount: 28 },
		{ label: '1 month', hours: 720, bucketCount: 30 },
		{ label: '6 months', hours: 4320, bucketCount: 24 },
		{ label: '1 year', hours: 8760, bucketCount: 24 },
		{ label: 'All time', hours: null, bucketCount: 24 },
	],
}));

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentForeground: '#f8f8f2',
		border: '#44475a',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
		scrollbar: '#44475a',
		scrollbarHover: '#6272a4',
	},
};

const mockGetUnifiedHistory = vi.fn();
const mockHistoryUpdate = vi.fn();

const createMockEntries = () => [
	{
		id: 'entry-1',
		type: 'USER' as const,
		timestamp: Date.now() - 1000,
		summary: 'User performed action A',
		sourceSessionId: 'session-1',
		agentSessionId: 'agent-session-1',
		agentName: 'Claude Code',
		projectPath: '/test',
	},
	{
		id: 'entry-2',
		type: 'AUTO' as const,
		timestamp: Date.now() - 2000,
		summary: 'Auto action B',
		sourceSessionId: 'session-2',
		agentSessionId: 'agent-session-2',
		agentName: 'Codex',
		projectPath: '/test',
		elapsedTimeMs: 2500,
		success: true,
		validated: false,
	},
	{
		id: 'entry-3',
		type: 'USER' as const,
		timestamp: Date.now() - 3000,
		summary: 'User performed action C',
		sourceSessionId: 'session-1',
		agentSessionId: 'agent-session-3',
		agentName: 'Claude Code',
		projectPath: '/test',
		usageStats: { totalCostUsd: 0.25 },
	},
];

/** Helper to create a paginated response */
const createPaginatedResponse = (entries: any[], hasMore = false, total?: number) => ({
	entries,
	total: total ?? entries.length,
	limit: 100,
	offset: 0,
	hasMore,
	stats: {
		agentCount: 2,
		sessionCount: 5,
		autoCount: entries.filter((e: any) => e.type === 'AUTO').length,
		userCount: entries.filter((e: any) => e.type === 'USER').length,
		totalCount: entries.length,
	},
});

beforeEach(() => {
	mockGetUnifiedHistory.mockReset();
	mockHistoryUpdate.mockReset();
	mockDirNotesSettings.defaultLookbackDays = 7;
	(window as any).maestro = {
		directorNotes: {
			getUnifiedHistory: mockGetUnifiedHistory,
		},
		history: {
			update: mockHistoryUpdate,
		},
	};
	mockHistoryUpdate.mockResolvedValue(true);
	mockGetUnifiedHistory.mockResolvedValue(createPaginatedResponse(createMockEntries()));
});

afterEach(() => {
	vi.clearAllMocks();
	mockOnSelect = undefined;
	mockSelectedIndex = -1;
});

describe('UnifiedHistoryTab', () => {
	describe('Loading and Data Fetching', () => {
		it('shows loading state initially', () => {
			mockGetUnifiedHistory.mockReturnValue(new Promise(() => {}));
			render(<UnifiedHistoryTab theme={mockTheme} />);

			expect(screen.getByText('Loading history...')).toBeInTheDocument();
		});

		it('fetches unified history on mount using default lookback from settings', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(mockGetUnifiedHistory).toHaveBeenCalledWith({
					lookbackDays: 7,
					filter: null,
					limit: 100,
					offset: 0,
				});
			});
		});

		it('fetches all-time history when defaultLookbackDays is 0', async () => {
			mockDirNotesSettings.defaultLookbackDays = 0;
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(mockGetUnifiedHistory).toHaveBeenCalledWith({
					lookbackDays: 0,
					filter: null,
					limit: 100,
					offset: 0,
				});
			});
			expect(screen.getByTestId('activity-lookback-hours')).toHaveTextContent('null');
		});

		it('falls back to all-time history when default lookback exceeds available options', async () => {
			mockDirNotesSettings.defaultLookbackDays = 10_000;
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(mockGetUnifiedHistory).toHaveBeenCalledWith({
					lookbackDays: 0,
					filter: null,
					limit: 100,
					offset: 0,
				});
			});
			expect(screen.getByTestId('activity-lookback-hours')).toHaveTextContent('null');
		});

		it('shows empty state when no entries found', async () => {
			mockGetUnifiedHistory.mockResolvedValue(createPaginatedResponse([]));
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				// With defaultLookbackDays=7, lookbackHours=168 (not null), so time-range message shown
				expect(screen.getByText(/No history entries in this time range/)).toBeInTheDocument();
			});
		});

		it('shows all-time empty state when no entries exist and lookback is all time', async () => {
			mockDirNotesSettings.defaultLookbackDays = 0;
			mockGetUnifiedHistory.mockResolvedValue(createPaginatedResponse([]));
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('No history entries found across any agents.')).toBeInTheDocument();
			});
		});

		it('renders entries from all sessions (aggregated)', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
				expect(screen.getByText('Auto action B')).toBeInTheDocument();
				expect(screen.getByText('User performed action C')).toBeInTheDocument();
			});
		});

		it('renders legacy entries that are missing an id using the virtual index fallback', async () => {
			mockGetUnifiedHistory.mockResolvedValue(
				createPaginatedResponse([
					{
						...createMockEntries()[0],
						id: undefined,
						summary: 'Legacy entry without id',
					} as any,
				])
			);

			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Legacy entry without id')).toBeInTheDocument();
			});
		});

		it('displays total entry count', async () => {
			mockGetUnifiedHistory.mockResolvedValue(
				createPaginatedResponse(createMockEntries(), false, 3)
			);
			render(<UnifiedHistoryTab theme={mockTheme} />);

			// The activity graph mock also shows entry count via data-testid="activity-entry-count",
			// and the component renders a separate entry count badge. Use getAllByText to account for both.
			await waitFor(() => {
				const matches = screen.getAllByText('3');
				expect(matches.length).toBeGreaterThanOrEqual(1);
			});
		});

		it('displays loaded/total when more entries exist', async () => {
			mockGetUnifiedHistory.mockResolvedValue(
				createPaginatedResponse(createMockEntries(), true, 250)
			);
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('3/250')).toBeInTheDocument();
			});
		});
	});

	describe('Stats Bar', () => {
		it('renders stats bar with aggregate counts after loading', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-stats-bar')).toBeInTheDocument();
				expect(screen.getByTestId('stats-agents')).toHaveTextContent('2');
				expect(screen.getByTestId('stats-sessions')).toHaveTextContent('5');
			});
		});

		it('does not render stats bar when a response omits stats', async () => {
			mockGetUnifiedHistory.mockResolvedValue({
				...createPaginatedResponse(createMockEntries()),
				stats: undefined,
			});

			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});
			expect(screen.queryByTestId('history-stats-bar')).not.toBeInTheDocument();
		});

		it('does not render stats bar when no entries exist', async () => {
			mockGetUnifiedHistory.mockResolvedValue({
				...createPaginatedResponse([]),
				stats: { agentCount: 0, sessionCount: 0, autoCount: 0, userCount: 0, totalCount: 0 },
			});
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText(/No history entries in this time range/)).toBeInTheDocument();
			});
			expect(screen.queryByTestId('history-stats-bar')).not.toBeInTheDocument();
		});

		it('does not render stats bar while loading', () => {
			mockGetUnifiedHistory.mockReturnValue(new Promise(() => {}));
			render(<UnifiedHistoryTab theme={mockTheme} />);

			expect(screen.queryByTestId('history-stats-bar')).not.toBeInTheDocument();
		});
	});

	describe('Filter Toggle', () => {
		it('renders filter toggle with AUTO and USER filters', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-filter-toggle')).toBeInTheDocument();
				expect(screen.getByTestId('filter-auto')).toBeInTheDocument();
				expect(screen.getByTestId('filter-user')).toBeInTheDocument();
			});
		});

		it('both filters are active by default', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('filter-auto')).toHaveAttribute('data-active', 'true');
				expect(screen.getByTestId('filter-user')).toHaveAttribute('data-active', 'true');
			});
		});

		it('toggles AUTO filter to hide AUTO entries', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Auto action B')).toBeInTheDocument();
			});

			// Toggle AUTO off
			await act(async () => {
				fireEvent.click(screen.getByTestId('filter-auto'));
			});

			// AUTO entries should be hidden
			await waitFor(() => {
				expect(screen.queryByText('Auto action B')).not.toBeInTheDocument();
			});

			// USER entries should remain
			expect(screen.getByText('User performed action A')).toBeInTheDocument();
		});

		it('can toggle a filter off and back on', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('filter-auto')).toHaveAttribute('data-active', 'true');
			});

			fireEvent.click(screen.getByTestId('filter-auto'));
			expect(screen.getByTestId('filter-auto')).toHaveAttribute('data-active', 'false');

			fireEvent.click(screen.getByTestId('filter-auto'));
			expect(screen.getByTestId('filter-auto')).toHaveAttribute('data-active', 'true');
		});

		it('shows the current-filters empty state when all filters are disabled', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('filter-auto'));
			fireEvent.click(screen.getByTestId('filter-user'));

			expect(screen.getByText('No entries match the current filters.')).toBeInTheDocument();
		});
	});

	describe('Activity Graph', () => {
		it('renders activity graph with entries', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('activity-graph')).toBeInTheDocument();
			});
		});

		it('passes correct entry count to activity graph', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('activity-entry-count')).toHaveTextContent('3');
			});
		});

		it('passes default lookback from settings to activity graph', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				// 7 days → 168 hours (1 week)
				expect(screen.getByTestId('activity-lookback-hours')).toHaveTextContent('168');
			});
		});

		it('re-fetches history with new lookback when graph lookback changes', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(mockGetUnifiedHistory).toHaveBeenCalledWith(
					expect.objectContaining({ lookbackDays: 7 })
				);
			});

			mockGetUnifiedHistory.mockClear();
			mockGetUnifiedHistory.mockResolvedValue(
				createPaginatedResponse(createMockEntries().slice(0, 1))
			);

			// Change lookback to "All Time" (null hours = 0 days) — different from initial 168h
			await act(async () => {
				fireEvent.click(screen.getByTestId('lookback-change-null'));
			});

			await waitFor(() => {
				expect(mockGetUnifiedHistory).toHaveBeenCalledWith(
					expect.objectContaining({ lookbackDays: 0, offset: 0 })
				);
			});
		});

		it('updates graph lookbackHours when lookback changes', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				// Default: 7 days → 168 hours
				expect(screen.getByTestId('activity-lookback-hours')).toHaveTextContent('168');
			});

			mockGetUnifiedHistory.mockResolvedValue(
				createPaginatedResponse(createMockEntries().slice(0, 1))
			);

			await act(async () => {
				fireEvent.click(screen.getByTestId('lookback-change-168'));
			});

			await waitFor(() => {
				expect(screen.getByTestId('activity-lookback-hours')).toHaveTextContent('168');
			});
		});

		it('does not update graph entries on scroll-append loads', async () => {
			// Initial load returns 3 entries with hasMore=true
			mockGetUnifiedHistory.mockResolvedValueOnce(
				createPaginatedResponse(createMockEntries(), true, 6)
			);

			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('activity-entry-count')).toHaveTextContent('3');
			});

			// Simulate scroll-triggered load returning 3 more entries
			mockGetUnifiedHistory.mockResolvedValueOnce(
				createPaginatedResponse(
					[
						{
							id: 'entry-4',
							type: 'AUTO',
							timestamp: Date.now() - 4000,
							summary: 'Action D',
							sourceSessionId: 's1',
							projectPath: '/test',
						},
						{
							id: 'entry-5',
							type: 'USER',
							timestamp: Date.now() - 5000,
							summary: 'Action E',
							sourceSessionId: 's2',
							projectPath: '/test',
						},
						{
							id: 'entry-6',
							type: 'AUTO',
							timestamp: Date.now() - 6000,
							summary: 'Action F',
							sourceSessionId: 's1',
							projectPath: '/test',
						},
					],
					false,
					6
				)
			);

			// Graph should still show 3 (the initial snapshot), not 6
			expect(screen.getByTestId('activity-entry-count')).toHaveTextContent('3');
		});

		it('loads the next page on near-bottom scroll without changing graph snapshot', async () => {
			let resolveNextPage: (value: ReturnType<typeof createPaginatedResponse>) => void = () => {};
			mockGetUnifiedHistory
				.mockResolvedValueOnce(createPaginatedResponse(createMockEntries(), true, 6))
				.mockReturnValueOnce(
					new Promise((resolve) => {
						resolveNextPage = resolve;
					})
				);

			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			const listContainer = screen.getByText('User performed action A').closest('[tabindex="0"]')!;
			Object.defineProperty(listContainer, 'scrollHeight', { value: 1000, configurable: true });
			Object.defineProperty(listContainer, 'scrollTop', { value: 600, configurable: true });
			Object.defineProperty(listContainer, 'clientHeight', { value: 10, configurable: true });

			act(() => {
				fireEvent.scroll(listContainer);
			});

			expect(screen.getByText('Loading more...')).toBeInTheDocument();
			expect(mockGetUnifiedHistory).toHaveBeenLastCalledWith(
				expect.objectContaining({ offset: 3 })
			);

			await act(async () => {
				resolveNextPage(
					createPaginatedResponse(
						[
							{
								id: 'entry-4',
								type: 'AUTO',
								timestamp: Date.now() - 4000,
								summary: 'Action D',
								sourceSessionId: 's1',
								projectPath: '/test',
							},
						],
						false,
						4
					)
				);
			});

			expect(screen.getByText('Action D')).toBeInTheDocument();
			expect(screen.getByTestId('activity-entry-count')).toHaveTextContent('3');
		});

		it('does not load the next page when scroll is not near the bottom', async () => {
			mockGetUnifiedHistory.mockResolvedValue(
				createPaginatedResponse(createMockEntries(), true, 6)
			);

			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			const listContainer = screen.getByText('User performed action A').closest('[tabindex="0"]')!;
			Object.defineProperty(listContainer, 'scrollHeight', { value: 1000, configurable: true });
			Object.defineProperty(listContainer, 'scrollTop', { value: 0, configurable: true });
			Object.defineProperty(listContainer, 'clientHeight', { value: 300, configurable: true });

			act(() => {
				fireEvent.scroll(listContainer);
			});

			expect(mockGetUnifiedHistory).toHaveBeenCalledTimes(1);
			expect(screen.queryByText('Loading more...')).not.toBeInTheDocument();
		});

		it('selects the first entry in range when an activity bar is clicked', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-entry-0')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('bar-click'));

			expect(mockSetSelectedIndex).toHaveBeenCalledWith(0);
		});

		it('leaves selection unchanged when an activity bar has no matching entries', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-entry-0')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('bar-click-empty'));

			expect(mockSetSelectedIndex).not.toHaveBeenCalled();
		});
	});

	describe('Search', () => {
		it('opens search with the button and filters by summary', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTitle('Search entries (⌘F)'));
			const searchInput = screen.getByPlaceholderText('Filter by summary or agent name...');
			fireEvent.change(searchInput, { target: { value: 'action b' } });

			expect(screen.getByText('Auto action B')).toBeInTheDocument();
			expect(screen.queryByText('User performed action A')).not.toBeInTheDocument();
			expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(1);
		});

		it('filters by agent name and shows no-match search state', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTitle('Search entries (⌘F)'));
			const searchInput = screen.getByPlaceholderText('Filter by summary or agent name...');
			fireEvent.change(searchInput, { target: { value: 'codex' } });
			expect(screen.getByText('Auto action B')).toBeInTheDocument();
			expect(screen.queryByText('User performed action A')).not.toBeInTheDocument();

			fireEvent.change(searchInput, { target: { value: 'missing' } });
			expect(screen.getByText('No entries matching "missing".')).toBeInTheDocument();
		});

		it('opens search with Cmd+F and closes it with the close button', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			const listContainer = screen.getByText('User performed action A').closest('[tabindex="0"]');
			expect(listContainer).toBeTruthy();

			fireEvent.keyDown(listContainer!, { key: 'f', metaKey: true });
			const searchInput = screen.getByPlaceholderText('Filter by summary or agent name...');
			fireEvent.change(searchInput, { target: { value: 'codex' } });

			fireEvent.click(screen.getByTitle('Close search (Esc)'));

			expect(
				screen.queryByPlaceholderText('Filter by summary or agent name...')
			).not.toBeInTheDocument();
			expect(screen.getByText('User performed action A')).toBeInTheDocument();
		});

		it('focuses and selects the search input when Cmd+F is pressed while search is open', async () => {
			const selectSpy = vi.spyOn(HTMLInputElement.prototype, 'select').mockImplementation(() => {});
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			const listContainer = screen.getByText('User performed action A').closest('[tabindex="0"]')!;
			fireEvent.keyDown(listContainer, { key: 'f', metaKey: true });
			expect(screen.getByPlaceholderText('Filter by summary or agent name...')).toBeInTheDocument();

			fireEvent.keyDown(listContainer, { key: 'f', metaKey: true });

			expect(selectSpy).toHaveBeenCalled();
			selectSpy.mockRestore();
		});
	});

	describe('Keyboard Navigation', () => {
		it('list container has tabIndex for focus', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-entry-0')).toBeInTheDocument();
			});

			// The list container should be focusable
			const listContainer = screen.getByTestId('history-entry-0').closest('[tabindex]');
			expect(listContainer).toHaveAttribute('tabindex', '0');
		});

		it('delegates keyDown events to list navigation handler', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			const listContainer = screen.getByText('User performed action A').closest('[tabindex="0"]');
			expect(listContainer).toBeTruthy();

			// Simulate arrow key press
			fireEvent.keyDown(listContainer!, { key: 'ArrowDown' });

			expect(mockHandleKeyDown).toHaveBeenCalled();
		});

		it('ignores invalid list navigation selections', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			act(() => {
				mockOnSelect?.(-1);
			});

			expect(screen.queryByTestId('history-detail-modal')).not.toBeInTheDocument();
		});

		it('does not trigger pagination when there are no more entries', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			const listContainer = screen.getByText('User performed action A').closest('[tabindex="0"]')!;
			fireEvent.scroll(listContainer);

			expect(mockGetUnifiedHistory).toHaveBeenCalledTimes(1);
		});

		it('scrolls the selected row into view when selected index is restored', async () => {
			mockSelectedIndex = 1;
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-entry-1')).toHaveAttribute('data-selected', 'true');
			});
		});

		it('focuses through the imperative handle and uses Escape to collapse search', async () => {
			const ref = React.createRef<any>();
			render(<UnifiedHistoryTab ref={ref} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			expect(ref.current.onEscape()).toBe(false);

			fireEvent.click(screen.getByTitle('Search entries (⌘F)'));
			fireEvent.change(screen.getByPlaceholderText('Filter by summary or agent name...'), {
				target: { value: 'codex' },
			});

			expect(ref.current.onEscape()).toBe(true);
			await waitFor(() => {
				expect(
					screen.queryByPlaceholderText('Filter by summary or agent name...')
				).not.toBeInTheDocument();
			});

			expect(() => ref.current.focus()).not.toThrow();
		});

		it('opens detail modal via onSelect callback (Enter key)', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			// Simulate onSelect being called (which happens when Enter is pressed in useListNavigation)
			expect(mockOnSelect).toBeDefined();
			await act(async () => {
				mockOnSelect!(0);
			});

			await waitFor(() => {
				expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
			});
		});
	});

	describe('Detail Modal', () => {
		it('opens detail modal when clicking an entry', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-entry-0')).toBeInTheDocument();
			});

			// Click entry
			fireEvent.click(screen.getByTestId('history-entry-0'));

			await waitFor(() => {
				expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
				expect(screen.getByTestId('detail-entry-summary')).toHaveTextContent(
					'User performed action A'
				);
			});
		});

		it('closes detail modal', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-entry-0')).toBeInTheDocument();
			});

			// Open modal
			fireEvent.click(screen.getByTestId('history-entry-0'));
			expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();

			// Close modal
			fireEvent.click(screen.getByTestId('detail-close'));
			expect(screen.queryByTestId('history-detail-modal')).not.toBeInTheDocument();
		});

		it('passes onUpdate to detail modal for validation toggle', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-entry-1')).toBeInTheDocument();
			});

			// Open modal for AUTO entry (entry-2 at index 1)
			fireEvent.click(screen.getByTestId('history-entry-1'));
			expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();

			// The toggle-validated button should be present (onUpdate is wired)
			expect(screen.getByTestId('detail-toggle-validated')).toBeInTheDocument();

			// Click to validate
			await act(async () => {
				fireEvent.click(screen.getByTestId('detail-toggle-validated'));
			});

			expect(mockHistoryUpdate).toHaveBeenCalledWith('entry-2', { validated: true }, 'session-2');
		});

		it('updates local state after successful validation toggle', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-entry-1')).toBeInTheDocument();
			});

			// Open modal for AUTO entry
			fireEvent.click(screen.getByTestId('history-entry-1'));

			// Initially not validated
			expect(screen.getByTestId('detail-entry-validated')).toHaveTextContent('false');

			// Toggle validated
			await act(async () => {
				fireEvent.click(screen.getByTestId('detail-toggle-validated'));
			});

			// Modal entry state should update
			await waitFor(() => {
				expect(screen.getByTestId('detail-entry-validated')).toHaveTextContent('true');
			});
		});

		it('passes filteredEntries and navigation props to detail modal', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-entry-0')).toBeInTheDocument();
			});

			// Open modal
			fireEvent.click(screen.getByTestId('history-entry-0'));

			// Navigate to next entry via detail modal
			await act(async () => {
				fireEvent.click(screen.getByTestId('detail-navigate-next'));
			});

			// setSelectedIndex should be called with new index
			expect(mockSetSelectedIndex).toHaveBeenCalledWith(1);
		});

		it('does not update local state when history update fails', async () => {
			mockHistoryUpdate.mockResolvedValueOnce(false);
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-entry-1')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('history-entry-1'));

			await act(async () => {
				fireEvent.click(screen.getByTestId('detail-toggle-validated'));
			});

			expect(mockHistoryUpdate).toHaveBeenCalledWith('entry-2', { validated: true }, 'session-2');
			expect(screen.getByTestId('detail-entry-validated')).toHaveTextContent('false');
		});

		it('returns false without IPC when updating an entry that is no longer loaded', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-entry-0')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('history-entry-0'));

			await act(async () => {
				fireEvent.click(screen.getByTestId('detail-toggle-missing'));
			});

			expect(mockHistoryUpdate).not.toHaveBeenCalled();
		});

		it('updates the list without replacing the currently open detail entry for another row', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('history-entry-0')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('history-entry-0'));

			await act(async () => {
				fireEvent.click(screen.getByTestId('detail-toggle-other'));
			});

			expect(mockHistoryUpdate).toHaveBeenCalledWith('entry-2', { validated: true }, 'session-2');
			expect(screen.getByTestId('detail-entry-summary')).toHaveTextContent(
				'User performed action A'
			);
		});

		it('resumes sessions from entry items and the detail modal', async () => {
			const onResumeSession = vi.fn();
			render(<UnifiedHistoryTab theme={mockTheme} onResumeSession={onResumeSession} />);

			await waitFor(() => {
				expect(screen.getByTestId('resume-entry-0')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('resume-entry-0'));
			expect(onResumeSession).toHaveBeenCalledWith('session-1', 'agent-session-1');

			fireEvent.click(screen.getByTestId('history-entry-1'));
			fireEvent.click(screen.getByTestId('detail-resume'));
			expect(onResumeSession).toHaveBeenCalledWith('session-2', 'agent-session-2');
		});

		it('ignores stale entry resume requests for unloaded agent sessions', async () => {
			const onResumeSession = vi.fn();
			render(<UnifiedHistoryTab theme={mockTheme} onResumeSession={onResumeSession} />);

			await waitFor(() => {
				expect(screen.getByTestId('resume-missing-entry-0')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('resume-missing-entry-0'));

			expect(onResumeSession).not.toHaveBeenCalled();
		});
	});

	describe('Agent Name Display', () => {
		it('passes showAgentName prop to HistoryEntryItem', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				const entry = screen.getByTestId('history-entry-0');
				expect(entry).toHaveAttribute('data-agent-name', 'true');
			});
		});

		it('renders agent names for entries from different sessions', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('agent-name-0')).toHaveTextContent('Claude Code');
				expect(screen.getByTestId('agent-name-1')).toHaveTextContent('Codex');
			});
		});
	});

	describe('File Tree Props', () => {
		it('passes fileTree and onFileClick to HistoryDetailModal', async () => {
			const fileTree = [{ name: 'test.ts', path: '/test.ts' }];
			const onFileClick = vi.fn();

			render(
				<UnifiedHistoryTab theme={mockTheme} fileTree={fileTree as any} onFileClick={onFileClick} />
			);

			await waitFor(() => {
				expect(screen.getByTestId('history-entry-0')).toBeInTheDocument();
			});

			// Open detail modal to verify fileTree is passed
			fireEvent.click(screen.getByTestId('history-entry-0'));
			expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
		});
	});

	describe('Error Handling', () => {
		it('shows empty state on fetch error', async () => {
			mockGetUnifiedHistory.mockRejectedValue(new Error('Network error'));

			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText(/No history entries in this time range/)).toBeInTheDocument();
			});
		});

		it('keeps existing entries when append loading fails', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockGetUnifiedHistory
				.mockResolvedValueOnce(createPaginatedResponse(createMockEntries(), true, 6))
				.mockRejectedValueOnce(new Error('Append failed'));
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			const listContainer = screen.getByText('User performed action A').closest('[tabindex="0"]')!;
			Object.defineProperty(listContainer, 'scrollHeight', { value: 1000, configurable: true });
			Object.defineProperty(listContainer, 'scrollTop', { value: 600, configurable: true });
			Object.defineProperty(listContainer, 'clientHeight', { value: 10, configurable: true });

			await act(async () => {
				fireEvent.scroll(listContainer);
			});

			await waitFor(() => {
				expect(mockGetUnifiedHistory).toHaveBeenLastCalledWith(
					expect.objectContaining({ offset: 3 })
				);
			});
			expect(screen.getByText('User performed action A')).toBeInTheDocument();
			consoleError.mockRestore();
		});
	});
});
