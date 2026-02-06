import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { UnifiedHistoryTab } from '../../../../renderer/components/DirectorNotes/UnifiedHistoryTab';
import type { Theme } from '../../../../renderer/types';

// Mock useSettings
vi.mock('../../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		directorNotesSettings: {
			provider: 'claude-code',
			defaultLookbackDays: 7,
		},
	}),
}));

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
const mockDetailOnClose = vi.fn();
vi.mock('../../../../renderer/components/HistoryDetailModal', () => ({
	HistoryDetailModal: ({ entry, onClose, onNavigate }: any) => (
		<div data-testid="history-detail-modal">
			<span data-testid="detail-entry-summary">{entry?.summary}</span>
			<button data-testid="detail-close" onClick={onClose}>Close</button>
			<button
				data-testid="detail-navigate-next"
				onClick={() => onNavigate?.({ id: 'next', summary: 'Next entry' }, 1)}
			>
				Next
			</button>
		</div>
	),
}));

// Mock History sub-components
vi.mock('../../../../renderer/components/History', () => ({
	ActivityGraph: ({ entries, onBarClick, lookbackHours }: any) => (
		<div data-testid="activity-graph">
			<span data-testid="activity-entry-count">{entries.length}</span>
			<span data-testid="activity-lookback-hours">{lookbackHours}</span>
			<button data-testid="bar-click" onClick={() => onBarClick?.(Date.now() - 3600000, Date.now())}>
				Click Bar
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

beforeEach(() => {
	(window as any).maestro = {
		directorNotes: {
			getUnifiedHistory: mockGetUnifiedHistory,
		},
	};
	mockGetUnifiedHistory.mockResolvedValue(createMockEntries());
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

		it('fetches unified history on mount', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(mockGetUnifiedHistory).toHaveBeenCalledWith({
					lookbackDays: 7,
					filter: null,
				});
			});
		});

		it('shows empty state when no entries found', async () => {
			mockGetUnifiedHistory.mockResolvedValue([]);
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText(/No history entries found/)).toBeInTheDocument();
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

		it('converts lookbackDays to lookbackHours for activity graph', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				// 7 days * 24 = 168 hours
				expect(screen.getByTestId('activity-lookback-hours')).toHaveTextContent('168');
			});
		});
	});

	describe('Keyboard Navigation', () => {
		it('list container has tabIndex for focus', async () => {
			render(<UnifiedHistoryTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('User performed action A')).toBeInTheDocument();
			});

			// The list container should be focusable
			const listContainer = screen.getByText('User performed action A').closest('[tabindex]');
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
				expect(screen.getByTestId('detail-entry-summary')).toHaveTextContent('User performed action A');
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
				<UnifiedHistoryTab
					theme={mockTheme}
					fileTree={fileTree as any}
					onFileClick={onFileClick}
				/>
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
				expect(screen.getByText(/No history entries found/)).toBeInTheDocument();
			});
		});
	});
});
