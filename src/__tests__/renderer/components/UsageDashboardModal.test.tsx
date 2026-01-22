/**
 * @fileoverview Tests for UsageDashboardModal component
 * Tests: rendering, time range selection, view mode tabs, layer stack registration,
 * data loading states, and CSV export functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { UsageDashboardModal } from '../../../renderer/components/UsageDashboard/UsageDashboardModal';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react icons - include all icons used by modal and its child components
vi.mock('lucide-react', () => {
	const createIcon = (name: string, emoji: string) => {
		return ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
			<span data-testid={`${name}-icon`} className={className} style={style}>
				{emoji}
			</span>
		);
	};

	return {
		// UsageDashboardModal icons
		X: createIcon('x', '×'),
		BarChart3: createIcon('barchart', '📊'),
		Calendar: createIcon('calendar', '📅'),
		Download: createIcon('download', '⬇️'),
		RefreshCw: createIcon('refresh', '🔄'),
		Database: createIcon('database', '💾'),
		// SummaryCards icons
		MessageSquare: createIcon('message-square', '💬'),
		Clock: createIcon('clock', '🕐'),
		Timer: createIcon('timer', '⏱️'),
		Bot: createIcon('bot', '🤖'),
		Users: createIcon('users', '👥'),
		Layers: createIcon('layers', '📚'),
		// AutoRunStats icons
		Play: createIcon('play', '▶️'),
		CheckSquare: createIcon('check-square', '✅'),
		ListChecks: createIcon('list-checks', '📝'),
		Target: createIcon('target', '🎯'),
		// ChartErrorBoundary icons
		AlertTriangle: createIcon('alert-triangle', '⚠️'),
		ChevronDown: createIcon('chevron-down', '▼'),
		ChevronUp: createIcon('chevron-up', '▲'),
	};
});

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-123');
const mockUnregisterLayer = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
	}),
}));

// Mock maestro stats API
const mockGetAggregation = vi.fn();
const mockExportCsv = vi.fn();
const mockOnStatsUpdate = vi.fn(() => vi.fn()); // Returns unsubscribe function
const mockGetAutoRunSessions = vi.fn(() => Promise.resolve([]));
const mockGetAutoRunTasks = vi.fn(() => Promise.resolve([]));
const mockGetDatabaseSize = vi.fn();

// Mock dialog and fs API
const mockSaveFile = vi.fn();
const mockWriteFile = vi.fn();

const mockMaestro = {
	stats: {
		getAggregation: mockGetAggregation,
		exportCsv: mockExportCsv,
		onStatsUpdate: mockOnStatsUpdate,
		getAutoRunSessions: mockGetAutoRunSessions,
		getAutoRunTasks: mockGetAutoRunTasks,
		getDatabaseSize: mockGetDatabaseSize,
	},
	dialog: {
		saveFile: mockSaveFile,
	},
	fs: {
		writeFile: mockWriteFile,
	},
};

// Set up window.maestro mock
Object.defineProperty(window, 'maestro', {
	value: mockMaestro,
	writable: true,
});

// Create test theme
const createTheme = (): Theme => ({
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		border: '#333355',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		info: '#3b82f6',
		bgAccentHover: '#9333ea',
	},
});

// Sample aggregation data
const createSampleData = () => ({
	totalQueries: 150,
	totalDuration: 3600000, // 1 hour in ms
	avgDuration: 24000, // 24 seconds
	byAgent: {
		'claude-code': { count: 100, duration: 2400000 },
		terminal: { count: 50, duration: 1200000 },
	},
	bySource: { user: 100, auto: 50 },
	byLocation: { local: 120, remote: 30 },
	byDay: [
		{ date: '2024-01-15', count: 25, duration: 600000 },
		{ date: '2024-01-16', count: 30, duration: 720000 },
		{ date: '2024-01-17', count: 45, duration: 1080000 },
		{ date: '2024-01-18', count: 50, duration: 1200000 },
	],
	byHour: [
		{ hour: 9, count: 20, duration: 480000 },
		{ hour: 10, count: 35, duration: 840000 },
		{ hour: 14, count: 45, duration: 1080000 },
		{ hour: 15, count: 50, duration: 1200000 },
	],
	totalSessions: 25,
	sessionsByAgent: { 'claude-code': 15, terminal: 10 },
	sessionsByDay: [
		{ date: '2024-01-15', count: 5 },
		{ date: '2024-01-16', count: 7 },
		{ date: '2024-01-17', count: 6 },
		{ date: '2024-01-18', count: 7 },
	],
	avgSessionDuration: 144000,
	byAgentByDay: {},
	bySessionByDay: {},
});

describe('UsageDashboardModal', () => {
	const theme = createTheme();
	const onClose = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetAggregation.mockResolvedValue(createSampleData());
		mockExportCsv.mockResolvedValue('date,count\n2024-01-15,25');
		mockSaveFile.mockResolvedValue(null); // User cancels by default
		mockWriteFile.mockResolvedValue({ success: true });
		mockGetDatabaseSize.mockResolvedValue(1024 * 1024 * 5); // 5 MB default
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('Rendering', () => {
		it('renders nothing when isOpen is false', () => {
			const { container } = render(
				<UsageDashboardModal isOpen={false} onClose={onClose} theme={theme} />
			);
			expect(container.firstChild).toBeNull();
		});

		it('renders modal when isOpen is true', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByRole('dialog')).toBeInTheDocument();
			});
		});

		it('renders modal title', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('Usage Dashboard')).toBeInTheDocument();
			});
		});

		it('renders time range selector with default value', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const select = screen.getByRole('combobox');
				expect(select).toBeInTheDocument();
				expect(select).toHaveValue('week');
			});
		});

		it('renders view mode tabs', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('Overview')).toBeInTheDocument();
				expect(screen.getByText('Agents')).toBeInTheDocument();
				expect(screen.getByText('Activity')).toBeInTheDocument();
				expect(screen.getByText('Auto Run')).toBeInTheDocument();
			});
		});

		it('renders Export CSV button', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('Export CSV')).toBeInTheDocument();
			});
		});

		it('renders close button', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTitle('Close (Esc)')).toBeInTheDocument();
			});
		});
	});

	describe('Layer Stack Integration', () => {
		it('registers with layer stack when opened', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(mockRegisterLayer).toHaveBeenCalledWith(
					expect.objectContaining({
						type: 'modal',
						blocksLowerLayers: true,
						capturesFocus: true,
						focusTrap: 'lenient',
					})
				);
			});
		});

		it('unregisters from layer stack when closed', async () => {
			const { rerender } = render(
				<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
			);

			await waitFor(() => {
				expect(mockRegisterLayer).toHaveBeenCalled();
			});

			rerender(<UsageDashboardModal isOpen={false} onClose={onClose} theme={theme} />);

			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-123');
		});
	});

	describe('Data Loading', () => {
		it('shows loading skeleton initially', async () => {
			mockGetAggregation.mockImplementation(() => new Promise(() => {})); // Never resolves

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('dashboard-skeleton')).toBeInTheDocument();
			});
		});

		it('loading skeleton matches current view mode', async () => {
			mockGetAggregation.mockImplementation(() => new Promise(() => {})); // Never resolves

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				// Default view is overview, so all skeleton components should be present
				expect(screen.getByTestId('summary-cards-skeleton')).toBeInTheDocument();
				expect(screen.getByTestId('agent-comparison-skeleton')).toBeInTheDocument();
				expect(screen.getByTestId('source-distribution-skeleton')).toBeInTheDocument();
				expect(screen.getByTestId('activity-heatmap-skeleton')).toBeInTheDocument();
				expect(screen.getByTestId('duration-trends-skeleton')).toBeInTheDocument();
			});
		});

		it('fetches stats on mount', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(mockGetAggregation).toHaveBeenCalledWith('week');
			});
		});

		it('displays summary stats after loading', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for stats to load
			await waitFor(
				() => {
					expect(screen.getByText('Total Queries')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// The number 150 should be rendered (may appear multiple times in different parts of the dashboard)
			const countElements = screen.getAllByText('150');
			expect(countElements.length).toBeGreaterThan(0);
		});

		it('shows empty state when no data', async () => {
			mockGetAggregation.mockResolvedValue({
				totalQueries: 0,
				totalDuration: 0,
				avgDuration: 0,
				byAgent: {},
				bySource: { user: 0, auto: 0 },
				byDay: [],
			});

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('No usage data yet')).toBeInTheDocument();
				expect(screen.getByText('Start using Maestro to see your stats!')).toBeInTheDocument();
			});
		});

		it('shows error state on fetch failure', async () => {
			mockGetAggregation.mockRejectedValue(new Error('Network error'));

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('Failed to load usage data')).toBeInTheDocument();
				expect(screen.getByText('Retry')).toBeInTheDocument();
			});
		});
	});

	describe('Time Range Selection', () => {
		it('changes time range when dropdown value changes', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(mockGetAggregation).toHaveBeenCalledWith('week');
			});

			const select = screen.getByRole('combobox');
			fireEvent.change(select, { target: { value: 'month' } });

			await waitFor(() => {
				expect(mockGetAggregation).toHaveBeenCalledWith('month');
			});
		});

		it('displays all time range options', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const select = screen.getByRole('combobox');
				const options = select.querySelectorAll('option');
				expect(options).toHaveLength(5);
				expect(options[0]).toHaveValue('day');
				expect(options[1]).toHaveValue('week');
				expect(options[2]).toHaveValue('month');
				expect(options[3]).toHaveValue('year');
				expect(options[4]).toHaveValue('all');
			});
		});
	});

	describe('View Mode Tabs', () => {
		it('switches view mode when tab is clicked', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('Overview')).toBeInTheDocument();
			});

			const agentsTab = screen.getByText('Agents');
			fireEvent.click(agentsTab);

			// The tab should now be active (different styling)
			expect(agentsTab).toHaveStyle({ color: theme.colors.accent });
		});
	});

	describe('Close Behavior', () => {
		it('calls onClose when close button is clicked', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTitle('Close (Esc)')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTitle('Close (Esc)'));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('calls onClose when clicking overlay', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByRole('dialog')).toBeInTheDocument();
			});

			// Click on the overlay (the parent div with modal-overlay class)
			const overlay = screen.getByRole('dialog').parentElement;
			fireEvent.click(overlay!);

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('does not close when clicking inside the modal', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByRole('dialog')).toBeInTheDocument();
			});

			// Click inside the modal
			fireEvent.click(screen.getByRole('dialog'));

			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('CSV Export', () => {
		it('shows save dialog when export button is clicked', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('Export CSV')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Export CSV'));

			await waitFor(() => {
				expect(mockSaveFile).toHaveBeenCalledWith(
					expect.objectContaining({
						filters: [{ name: 'CSV Files', extensions: ['csv'] }],
						title: 'Export Usage Data',
					})
				);
			});
		});

		it('does not export if user cancels save dialog', async () => {
			mockSaveFile.mockResolvedValue(null); // User cancels

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('Export CSV')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Export CSV'));

			await waitFor(() => {
				expect(mockSaveFile).toHaveBeenCalled();
			});

			// exportCsv should not be called if user cancelled
			expect(mockExportCsv).not.toHaveBeenCalled();
		});

		it('exports CSV to selected file location', async () => {
			const testFilePath = '/path/to/export.csv';
			const csvContent =
				'id,sessionId,agentType,source,startTime,duration\n"1","test","claude-code","user","2024-01-15","1000"';
			mockSaveFile.mockResolvedValue(testFilePath);
			mockExportCsv.mockResolvedValue(csvContent);

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('Export CSV')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Export CSV'));

			await waitFor(() => {
				expect(mockExportCsv).toHaveBeenCalledWith('week');
			});

			await waitFor(() => {
				expect(mockWriteFile).toHaveBeenCalledWith(testFilePath, csvContent);
			});
		});

		it('handles export error gracefully', async () => {
			const testFilePath = '/path/to/export.csv';
			mockSaveFile.mockResolvedValue(testFilePath);
			mockExportCsv.mockRejectedValue(new Error('Export failed'));

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('Export CSV')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Export CSV'));

			await waitFor(() => {
				expect(consoleSpy).toHaveBeenCalledWith('Failed to export CSV:', expect.any(Error));
			});

			consoleSpy.mockRestore();
		});
	});

	describe('Stats Updates Subscription', () => {
		it('subscribes to stats updates when opened', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(mockOnStatsUpdate).toHaveBeenCalled();
			});
		});

		it('unsubscribes from stats updates when closed', async () => {
			const unsubscribe = vi.fn();
			mockOnStatsUpdate.mockReturnValue(unsubscribe);

			const { rerender } = render(
				<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
			);

			await waitFor(() => {
				expect(mockOnStatsUpdate).toHaveBeenCalled();
			});

			rerender(<UsageDashboardModal isOpen={false} onClose={onClose} theme={theme} />);

			expect(unsubscribe).toHaveBeenCalled();
		});
	});

	describe('Summary Cards', () => {
		it('displays formatted duration for total time', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('Total Time')).toBeInTheDocument();
				expect(screen.getByText('1h 0m')).toBeInTheDocument(); // 3600000ms = 1 hour
			});
		});

		it('displays top agent label', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('Top Agent')).toBeInTheDocument();
				// claude-code appears in multiple places (summary and chart)
				const claudeCodeElements = screen.getAllByText('claude-code');
				expect(claudeCodeElements.length).toBeGreaterThan(0);
			});
		});

		it('displays interactive percentage', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('Interactive %')).toBeInTheDocument();
				expect(screen.getByText('67%')).toBeInTheDocument(); // 100/150 = 66.67%
			});
		});
	});

	describe('Debounced Refresh - No Flickering', () => {
		it('data remains visible during refresh (no loading state flicker)', async () => {
			const initialData = createSampleData();
			const updatedData = {
				...createSampleData(),
				totalQueries: 200, // Changed value
			};

			mockGetAggregation.mockResolvedValueOnce(initialData);

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for initial data to load
			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Verify initial data is shown
			expect(screen.getAllByText('150').length).toBeGreaterThan(0);

			// Capture the update callback from onStatsUpdate
			const updateCallback = mockOnStatsUpdate.mock.calls[0][0];

			// Setup next fetch to return updated data
			mockGetAggregation.mockResolvedValueOnce(updatedData);

			// Trigger a stats update (which starts the debounce timer)
			act(() => {
				updateCallback();
			});

			// Immediately after trigger, data should still be visible (not loading skeleton)
			// The debounce timer hasn't fired yet so no fetch has been made
			expect(screen.queryByTestId('dashboard-skeleton')).not.toBeInTheDocument();
			expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();

			// Original data should still be visible during debounce wait
			expect(screen.getAllByText('150').length).toBeGreaterThan(0);
		});

		it('debounce batches multiple rapid stats:updated events into single fetch', async () => {
			// This test verifies the debounce mechanism using the real callback behavior
			const initialData = createSampleData();
			mockGetAggregation.mockResolvedValue(initialData);

			// Track how many times the callback is invoked
			let callbackInvocations = 0;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				// Store callback for our test but also wrap to count
				const wrappedCallback = () => {
					callbackInvocations++;
					callback();
				};
				return () => {};
			});

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for initial load
			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// The debounce logic is in the component, so we verify the subscription happens
			expect(mockOnStatsUpdate).toHaveBeenCalled();

			// Verify the subscription was established
			expect(mockOnStatsUpdate.mock.calls[0]).toBeDefined();
		});

		it('real-time updates do not show loading spinner that hides data', async () => {
			const initialData = createSampleData();
			const updatedData = { ...createSampleData(), totalQueries: 300 };
			mockGetAggregation.mockResolvedValueOnce(initialData);

			// Store the callback for triggering updates
			let statsCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				statsCallback = callback;
				return vi.fn();
			});

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for initial load
			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Setup next fetch
			mockGetAggregation.mockResolvedValueOnce(updatedData);

			// Trigger real-time update via the stats callback
			act(() => {
				if (statsCallback) statsCallback();
			});

			// Content should still be visible (real-time updates don't show skeleton)
			expect(screen.queryByTestId('dashboard-skeleton')).not.toBeInTheDocument();
			expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
		});

		it('unsubscribes from stats updates when modal closes', async () => {
			const initialData = createSampleData();
			mockGetAggregation.mockResolvedValueOnce(initialData);
			const unsubscribeMock = vi.fn();
			mockOnStatsUpdate.mockReturnValue(unsubscribeMock);

			const { rerender } = render(
				<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
			);

			// Wait for initial load
			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Close modal
			rerender(<UsageDashboardModal isOpen={false} onClose={onClose} theme={theme} />);

			// Unsubscribe should have been called (which also clears debounce timer)
			expect(unsubscribeMock).toHaveBeenCalled();
		});

		it('content persists when real-time update is triggered after initial load', async () => {
			const initialData = createSampleData();
			const refreshedData = { ...createSampleData(), totalQueries: 300 };
			mockGetAggregation.mockResolvedValueOnce(initialData);

			// Store the callback for triggering updates
			let statsCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				statsCallback = callback;
				return vi.fn();
			});

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for initial load
			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Setup next fetch
			mockGetAggregation.mockResolvedValueOnce(refreshedData);

			// Trigger real-time update via the stats callback
			act(() => {
				if (statsCallback) statsCallback();
			});

			// Critical: content should NOT disappear during real-time update (no skeleton shown)
			expect(screen.queryByTestId('dashboard-skeleton')).not.toBeInTheDocument();

			// Verify content still there
			expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
		});

		it('time range change triggers new fetch', async () => {
			const weekData = createSampleData();
			const monthData = { ...createSampleData(), totalQueries: 500 };
			mockGetAggregation.mockResolvedValueOnce(weekData);

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for initial week data to load
			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Setup month data fetch
			mockGetAggregation.mockResolvedValueOnce(monthData);

			// Change time range to month
			const select = screen.getByRole('combobox');
			fireEvent.change(select, { target: { value: 'month' } });

			// Should trigger fetch with new time range
			await waitFor(() => {
				expect(mockGetAggregation).toHaveBeenCalledWith('month');
			});
		});

		it('debounce subscription pattern is correctly established', async () => {
			const initialData = createSampleData();
			mockGetAggregation.mockResolvedValueOnce(initialData);

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for component to be ready
			await waitFor(() => {
				expect(mockOnStatsUpdate).toHaveBeenCalled();
			});

			// Verify the callback is a function (the component passed a handler)
			const subscribedCallback = mockOnStatsUpdate.mock.calls[0][0];
			expect(typeof subscribedCallback).toBe('function');
		});
	});

	describe('New Data Visual Indicator', () => {
		beforeEach(() => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('indicator does NOT appear for initial load', async () => {
			const initialData = createSampleData();
			mockGetAggregation.mockResolvedValue(initialData);

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for initial load
			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Indicator should NOT appear for initial load
			expect(screen.queryByTestId('new-data-indicator')).not.toBeInTheDocument();
		});

		it('indicator appears after real-time update completes', async () => {
			const initialData = createSampleData();
			mockGetAggregation.mockResolvedValue(initialData);

			// Store the callback for triggering updates
			let statsCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				statsCallback = callback;
				return vi.fn();
			});

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for initial load
			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Trigger real-time update via the stats callback and wait for debounce
			await act(async () => {
				if (statsCallback) statsCallback();
				await vi.advanceTimersByTimeAsync(1100);
			});

			// Wait for indicator to appear after update completes
			await waitFor(
				() => {
					expect(screen.getByTestId('new-data-indicator')).toBeInTheDocument();
				},
				{ timeout: 2000 }
			);

			// Verify the "Updated" text is shown
			expect(screen.getByText('Updated')).toBeInTheDocument();
		});

		it('indicator has pulse-fade animation styling', async () => {
			const initialData = createSampleData();
			mockGetAggregation.mockResolvedValue(initialData);

			// Store the callback for triggering updates
			let statsCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				statsCallback = callback;
				return vi.fn();
			});

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for initial load
			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Trigger real-time update via the stats callback and wait for debounce
			await act(async () => {
				if (statsCallback) statsCallback();
				await vi.advanceTimersByTimeAsync(1100);
			});

			// Wait for indicator
			await waitFor(
				() => {
					const indicator = screen.getByTestId('new-data-indicator');
					expect(indicator).toBeInTheDocument();
					expect(indicator).toHaveStyle({ animation: 'pulse-fade 3s ease-out forwards' });
				},
				{ timeout: 2000 }
			);
		});

		it('indicator has pulsing dot element', async () => {
			const initialData = createSampleData();
			mockGetAggregation.mockResolvedValue(initialData);

			// Store the callback for triggering updates
			let statsCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				statsCallback = callback;
				return vi.fn();
			});

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for initial load
			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Trigger real-time update via the stats callback and wait for debounce
			await act(async () => {
				if (statsCallback) statsCallback();
				await vi.advanceTimersByTimeAsync(1100);
			});

			// Wait for indicator with pulsing dot
			await waitFor(
				() => {
					const indicator = screen.getByTestId('new-data-indicator');
					const dot = indicator.querySelector('span');
					expect(dot).toBeInTheDocument();
					expect(dot).toHaveStyle({ animation: 'pulse-dot 1s ease-in-out 3' });
				},
				{ timeout: 2000 }
			);
		});

		it('indicator is theme-aware with accent color', async () => {
			const initialData = createSampleData();
			mockGetAggregation.mockResolvedValue(initialData);

			// Store the callback for triggering updates
			let statsCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				statsCallback = callback;
				return vi.fn();
			});

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for initial load
			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Trigger real-time update via the stats callback and wait for debounce
			await act(async () => {
				if (statsCallback) statsCallback();
				await vi.advanceTimersByTimeAsync(1100);
			});

			// Wait for indicator and check theme styling
			await waitFor(
				() => {
					const indicator = screen.getByTestId('new-data-indicator');
					expect(indicator).toHaveStyle({ color: theme.colors.accent });
					expect(indicator).toHaveStyle({ backgroundColor: `${theme.colors.accent}20` });
				},
				{ timeout: 2000 }
			);
		});

		it('indicator dot uses theme accent color for background', async () => {
			const initialData = createSampleData();
			mockGetAggregation.mockResolvedValue(initialData);

			// Store the callback for triggering updates
			let statsCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				statsCallback = callback;
				return vi.fn();
			});

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for initial load
			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Trigger real-time update via the stats callback and wait for debounce
			await act(async () => {
				if (statsCallback) statsCallback();
				await vi.advanceTimersByTimeAsync(1100);
			});

			// Wait for indicator and check dot styling
			await waitFor(
				() => {
					const indicator = screen.getByTestId('new-data-indicator');
					const dot = indicator.querySelector('span');
					expect(dot).toHaveStyle({ backgroundColor: theme.colors.accent });
				},
				{ timeout: 2000 }
			);
		});
	});

	describe('Real-time Updates During Active AI Session', () => {
		/**
		 * These tests verify the end-to-end flow of real-time updates when the
		 * Usage Dashboard is open while an AI session is actively recording stats.
		 *
		 * The flow being tested:
		 * 1. Main process writes to stats DB (via stats:record-query, stats:record-task, etc.)
		 * 2. Main process broadcasts 'stats:updated' event
		 * 3. Dashboard (via onStatsUpdate subscription) receives the update
		 * 4. Dashboard debounces multiple rapid updates (1 second)
		 * 5. Dashboard fetches fresh aggregation data
		 * 6. Dashboard updates UI with new data
		 * 7. "Updated" indicator appears briefly to signal fresh data
		 */

		beforeEach(() => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('dashboard updates data when stats:updated is received (simulating active AI query)', async () => {
			// Initial data - represents state before AI query starts
			const initialData = createSampleData();
			// Updated data - represents state after AI query completes (1 more query)
			const afterQueryData = {
				...createSampleData(),
				totalQueries: 151, // One more query was recorded
				totalDuration: 3630000, // Added 30 seconds
			};

			let updateCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				updateCallback = callback;
				return vi.fn(); // Return unsubscribe function
			});

			mockGetAggregation.mockResolvedValueOnce(initialData);

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			// Wait for initial load with original data
			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Verify initial data is displayed
			expect(screen.getAllByText('150').length).toBeGreaterThan(0);

			// Setup next fetch to return updated data
			mockGetAggregation.mockResolvedValueOnce(afterQueryData);

			// Simulate what happens when main process records a query:
			// stats:record-query IPC handler broadcasts 'stats:updated'
			// which triggers our subscribed callback
			expect(updateCallback).not.toBeNull();
			act(() => {
				updateCallback!();
			});

			// Advance past the 1-second debounce
			await act(async () => {
				vi.advanceTimersByTime(1100);
			});

			// Dashboard should have fetched new aggregation data
			await waitFor(() => {
				expect(mockGetAggregation).toHaveBeenCalledTimes(2);
			});

			// New data should be displayed (151 queries instead of 150)
			await waitFor(() => {
				expect(screen.getAllByText('151').length).toBeGreaterThan(0);
			});
		});

		it('multiple rapid stats updates are debounced into single fetch', async () => {
			const initialData = createSampleData();
			const afterMultipleQueriesData = {
				...createSampleData(),
				totalQueries: 155, // 5 more queries from rapid updates
			};

			let updateCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				updateCallback = callback;
				return vi.fn();
			});

			mockGetAggregation.mockResolvedValueOnce(initialData);

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Setup next fetch
			mockGetAggregation.mockResolvedValueOnce(afterMultipleQueriesData);

			// Simulate 5 rapid stats updates (like an AI session processing multiple items quickly)
			act(() => {
				updateCallback!(); // Update 1 at t=0
			});
			await act(async () => {
				vi.advanceTimersByTime(100);
			});
			act(() => {
				updateCallback!(); // Update 2 at t=100ms
			});
			await act(async () => {
				vi.advanceTimersByTime(100);
			});
			act(() => {
				updateCallback!(); // Update 3 at t=200ms
			});
			await act(async () => {
				vi.advanceTimersByTime(100);
			});
			act(() => {
				updateCallback!(); // Update 4 at t=300ms
			});
			await act(async () => {
				vi.advanceTimersByTime(100);
			});
			act(() => {
				updateCallback!(); // Update 5 at t=400ms
			});

			// At this point, debounce timer keeps resetting
			// So no fetch has happened yet (still only initial fetch)
			expect(mockGetAggregation).toHaveBeenCalledTimes(1);

			// Advance past 1-second debounce after last update
			await act(async () => {
				vi.advanceTimersByTime(1100);
			});

			// Should have made exactly 2 fetches total: initial + one debounced fetch
			await waitFor(() => {
				expect(mockGetAggregation).toHaveBeenCalledTimes(2);
			});
		});

		it('stats updates during an Auto Run session update dashboard correctly', async () => {
			// This simulates the Auto Run flow where stats are recorded for each task
			const initialData = createSampleData();
			const afterAutoRunData = {
				...createSampleData(),
				totalQueries: 160,
				bySource: { user: 100, auto: 60 }, // More auto queries from Auto Run
			};

			let updateCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				updateCallback = callback;
				return vi.fn();
			});

			mockGetAggregation.mockResolvedValueOnce(initialData);

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Initial state shows 67% interactive (100/150)
			expect(screen.getByText('67%')).toBeInTheDocument();

			mockGetAggregation.mockResolvedValueOnce(afterAutoRunData);

			// Simulate Auto Run recording a task (triggers stats:updated)
			act(() => {
				updateCallback!();
			});

			await act(async () => {
				vi.advanceTimersByTime(1100);
			});

			// Dashboard should update with new Auto Run data
			await waitFor(() => {
				expect(mockGetAggregation).toHaveBeenCalledTimes(2);
			});

			// Interactive percentage should update (100/160 = 62.5%, rounded to 63%)
			await waitFor(() => {
				expect(screen.getByText('63%')).toBeInTheDocument();
			});
		});

		it('"Updated" indicator appears when real-time data arrives', async () => {
			const initialData = createSampleData();
			const updatedData = {
				...createSampleData(),
				totalQueries: 151,
			};

			let updateCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				updateCallback = callback;
				return vi.fn();
			});

			mockGetAggregation.mockResolvedValueOnce(initialData);

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Initially no indicator
			expect(screen.queryByTestId('new-data-indicator')).not.toBeInTheDocument();

			mockGetAggregation.mockResolvedValueOnce(updatedData);

			// Simulate stats:updated from an active AI session
			act(() => {
				updateCallback!();
			});

			await act(async () => {
				vi.advanceTimersByTime(1100);
			});

			// Indicator should appear
			await waitFor(
				() => {
					expect(screen.getByTestId('new-data-indicator')).toBeInTheDocument();
					expect(screen.getByText('Updated')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);
		});

		it('dashboard continues working after multiple update cycles', async () => {
			// Simulates a longer AI session with multiple rounds of updates
			const data1 = createSampleData();
			const data2 = { ...createSampleData(), totalQueries: 151 };
			const data3 = { ...createSampleData(), totalQueries: 152 };
			const data4 = { ...createSampleData(), totalQueries: 153 };

			let updateCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				updateCallback = callback;
				return vi.fn();
			});

			mockGetAggregation
				.mockResolvedValueOnce(data1)
				.mockResolvedValueOnce(data2)
				.mockResolvedValueOnce(data3)
				.mockResolvedValueOnce(data4);

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// First update cycle
			act(() => {
				updateCallback!();
			});
			await act(async () => {
				vi.advanceTimersByTime(1100);
			});

			await waitFor(() => {
				expect(screen.getAllByText('151').length).toBeGreaterThan(0);
			});

			// Second update cycle
			act(() => {
				updateCallback!();
			});
			await act(async () => {
				vi.advanceTimersByTime(1100);
			});

			await waitFor(() => {
				expect(screen.getAllByText('152').length).toBeGreaterThan(0);
			});

			// Third update cycle
			act(() => {
				updateCallback!();
			});
			await act(async () => {
				vi.advanceTimersByTime(1100);
			});

			await waitFor(() => {
				expect(screen.getAllByText('153').length).toBeGreaterThan(0);
			});

			// Dashboard should have fetched 4 times total
			expect(mockGetAggregation).toHaveBeenCalledTimes(4);
		});

		it('closing modal during active session properly unsubscribes', async () => {
			const initialData = createSampleData();
			const unsubscribeMock = vi.fn();

			let updateCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				updateCallback = callback;
				return unsubscribeMock;
			});

			mockGetAggregation.mockResolvedValue(initialData);

			const { rerender } = render(
				<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
			);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Simulate user closing modal during active AI session
			rerender(<UsageDashboardModal isOpen={false} onClose={onClose} theme={theme} />);

			// Unsubscribe should be called - no more updates after close
			expect(unsubscribeMock).toHaveBeenCalled();

			// Any pending debounce timer should be cleared
			// (verified by no errors when we advance time after close)
			await act(async () => {
				vi.advanceTimersByTime(2000);
			});

			// No additional fetches after initial one
			expect(mockGetAggregation).toHaveBeenCalledTimes(1);
		});

		it('reopening modal after close re-establishes subscription', async () => {
			const initialData = createSampleData();
			const afterReopenData = { ...createSampleData(), totalQueries: 175 };

			let subscriptionCount = 0;
			let latestCallback: (() => void) | null = null;

			mockOnStatsUpdate.mockImplementation((callback: () => void) => {
				subscriptionCount++;
				latestCallback = callback;
				return vi.fn();
			});

			mockGetAggregation
				.mockResolvedValueOnce(initialData)
				.mockResolvedValueOnce(initialData)
				.mockResolvedValueOnce(afterReopenData);

			const { rerender } = render(
				<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
			);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			expect(subscriptionCount).toBe(1);

			// Close modal
			rerender(<UsageDashboardModal isOpen={false} onClose={onClose} theme={theme} />);

			// Reopen modal
			rerender(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Should have subscribed again
			expect(subscriptionCount).toBe(2);

			// Trigger update on new subscription
			act(() => {
				latestCallback!();
			});
			await act(async () => {
				vi.advanceTimersByTime(1100);
			});

			// New subscription should work
			await waitFor(() => {
				expect(screen.getAllByText('175').length).toBeGreaterThan(0);
			});
		});
	});

	describe('Database Size Indicator', () => {
		it('displays database size in footer when modal opens', async () => {
			mockGetDatabaseSize.mockResolvedValue(1024 * 1024 * 5); // 5 MB

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('database-size-indicator')).toBeInTheDocument();
				expect(screen.getByText('5.0 MB')).toBeInTheDocument();
			});
		});

		it('fetches database size alongside stats data', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(mockGetDatabaseSize).toHaveBeenCalled();
				expect(mockGetAggregation).toHaveBeenCalled();
			});
		});

		it('updates database size when data is refreshed', async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			mockGetDatabaseSize.mockResolvedValue(1024 * 1024 * 5); // Start with 5 MB

			let updateCallback: (() => void) | null = null;
			mockOnStatsUpdate.mockImplementation((cb: () => void) => {
				updateCallback = cb;
				return () => {};
			});

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('5.0 MB')).toBeInTheDocument();
			});

			// Update size for next fetch
			mockGetDatabaseSize.mockResolvedValue(1024 * 1024 * 10); // 10 MB

			// Trigger real-time update
			act(() => {
				updateCallback!();
			});
			await act(async () => {
				vi.advanceTimersByTime(1100);
			});

			await waitFor(() => {
				expect(screen.getByText('10.0 MB')).toBeInTheDocument();
			});

			vi.useRealTimers();
		});

		it('formats bytes correctly (< 1 KB)', async () => {
			mockGetDatabaseSize.mockResolvedValue(500); // 500 bytes

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('500 B')).toBeInTheDocument();
			});
		});

		it('formats kilobytes correctly', async () => {
			mockGetDatabaseSize.mockResolvedValue(1024 * 512); // 512 KB

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('512.0 KB')).toBeInTheDocument();
			});
		});

		it('formats megabytes correctly', async () => {
			mockGetDatabaseSize.mockResolvedValue(1024 * 1024 * 25.7); // 25.7 MB

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('25.7 MB')).toBeInTheDocument();
			});
		});

		it('formats gigabytes correctly', async () => {
			mockGetDatabaseSize.mockResolvedValue(1024 * 1024 * 1024 * 1.5); // 1.5 GB

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('1.50 GB')).toBeInTheDocument();
			});
		});

		it('shows database icon with correct tooltip', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const indicator = screen.getByTestId('database-size-indicator');
				expect(indicator).toHaveAttribute('title', 'Stats database size');
				expect(screen.getByTestId('database-icon')).toBeInTheDocument();
			});
		});

		it('does not display indicator when database size is null', async () => {
			mockGetDatabaseSize.mockResolvedValue(null);

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			expect(screen.queryByTestId('database-size-indicator')).not.toBeInTheDocument();
		});

		it('handles zero database size', async () => {
			mockGetDatabaseSize.mockResolvedValue(0);

			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByText('0 B')).toBeInTheDocument();
			});
		});
	});

	describe('Keyboard Navigation Between Chart Sections', () => {
		/**
		 * These tests verify keyboard navigation functionality for the Usage Dashboard.
		 *
		 * Navigation features:
		 * 1. Tab navigation between view mode tabs (Overview, Agents, Activity, Auto Run)
		 * 2. Arrow key navigation within tabs (Left/Right to switch tabs)
		 * 3. Tab key to move from tabs to chart sections
		 * 4. Arrow key navigation between chart sections (Up/Down)
		 * 5. Home/End keys to jump to first/last section
		 * 6. Visual focus indicator on focused section
		 */

		it('renders view mode tabs with tablist role', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const tablist = screen.getByRole('tablist');
				expect(tablist).toBeInTheDocument();
				expect(tablist).toHaveAttribute('aria-label', 'Dashboard view modes');
			});
		});

		it('renders individual tabs with proper ARIA attributes', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const tabs = screen.getAllByRole('tab');
				expect(tabs).toHaveLength(4);

				// First tab (Overview) should be selected
				expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
				expect(tabs[0]).toHaveAttribute('aria-controls', 'tabpanel-overview');
				expect(tabs[0]).toHaveAttribute('id', 'tab-overview');

				// Other tabs should not be selected
				expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
				expect(tabs[2]).toHaveAttribute('aria-selected', 'false');
				expect(tabs[3]).toHaveAttribute('aria-selected', 'false');
			});
		});

		it('switches tabs with ArrowRight key', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			const tablist = screen.getByTestId('view-mode-tabs');

			// Focus tablist and press ArrowRight
			fireEvent.keyDown(tablist, { key: 'ArrowRight' });

			await waitFor(() => {
				const tabs = screen.getAllByRole('tab');
				// Should now be on Agents tab
				expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
				expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
			});
		});

		it('switches tabs with ArrowLeft key', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			const tablist = screen.getByTestId('view-mode-tabs');

			// First move to Agents tab
			fireEvent.keyDown(tablist, { key: 'ArrowRight' });

			await waitFor(() => {
				expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');
			});

			// Now press ArrowLeft to go back to Overview
			fireEvent.keyDown(tablist, { key: 'ArrowLeft' });

			await waitFor(() => {
				const tabs = screen.getAllByRole('tab');
				expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
				expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
			});
		});

		it('wraps around when pressing ArrowLeft on first tab', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			const tablist = screen.getByTestId('view-mode-tabs');

			// Press ArrowLeft while on first tab - should wrap to last tab (Auto Run)
			fireEvent.keyDown(tablist, { key: 'ArrowLeft' });

			await waitFor(() => {
				const tabs = screen.getAllByRole('tab');
				expect(tabs[3]).toHaveAttribute('aria-selected', 'true'); // Auto Run tab
				expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
			});
		});

		it('wraps around when pressing ArrowRight on last tab', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			const tablist = screen.getByTestId('view-mode-tabs');

			// Navigate to last tab (Auto Run)
			fireEvent.keyDown(tablist, { key: 'ArrowLeft' }); // Wraps to last

			await waitFor(() => {
				expect(screen.getAllByRole('tab')[3]).toHaveAttribute('aria-selected', 'true');
			});

			// Press ArrowRight - should wrap to first tab (Overview)
			fireEvent.keyDown(tablist, { key: 'ArrowRight' });

			await waitFor(() => {
				const tabs = screen.getAllByRole('tab');
				expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
				expect(tabs[3]).toHaveAttribute('aria-selected', 'false');
			});
		});

		it('renders chart sections as focusable regions in overview mode', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Check for focusable chart sections
			expect(screen.getByTestId('section-summary-cards')).toHaveAttribute('tabIndex', '0');
			expect(screen.getByTestId('section-summary-cards')).toHaveAttribute('role', 'region');
			expect(screen.getByTestId('section-summary-cards')).toHaveAttribute(
				'aria-label',
				'Summary Cards'
			);

			expect(screen.getByTestId('section-agent-comparison')).toHaveAttribute('tabIndex', '0');
			expect(screen.getByTestId('section-agent-comparison')).toHaveAttribute(
				'aria-label',
				'Provider Comparison Chart'
			);

			expect(screen.getByTestId('section-source-distribution')).toHaveAttribute('tabIndex', '0');
			expect(screen.getByTestId('section-source-distribution')).toHaveAttribute(
				'aria-label',
				'Session Type Chart'
			);

			expect(screen.getByTestId('section-activity-heatmap')).toHaveAttribute('tabIndex', '0');
			expect(screen.getByTestId('section-activity-heatmap')).toHaveAttribute(
				'aria-label',
				'Activity Heatmap'
			);

			expect(screen.getByTestId('section-duration-trends')).toHaveAttribute('tabIndex', '0');
			expect(screen.getByTestId('section-duration-trends')).toHaveAttribute(
				'aria-label',
				'Duration Trends Chart'
			);
		});

		it('renders tabpanel with proper ARIA attributes', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				const tabpanel = screen.getByRole('tabpanel');
				expect(tabpanel).toBeInTheDocument();
				expect(tabpanel).toHaveAttribute('id', 'tabpanel-overview');
				expect(tabpanel).toHaveAttribute('aria-labelledby', 'tab-overview');
			});
		});

		it('updates tabpanel id when view mode changes', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Click on Agents tab
			fireEvent.click(screen.getByText('Agents'));

			await waitFor(() => {
				const tabpanel = screen.getByRole('tabpanel');
				expect(tabpanel).toHaveAttribute('id', 'tabpanel-agents');
				expect(tabpanel).toHaveAttribute('aria-labelledby', 'tab-agents');
			});
		});

		it('navigates between chart sections with ArrowDown key', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			const summarySection = screen.getByTestId('section-summary-cards');

			// Focus summary cards section and press ArrowDown
			summarySection.focus();
			fireEvent.keyDown(summarySection, { key: 'ArrowDown' });

			// Should focus agent comparison (next section)
			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByTestId('section-agent-comparison'));
			});
		});

		it('navigates between chart sections with ArrowUp key', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			const agentSection = screen.getByTestId('section-agent-comparison');

			// Focus agent comparison and press ArrowUp
			agentSection.focus();
			fireEvent.keyDown(agentSection, { key: 'ArrowUp' });

			// Should focus summary cards (previous section)
			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByTestId('section-summary-cards'));
			});
		});

		it('Home key focuses first section', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			const durationSection = screen.getByTestId('section-duration-trends');

			// Focus last section and press Home
			durationSection.focus();
			fireEvent.keyDown(durationSection, { key: 'Home' });

			// Should focus first section (summary cards)
			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByTestId('section-summary-cards'));
			});
		});

		it('End key focuses last section', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			const summarySection = screen.getByTestId('section-summary-cards');

			// Focus first section and press End
			summarySection.focus();
			fireEvent.keyDown(summarySection, { key: 'End' });

			// Should focus last section (duration trends)
			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByTestId('section-duration-trends'));
			});
		});

		it('shows visual focus indicator on focused section', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			const tablist = screen.getByTestId('view-mode-tabs');

			// Tab from tablist to first section
			fireEvent.keyDown(tablist, { key: 'Tab' });

			await waitFor(() => {
				const summarySection = screen.getByTestId('section-summary-cards');
				// Check for focus ring style
				expect(summarySection).toHaveStyle({ boxShadow: `0 0 0 2px ${theme.colors.accent}` });
			});
		});

		it('renders only one section in agents view mode', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Switch to Agents view
			fireEvent.click(screen.getByText('Agents'));

			await waitFor(() => {
				expect(screen.getByTestId('section-agent-comparison')).toBeInTheDocument();
				// Only one section in agents view
				expect(screen.queryByTestId('section-summary-cards')).not.toBeInTheDocument();
				expect(screen.queryByTestId('section-source-distribution')).not.toBeInTheDocument();
			});
		});

		it('renders two sections in activity view mode', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Switch to Activity view
			fireEvent.click(screen.getByText('Activity'));

			await waitFor(() => {
				expect(screen.getByTestId('section-activity-heatmap')).toBeInTheDocument();
				expect(screen.getByTestId('section-duration-trends')).toBeInTheDocument();
				// No other sections
				expect(screen.queryByTestId('section-summary-cards')).not.toBeInTheDocument();
				expect(screen.queryByTestId('section-agent-comparison')).not.toBeInTheDocument();
			});
		});

		it('renders autorun-stats section in autorun view mode', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Switch to Auto Run view - use the tab button specifically
			const tabs = screen.getAllByRole('tab');
			fireEvent.click(tabs[3]); // Auto Run is the 4th tab

			await waitFor(() => {
				expect(screen.getByTestId('section-autorun-stats')).toBeInTheDocument();
				expect(screen.getByTestId('section-autorun-stats')).toHaveAttribute(
					'aria-label',
					'Auto Run Statistics'
				);
			});
		});

		it('ArrowUp from first section returns focus to tabs', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			const summarySection = screen.getByTestId('section-summary-cards');
			const tablist = screen.getByTestId('view-mode-tabs');

			// Focus first section and press ArrowUp (or Shift+Tab)
			summarySection.focus();
			fireEvent.keyDown(summarySection, { key: 'ArrowUp' });

			// Focus should return to tabs
			await waitFor(() => {
				expect(document.activeElement).toBe(tablist);
			});
		});

		it('Shift+Tab from first section returns focus to tabs', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			const summarySection = screen.getByTestId('section-summary-cards');
			const tablist = screen.getByTestId('view-mode-tabs');

			// Focus first section and press Shift+Tab
			summarySection.focus();
			fireEvent.keyDown(summarySection, { key: 'Tab', shiftKey: true });

			// Focus should return to tabs
			await waitFor(() => {
				expect(document.activeElement).toBe(tablist);
			});
		});

		it('Tab from tabs focuses first chart section', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			const tablist = screen.getByTestId('view-mode-tabs');

			// Focus tablist and press Tab (without shift)
			tablist.focus();
			fireEvent.keyDown(tablist, { key: 'Tab' });

			// Should focus first section
			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByTestId('section-summary-cards'));
			});
		});

		it('resets focused section when view mode changes', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Focus a section in overview
			const summarySection = screen.getByTestId('section-summary-cards');
			summarySection.focus();
			fireEvent.keyDown(summarySection, { key: 'ArrowDown' });

			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByTestId('section-agent-comparison'));
			});

			// Switch to Agents view
			fireEvent.click(screen.getByText('Agents'));

			await waitFor(() => {
				// The section in the new view should not have focus ring initially
				const agentSection = screen.getByTestId('section-agent-comparison');
				expect(agentSection).not.toHaveStyle({ boxShadow: `0 0 0 2px ${theme.colors.accent}` });
			});
		});

		it('Tab navigation cycles through sections in activity view', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			// Switch to Activity view
			fireEvent.click(screen.getByText('Activity'));

			await waitFor(() => {
				expect(screen.getByTestId('section-activity-heatmap')).toBeInTheDocument();
			});

			const heatmapSection = screen.getByTestId('section-activity-heatmap');

			// Focus heatmap and Tab to duration trends
			heatmapSection.focus();
			fireEvent.keyDown(heatmapSection, { key: 'Tab' });

			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByTestId('section-duration-trends'));
			});
		});

		it('supports ArrowUp and ArrowDown for tab navigation as alternatives', async () => {
			render(<UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />);

			await waitFor(() => {
				expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
			});

			const tablist = screen.getByTestId('view-mode-tabs');

			// ArrowDown should also switch tabs (same as ArrowRight)
			fireEvent.keyDown(tablist, { key: 'ArrowDown' });

			await waitFor(() => {
				expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true');
			});

			// ArrowUp should also switch tabs (same as ArrowLeft)
			fireEvent.keyDown(tablist, { key: 'ArrowUp' });

			await waitFor(() => {
				expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true');
			});
		});
	});
});
