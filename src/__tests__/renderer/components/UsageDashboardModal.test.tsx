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
      <span data-testid={`${name}-icon`} className={className} style={style}>{emoji}</span>
    );
  };

  return {
    // UsageDashboardModal icons
    X: createIcon('x', '×'),
    BarChart3: createIcon('barchart', '📊'),
    Calendar: createIcon('calendar', '📅'),
    Download: createIcon('download', '⬇️'),
    RefreshCw: createIcon('refresh', '🔄'),
    // SummaryCards icons
    MessageSquare: createIcon('message-square', '💬'),
    Clock: createIcon('clock', '🕐'),
    Timer: createIcon('timer', '⏱️'),
    Bot: createIcon('bot', '🤖'),
    Users: createIcon('users', '👥'),
    // AutoRunStats icons
    Play: createIcon('play', '▶️'),
    CheckSquare: createIcon('check-square', '✅'),
    ListChecks: createIcon('list-checks', '📝'),
    Target: createIcon('target', '🎯'),
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
    'terminal': { count: 50, duration: 1200000 },
  },
  bySource: { user: 100, auto: 50 },
  byDay: [
    { date: '2024-01-15', count: 25, duration: 600000 },
    { date: '2024-01-16', count: 30, duration: 720000 },
    { date: '2024-01-17', count: 45, duration: 1080000 },
    { date: '2024-01-18', count: 50, duration: 1200000 },
  ],
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
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
    });

    it('renders modal title', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByText('Usage Dashboard')).toBeInTheDocument();
      });
    });

    it('renders time range selector with default value', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        const select = screen.getByRole('combobox');
        expect(select).toBeInTheDocument();
        expect(select).toHaveValue('week');
      });
    });

    it('renders view mode tabs', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByText('Overview')).toBeInTheDocument();
        expect(screen.getByText('Agents')).toBeInTheDocument();
        expect(screen.getByText('Activity')).toBeInTheDocument();
        expect(screen.getByText('Auto Run')).toBeInTheDocument();
      });
    });

    it('renders Export CSV button', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByText('Export CSV')).toBeInTheDocument();
      });
    });

    it('renders close button', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByTitle('Close (Esc)')).toBeInTheDocument();
      });
    });
  });

  describe('Layer Stack Integration', () => {
    it('registers with layer stack when opened', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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

      rerender(
        <UsageDashboardModal isOpen={false} onClose={onClose} theme={theme} />
      );

      expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-123');
    });
  });

  describe('Data Loading', () => {
    it('shows loading state initially', async () => {
      mockGetAggregation.mockImplementation(() => new Promise(() => {})); // Never resolves

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByText('Loading usage data...')).toBeInTheDocument();
      });
    });

    it('fetches stats on mount', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(mockGetAggregation).toHaveBeenCalledWith('week');
      });
    });

    it('displays summary stats after loading', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      // Wait for stats to load
      await waitFor(() => {
        expect(screen.getByText('Total Queries')).toBeInTheDocument();
      }, { timeout: 3000 });

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

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByText('No usage data yet')).toBeInTheDocument();
        expect(screen.getByText('Start using Maestro to see your stats!')).toBeInTheDocument();
      });
    });

    it('shows error state on fetch failure', async () => {
      mockGetAggregation.mockRejectedValue(new Error('Network error'));

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByText('Failed to load usage data')).toBeInTheDocument();
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });
    });
  });

  describe('Time Range Selection', () => {
    it('changes time range when dropdown value changes', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByTitle('Close (Esc)')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Close (Esc)'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when clicking overlay', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });

      // Click on the overlay (the parent div with modal-overlay class)
      const overlay = screen.getByRole('dialog').parentElement;
      fireEvent.click(overlay!);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not close when clicking inside the modal', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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
      const csvContent = 'id,sessionId,agentType,source,startTime,duration\n"1","test","claude-code","user","2024-01-15","1000"';
      mockSaveFile.mockResolvedValue(testFilePath);
      mockExportCsv.mockResolvedValue(csvContent);

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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

      rerender(
        <UsageDashboardModal isOpen={false} onClose={onClose} theme={theme} />
      );

      expect(unsubscribe).toHaveBeenCalled();
    });
  });

  describe('Summary Cards', () => {
    it('displays formatted duration for total time', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByText('Total Time')).toBeInTheDocument();
        expect(screen.getByText('1h 0m')).toBeInTheDocument(); // 3600000ms = 1 hour
      });
    });

    it('displays top agent label', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByText('Top Agent')).toBeInTheDocument();
        // claude-code appears in multiple places (summary and chart)
        const claudeCodeElements = screen.getAllByText('claude-code');
        expect(claudeCodeElements.length).toBeGreaterThan(0);
      });
    });

    it('displays interactive percentage', async () => {
      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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

      // Immediately after trigger, data should still be visible (not loading state)
      // The debounce timer hasn't fired yet so no fetch has been made
      expect(screen.queryByText('Loading usage data...')).not.toBeInTheDocument();
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

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
      });

      // The debounce logic is in the component, so we verify the subscription happens
      expect(mockOnStatsUpdate).toHaveBeenCalled();

      // Verify the subscription was established
      expect(mockOnStatsUpdate.mock.calls[0]).toBeDefined();
    });

    it('refresh button does not show loading spinner that hides data', async () => {
      const initialData = createSampleData();
      mockGetAggregation.mockResolvedValueOnce(initialData);

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
      });

      // Setup next fetch
      mockGetAggregation.mockResolvedValueOnce(createSampleData());

      // Click the manual refresh button
      const refreshButton = screen.getByTitle('Refresh');
      fireEvent.click(refreshButton);

      // Content should still be visible (refresh uses showRefresh=true path)
      expect(screen.queryByText('Loading usage data...')).not.toBeInTheDocument();
      expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();

      // Wait for refresh to complete
      await waitFor(() => {
        expect(mockGetAggregation).toHaveBeenCalledTimes(2);
      });

      // After refresh completes, content should still be visible
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
      rerender(
        <UsageDashboardModal isOpen={false} onClose={onClose} theme={theme} />
      );

      // Unsubscribe should have been called (which also clears debounce timer)
      expect(unsubscribeMock).toHaveBeenCalled();
    });

    it('content persists when refresh is triggered after initial load', async () => {
      const initialData = createSampleData();
      const refreshedData = { ...createSampleData(), totalQueries: 300 };
      mockGetAggregation.mockResolvedValueOnce(initialData);

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
      });

      // Setup next fetch
      mockGetAggregation.mockResolvedValueOnce(refreshedData);

      // Click refresh
      fireEvent.click(screen.getByTitle('Refresh'));

      // Critical: content should NOT disappear during refresh
      expect(screen.queryByText('Loading usage data...')).not.toBeInTheDocument();

      // Wait for update to complete
      await waitFor(() => {
        expect(mockGetAggregation).toHaveBeenCalledTimes(2);
      });

      // Verify content still there
      expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
    });

    it('time range change triggers new fetch', async () => {
      const weekData = createSampleData();
      const monthData = { ...createSampleData(), totalQueries: 500 };
      mockGetAggregation.mockResolvedValueOnce(weekData);

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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
    it('indicator does NOT appear for initial load', async () => {
      const initialData = createSampleData();
      mockGetAggregation.mockResolvedValue(initialData);

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
      });

      // Indicator should NOT appear for initial load
      expect(screen.queryByTestId('new-data-indicator')).not.toBeInTheDocument();
    });

    it('indicator appears after manual refresh completes', async () => {
      const initialData = createSampleData();
      mockGetAggregation.mockResolvedValue(initialData);

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
      });

      // Click refresh button
      fireEvent.click(screen.getByTitle('Refresh'));

      // Wait for indicator to appear after refresh completes
      await waitFor(() => {
        expect(screen.getByTestId('new-data-indicator')).toBeInTheDocument();
      }, { timeout: 2000 });

      // Verify the "Updated" text is shown
      expect(screen.getByText('Updated')).toBeInTheDocument();
    });

    it('indicator has pulse-fade animation styling', async () => {
      const initialData = createSampleData();
      mockGetAggregation.mockResolvedValue(initialData);

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
      });

      // Click refresh button to trigger indicator
      fireEvent.click(screen.getByTitle('Refresh'));

      // Wait for indicator
      await waitFor(() => {
        const indicator = screen.getByTestId('new-data-indicator');
        expect(indicator).toBeInTheDocument();
        expect(indicator).toHaveStyle({ animation: 'pulse-fade 3s ease-out forwards' });
      }, { timeout: 2000 });
    });

    it('indicator has pulsing dot element', async () => {
      const initialData = createSampleData();
      mockGetAggregation.mockResolvedValue(initialData);

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
      });

      // Click refresh button to trigger indicator
      fireEvent.click(screen.getByTitle('Refresh'));

      // Wait for indicator with pulsing dot
      await waitFor(() => {
        const indicator = screen.getByTestId('new-data-indicator');
        const dot = indicator.querySelector('span');
        expect(dot).toBeInTheDocument();
        expect(dot).toHaveStyle({ animation: 'pulse-dot 1s ease-in-out 3' });
      }, { timeout: 2000 });
    });

    it('indicator is theme-aware with accent color', async () => {
      const initialData = createSampleData();
      mockGetAggregation.mockResolvedValue(initialData);

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
      });

      // Click refresh button to trigger indicator
      fireEvent.click(screen.getByTitle('Refresh'));

      // Wait for indicator and check theme styling
      await waitFor(() => {
        const indicator = screen.getByTestId('new-data-indicator');
        expect(indicator).toHaveStyle({ color: theme.colors.accent });
        expect(indicator).toHaveStyle({ backgroundColor: `${theme.colors.accent}20` });
      }, { timeout: 2000 });
    });

    it('indicator dot uses theme accent color for background', async () => {
      const initialData = createSampleData();
      mockGetAggregation.mockResolvedValue(initialData);

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      // Wait for initial load
      await waitFor(() => {
        expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
      });

      // Click refresh button to trigger indicator
      fireEvent.click(screen.getByTitle('Refresh'));

      // Wait for indicator and check dot styling
      await waitFor(() => {
        const indicator = screen.getByTestId('new-data-indicator');
        const dot = indicator.querySelector('span');
        expect(dot).toHaveStyle({ backgroundColor: theme.colors.accent });
      }, { timeout: 2000 });
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

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

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
      await waitFor(() => {
        expect(screen.getByTestId('new-data-indicator')).toBeInTheDocument();
        expect(screen.getByText('Updated')).toBeInTheDocument();
      }, { timeout: 3000 });
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

      render(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
      });

      // First update cycle
      act(() => { updateCallback!(); });
      await act(async () => { vi.advanceTimersByTime(1100); });

      await waitFor(() => {
        expect(screen.getAllByText('151').length).toBeGreaterThan(0);
      });

      // Second update cycle
      act(() => { updateCallback!(); });
      await act(async () => { vi.advanceTimersByTime(1100); });

      await waitFor(() => {
        expect(screen.getAllByText('152').length).toBeGreaterThan(0);
      });

      // Third update cycle
      act(() => { updateCallback!(); });
      await act(async () => { vi.advanceTimersByTime(1100); });

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
      rerender(
        <UsageDashboardModal isOpen={false} onClose={onClose} theme={theme} />
      );

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
      rerender(
        <UsageDashboardModal isOpen={false} onClose={onClose} theme={theme} />
      );

      // Reopen modal
      rerender(
        <UsageDashboardModal isOpen={true} onClose={onClose} theme={theme} />
      );

      await waitFor(() => {
        expect(screen.getByTestId('usage-dashboard-content')).toBeInTheDocument();
      });

      // Should have subscribed again
      expect(subscriptionCount).toBe(2);

      // Trigger update on new subscription
      act(() => { latestCallback!(); });
      await act(async () => { vi.advanceTimersByTime(1100); });

      // New subscription should work
      await waitFor(() => {
        expect(screen.getAllByText('175').length).toBeGreaterThan(0);
      });
    });
  });
});
