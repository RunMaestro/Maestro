/**
 * Tests for AutoRunStats component
 *
 * Verifies:
 * - Renders all six metric cards correctly
 * - Displays formatted values (numbers, durations, percentages)
 * - Shows mini bar chart for tasks over time
 * - Handles loading, error, and empty states
 * - Applies theme colors properly
 * - Calculates derived metrics correctly (avg tasks/session, success rate)
 * - Tooltip shows on hover
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { AutoRunStats } from '../../../../renderer/components/UsageDashboard/AutoRunStats';
import { THEMES } from '../../../../shared/themes';

// Test theme
const theme = THEMES['dracula'];

// Mock Auto Run sessions data
const mockSessions = [
  {
    id: 'session-1',
    sessionId: 'maestro-1',
    agentType: 'claude-code',
    documentPath: '/project/TASKS.md',
    startTime: Date.now() - 3600000, // 1 hour ago
    duration: 1800000, // 30 minutes
    tasksTotal: 5,
    tasksCompleted: 4,
    projectPath: '/project',
  },
  {
    id: 'session-2',
    sessionId: 'maestro-2',
    agentType: 'claude-code',
    documentPath: '/project/TASKS.md',
    startTime: Date.now() - 7200000, // 2 hours ago
    duration: 2400000, // 40 minutes
    tasksTotal: 3,
    tasksCompleted: 3,
    projectPath: '/project',
  },
];

// Mock tasks data
const mockTasksSession1 = [
  {
    id: 'task-1',
    autoRunSessionId: 'session-1',
    sessionId: 'maestro-1',
    agentType: 'claude-code',
    taskIndex: 0,
    taskContent: 'Task 1',
    startTime: Date.now() - 3600000,
    duration: 300000, // 5 minutes
    success: true,
  },
  {
    id: 'task-2',
    autoRunSessionId: 'session-1',
    sessionId: 'maestro-1',
    agentType: 'claude-code',
    taskIndex: 1,
    taskContent: 'Task 2',
    startTime: Date.now() - 3300000,
    duration: 450000, // 7.5 minutes
    success: true,
  },
  {
    id: 'task-3',
    autoRunSessionId: 'session-1',
    sessionId: 'maestro-1',
    agentType: 'claude-code',
    taskIndex: 2,
    taskContent: 'Task 3',
    startTime: Date.now() - 2850000,
    duration: 200000,
    success: true,
  },
  {
    id: 'task-4',
    autoRunSessionId: 'session-1',
    sessionId: 'maestro-1',
    agentType: 'claude-code',
    taskIndex: 3,
    taskContent: 'Task 4',
    startTime: Date.now() - 2650000,
    duration: 350000,
    success: true,
  },
  {
    id: 'task-5',
    autoRunSessionId: 'session-1',
    sessionId: 'maestro-1',
    agentType: 'claude-code',
    taskIndex: 4,
    taskContent: 'Task 5 - failed',
    startTime: Date.now() - 2300000,
    duration: 180000,
    success: false,
  },
];

const mockTasksSession2 = [
  {
    id: 'task-6',
    autoRunSessionId: 'session-2',
    sessionId: 'maestro-2',
    agentType: 'claude-code',
    taskIndex: 0,
    taskContent: 'Task 1',
    startTime: Date.now() - 7200000,
    duration: 600000, // 10 minutes
    success: true,
  },
  {
    id: 'task-7',
    autoRunSessionId: 'session-2',
    sessionId: 'maestro-2',
    agentType: 'claude-code',
    taskIndex: 1,
    taskContent: 'Task 2',
    startTime: Date.now() - 6600000,
    duration: 480000,
    success: true,
  },
  {
    id: 'task-8',
    autoRunSessionId: 'session-2',
    sessionId: 'maestro-2',
    agentType: 'claude-code',
    taskIndex: 2,
    taskContent: 'Task 3',
    startTime: Date.now() - 6120000,
    duration: 420000,
    success: true,
  },
];

// Combined tasks for mocking
const allTasks = [...mockTasksSession1, ...mockTasksSession2];

// Mock window.maestro.stats API
const mockStatsApi = {
  getAutoRunSessions: vi.fn(),
  getAutoRunTasks: vi.fn(),
  onStatsUpdate: vi.fn(() => () => {}), // Returns unsubscribe function
};

beforeEach(() => {
  // Setup mock API
  (window as any).maestro = {
    stats: mockStatsApi,
  };

  // Reset all mocks
  vi.clearAllMocks();

  // Default successful responses
  mockStatsApi.getAutoRunSessions.mockResolvedValue(mockSessions);
  mockStatsApi.getAutoRunTasks.mockImplementation((sessionId: string) => {
    if (sessionId === 'session-1') return Promise.resolve(mockTasksSession1);
    if (sessionId === 'session-2') return Promise.resolve(mockTasksSession2);
    return Promise.resolve([]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AutoRunStats', () => {
  describe('Rendering', () => {
    it('renders the auto run stats container after loading', async () => {
      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByTestId('autorun-stats')).toBeInTheDocument();
      });
    });

    it('renders all six metric cards', async () => {
      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        const cards = screen.getAllByTestId('autorun-metric-card');
        expect(cards).toHaveLength(6);
      });
    });

    it('renders Total Sessions metric', async () => {
      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByText('Total Sessions')).toBeInTheDocument();
        expect(screen.getByText('2')).toBeInTheDocument();
      });
    });

    it('renders Tasks Done metric', async () => {
      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByText('Tasks Done')).toBeInTheDocument();
        // 7 successful tasks out of 8 total
        expect(screen.getByText('7')).toBeInTheDocument();
        expect(screen.getByText('of 8 attempted')).toBeInTheDocument();
      });
    });

    it('renders Avg Tasks/Session metric', async () => {
      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByText('Avg Tasks/Session')).toBeInTheDocument();
        // 7 successful tasks / 2 sessions = 3.5
        expect(screen.getByText('3.5')).toBeInTheDocument();
      });
    });

    it('renders Success Rate metric', async () => {
      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByText('Success Rate')).toBeInTheDocument();
        // 7 out of 8 = 87.5%, rounded to 88%
        expect(screen.getByText('88%')).toBeInTheDocument();
      });
    });

    it('renders Avg Session duration metric', async () => {
      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByText('Avg Session')).toBeInTheDocument();
        // Average of 30m and 40m = 35m
        expect(screen.getByText('35m 0s')).toBeInTheDocument();
      });
    });

    it('renders Avg Task duration metric', async () => {
      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByText('Avg Task')).toBeInTheDocument();
      });
    });

    it('renders tasks chart section', async () => {
      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByTestId('autorun-tasks-chart')).toBeInTheDocument();
        expect(screen.getByText('Tasks Completed Over Time')).toBeInTheDocument();
      });
    });
  });

  describe('Loading State', () => {
    it('shows loading state initially', async () => {
      // Make API slow
      mockStatsApi.getAutoRunSessions.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockSessions), 1000))
      );

      render(<AutoRunStats timeRange="week" theme={theme} />);

      expect(screen.getByTestId('autorun-stats-loading')).toBeInTheDocument();
      expect(screen.getByText('Loading Auto Run stats...')).toBeInTheDocument();
    });
  });

  describe('Error State', () => {
    it('shows error state when fetch fails', async () => {
      mockStatsApi.getAutoRunSessions.mockRejectedValue(new Error('API Error'));

      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByTestId('autorun-stats-error')).toBeInTheDocument();
        expect(screen.getByText('Failed to load Auto Run stats')).toBeInTheDocument();
      });
    });

    it('shows retry button on error', async () => {
      mockStatsApi.getAutoRunSessions.mockRejectedValue(new Error('API Error'));

      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });
    });

    it('retries fetch when retry button clicked', async () => {
      mockStatsApi.getAutoRunSessions
        .mockRejectedValueOnce(new Error('API Error'))
        .mockResolvedValueOnce(mockSessions);

      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Retry'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('autorun-stats')).toBeInTheDocument();
      });
    });
  });

  describe('Empty State', () => {
    it('shows empty state when no sessions exist', async () => {
      mockStatsApi.getAutoRunSessions.mockResolvedValue([]);

      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByTestId('autorun-stats-empty')).toBeInTheDocument();
        expect(screen.getByText('No Auto Run data yet')).toBeInTheDocument();
        expect(screen.getByText('Run some batch tasks to see your stats!')).toBeInTheDocument();
      });
    });
  });

  describe('Number Formatting', () => {
    it('formats thousands with K suffix', async () => {
      // Create many sessions
      const manySessions = Array.from({ length: 1500 }, (_, i) => ({
        ...mockSessions[0],
        id: `session-${i}`,
        duration: 60000,
      }));
      mockStatsApi.getAutoRunSessions.mockResolvedValue(manySessions);
      mockStatsApi.getAutoRunTasks.mockResolvedValue([]);

      render(<AutoRunStats timeRange="all" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByText('1.5K')).toBeInTheDocument();
      });
    });
  });

  describe('Duration Formatting', () => {
    it('formats hours and minutes correctly', async () => {
      const longSession = [{
        ...mockSessions[0],
        duration: 7200000, // 2 hours
      }];
      mockStatsApi.getAutoRunSessions.mockResolvedValue(longSession);
      mockStatsApi.getAutoRunTasks.mockResolvedValue([]);

      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByText('2h 0m')).toBeInTheDocument();
      });
    });

    it('formats seconds only correctly', async () => {
      const shortTasks = [{
        ...mockTasksSession1[0],
        duration: 45000, // 45 seconds
      }];
      mockStatsApi.getAutoRunSessions.mockResolvedValue([mockSessions[0]]);
      mockStatsApi.getAutoRunTasks.mockResolvedValue(shortTasks);

      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        // Avg task should be 45s
        expect(screen.getByText('45s')).toBeInTheDocument();
      });
    });
  });

  describe('Success Rate Calculation', () => {
    it('calculates 100% success rate correctly', async () => {
      const successfulTasks = mockTasksSession2; // All 3 successful
      mockStatsApi.getAutoRunSessions.mockResolvedValue([mockSessions[1]]);
      mockStatsApi.getAutoRunTasks.mockResolvedValue(successfulTasks);

      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByText('100%')).toBeInTheDocument();
      });
    });

    it('calculates 0% success rate correctly', async () => {
      const failedTasks = mockTasksSession1.map((t) => ({ ...t, success: false }));
      mockStatsApi.getAutoRunSessions.mockResolvedValue([mockSessions[0]]);
      mockStatsApi.getAutoRunTasks.mockResolvedValue(failedTasks);

      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByText('0%')).toBeInTheDocument();
      });
    });
  });

  describe('Tasks Chart', () => {
    it('renders task bars for each day', async () => {
      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        const chart = screen.getByTestId('autorun-tasks-chart');
        // Should have bars (might be combined into same day depending on test timing)
        expect(chart.querySelectorAll('[data-testid^="task-bar-"]').length).toBeGreaterThan(0);
      });
    });

    it('shows empty chart message when no tasks', async () => {
      mockStatsApi.getAutoRunSessions.mockResolvedValue([{
        ...mockSessions[0],
        tasksTotal: 0,
        tasksCompleted: 0,
      }]);
      mockStatsApi.getAutoRunTasks.mockResolvedValue([]);

      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(screen.getByText('No task data available')).toBeInTheDocument();
      });
    });
  });

  describe('Theme Support', () => {
    it('applies theme background color to metric cards', async () => {
      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        const cards = screen.getAllByTestId('autorun-metric-card');
        cards.forEach((card) => {
          expect(card).toHaveStyle({
            backgroundColor: theme.colors.bgMain,
          });
        });
      });
    });

    it('works with light theme', async () => {
      const lightTheme = THEMES['github-light'];
      render(<AutoRunStats timeRange="week" theme={lightTheme} />);

      await waitFor(() => {
        expect(screen.getByTestId('autorun-stats')).toBeInTheDocument();
        expect(screen.getByText('Total Sessions')).toBeInTheDocument();
      });
    });

    it('works with different dark themes', async () => {
      const nordTheme = THEMES['nord'];
      render(<AutoRunStats timeRange="week" theme={nordTheme} />);

      await waitFor(() => {
        expect(screen.getByTestId('autorun-stats')).toBeInTheDocument();
        const cards = screen.getAllByTestId('autorun-metric-card');
        cards.forEach((card) => {
          expect(card).toHaveStyle({
            backgroundColor: nordTheme.colors.bgMain,
          });
        });
      });
    });
  });

  describe('Icons', () => {
    it('renders SVG icons for each metric', async () => {
      const { container } = render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        const metrics = screen.getByTestId('autorun-metrics');
        const svgElements = metrics.querySelectorAll('svg');
        expect(svgElements.length).toBe(6);
      });
    });
  });

  describe('Grid Layout', () => {
    it('uses 6-column grid layout for metrics', async () => {
      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        const container = screen.getByTestId('autorun-metrics');
        expect(container).toHaveClass('grid-cols-6');
      });
    });
  });

  describe('Real-time Updates', () => {
    it('subscribes to stats updates', async () => {
      render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(mockStatsApi.onStatsUpdate).toHaveBeenCalled();
      });
    });

    it('unsubscribes on unmount', async () => {
      const unsubscribe = vi.fn();
      mockStatsApi.onStatsUpdate.mockReturnValue(unsubscribe);

      const { unmount } = render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(mockStatsApi.onStatsUpdate).toHaveBeenCalled();
      });

      unmount();

      expect(unsubscribe).toHaveBeenCalled();
    });
  });

  describe('Time Range Changes', () => {
    it('refetches data when time range changes', async () => {
      const { rerender } = render(<AutoRunStats timeRange="week" theme={theme} />);

      await waitFor(() => {
        expect(mockStatsApi.getAutoRunSessions).toHaveBeenCalledWith('week');
      });

      rerender(<AutoRunStats timeRange="month" theme={theme} />);

      await waitFor(() => {
        expect(mockStatsApi.getAutoRunSessions).toHaveBeenCalledWith('month');
      });
    });
  });
});
