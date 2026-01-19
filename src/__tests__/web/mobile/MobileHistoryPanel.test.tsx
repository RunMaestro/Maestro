/**
 * Tests for MobileHistoryPanel component
 *
 * A full-screen view displaying history entries from the desktop app.
 * Features list view of entries, filter by type, and tap to view details.
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing component
vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#404040',
		accent: '#007acc',
		success: '#4caf50',
		warning: '#ff9800',
		error: '#f44336',
	}),
}));

vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: {
		tap: [10],
		success: [10, 50, 10],
		error: [50, 50, 50],
		send: [20],
		interrupt: [50],
	},
	GESTURE_THRESHOLDS: {
		swipeDistance: 50,
		swipeTime: 300,
		pullToRefresh: 80,
		longPress: 500,
	},
}));

vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../web/utils/config', () => ({
	buildApiUrl: vi.fn((path: string) => `http://localhost:8080${path}`),
}));

import MobileHistoryPanel, {
	HistoryEntry,
	HistoryEntryType,
	MobileHistoryPanelProps,
} from '../../../web/mobile/MobileHistoryPanel';
import { triggerHaptic, HAPTIC_PATTERNS } from '../../../web/mobile/constants';
import { webLogger } from '../../../web/utils/logger';
import { buildApiUrl } from '../../../web/utils/config';

// Test utilities
function createMockEntry(overrides?: Partial<HistoryEntry>): HistoryEntry {
	return {
		id: 'entry-1',
		type: 'USER',
		timestamp: Date.now(),
		summary: 'Test summary for this entry',
		projectPath: '/path/to/project',
		...overrides,
	};
}

// Helper to get filter buttons (they have aria-pressed attribute)
function getFilterButton(filterName: 'All' | 'AUTO' | 'USER'): HTMLElement {
	const filterButtons = screen
		.getAllByRole('button')
		.filter((btn) => btn.hasAttribute('aria-pressed'));
	const button = filterButtons.find((btn) => btn.textContent?.includes(filterName));
	if (!button) throw new Error(`Filter button "${filterName}" not found`);
	return button;
}

function createAutoEntry(overrides?: Partial<HistoryEntry>): HistoryEntry {
	return createMockEntry({
		type: 'AUTO',
		success: true,
		elapsedTimeMs: 5000,
		usageStats: {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadInputTokens: 100,
			cacheCreationInputTokens: 50,
			totalCostUsd: 0.05,
			contextWindow: 128000,
		},
		...overrides,
	});
}

describe('MobileHistoryPanel', () => {
	let originalFetch: typeof global.fetch;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		originalFetch = global.fetch;

		// Default mock for fetch - returns empty entries
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ entries: [] }),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		global.fetch = originalFetch;
	});

	describe('Type exports', () => {
		it('exports HistoryEntryType type', () => {
			const autoType: HistoryEntryType = 'AUTO';
			const userType: HistoryEntryType = 'USER';
			expect(autoType).toBe('AUTO');
			expect(userType).toBe('USER');
		});

		it('exports HistoryEntry interface', () => {
			const entry: HistoryEntry = createMockEntry();
			expect(entry.id).toBeDefined();
			expect(entry.type).toBeDefined();
			expect(entry.timestamp).toBeDefined();
			expect(entry.summary).toBeDefined();
			expect(entry.projectPath).toBeDefined();
		});

		it('exports MobileHistoryPanelProps interface', () => {
			const props: MobileHistoryPanelProps = {
				onClose: vi.fn(),
				projectPath: '/test/path',
				sessionId: 'session-123',
			};
			expect(props.onClose).toBeDefined();
		});
	});

	describe('Initial render and API fetch', () => {
		it('renders header with title "History"', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
		});

		it('renders Done button in header', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByRole('button', { name: 'Close history' })).toBeInTheDocument();
		});

		it('renders filter pills (All, AUTO, USER)', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByRole('button', { name: /All/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /AUTO/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /USER/i })).toBeInTheDocument();
		});

		it('calls buildApiUrl with correct path on mount', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(buildApiUrl).toHaveBeenCalledWith('/history');
		});

		it('includes projectPath in API query params', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} projectPath="/test/project" />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(buildApiUrl).toHaveBeenCalledWith('/history?projectPath=%2Ftest%2Fproject');
		});

		it('includes sessionId in API query params', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} sessionId="session-123" />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(buildApiUrl).toHaveBeenCalledWith('/history?sessionId=session-123');
		});

		it('includes both projectPath and sessionId in query params', async () => {
			render(
				<MobileHistoryPanel onClose={vi.fn()} projectPath="/test/project" sessionId="session-123" />
			);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(buildApiUrl).toHaveBeenCalledWith(
				'/history?projectPath=%2Ftest%2Fproject&sessionId=session-123'
			);
		});

		it('fetches entries from API on mount', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(global.fetch).toHaveBeenCalledWith('http://localhost:8080/history');
		});
	});

	describe('Loading state', () => {
		it('shows loading message while fetching', async () => {
			// Make fetch hang
			global.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			expect(screen.getByText('Loading history...')).toBeInTheDocument();
		});
	});

	describe('Error state', () => {
		it('displays error message on fetch failure', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('Network error')).toBeInTheDocument();
		});

		it('displays error for non-ok response', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				statusText: 'Internal Server Error',
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText(/Failed to fetch history/)).toBeInTheDocument();
		});

		it('shows "Make sure the desktop app is running" on error', async () => {
			global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('Make sure the desktop app is running')).toBeInTheDocument();
		});

		it('logs error via webLogger', async () => {
			const error = new Error('Test error');
			global.fetch = vi.fn().mockRejectedValue(error);

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(webLogger.error).toHaveBeenCalledWith(
				'Failed to fetch history',
				'MobileHistory',
				error
			);
		});
	});

	describe('Empty state', () => {
		it('shows empty message when no entries', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries: [] }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('No history entries')).toBeInTheDocument();
		});

		it('shows hint for empty "all" filter', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries: [] }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText(/Run batch tasks or use \/history/)).toBeInTheDocument();
		});

		it('shows filter-specific empty message', async () => {
			const entries = [createMockEntry({ type: 'USER' })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Click AUTO filter
			fireEvent.click(getFilterButton('AUTO'));

			expect(screen.getByText(/No AUTO entries found/)).toBeInTheDocument();
		});
	});

	describe('Entry list rendering', () => {
		it('renders USER entries correctly', async () => {
			const entries = [
				createMockEntry({
					id: 'user-1',
					summary: 'User command summary',
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('User command summary')).toBeInTheDocument();
			// USER appears in both filter button and entry type badge
			const userTexts = screen.getAllByText('USER');
			expect(userTexts.length).toBeGreaterThanOrEqual(2);
		});

		it('renders AUTO entries with success indicator', async () => {
			const entries = [
				createAutoEntry({
					id: 'auto-1',
					summary: 'Auto run summary',
					success: true,
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('Auto run summary')).toBeInTheDocument();
			// AUTO appears in both filter button and entry type badge
			const autoTexts = screen.getAllByText('AUTO');
			expect(autoTexts.length).toBeGreaterThanOrEqual(2);
			expect(screen.getByTitle('Task completed successfully')).toBeInTheDocument();
		});

		it('renders AUTO entries with failure indicator', async () => {
			const entries = [
				createAutoEntry({
					id: 'auto-fail',
					summary: 'Failed task',
					success: false,
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByTitle('Task failed')).toBeInTheDocument();
		});

		it('renders Claude session ID octet', async () => {
			const entries = [
				createMockEntry({
					agentSessionId: 'abc12345-def6-7890-ghij-klmnopqrstuv',
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// First octet in uppercase
			expect(screen.getByText('ABC12345')).toBeInTheDocument();
		});

		it('renders elapsed time for entries with elapsedTimeMs', async () => {
			const entries = [
				createAutoEntry({
					elapsedTimeMs: 65000, // 1m 5s
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('1m 5s')).toBeInTheDocument();
		});

		it('renders cost for entries with usageStats', async () => {
			const entries = [
				createAutoEntry({
					usageStats: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.25,
						contextWindow: 128000,
					},
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('$0.25')).toBeInTheDocument();
		});

		it('shows "No summary available" for entries without summary', async () => {
			const entries = [
				createMockEntry({
					summary: '',
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('No summary available')).toBeInTheDocument();
		});

		it('logs successful fetch count via webLogger.debug', async () => {
			const entries = [createMockEntry({ id: 'e1' }), createMockEntry({ id: 'e2' })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(webLogger.debug).toHaveBeenCalledWith('Fetched 2 history entries', 'MobileHistory');
		});
	});

	describe('Filter functionality', () => {
		const mixedEntries = [
			createMockEntry({ id: 'user-1', type: 'USER', summary: 'User entry 1' }),
			createAutoEntry({ id: 'auto-1', summary: 'Auto entry 1' }),
			createMockEntry({ id: 'user-2', type: 'USER', summary: 'User entry 2' }),
			createAutoEntry({ id: 'auto-2', summary: 'Auto entry 2' }),
		];

		beforeEach(() => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries: mixedEntries }),
			});
		});

		it('shows all entries by default', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('User entry 1')).toBeInTheDocument();
			expect(screen.getByText('Auto entry 1')).toBeInTheDocument();
			expect(screen.getByText('User entry 2')).toBeInTheDocument();
			expect(screen.getByText('Auto entry 2')).toBeInTheDocument();
		});

		it('filters to AUTO entries only', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(getFilterButton('AUTO'));

			expect(screen.queryByText('User entry 1')).not.toBeInTheDocument();
			expect(screen.getByText('Auto entry 1')).toBeInTheDocument();
			expect(screen.queryByText('User entry 2')).not.toBeInTheDocument();
			expect(screen.getByText('Auto entry 2')).toBeInTheDocument();
		});

		it('filters to USER entries only', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(getFilterButton('USER'));

			expect(screen.getByText('User entry 1')).toBeInTheDocument();
			expect(screen.queryByText('Auto entry 1')).not.toBeInTheDocument();
			expect(screen.getByText('User entry 2')).toBeInTheDocument();
			expect(screen.queryByText('Auto entry 2')).not.toBeInTheDocument();
		});

		it('returns to all entries when "All" filter is clicked', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// First filter to AUTO
			fireEvent.click(getFilterButton('AUTO'));
			// Then back to All
			fireEvent.click(getFilterButton('All'));

			expect(screen.getByText('User entry 1')).toBeInTheDocument();
			expect(screen.getByText('Auto entry 1')).toBeInTheDocument();
		});

		it('shows correct counts on filter pills', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// All filter should show 4
			expect(getFilterButton('All')).toHaveTextContent('4');
			// AUTO filter should show 2
			expect(getFilterButton('AUTO')).toHaveTextContent('2');
			// USER filter should show 2
			expect(getFilterButton('USER')).toHaveTextContent('2');
		});

		it('triggers haptic feedback on filter change', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(getFilterButton('AUTO'));

			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('marks active filter with aria-pressed', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const allFilter = getFilterButton('All');
			expect(allFilter).toHaveAttribute('aria-pressed', 'true');

			fireEvent.click(getFilterButton('AUTO'));

			expect(allFilter).toHaveAttribute('aria-pressed', 'false');
			expect(getFilterButton('AUTO')).toHaveAttribute('aria-pressed', 'true');
		});
	});

	describe('Entry selection and detail view', () => {
		it('opens detail view when entry is clicked', async () => {
			const entries = [
				createMockEntry({
					id: 'entry-1',
					summary: 'Click me',
					fullResponse: 'Full response content here',
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Click the entry
			const entryButton = screen.getByRole('button', { name: /USER entry from/i });
			fireEvent.click(entryButton);

			// Detail view should show full response
			expect(screen.getByText('Full response content here')).toBeInTheDocument();
		});

		it('triggers haptic on entry click', async () => {
			const entries = [createMockEntry()];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const entryButton = screen.getByRole('button', { name: /USER entry from/i });
			fireEvent.click(entryButton);

			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('shows "Done" button in detail view', async () => {
			const entries = [createMockEntry({ fullResponse: 'Content' })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /USER entry from/i }));

			expect(screen.getByRole('button', { name: 'Close detail view' })).toBeInTheDocument();
		});

		it('closes detail view when Done is clicked', async () => {
			const entries = [createMockEntry({ fullResponse: 'Full content' })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Open detail
			fireEvent.click(screen.getByRole('button', { name: /USER entry from/i }));
			expect(screen.getByText('Full content')).toBeInTheDocument();

			// Close detail
			fireEvent.click(screen.getByRole('button', { name: 'Close detail view' }));

			// Full content should be hidden (detail view closed)
			// But summary is still visible in list
			expect(screen.queryByText('Full content')).not.toBeInTheDocument();
		});

		it('triggers haptic when closing detail view', async () => {
			const entries = [createMockEntry({ fullResponse: 'Content' })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /USER entry from/i }));
			vi.clearAllMocks();

			fireEvent.click(screen.getByRole('button', { name: 'Close detail view' }));

			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('closes detail view on Escape key', async () => {
			const entries = [createMockEntry({ fullResponse: 'Full content' })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /USER entry from/i }));
			expect(screen.getByText('Full content')).toBeInTheDocument();

			fireEvent.keyDown(document, { key: 'Escape' });

			expect(screen.queryByText('Full content')).not.toBeInTheDocument();
		});
	});

	describe('Detail view content', () => {
		it('strips ANSI codes from response', async () => {
			const entries = [
				createMockEntry({
					fullResponse: '\x1b[32mGreen text\x1b[0m and \x1b[31mred text\x1b[0m',
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /USER entry from/i }));

			expect(screen.getByText('Green text and red text')).toBeInTheDocument();
		});

		it('uses summary when fullResponse is not available', async () => {
			const entries = [
				createMockEntry({
					summary: 'Summary as content',
					fullResponse: undefined,
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /USER entry from/i }));

			// In detail view, summary is used
			const preElements = document.querySelectorAll('pre');
			const found = Array.from(preElements).some((pre) =>
				pre.textContent?.includes('Summary as content')
			);
			expect(found).toBe(true);
		});

		it('shows context usage percentage', async () => {
			const entries = [
				createAutoEntry({
					contextUsage: 75,
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /AUTO entry from/i }));

			expect(screen.getByText('75%')).toBeInTheDocument();
		});

		it('shows elapsed time in detail view', async () => {
			const entries = [
				createAutoEntry({
					elapsedTimeMs: 125000, // 2m 5s
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /AUTO entry from/i }));

			// Elapsed time appears in both list (behind detail) and detail view
			const elapsedElements = screen.getAllByText('2m 5s');
			expect(elapsedElements.length).toBeGreaterThanOrEqual(1);
		});

		it('shows token counts in detail view', async () => {
			const entries = [
				createAutoEntry({
					usageStats: {
						inputTokens: 1500,
						outputTokens: 750,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0.1,
						contextWindow: 128000,
					},
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /AUTO entry from/i }));

			expect(screen.getByText('In: 1,500')).toBeInTheDocument();
			expect(screen.getByText('Out: 750')).toBeInTheDocument();
		});

		it('shows cost in detail view', async () => {
			const entries = [
				createAutoEntry({
					usageStats: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 1.23,
						contextWindow: 128000,
					},
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /AUTO entry from/i }));

			// Cost appears in both list (behind detail) and detail view
			const costElements = screen.getAllByText('$1.23');
			expect(costElements.length).toBeGreaterThanOrEqual(1);
		});

		it('shows Claude session ID in detail view', async () => {
			const entries = [
				createMockEntry({
					agentSessionId: 'xyz98765-abc-def-ghi-jklmnop',
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /USER entry from/i }));

			// Should show in both list and detail views
			const sessionIdElements = screen.getAllByText('XYZ98765');
			expect(sessionIdElements.length).toBeGreaterThanOrEqual(1);
		});

		it('shows success indicator in detail view for AUTO', async () => {
			const entries = [
				createAutoEntry({
					success: true,
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /AUTO entry from/i }));

			// Should have checkmark indicator in detail view header
			const successIndicators = screen.getAllByTitle('Task completed successfully');
			expect(successIndicators.length).toBeGreaterThanOrEqual(1);
		});

		it('shows failure indicator in detail view for AUTO', async () => {
			const entries = [
				createAutoEntry({
					success: false,
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /AUTO entry from/i }));

			const failureIndicators = screen.getAllByTitle('Task failed');
			expect(failureIndicators.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('Close button and Escape key', () => {
		it('calls onClose when Done button is clicked', async () => {
			const onClose = vi.fn();
			render(<MobileHistoryPanel onClose={onClose} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: 'Close history' }));

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('triggers haptic when Done button is clicked', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: 'Close history' }));

			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('calls onClose on Escape key when no detail view', async () => {
			const onClose = vi.fn();
			render(<MobileHistoryPanel onClose={onClose} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.keyDown(document, { key: 'Escape' });

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('does not call onClose on Escape when detail view is open', async () => {
			const onClose = vi.fn();
			const entries = [createMockEntry({ fullResponse: 'Content' })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={onClose} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Open detail view
			fireEvent.click(screen.getByRole('button', { name: /USER entry from/i }));

			// Escape should close detail view, not the panel
			fireEvent.keyDown(document, { key: 'Escape' });

			expect(onClose).not.toHaveBeenCalled();
		});

		it('cleans up keyboard event listener on unmount', async () => {
			const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

			const { unmount } = render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			unmount();

			expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
			removeEventListenerSpy.mockRestore();
		});
	});

	describe('Context usage color coding', () => {
		it('shows green for context usage < 70%', async () => {
			const entries = [createAutoEntry({ contextUsage: 50 })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /AUTO entry from/i }));

			const percentElement = screen.getByText('50%');
			expect(percentElement).toHaveStyle({ color: '#4caf50' }); // success color
		});

		it('shows orange/warning for context usage >= 70% and < 90%', async () => {
			const entries = [createAutoEntry({ contextUsage: 75 })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /AUTO entry from/i }));

			const percentElement = screen.getByText('75%');
			expect(percentElement).toHaveStyle({ color: '#ff9800' }); // warning color
		});

		it('shows red/error for context usage >= 90%', async () => {
			const entries = [createAutoEntry({ contextUsage: 95 })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			fireEvent.click(screen.getByRole('button', { name: /AUTO entry from/i }));

			const percentElement = screen.getByText('95%');
			expect(percentElement).toHaveStyle({ color: '#f44336' }); // error color
		});
	});

	describe('formatElapsedTime (tested via component)', () => {
		it('formats milliseconds', async () => {
			const entries = [createAutoEntry({ elapsedTimeMs: 500 })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('500ms')).toBeInTheDocument();
		});

		it('formats seconds', async () => {
			const entries = [createAutoEntry({ elapsedTimeMs: 45000 })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('45s')).toBeInTheDocument();
		});

		it('formats minutes and seconds', async () => {
			const entries = [createAutoEntry({ elapsedTimeMs: 185000 })]; // 3m 5s
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('3m 5s')).toBeInTheDocument();
		});

		it('formats hours and minutes', async () => {
			const entries = [createAutoEntry({ elapsedTimeMs: 7380000 })]; // 2h 3m
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('2h 3m')).toBeInTheDocument();
		});
	});

	describe('formatTime (tested via component)', () => {
		it('formats today timestamp as time only', async () => {
			const now = new Date();
			const todayTimestamp = now.getTime();
			const entries = [createMockEntry({ timestamp: todayTimestamp })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Should show time in format like "2:30 PM" or "14:30" depending on locale
			const entryButton = screen.getByRole('button', { name: /USER entry from/i });
			expect(entryButton).toHaveTextContent(/\d{1,2}:\d{2}/);
		});

		it('formats past date with month and day', async () => {
			// A date from last year
			const pastDate = new Date('2023-06-15T10:30:00').getTime();
			const entries = [createMockEntry({ timestamp: pastDate })];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Should include month abbreviation
			const entryButton = screen.getByRole('button', { name: /USER entry from/i });
			expect(entryButton).toHaveTextContent(/Jun/);
		});
	});

	describe('Zero cost handling', () => {
		it('does not show cost when totalCostUsd is 0', async () => {
			const entries = [
				createAutoEntry({
					usageStats: {
						inputTokens: 100,
						outputTokens: 50,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 0,
						contextWindow: 128000,
					},
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// In list view, cost should not be shown
			expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
		});
	});

	describe('Edge cases', () => {
		it('handles null/undefined entries array', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries: null }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Should show empty state
			expect(screen.getByText('No history entries')).toBeInTheDocument();
		});

		it('handles missing entries field', async () => {
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({}),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('No history entries')).toBeInTheDocument();
		});

		it('handles unicode in summary', async () => {
			const entries = [
				createMockEntry({
					summary: 'Hello 世界! 🚀 Привет',
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('Hello 世界! 🚀 Привет')).toBeInTheDocument();
		});

		it('handles very long summary (truncation in card)', async () => {
			const longSummary = 'A'.repeat(500);
			const entries = [
				createMockEntry({
					summary: longSummary,
				}),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// The summary should be rendered (CSS handles truncation)
			expect(screen.getByText(longSummary)).toBeInTheDocument();
		});

		it('handles special characters in project path', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} projectPath="/path/with spaces/and&special" />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// URLSearchParams encodes space as + not %20
			expect(buildApiUrl).toHaveBeenCalledWith(
				'/history?projectPath=%2Fpath%2Fwith+spaces%2Fand%26special'
			);
		});

		it('handles AUTO entry without success field', async () => {
			const entries = [
				{
					...createAutoEntry(),
					success: undefined,
				},
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Should not show success/failure indicator
			expect(screen.queryByTitle('Task completed successfully')).not.toBeInTheDocument();
			expect(screen.queryByTitle('Task failed')).not.toBeInTheDocument();
		});

		it('handles rapid filter changes', async () => {
			const entries = [
				createMockEntry({ id: 'user-1', type: 'USER' }),
				createAutoEntry({ id: 'auto-1' }),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Rapidly change filters
			fireEvent.click(getFilterButton('AUTO'));
			fireEvent.click(getFilterButton('USER'));
			fireEvent.click(getFilterButton('All'));
			fireEvent.click(getFilterButton('AUTO'));

			// Final state should be AUTO filter active
			expect(getFilterButton('AUTO')).toHaveAttribute('aria-pressed', 'true');
		});

		it('handles multiple entries with same ID gracefully', async () => {
			const entries = [
				createMockEntry({ id: 'same-id', summary: 'First' }),
				createMockEntry({ id: 'same-id', summary: 'Second' }),
			];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			// Should not throw
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Both entries render (React keys may warn but shouldn't crash)
			expect(screen.getByText('First')).toBeInTheDocument();
			expect(screen.getByText('Second')).toBeInTheDocument();
		});
	});

	describe('Accessibility', () => {
		it('has aria-label on entry buttons', async () => {
			const entries = [createMockEntry()];
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ entries }),
			});

			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const entryButton = screen.getByRole('button', { name: /USER entry from/i });
			expect(entryButton).toHaveAttribute('aria-label');
		});

		it('has aria-pressed on filter buttons', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const allFilter = screen.getByRole('button', { name: /^All/i });
			expect(allFilter).toHaveAttribute('aria-pressed');
		});

		it('has aria-label on close button', async () => {
			render(<MobileHistoryPanel onClose={vi.fn()} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByRole('button', { name: 'Close history' })).toBeInTheDocument();
		});
	});

	describe('Default export', () => {
		it('exports MobileHistoryPanel as default', () => {
			expect(MobileHistoryPanel).toBeDefined();
			expect(typeof MobileHistoryPanel).toBe('function');
		});
	});
});
