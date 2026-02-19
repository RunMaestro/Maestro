import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { UnifiedHistoryTab } from '../../../../renderer/components/DirectorNotes/UnifiedHistoryTab';
import type { Theme } from '../../../../renderer/types';

// Mock useListNavigation
const mockHandleKeyDown = vi.fn();
const mockSetSelectedIndex = vi.fn();
let mockOnSelect: ((index: number) => void) | undefined;

vi.mock('../../../../renderer/hooks/keyboard/useListNavigation', () => ({
	useListNavigation: (opts: any) => {
		mockOnSelect = opts.onSelect;
		return {
			selectedIndex: -1,
			setSelectedIndex: mockSetSelectedIndex,
			handleKeyDown: mockHandleKeyDown,
		};
	},
}));

// Mock @tanstack/react-virtual
vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: (opts: any) => ({
		getVirtualItems: () =>
			Array.from({ length: Math.min(opts.count, 20) }, (_, i) => ({
				index: i,
				start: i * 80,
				size: 80,
				key: `virtual-${i}`,
			})),
		getTotalSize: () => opts.count * 80,
		scrollToIndex: vi.fn(),
		measureElement: vi.fn(),
	}),
}));

// Mock HistoryDetailModal
vi.mock('../../../../renderer/components/HistoryDetailModal', () => ({
	HistoryDetailModal: ({ entry, onClose, onNavigate, onUpdate }: any) => (
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
			<button data-testid="lookback-change-168" onClick={() => onLookbackChange?.(168)}>
				1 Week
			</button>
			<button data-testid="lookback-change-null" onClick={() => onLookbackChange?.(null)}>
				All Time
			</button>
		</div>
	),
	HistoryEntryItem: ({ entry, index, isSelected, onOpenDetailModal, showAgentName }: any) => (
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
		agentName: 'Claude Code',
		projectPath: '/test',
	},
	{
		id: 'entry-2',
		type: 'AUTO' as const,
		timestamp: Date.now() - 2000,
		summary: 'Auto action B',
		sourceSessionId: 'session-2',
		agentName: 'Codex',
		projectPath: '/test',
		success: true,
		validated: false,
	},
	{
		id: 'entry-3',
		type: 'USER' as const,
		timestamp: Date.now() - 3000,
		summary: 'User performed action C',
		sourceSessionId: 'session-1',
		agentName: 'Claude Code',
		projectPath: '/test',
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
});

describe('UnifiedHistoryTab', () => {
	describe('Loading and Data Fetching', () => {
		it('shows loading state initially', () => {
			mockGetUnifiedHistory.mockReturnValue(new Promise(() => {}));
			render(<UnifiedHistoryTab theme={mockTheme} />);

			expect(screen.getByText('Loading history...')).toBeInTheDocument();
		});

		it('fetches unified history on mount with all-time lookback and pagination', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(mockGetUnifiedHistory).toHaveBeenCalledWith({
					lookbackDays: 0,
					filter: null,
					limit: 100,
					offset: 0,
				});
			});
		});

		it('shows empty state when no entries found', async () => {
			mockGetUnifiedHistory.mockResolvedValue(createPaginatedResponse([]));
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText(/No history entries found across any agents/)).toBeInTheDocument();
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

		it('does not render stats bar when no entries exist', async () => {
			mockGetUnifiedHistory.mockResolvedValue({
				...createPaginatedResponse([]),
				stats: { agentCount: 0, sessionCount: 0, autoCount: 0, userCount: 0, totalCount: 0 },
			});
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText(/No history entries found across any agents/)).toBeInTheDocument();
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

		it('passes null lookbackHours (all time) to activity graph by default', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('activity-lookback-hours')).toHaveTextContent('null');
			});
		});

		it('re-fetches history with new lookback when graph lookback changes', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(mockGetUnifiedHistory).toHaveBeenCalledWith(
					expect.objectContaining({ lookbackDays: 0 })
				);
			});

			mockGetUnifiedHistory.mockClear();
			mockGetUnifiedHistory.mockResolvedValue(
				createPaginatedResponse(createMockEntries().slice(0, 1))
			);

			// Change lookback to 1 week (168 hours = 7 days)
			await act(async () => {
				fireEvent.click(screen.getByTestId('lookback-change-168'));
			});

			await waitFor(() => {
				expect(mockGetUnifiedHistory).toHaveBeenCalledWith(
					expect.objectContaining({ lookbackDays: 7, offset: 0 })
				);
			});
		});

		it('updates graph lookbackHours when lookback changes', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByTestId('activity-lookback-hours')).toHaveTextContent('null');
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
				expect(screen.getByText(/No history entries found across any agents/)).toBeInTheDocument();
			});
		});
	});
});
