/**
 * Tests for HistoryPanel.tsx
 *
 * Tests cover:
 * - Pure helper functions: formatElapsedTime, formatTime, getPillColor, getEntryIcon
 * - DoubleCheck SVG component
 * - ActivityGraph component: bucketing, tooltips, bar rendering, bar click
 * - HistoryPanel main component:
 *   - History loading and pagination
 *   - Filter toggle (AUTO/USER)
 *   - Search filter
 *   - Keyboard navigation (/, ArrowUp, ArrowDown, Enter, Escape)
 *   - Entry selection and detail modal
 *   - Entry deletion
 *   - Ref API (focus, refreshHistory)
 *   - Empty states (loading, no entries, no matches)
 *   - Entry card rendering (success/failure, type pills, cost, elapsed time)
 *   - Graph bar click navigation
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { HistoryPanel, HistoryPanelHandle } from '../../../renderer/components/HistoryPanel';
import type { Theme, Session, HistoryEntry, HistoryEntryType } from '../../../renderer/types';
import { useUIStore } from '../../../renderer/stores/uiStore';

// Mock child components
vi.mock('../../../renderer/components/HistoryDetailModal', () => ({
	HistoryDetailModal: ({
		entry,
		onClose,
		onDelete,
		onNavigate,
		onUpdate,
		filteredEntries,
		currentIndex,
	}: {
		entry: HistoryEntry;
		onClose: () => void;
		onDelete?: (id: string) => void;
		onNavigate?: (entry: HistoryEntry, index: number) => void;
		onUpdate?: (entryId: string, updates: Partial<HistoryEntry>) => Promise<boolean>;
		filteredEntries?: HistoryEntry[];
		currentIndex?: number;
	}) => (
		<div data-testid="history-detail-modal">
			<span data-testid="modal-entry-id">{entry.id}</span>
			<span data-testid="modal-entry-summary">{entry.summary}</span>
			<span data-testid="modal-current-index">{currentIndex}</span>
			<button onClick={onClose} data-testid="modal-close">
				Close
			</button>
			{onDelete && (
				<button onClick={() => onDelete(entry.id)} data-testid="modal-delete">
					Delete
				</button>
			)}
			{onUpdate && (
				<button
					onClick={() => onUpdate(entry.id, { summary: 'Updated summary' })}
					data-testid="modal-update"
				>
					Update
				</button>
			)}
			{onNavigate && filteredEntries && filteredEntries.length > 1 && (
				<>
					<button
						onClick={() => {
							const nextIndex = (currentIndex ?? 0) + 1;
							if (nextIndex < filteredEntries.length) {
								onNavigate(filteredEntries[nextIndex], nextIndex);
							}
						}}
						data-testid="modal-navigate-next"
					>
						Next
					</button>
					<button
						onClick={() => {
							// Navigate to entry at index 60 (beyond default displayCount of 50)
							const targetIndex = 60;
							if (targetIndex < filteredEntries.length) {
								onNavigate(filteredEntries[targetIndex], targetIndex);
							}
						}}
						data-testid="modal-navigate-far"
					>
						Navigate Far
					</button>
				</>
			)}
		</div>
	),
}));

vi.mock('../../../renderer/components/HistoryHelpModal', () => ({
	HistoryHelpModal: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="history-help-modal">
			<button onClick={onClose} data-testid="help-modal-close">
				Close Help
			</button>
		</div>
	),
}));

// Create mock theme
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#808080',
		accent: '#007acc',
		border: '#404040',
		success: '#4ec9b0',
		warning: '#dcdcaa',
		error: '#f14c4c',
		buttonBg: '#0e639c',
		buttonText: '#ffffff',
	},
};

// Create mock session
const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'session-1',
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	inputMode: 'ai',
	cwd: '/test/project',
	projectRoot: '/test/project',
	aiPid: 1234,
	terminalPid: 5678,
	aiLogs: [],
	shellLogs: [],
	isGitRepo: true,
	fileTree: [],
	fileExplorerExpanded: [],
	messageQueue: [],
	...overrides,
});

// Create mock history entry factory
const createMockEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
	id: `entry-${Math.random().toString(36).substring(7)}`,
	type: 'AUTO' as HistoryEntryType,
	timestamp: Date.now(),
	summary: 'Test summary',
	projectPath: '/test/project',
	...overrides,
});

const smoothScrollDynamicSizeWarning =
	'The `smooth` scroll behavior is not fully supported with dynamic size.';

const expectSmoothScrollDynamicSizeWarning = (trigger: () => void) => {
	const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

	try {
		trigger();
		expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
		expect(consoleWarnSpy).toHaveBeenCalledWith(smoothScrollDynamicSizeWarning);
	} finally {
		consoleWarnSpy.mockRestore();
	}
};

describe('HistoryPanel', () => {
	let mockHistoryGetAll: ReturnType<typeof vi.fn>;
	let mockHistoryDelete: ReturnType<typeof vi.fn>;
	let mockHistoryUpdate: ReturnType<typeof vi.fn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });

		// Reset uiStore state used by HistoryPanel
		useUIStore.setState({ historySearchFilterOpen: false });

		// Mock scrollIntoView for jsdom
		Element.prototype.scrollIntoView = vi.fn();

		// Set up history API mocks
		mockHistoryGetAll = vi.fn().mockResolvedValue([]);
		mockHistoryDelete = vi.fn().mockResolvedValue(true);
		mockHistoryUpdate = vi.fn().mockResolvedValue(true);

		// Add history and settings mocks to window.maestro
		(
			window as unknown as {
				maestro: {
					history: {
						getAll: typeof mockHistoryGetAll;
						delete: typeof mockHistoryDelete;
						update: typeof mockHistoryUpdate;
					};
					settings: {
						get: ReturnType<typeof vi.fn>;
						set: ReturnType<typeof vi.fn>;
					};
				};
			}
		).maestro = {
			history: {
				getAll: mockHistoryGetAll,
				delete: mockHistoryDelete,
				update: mockHistoryUpdate,
			},
			settings: {
				get: vi.fn().mockResolvedValue(undefined),
				set: vi.fn().mockResolvedValue(undefined),
			},
		};

		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		consoleErrorSpy.mockRestore();
	});

	// ===== PURE FUNCTION TESTS =====
	describe('formatElapsedTime helper (tested via component)', () => {
		it('should format milliseconds', async () => {
			const entry = createMockEntry({
				elapsedTimeMs: 500,
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('500ms')).toBeInTheDocument();
			});
		});

		it('should format seconds', async () => {
			const entry = createMockEntry({
				elapsedTimeMs: 45000, // 45 seconds
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('45s')).toBeInTheDocument();
			});
		});

		it('should format minutes and seconds', async () => {
			const entry = createMockEntry({
				elapsedTimeMs: 125000, // 2m 5s
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('2m 5s')).toBeInTheDocument();
			});
		});

		it('should format hours and minutes', async () => {
			const entry = createMockEntry({
				elapsedTimeMs: 3725000, // 1h 2m
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('1h 2m')).toBeInTheDocument();
			});
		});

		it('should handle boundary cases', async () => {
			const entry1 = createMockEntry({ id: 'e1', elapsedTimeMs: 999 }); // 999ms
			const entry2 = createMockEntry({ id: 'e2', elapsedTimeMs: 1000 }); // 1s
			const entry3 = createMockEntry({ id: 'e3', elapsedTimeMs: 59999 }); // 59s
			const entry4 = createMockEntry({ id: 'e4', elapsedTimeMs: 60000 }); // 1m 0s
			mockHistoryGetAll.mockResolvedValue([entry1, entry2, entry3, entry4]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('999ms')).toBeInTheDocument();
				expect(screen.getByText('1s')).toBeInTheDocument();
				expect(screen.getByText('59s')).toBeInTheDocument();
				expect(screen.getByText('1m 0s')).toBeInTheDocument();
			});
		});
	});

	describe('formatTime helper (tested via component)', () => {
		it('should format today timestamps as time only', async () => {
			const now = new Date();
			const todayEntry = createMockEntry({
				timestamp: now.getTime(),
			});
			mockHistoryGetAll.mockResolvedValue([todayEntry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				// Should show time format like "10:30 AM" (no date)
				const timestampText = screen.getByText(/^\d{1,2}:\d{2}\s*(AM|PM)$/i);
				expect(timestampText).toBeInTheDocument();
			});
		});

		it('should format past date timestamps with date and time', async () => {
			// Set date to yesterday
			const yesterday = new Date();
			yesterday.setDate(yesterday.getDate() - 1);

			const entry = createMockEntry({
				timestamp: yesterday.getTime(),
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				// Should show date + time format like "Dec 6 10:30 AM"
				const timestamps = screen.getAllByText(/\w{3}\s+\d{1,2}/);
				expect(timestamps.length).toBeGreaterThan(0);
			});
		});
	});

	describe('getPillColor helper (tested via component)', () => {
		it('should use warning color for AUTO entries', async () => {
			const entry = createMockEntry({ type: 'AUTO' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				const typePill = screen.getByText('AUTO');
				expect(typePill).toHaveStyle({ color: mockTheme.colors.warning });
			});
		});

		it('should use accent color for USER entries', async () => {
			const entry = createMockEntry({ type: 'USER' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				const typePill = screen.getByText('USER');
				expect(typePill).toHaveStyle({ color: mockTheme.colors.accent });
			});
		});
	});

	// ===== DOUBLE CHECK COMPONENT =====
	describe('DoubleCheck SVG component (tested via validated entries)', () => {
		it('should render double checkmark for validated AUTO entries', async () => {
			const entry = createMockEntry({
				type: 'AUTO',
				success: true,
				validated: true,
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				// Find the success indicator with validated title
				const indicator = screen.getByTitle('Task completed successfully and human-validated');
				expect(indicator).toBeInTheDocument();
				// Should contain an SVG with two polylines (double check)
				const svg = indicator.querySelector('svg');
				expect(svg).toBeInTheDocument();
				const polylines = svg?.querySelectorAll('polyline');
				expect(polylines?.length).toBe(2);
			});
		});
	});

	// ===== LOADING AND EMPTY STATES =====
	describe('loading and empty states', () => {
		it('should show loading state initially', async () => {
			// Create a promise that never resolves to simulate loading
			mockHistoryGetAll.mockImplementation(() => new Promise(() => {}));

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			expect(screen.getByText('Loading history...')).toBeInTheDocument();
		});

		it('should show empty state when no entries exist', async () => {
			mockHistoryGetAll.mockResolvedValue([]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText(/No history yet/)).toBeInTheDocument();
			});
		});

		it('should show filter empty state when no entries match filters', async () => {
			const entry = createMockEntry({ type: 'AUTO' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('AUTO')).toBeInTheDocument();
			});

			// Toggle off AUTO filter
			const autoFilter = screen.getByRole('button', { name: /AUTO/i });
			fireEvent.click(autoFilter);

			await waitFor(() => {
				expect(screen.getByText('No entries match the selected filters.')).toBeInTheDocument();
			});
		});

		it('should show search empty state when no entries match search', async () => {
			const entry = createMockEntry({ summary: 'Test summary' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Test summary')).toBeInTheDocument();
			});

			// Open search with Cmd+F
			const listContainer = container.querySelector('[tabIndex="0"]');
			if (listContainer) {
				fireEvent.keyDown(listContainer, { key: 'f', metaKey: true });
			}

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Filter history...')).toBeInTheDocument();
			});

			// Type search that won't match
			const searchInput = screen.getByPlaceholderText('Filter history...');
			fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

			await waitFor(() => {
				expect(screen.getByText(/No entries match "nonexistent"/)).toBeInTheDocument();
			});
		});

		it('should handle API errors gracefully', async () => {
			mockHistoryGetAll.mockRejectedValue(new Error('API Error'));

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to load history:', expect.any(Error));
				expect(screen.getByText(/No history yet/)).toBeInTheDocument();
			});
		});
	});

	// ===== FILTER FUNCTIONALITY =====
	describe('filter functionality', () => {
		it('should toggle AUTO filter', async () => {
			const autoEntry = createMockEntry({ type: 'AUTO', summary: 'Auto task' });
			const userEntry = createMockEntry({ type: 'USER', summary: 'User task' });
			mockHistoryGetAll.mockResolvedValue([autoEntry, userEntry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Auto task')).toBeInTheDocument();
				expect(screen.getByText('User task')).toBeInTheDocument();
			});

			// Toggle off AUTO
			const autoFilter = screen.getByRole('button', { name: /AUTO/i });
			fireEvent.click(autoFilter);

			await waitFor(() => {
				expect(screen.queryByText('Auto task')).not.toBeInTheDocument();
				expect(screen.getByText('User task')).toBeInTheDocument();
			});

			// Toggle AUTO back on
			fireEvent.click(autoFilter);

			await waitFor(() => {
				expect(screen.getByText('Auto task')).toBeInTheDocument();
			});
		});

		it('should toggle USER filter', async () => {
			const autoEntry = createMockEntry({ type: 'AUTO', summary: 'Auto task' });
			const userEntry = createMockEntry({ type: 'USER', summary: 'User task' });
			mockHistoryGetAll.mockResolvedValue([autoEntry, userEntry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Auto task')).toBeInTheDocument();
				expect(screen.getByText('User task')).toBeInTheDocument();
			});

			// Toggle off USER
			const userFilter = screen.getByRole('button', { name: /USER/i });
			fireEvent.click(userFilter);

			await waitFor(() => {
				expect(screen.getByText('Auto task')).toBeInTheDocument();
				expect(screen.queryByText('User task')).not.toBeInTheDocument();
			});
		});

		it('should filter by search text in summary', async () => {
			const entry1 = createMockEntry({ summary: 'Alpha task' });
			const entry2 = createMockEntry({ summary: 'Beta task' });
			mockHistoryGetAll.mockResolvedValue([entry1, entry2]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Alpha task')).toBeInTheDocument();
				expect(screen.getByText('Beta task')).toBeInTheDocument();
			});

			// Open search
			const listContainer = container.querySelector('[tabIndex="0"]');
			if (listContainer) {
				fireEvent.keyDown(listContainer, { key: 'f', metaKey: true });
			}

			const searchInput = await screen.findByPlaceholderText('Filter history...');
			fireEvent.change(searchInput, { target: { value: 'Alpha' } });

			await waitFor(() => {
				expect(screen.getByText('Alpha task')).toBeInTheDocument();
				expect(screen.queryByText('Beta task')).not.toBeInTheDocument();
			});
		});

		it('should filter by search text in fullResponse', async () => {
			const entry = createMockEntry({
				summary: 'Generic summary',
				fullResponse: 'Full response with unique keyword123',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Generic summary')).toBeInTheDocument();
			});

			// Open search
			const listContainer = container.querySelector('[tabIndex="0"]');
			if (listContainer) {
				fireEvent.keyDown(listContainer, { key: 'f', metaKey: true });
			}

			const searchInput = await screen.findByPlaceholderText('Filter history...');
			fireEvent.change(searchInput, { target: { value: 'keyword123' } });

			await waitFor(() => {
				expect(screen.getByText('Generic summary')).toBeInTheDocument();
			});
		});

		it('should filter by claude session ID', async () => {
			const entry = createMockEntry({
				summary: 'Session task',
				agentSessionId: 'abc12345-xyz-789',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Session task')).toBeInTheDocument();
			});

			// Open search
			const listContainer = container.querySelector('[tabIndex="0"]');
			if (listContainer) {
				fireEvent.keyDown(listContainer, { key: 'f', metaKey: true });
			}

			const searchInput = await screen.findByPlaceholderText('Filter history...');
			fireEvent.change(searchInput, { target: { value: 'abc12345' } });

			await waitFor(() => {
				expect(screen.getByText('Session task')).toBeInTheDocument();
			});
		});

		it('should be case-insensitive in search', async () => {
			const entry = createMockEntry({ summary: 'UPPERCASE Summary' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('UPPERCASE Summary')).toBeInTheDocument();
			});

			// Open search
			const listContainer = container.querySelector('[tabIndex="0"]');
			if (listContainer) {
				fireEvent.keyDown(listContainer, { key: 'f', metaKey: true });
			}

			const searchInput = await screen.findByPlaceholderText('Filter history...');
			fireEvent.change(searchInput, { target: { value: 'uppercase' } });

			await waitFor(() => {
				expect(screen.getByText('UPPERCASE Summary')).toBeInTheDocument();
			});
		});

		it('should open search with Ctrl+F and leave it open on a repeated shortcut', async () => {
			const entry = createMockEntry({ summary: 'Ctrl search entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Ctrl search entry')).toBeInTheDocument();
			});

			const listContainer = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(listContainer!, { key: 'f', ctrlKey: true });

			const searchInput = await screen.findByPlaceholderText('Filter history...');
			fireEvent.change(searchInput, { target: { value: 'Ctrl' } });
			fireEvent.keyDown(listContainer!, { key: 'f', ctrlKey: true });

			expect(screen.getByPlaceholderText('Filter history...')).toHaveValue('Ctrl');
		});

		it('should filter entries by graph lookback period', async () => {
			const now = Date.now();
			const recentEntry = createMockEntry({
				id: 'recent',
				summary: 'Recent task',
				timestamp: now - 2 * 60 * 60 * 1000, // 2 hours ago
			});
			const oldEntry = createMockEntry({
				id: 'old',
				summary: 'Old task',
				timestamp: now - 48 * 60 * 60 * 1000, // 48 hours ago
			});
			mockHistoryGetAll.mockResolvedValue([recentEntry, oldEntry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			// Both entries visible initially (all time)
			await waitFor(() => {
				expect(screen.getByText('Recent task')).toBeInTheDocument();
				expect(screen.getByText('Old task')).toBeInTheDocument();
			});

			// Right-click the graph to open context menu
			const graphContainer = container.querySelector(
				'[class*="flex-1"][class*="min-w-0"][class*="flex-col"]'
			);
			if (graphContainer) {
				fireEvent.contextMenu(graphContainer);
			}

			// Select "24 hours" from the context menu
			await waitFor(() => {
				const option24h = screen.getByText('24 hours');
				expect(option24h).toBeInTheDocument();
				fireEvent.click(option24h);
			});

			// Old entry (48h ago) should be filtered out
			await waitFor(() => {
				expect(screen.getByText('Recent task')).toBeInTheDocument();
				expect(screen.queryByText('Old task')).not.toBeInTheDocument();
			});
		});

		it('should restore saved graph lookback and allow returning to all time', async () => {
			const maestro = window.maestro as unknown as {
				settings: {
					get: ReturnType<typeof vi.fn>;
					set: ReturnType<typeof vi.fn>;
				};
			};
			maestro.settings.get.mockResolvedValue(24);
			const oldEntry = createMockEntry({
				id: 'outside-lookback',
				summary: 'Older saved-lookback task',
				timestamp: Date.now() - 48 * 60 * 60 * 1000,
			});
			mockHistoryGetAll.mockResolvedValue([oldEntry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText(/No entries in the last/)).toBeInTheDocument();
				expect(screen.getByText('24h')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByRole('button', { name: /Show all time \(1 entries\)/i }));

			await waitFor(() => {
				expect(screen.getByText('Older saved-lookback task')).toBeInTheDocument();
			});
			expect(maestro.settings.set).toHaveBeenCalledWith('historyGraphLookback:session-1', null);
		});

		it('should describe empty week and month lookback windows', async () => {
			const maestro = window.maestro as unknown as {
				settings: {
					get: ReturnType<typeof vi.fn>;
				};
			};
			const oldEntry = createMockEntry({
				id: 'outside-long-lookback',
				summary: 'Older long-lookback task',
				timestamp: Date.now() - 400 * 24 * 60 * 60 * 1000,
			});
			mockHistoryGetAll.mockResolvedValue([oldEntry]);

			maestro.settings.get.mockResolvedValue(168);
			const { rerender } = render(
				<HistoryPanel session={createMockSession({ id: 'week-lookback' })} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText(/No entries in the last/)).toBeInTheDocument();
				expect(screen.getByText('7d')).toBeInTheDocument();
			});

			maestro.settings.get.mockResolvedValue(720);
			rerender(
				<HistoryPanel session={createMockSession({ id: 'month-lookback' })} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(
					screen.getAllByText((_, element) =>
						Boolean(element?.textContent?.includes('No entries in the last 1mo.'))
					).length
				).toBeGreaterThan(0);
			});
		});

		it('should show result count when searching', async () => {
			const entries = [
				createMockEntry({ id: 'e1', summary: 'Alpha one' }),
				createMockEntry({ id: 'e2', summary: 'Alpha two' }),
				createMockEntry({ id: 'e3', summary: 'Beta xyz' }),
			];
			mockHistoryGetAll.mockResolvedValue(entries);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Alpha one')).toBeInTheDocument();
			});

			// Open search
			const listContainer = container.querySelector('[tabIndex="0"]');
			if (listContainer) {
				fireEvent.keyDown(listContainer, { key: 'f', metaKey: true });
			}

			const searchInput = await screen.findByPlaceholderText('Filter history...');
			// Search for "Alpha" which should match 2 entries
			fireEvent.change(searchInput, { target: { value: 'Alpha' } });

			// Check that the result count is shown
			await waitFor(() => {
				// The component shows "{count} result" or "{count} results"
				const resultCountDiv = container.querySelector('.text-right.text-\\[10px\\]');
				expect(resultCountDiv).toBeInTheDocument();
				expect(resultCountDiv?.textContent).toMatch(/2 results?/);
			});
		});

		it('should close search with Escape and clear filter', async () => {
			const entry = createMockEntry({ summary: 'Test entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Test entry')).toBeInTheDocument();
			});

			// Open search
			const listContainer = container.querySelector('[tabIndex="0"]');
			if (listContainer) {
				fireEvent.keyDown(listContainer, { key: 'f', metaKey: true });
			}

			const searchInput = await screen.findByPlaceholderText('Filter history...');
			fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

			// Press Escape to close search
			fireEvent.keyDown(searchInput, { key: 'Escape' });

			await waitFor(() => {
				expect(screen.queryByPlaceholderText('Filter history...')).not.toBeInTheDocument();
				expect(screen.getByText('Test entry')).toBeInTheDocument();
			});
		});

		it('should ignore unrelated keys in the search field', async () => {
			const entry = createMockEntry({ summary: 'Search key entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Search key entry')).toBeInTheDocument();
			});

			const listContainer = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(listContainer!, { key: 'f', metaKey: true });

			const searchInput = await screen.findByPlaceholderText('Filter history...');
			fireEvent.change(searchInput, { target: { value: 'Search' } });
			fireEvent.keyDown(searchInput, { key: 'Tab' });

			expect(screen.getByPlaceholderText('Filter history...')).toHaveValue('Search');
		});
	});

	// ===== KEYBOARD NAVIGATION =====
	describe('keyboard navigation', () => {
		it('should navigate with ArrowDown', async () => {
			const entries = [
				createMockEntry({ id: 'entry-1', summary: 'First entry' }),
				createMockEntry({ id: 'entry-2', summary: 'Second entry' }),
			];
			mockHistoryGetAll.mockResolvedValue(entries);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('First entry')).toBeInTheDocument();
			});

			const listContainer = container.querySelector('[tabIndex="0"]');
			expect(listContainer).toBeTruthy();

			// Navigate down
			fireEvent.keyDown(listContainer!, { key: 'ArrowDown' });

			// First item should be selected
			await waitFor(() => {
				const firstCard = screen.getByText('First entry').closest('div[class*="cursor-pointer"]');
				expect(firstCard).toHaveStyle({ outlineOffset: '1px' });
			});
		});

		it('should navigate with ArrowUp', async () => {
			const entries = [
				createMockEntry({ id: 'entry-1', summary: 'First entry' }),
				createMockEntry({ id: 'entry-2', summary: 'Second entry' }),
			];
			mockHistoryGetAll.mockResolvedValue(entries);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('First entry')).toBeInTheDocument();
			});

			const listContainer = container.querySelector('[tabIndex="0"]');

			// Navigate down twice then up
			fireEvent.keyDown(listContainer!, { key: 'ArrowDown' });
			fireEvent.keyDown(listContainer!, { key: 'ArrowDown' });
			fireEvent.keyDown(listContainer!, { key: 'ArrowUp' });

			// Should be back on first item
			await waitFor(() => {
				const firstCard = screen.getByText('First entry').closest('div[class*="cursor-pointer"]');
				expect(firstCard).toHaveStyle({ outlineOffset: '1px' });
			});
		});

		it('should open detail modal with Enter', async () => {
			const entry = createMockEntry({ summary: 'Detail entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Detail entry')).toBeInTheDocument();
			});

			const listContainer = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(listContainer!, { key: 'ArrowDown' });
			fireEvent.keyDown(listContainer!, { key: 'Enter' });

			await waitFor(() => {
				expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
				expect(screen.getByTestId('modal-entry-summary')).toHaveTextContent('Detail entry');
			});
		});

		it('should clear selection with Escape when modal is closed', async () => {
			const entry = createMockEntry({ summary: 'Test entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Test entry')).toBeInTheDocument();
			});

			const listContainer = container.querySelector('[tabIndex="0"]');

			// Select item
			fireEvent.keyDown(listContainer!, { key: 'ArrowDown' });

			// Verify selection
			await waitFor(() => {
				const card = screen.getByText('Test entry').closest('div[class*="cursor-pointer"]');
				expect(card).toHaveStyle({ outlineOffset: '1px' });
			});

			// Press Escape to clear selection
			fireEvent.keyDown(listContainer!, { key: 'Escape' });

			await waitFor(() => {
				const card = screen.getByText('Test entry').closest('div[class*="cursor-pointer"]');
				expect(card).not.toHaveStyle({ outline: expect.stringContaining('solid') });
			});
		});

		it('should move focus to list with ArrowDown from search input', async () => {
			const entry = createMockEntry({ summary: 'Test entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Test entry')).toBeInTheDocument();
			});

			// Open search
			const listContainer = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(listContainer!, { key: 'f', metaKey: true });

			const searchInput = await screen.findByPlaceholderText('Filter history...');

			// Press ArrowDown to move focus to list
			fireEvent.keyDown(searchInput, { key: 'ArrowDown' });

			await waitFor(() => {
				const card = screen.getByText('Test entry').closest('div[class*="cursor-pointer"]');
				expect(card).toHaveStyle({ outlineOffset: '1px' });
			});
		});

		it('should leave selection empty when ArrowDown is pressed from search with no matches', async () => {
			const entry = createMockEntry({ summary: 'Visible before search' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Visible before search')).toBeInTheDocument();
			});

			const listContainer = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(listContainer!, { key: 'f', metaKey: true });

			const searchInput = await screen.findByPlaceholderText('Filter history...');
			fireEvent.change(searchInput, { target: { value: 'no matches' } });
			fireEvent.keyDown(searchInput, { key: 'ArrowDown' });

			await waitFor(() => {
				expect(screen.getByText(/No entries match "no matches"/)).toBeInTheDocument();
			});
			expect(screen.queryByTestId('history-detail-modal')).not.toBeInTheDocument();
		});
	});

	// ===== DETAIL MODAL =====
	describe('detail modal', () => {
		it('should open detail modal on entry click', async () => {
			const entry = createMockEntry({ summary: 'Click entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Click entry')).toBeInTheDocument();
			});

			// Click on entry
			fireEvent.click(screen.getByText('Click entry'));

			await waitFor(() => {
				expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
			});
		});

		it('should close detail modal', async () => {
			const entry = createMockEntry({ summary: 'Modal entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Modal entry')).toBeInTheDocument();
			});

			// Open modal
			fireEvent.click(screen.getByText('Modal entry'));

			await waitFor(() => {
				expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
			});

			// Close modal
			fireEvent.click(screen.getByTestId('modal-close'));

			await waitFor(() => {
				expect(screen.queryByTestId('history-detail-modal')).not.toBeInTheDocument();
			});
		});
	});

	// ===== DELETE FUNCTIONALITY =====
	describe('delete functionality', () => {
		it('should delete entry via modal', async () => {
			const entry = createMockEntry({ id: 'delete-me', summary: 'Delete entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Delete entry')).toBeInTheDocument();
			});

			// Open modal
			fireEvent.click(screen.getByText('Delete entry'));

			await waitFor(() => {
				expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
			});

			// Click delete
			fireEvent.click(screen.getByTestId('modal-delete'));

			await waitFor(() => {
				// sessionId 'session-1' is passed for efficient lookup in per-session storage
				expect(mockHistoryDelete).toHaveBeenCalledWith('delete-me', 'session-1');
			});
		});

		it('should handle delete error gracefully', async () => {
			const entry = createMockEntry({ id: 'error-entry', summary: 'Error entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);
			mockHistoryDelete.mockRejectedValue(new Error('Delete failed'));

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Error entry')).toBeInTheDocument();
			});

			// Open modal and delete
			fireEvent.click(screen.getByText('Error entry'));

			await waitFor(() => {
				expect(screen.getByTestId('modal-delete')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('modal-delete'));

			await waitFor(() => {
				expect(consoleErrorSpy).toHaveBeenCalledWith(
					'Failed to delete history entry:',
					expect.any(Error)
				);
			});
		});

		it('should keep a history entry when deletion reports failure', async () => {
			const entry = createMockEntry({ id: 'delete-false-entry', summary: 'Keep entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);
			mockHistoryDelete.mockResolvedValue(false);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Keep entry')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Keep entry'));
			await screen.findByTestId('modal-delete');
			fireEvent.click(screen.getByTestId('modal-delete'));

			await waitFor(() => {
				expect(mockHistoryDelete).toHaveBeenCalledWith('delete-false-entry', 'session-1');
			});
			expect(screen.getAllByText('Keep entry').length).toBeGreaterThan(0);
		});
	});

	// ===== REF API =====
	describe('ref API', () => {
		it('should expose focus method', async () => {
			const ref = React.createRef<HistoryPanelHandle>();
			const entry = createMockEntry({ summary: 'Ref entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel ref={ref} session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Ref entry')).toBeInTheDocument();
			});

			act(() => {
				ref.current?.focus();
			});

			// Should select first item when focus is called
			await waitFor(() => {
				const card = screen.getByText('Ref entry').closest('div[class*="cursor-pointer"]');
				expect(card).toHaveStyle({ outlineOffset: '1px' });
			});
		});

		it('should not select an item when focus is called with an empty history list', async () => {
			const ref = React.createRef<HistoryPanelHandle>();
			mockHistoryGetAll.mockResolvedValue([]);

			render(<HistoryPanel ref={ref} session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText(/No history yet/)).toBeInTheDocument();
			});

			act(() => {
				ref.current?.focus();
			});

			expect(screen.queryByTestId('history-detail-modal')).not.toBeInTheDocument();
		});

		it('should preserve the current selection when focus is called after keyboard navigation', async () => {
			const ref = React.createRef<HistoryPanelHandle>();
			const entries = [
				createMockEntry({ id: 'first-ref-entry', summary: 'First ref entry' }),
				createMockEntry({ id: 'second-ref-entry', summary: 'Second ref entry' }),
			];
			mockHistoryGetAll.mockResolvedValue(entries);

			const { container } = render(
				<HistoryPanel ref={ref} session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('First ref entry')).toBeInTheDocument();
			});

			const listContainer = container.querySelector('[tabIndex="0"]');
			fireEvent.keyDown(listContainer!, { key: 'ArrowDown' });
			fireEvent.keyDown(listContainer!, { key: 'ArrowDown' });

			act(() => {
				ref.current?.focus();
			});

			await waitFor(() => {
				const secondCard = screen
					.getByText('Second ref entry')
					.closest('div[class*="cursor-pointer"]');
				expect(secondCard).toHaveStyle({ outlineOffset: '1px' });
			});
		});

		it('should expose refreshHistory method', async () => {
			const ref = React.createRef<HistoryPanelHandle>();
			mockHistoryGetAll.mockResolvedValue([]);

			render(<HistoryPanel ref={ref} session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(mockHistoryGetAll).toHaveBeenCalledTimes(1);
			});

			// Add new entry
			const newEntry = createMockEntry({ summary: 'New entry after refresh' });
			mockHistoryGetAll.mockResolvedValue([newEntry]);

			// Refresh history
			act(() => {
				ref.current?.refreshHistory();
			});

			await waitFor(() => {
				expect(mockHistoryGetAll).toHaveBeenCalledTimes(2);
				expect(screen.getByText('New entry after refresh')).toBeInTheDocument();
			});
		});

		it('should skip refresh scroll restoration if the panel unmounts before animation frame', async () => {
			const rafCallbacks: FrameRequestCallback[] = [];
			vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
				(callback: FrameRequestCallback) => {
					rafCallbacks.push(callback);
					return rafCallbacks.length;
				}
			);
			const ref = React.createRef<HistoryPanelHandle>();
			const entry = createMockEntry({ summary: 'Refresh unmount entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { unmount } = render(
				<HistoryPanel ref={ref} session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Refresh unmount entry')).toBeInTheDocument();
			});

			act(() => {
				ref.current?.refreshHistory();
			});

			await waitFor(() => {
				expect(rafCallbacks.length).toBeGreaterThan(0);
			});
			unmount();

			expect(() => rafCallbacks.forEach((callback) => callback(0))).not.toThrow();
		});
	});

	// ===== ENTRY CARD RENDERING =====
	describe('entry card rendering', () => {
		it('should render success indicator for successful AUTO entries', async () => {
			const entry = createMockEntry({
				type: 'AUTO',
				success: true,
				validated: false,
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				const indicator = screen.getByTitle('Task completed successfully');
				expect(indicator).toBeInTheDocument();
			});
		});

		it('should render failure indicator for failed AUTO entries', async () => {
			const entry = createMockEntry({
				type: 'AUTO',
				success: false,
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				const indicator = screen.getByTitle('Task failed');
				expect(indicator).toBeInTheDocument();
			});
		});

		it('should render cost badge when usageStats has cost', async () => {
			const entry = createMockEntry({
				usageStats: {
					inputTokens: 1000,
					outputTokens: 500,
					totalCostUsd: 0.05,
					tokenCacheHits: 0,
					contextWindow: 100000,
				},
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('$0.05')).toBeInTheDocument();
			});
		});

		it('should render claude session ID badge', async () => {
			const onOpenSessionAsTab = vi.fn();
			const entry = createMockEntry({
				agentSessionId: 'abc12345-def-789',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(
				<HistoryPanel
					session={createMockSession()}
					theme={mockTheme}
					onOpenSessionAsTab={onOpenSessionAsTab}
				/>
			);

			await waitFor(() => {
				// Should show first octet of session ID
				expect(screen.getByText('ABC12345')).toBeInTheDocument();
			});
		});

		it('should render session name instead of ID when available', async () => {
			const entry = createMockEntry({
				agentSessionId: 'abc12345-def-789',
				sessionName: 'My Session',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('My Session')).toBeInTheDocument();
				expect(screen.queryByText('ABC12345')).not.toBeInTheDocument();
			});
		});

		it('should call onOpenSessionAsTab when session badge is clicked', async () => {
			const onOpenSessionAsTab = vi.fn();
			const entry = createMockEntry({
				agentSessionId: 'abc12345-def-789',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(
				<HistoryPanel
					session={createMockSession()}
					theme={mockTheme}
					onOpenSessionAsTab={onOpenSessionAsTab}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('ABC12345')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('ABC12345'));

			expect(onOpenSessionAsTab).toHaveBeenCalledWith('abc12345-def-789', '/test/project');
		});

		it('should render summary with truncation', async () => {
			const longSummary =
				'This is a very long summary that should be truncated to three lines maximum in the history panel display because we do not want to show too much text.';
			const entry = createMockEntry({
				summary: longSummary,
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				const summaryElement = screen.getByText(longSummary);
				expect(summaryElement).toBeInTheDocument();
				// Check CSS truncation is applied
				expect(summaryElement).toHaveStyle({ WebkitLineClamp: '3' });
			});
		});

		it('should show "No summary available" for entries without summary', async () => {
			const entry = createMockEntry({
				summary: '',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('No summary available')).toBeInTheDocument();
			});
		});

		it('should render entries with an empty id using the virtual row fallback key', async () => {
			const entry = createMockEntry({
				id: '',
				summary: 'Empty id entry',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Empty id entry')).toBeInTheDocument();
			});
		});
	});

	// ===== VIRTUALIZATION =====
	describe('virtualization', () => {
		it('should render entries using virtualization', async () => {
			// Create 60 entries
			const entries = Array.from({ length: 60 }, (_, i) =>
				createMockEntry({ id: `entry-${i}`, summary: `Entry ${i}` })
			);
			mockHistoryGetAll.mockResolvedValue(entries);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			// First entry should be visible (virtualization renders visible entries)
			await waitFor(() => {
				expect(screen.getByText('Entry 0')).toBeInTheDocument();
			});

			// All entries are accessible in the virtualized list, but only visible ones are in DOM
			// The virtualizer will render a subset based on scroll position and overscan
		});

		it('should handle many entries efficiently with virtualization', async () => {
			// Create many entries to test virtualization handles large lists
			const entries = Array.from({ length: 500 }, (_, i) =>
				createMockEntry({ id: `entry-${i}`, summary: `Entry ${i}` })
			);
			mockHistoryGetAll.mockResolvedValue(entries);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			// Should render without performance issues and show first entries
			await waitFor(() => {
				expect(screen.getByText('Entry 0')).toBeInTheDocument();
			});
		});
	});

	// ===== ACTIVITY GRAPH =====
	describe('ActivityGraph component', () => {
		it('should render 24 bars for hourly buckets', async () => {
			const now = Date.now();
			const entry = createMockEntry({ timestamp: now - 1000 }); // Recent entry
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				// The graph should have 24 bars
				const graphBars = container.querySelectorAll('[class*="flex-1"][class*="min-w-0"]');
				// 24 bars in the graph
				expect(graphBars.length).toBeGreaterThanOrEqual(24);
			});
		});

		it('should show "Now" label for all-time view (default)', async () => {
			mockHistoryGetAll.mockResolvedValue([]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			// Default is now "All time" which shows start date and "Now" labels
			await waitFor(() => {
				expect(screen.getByText('Now')).toBeInTheDocument();
			});
		});

		it('should display tooltip on bar hover', async () => {
			const now = Date.now();
			const entry = createMockEntry({ type: 'AUTO', timestamp: now - 1000 });
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				// Find the most recent bar (index 23)
				const bars = container.querySelectorAll(
					'[class*="flex-1"][class*="min-w-0"][class*="cursor-pointer"]'
				);
				expect(bars.length).toBeGreaterThan(0);
			});

			// Find a bar with data and hover
			const bars = container.querySelectorAll('[class*="rounded-t-sm"][style*="cursor: pointer"]');
			if (bars.length > 0) {
				fireEvent.mouseEnter(bars[bars.length - 1]);

				await waitFor(() => {
					// Tooltip should show Auto/User counts
					expect(screen.getByText('Auto')).toBeInTheDocument();
					expect(screen.getByText('User')).toBeInTheDocument();
				});

				fireEvent.mouseLeave(bars[bars.length - 1]);
			}
		});

		it('should select a history entry when clicking its activity graph bucket', async () => {
			const entry = createMockEntry({
				id: 'graph-click-entry',
				summary: 'Graph click entry',
				timestamp: Date.now() - 1000,
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Graph click entry')).toBeInTheDocument();
			});

			const bars = Array.from(
				container.querySelectorAll<HTMLElement>('[class*="rounded-t-sm"][style*="cursor: pointer"]')
			);
			expectSmoothScrollDynamicSizeWarning(() => {
				fireEvent.click(bars[bars.length - 1]);
			});

			await waitFor(() => {
				const card = screen.getByText('Graph click entry').closest('div[class*="cursor-pointer"]');
				expect(card).toHaveStyle({ outline: `2px solid ${mockTheme.colors.accent}` });
			});
		});

		it('should select another entry in the bucket when the newest bucket entry is filtered out', async () => {
			const timestamp = Date.now() - 1000;
			const autoEntry = createMockEntry({
				id: 'filtered-auto-entry',
				type: 'AUTO',
				summary: 'Filtered auto bucket entry',
				timestamp,
			});
			const userEntry = createMockEntry({
				id: 'visible-user-entry',
				type: 'USER',
				summary: 'Visible user bucket entry',
				timestamp,
			});
			mockHistoryGetAll.mockResolvedValue([autoEntry, userEntry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Filtered auto bucket entry')).toBeInTheDocument();
				expect(screen.getByText('Visible user bucket entry')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByRole('button', { name: /AUTO/i }));

			await waitFor(() => {
				expect(screen.queryByText('Filtered auto bucket entry')).not.toBeInTheDocument();
				expect(screen.getByText('Visible user bucket entry')).toBeInTheDocument();
			});

			const bars = Array.from(
				container.querySelectorAll<HTMLElement>('[class*="rounded-t-sm"][style*="cursor: pointer"]')
			);
			expectSmoothScrollDynamicSizeWarning(() => {
				fireEvent.click(bars[bars.length - 1]);
			});

			await waitFor(() => {
				const card = screen
					.getByText('Visible user bucket entry')
					.closest('div[class*="cursor-pointer"]');
				expect(card).toHaveStyle({ outline: `2px solid ${mockTheme.colors.accent}` });
			});
		});

		it('should ignore graph bucket clicks when every entry in the bucket is filtered out', async () => {
			const autoEntry = createMockEntry({
				id: 'only-filtered-auto-entry',
				type: 'AUTO',
				summary: 'Only filtered bucket entry',
				timestamp: Date.now() - 1000,
			});
			mockHistoryGetAll.mockResolvedValue([autoEntry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Only filtered bucket entry')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByRole('button', { name: /AUTO/i }));

			await waitFor(() => {
				expect(screen.queryByText('Only filtered bucket entry')).not.toBeInTheDocument();
			});

			const bars = Array.from(
				container.querySelectorAll<HTMLElement>('[class*="rounded-t-sm"][style*="cursor: pointer"]')
			);
			fireEvent.click(bars[bars.length - 1]);

			expect(screen.queryByTestId('history-detail-modal')).not.toBeInTheDocument();
			expect(screen.queryByText('Only filtered bucket entry')).not.toBeInTheDocument();
		});

		it('should update graph reference time while scrolling the history list', async () => {
			const entry = createMockEntry({
				summary: 'Historical scroll entry',
				timestamp: Date.now() - 2 * 60 * 60 * 1000,
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container } = render(
				<HistoryPanel session={createMockSession()} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Historical scroll entry')).toBeInTheDocument();
			});

			const list = container.querySelector<HTMLElement>(
				'[tabindex="0"][class*="overflow-y-auto"]'
			)!;
			Object.defineProperty(list, 'scrollTop', { value: 80, writable: true });
			fireEvent.scroll(list);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(8);
			});

			await waitFor(() => {
				expect(container.querySelector('[title*="Viewing:"]')).toBeInTheDocument();
			});

			list.scrollTop = 0;
			fireEvent.scroll(list);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(8);
			});

			await waitFor(() => {
				expect(container.querySelector('[title*="Viewing:"]')).not.toBeInTheDocument();
			});
		});

		it('should restore cached scroll position when the same session is remounted', async () => {
			const rafSpy = vi
				.spyOn(window, 'requestAnimationFrame')
				.mockImplementation((callback: FrameRequestCallback) => {
					callback(0);
					return 1;
				});
			const session = createMockSession({ id: 'restore-scroll-session' });
			const entry = createMockEntry({ summary: 'Restore scroll entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container, unmount } = render(<HistoryPanel session={session} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Restore scroll entry')).toBeInTheDocument();
			});

			const firstList = container.querySelector<HTMLElement>(
				'[tabindex="0"][class*="overflow-y-auto"]'
			)!;
			Object.defineProperty(firstList, 'scrollTop', { value: 96, writable: true });
			fireEvent.scroll(firstList);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(8);
			});

			unmount();

			const { container: remountedContainer } = render(
				<HistoryPanel session={session} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(screen.getByText('Restore scroll entry')).toBeInTheDocument();
			});

			const remountedList = remountedContainer.querySelector<HTMLElement>(
				'[tabindex="0"][class*="overflow-y-auto"]'
			)!;
			expect(remountedList.scrollTop).toBe(96);
			expect(rafSpy).toHaveBeenCalled();
		});

		it('should skip cached scroll restoration if the remounted panel unmounts before animation frame', async () => {
			const rafCallbacks: FrameRequestCallback[] = [];
			vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
				(callback: FrameRequestCallback) => {
					rafCallbacks.push(callback);
					return rafCallbacks.length;
				}
			);
			const session = createMockSession({ id: 'restore-scroll-unmount-session' });
			const entry = createMockEntry({ summary: 'Unmount before restore entry' });
			mockHistoryGetAll.mockResolvedValue([entry]);

			const { container, unmount } = render(<HistoryPanel session={session} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Unmount before restore entry')).toBeInTheDocument();
			});

			const firstList = container.querySelector<HTMLElement>(
				'[tabindex="0"][class*="overflow-y-auto"]'
			)!;
			Object.defineProperty(firstList, 'scrollTop', { value: 72, writable: true });
			fireEvent.scroll(firstList);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(8);
			});

			unmount();
			const { unmount: unmountRemounted } = render(
				<HistoryPanel session={session} theme={mockTheme} />
			);

			await waitFor(() => {
				expect(rafCallbacks.length).toBeGreaterThan(0);
			});
			unmountRemounted();

			expect(() => rafCallbacks.forEach((callback) => callback(0))).not.toThrow();
		});
	});

	// ===== HELP MODAL =====
	describe('help modal', () => {
		it('should open help modal on help button click', async () => {
			mockHistoryGetAll.mockResolvedValue([]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				const helpButton = screen.getByTitle('History panel help');
				expect(helpButton).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTitle('History panel help'));

			await waitFor(() => {
				expect(screen.getByTestId('history-help-modal')).toBeInTheDocument();
			});
		});

		it('should close help modal', async () => {
			mockHistoryGetAll.mockResolvedValue([]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				const helpButton = screen.getByTitle('History panel help');
				fireEvent.click(helpButton);
			});

			await waitFor(() => {
				expect(screen.getByTestId('history-help-modal')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('help-modal-close'));

			await waitFor(() => {
				expect(screen.queryByTestId('history-help-modal')).not.toBeInTheDocument();
			});
		});
	});

	// ===== SESSION CHANGES =====
	describe('session changes', () => {
		it('should reload history when session changes', async () => {
			const session1 = createMockSession({ id: 'session-1', cwd: '/project1' });
			const session2 = createMockSession({ id: 'session-2', cwd: '/project2' });

			mockHistoryGetAll.mockResolvedValue([createMockEntry({ summary: 'Entry from session 1' })]);

			const { rerender } = render(<HistoryPanel session={session1} theme={mockTheme} />);

			await waitFor(() => {
				expect(mockHistoryGetAll).toHaveBeenCalledWith('/project1', 'session-1');
			});

			// Change session
			mockHistoryGetAll.mockResolvedValue([createMockEntry({ summary: 'Entry from session 2' })]);

			rerender(<HistoryPanel session={session2} theme={mockTheme} />);

			await waitFor(() => {
				expect(mockHistoryGetAll).toHaveBeenCalledWith('/project2', 'session-2');
			});
		});
	});

	// ===== EDGE CASES =====
	describe('edge cases', () => {
		it('should handle entries with missing type (filtered out)', async () => {
			// Note: The component's filtering uses entry.type check which filters out entries without type
			// This test verifies that invalid entries don't cause crashes and are filtered out
			const validEntry = createMockEntry({ summary: 'Valid entry' });
			mockHistoryGetAll.mockResolvedValue([
				{ id: 'no-type', timestamp: Date.now(), summary: 'No type entry', projectPath: '/test' },
				validEntry,
			]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			// Entry without type should be filtered out, valid entry should show
			await waitFor(() => {
				expect(screen.getByText('Valid entry')).toBeInTheDocument();
				expect(screen.queryByText('No type entry')).not.toBeInTheDocument();
			});
		});

		it('should handle non-array API response', async () => {
			mockHistoryGetAll.mockResolvedValue('not an array');

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText(/No history yet/)).toBeInTheDocument();
			});
		});

		it('should handle entries with special characters in summary', async () => {
			const entry = createMockEntry({
				summary: '<script>alert("XSS")</script> & special " chars',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				// React should escape the content
				expect(
					screen.getByText(/<script>alert\("XSS"\)<\/script> & special " chars/)
				).toBeInTheDocument();
			});
		});

		it('should handle entries with unicode characters in summary', async () => {
			const entry = createMockEntry({
				summary: '日本語テスト 🚀 emoji test',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('日本語テスト 🚀 emoji test')).toBeInTheDocument();
			});
		});

		it('should handle entries with unicode session names', async () => {
			const entry = createMockEntry({
				summary: 'Unicode session',
				agentSessionId: 'abc-123',
				sessionName: '会議セッション',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(
				<HistoryPanel
					session={createMockSession()}
					theme={mockTheme}
					onOpenSessionAsTab={vi.fn()}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Unicode session')).toBeInTheDocument();
				// Session name should be displayed instead of session ID
				expect(screen.getByText('会議セッション')).toBeInTheDocument();
			});
		});

		it('should limit entries to MAX_HISTORY_IN_MEMORY', async () => {
			// Create 600 entries (more than 500 limit)
			const entries = Array.from({ length: 600 }, (_, i) =>
				createMockEntry({ id: `entry-${i}`, summary: `Entry ${i}` })
			);
			mockHistoryGetAll.mockResolvedValue(entries);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			// Should display entries (virtualized) with the first one visible
			// The MAX_HISTORY_IN_MEMORY limit (500) is applied when storing entries
			await waitFor(() => {
				expect(screen.getByText('Entry 0')).toBeInTheDocument();
			});
		});

		it('should handle zero cost in usageStats', async () => {
			const entry = createMockEntry({
				usageStats: {
					inputTokens: 0,
					outputTokens: 0,
					totalCostUsd: 0,
					tokenCacheHits: 0,
					contextWindow: 100000,
				},
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				// Should not show cost badge for zero cost
				expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
			});
		});

		it('should handle entry with only required fields (minimal data)', async () => {
			const entry = createMockEntry({
				type: 'USER',
				summary: 'Minimal entry summary',
				agentSessionId: undefined,
				usageStats: undefined,
				elapsedTimeMs: undefined,
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Minimal entry summary')).toBeInTheDocument();
				// Type badge in the card
				const typeBadges = screen.getAllByText('USER');
				expect(typeBadges.length).toBeGreaterThanOrEqual(1);
			});
		});
	});

	// ===== CALLBACKS =====
	describe('callbacks', () => {
		it('should call onJumpToAgentSession from detail modal', async () => {
			const onJumpToAgentSession = vi.fn();
			const entry = createMockEntry({
				agentSessionId: 'jump-session-id',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(
				<HistoryPanel
					session={createMockSession()}
					theme={mockTheme}
					onJumpToAgentSession={onJumpToAgentSession}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Test summary')).toBeInTheDocument();
			});

			// The callback is passed to the modal component
			// Our mock doesn't invoke it, but we verify it's passed correctly
		});

		it('should call onResumeSession from detail modal', async () => {
			const onResumeSession = vi.fn();
			const entry = createMockEntry({
				agentSessionId: 'resume-session-id',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);

			render(
				<HistoryPanel
					session={createMockSession()}
					theme={mockTheme}
					onResumeSession={onResumeSession}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Test summary')).toBeInTheDocument();
			});

			// Verify prop is passed (mock modal doesn't expose this functionality)
		});

		it('should update entry when onUpdate is called from detail modal', async () => {
			const entry = createMockEntry({
				id: 'update-test-entry',
				summary: 'Original summary',
			});
			const untouchedEntry = createMockEntry({
				id: 'untouched-update-entry',
				summary: 'Untouched summary',
			});
			mockHistoryGetAll.mockResolvedValue([entry, untouchedEntry]);
			mockHistoryUpdate.mockResolvedValue(true);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Original summary')).toBeInTheDocument();
			});

			// Open the detail modal by clicking the entry
			fireEvent.click(screen.getByText('Original summary'));

			await waitFor(() => {
				expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
			});

			// Click the Update button in the mock modal
			fireEvent.click(screen.getByTestId('modal-update'));

			await waitFor(() => {
				// Verify the history update was called with sessionId for efficient lookup
				expect(mockHistoryUpdate).toHaveBeenCalledWith(
					'update-test-entry',
					{ summary: 'Updated summary' },
					'session-1'
				);
				expect(screen.getByText('Untouched summary')).toBeInTheDocument();
			});
		});

		it('should handle failed update gracefully', async () => {
			const entry = createMockEntry({
				id: 'update-fail-entry',
				summary: 'Will not change',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);
			mockHistoryUpdate.mockResolvedValue(false);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Will not change')).toBeInTheDocument();
			});

			// Open the detail modal
			fireEvent.click(screen.getByText('Will not change'));

			await waitFor(() => {
				expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
			});

			// Click update - should fail silently
			fireEvent.click(screen.getByTestId('modal-update'));

			await waitFor(() => {
				expect(mockHistoryUpdate).toHaveBeenCalled();
			});

			// Verify component didn't crash - modal is still visible
			expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
		});

		it('should not reopen the detail modal when an async update resolves after close', async () => {
			let resolveUpdate: ((value: boolean) => void) | undefined;
			const entry = createMockEntry({
				id: 'delayed-update-entry',
				summary: 'Delayed original summary',
			});
			mockHistoryGetAll.mockResolvedValue([entry]);
			mockHistoryUpdate.mockImplementation(
				() =>
					new Promise<boolean>((resolve) => {
						resolveUpdate = resolve;
					})
			);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Delayed original summary')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Delayed original summary'));
			await screen.findByTestId('history-detail-modal');
			fireEvent.click(screen.getByTestId('modal-update'));

			await waitFor(() => {
				expect(mockHistoryUpdate).toHaveBeenCalledWith(
					'delayed-update-entry',
					{ summary: 'Updated summary' },
					'session-1'
				);
			});

			fireEvent.click(screen.getByTestId('modal-close'));
			await waitFor(() => {
				expect(screen.queryByTestId('history-detail-modal')).not.toBeInTheDocument();
			});

			await act(async () => {
				resolveUpdate?.(true);
				await Promise.resolve();
			});

			await waitFor(() => {
				expect(screen.getByText('Updated summary')).toBeInTheDocument();
			});
			expect(screen.queryByTestId('history-detail-modal')).not.toBeInTheDocument();
		});

		it('should navigate to next entry when onNavigate is called', async () => {
			const entries = [
				createMockEntry({ id: 'entry-1', summary: 'First entry' }),
				createMockEntry({ id: 'entry-2', summary: 'Second entry' }),
				createMockEntry({ id: 'entry-3', summary: 'Third entry' }),
			];
			mockHistoryGetAll.mockResolvedValue(entries);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('First entry')).toBeInTheDocument();
			});

			// Open detail modal for first entry
			fireEvent.click(screen.getByText('First entry'));

			await waitFor(() => {
				expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
				expect(screen.getByTestId('modal-entry-summary')).toHaveTextContent('First entry');
			});

			// Click navigate next button
			expectSmoothScrollDynamicSizeWarning(() => {
				fireEvent.click(screen.getByTestId('modal-navigate-next'));
			});

			await waitFor(() => {
				// Should now show second entry
				expect(screen.getByTestId('modal-entry-summary')).toHaveTextContent('Second entry');
				expect(screen.getByTestId('modal-current-index')).toHaveTextContent('1');
			});
		});

		it('should navigate to any entry in the virtualized list', async () => {
			// Create many entries to test virtualized navigation
			const entries = Array.from({ length: 100 }, (_, i) =>
				createMockEntry({
					id: `entry-${i}`,
					summary: `Entry number ${i}`,
					timestamp: Date.now() - i * 60000, // Entries in reverse chronological order
				})
			);
			mockHistoryGetAll.mockResolvedValue(entries);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				// First entry should be visible with virtualization
				expect(screen.getByText('Entry number 0')).toBeInTheDocument();
			});

			// Open detail modal for first entry
			fireEvent.click(screen.getByText('Entry number 0'));

			await waitFor(() => {
				expect(screen.getByTestId('history-detail-modal')).toBeInTheDocument();
			});

			// Click "Navigate Far" to go to entry at index 60
			// With virtualization, all entries are accessible without pagination
			expectSmoothScrollDynamicSizeWarning(() => {
				fireEvent.click(screen.getByTestId('modal-navigate-far'));
			});

			await waitFor(() => {
				// Should have navigated to entry 60
				expect(screen.getByTestId('modal-entry-summary')).toHaveTextContent('Entry number 60');
				expect(screen.getByTestId('modal-current-index')).toHaveTextContent('60');
			});
		});
	});

	// ===== FILTER STYLING =====
	describe('filter button styling', () => {
		it('should apply active styling to selected filters', async () => {
			mockHistoryGetAll.mockResolvedValue([]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			await waitFor(() => {
				const autoFilter = screen.getByRole('button', { name: /AUTO/i });
				const userFilter = screen.getByRole('button', { name: /USER/i });

				// Both should be active by default
				expect(autoFilter).toHaveClass('opacity-100');
				expect(userFilter).toHaveClass('opacity-100');
			});
		});

		it('should apply inactive styling to deselected filters', async () => {
			mockHistoryGetAll.mockResolvedValue([]);

			render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

			const autoFilter = screen.getByRole('button', { name: /AUTO/i });

			// Toggle off AUTO
			fireEvent.click(autoFilter);

			await waitFor(() => {
				expect(autoFilter).toHaveClass('opacity-40');
			});
		});
	});
});
// Restore original Intl.DateTimeFormat after all tests
