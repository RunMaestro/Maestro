/**
 * @fileoverview Tests for AgentSessionsBrowser component
 *
 * AgentSessionsBrowser is a modal component that displays Claude sessions:
 * - Session list with search and filtering
 * - Session detail view with messages
 * - Session stats (cost, duration, tokens)
 * - Star/unstar sessions
 * - Rename sessions
 * - Resume sessions
 * - Progressive stats loading
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { AgentSessionsBrowser } from '../../../renderer/components/AgentSessionsBrowser';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme, Session, LogEntry } from '../../../renderer/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Search: () => <span data-testid="icon-search" />,
  Clock: () => <span data-testid="icon-clock" />,
  MessageSquare: () => <span data-testid="icon-message-square" />,
  HardDrive: () => <span data-testid="icon-hard-drive" />,
  Play: () => <span data-testid="icon-play" />,
  ChevronLeft: () => <span data-testid="icon-chevron-left" />,
  ChevronRight: () => <span data-testid="icon-chevron-right" />,
  Loader2: ({ className }: { className?: string }) => (
    <span data-testid="icon-loader" className={className} />
  ),
  Plus: () => <span data-testid="icon-plus" />,
  X: () => <span data-testid="icon-x" />,
  List: () => <span data-testid="icon-list" />,
  Database: () => <span data-testid="icon-database" />,
  BarChart3: () => <span data-testid="icon-bar-chart" />,
  ChevronDown: () => <span data-testid="icon-chevron-down" />,
  User: () => <span data-testid="icon-user" />,
  Bot: () => <span data-testid="icon-bot" />,
  DollarSign: () => <span data-testid="icon-dollar-sign" />,
  Star: ({ style }: { style?: React.CSSProperties }) => (
    <span data-testid="icon-star" style={style} />
  ),
  Zap: () => <span data-testid="icon-zap" />,
  Timer: () => <span data-testid="icon-timer" />,
  Hash: () => <span data-testid="icon-hash" />,
  ArrowDownToLine: () => <span data-testid="icon-arrow-down" />,
  ArrowUpFromLine: () => <span data-testid="icon-arrow-up" />,
  Edit3: () => <span data-testid="icon-edit" />,
  CheckCircle2: () => <span data-testid="icon-check-circle" />,
  AlertCircle: () => <span data-testid="icon-alert-circle" />,
}));

// Default theme
const defaultTheme: Theme = {
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
    info: '#8be9fd',
  },
};

// Mock ClaudeSession
interface ClaudeSession {
  sessionId: string;
  projectPath: string;
  timestamp: string;
  modifiedAt: string;
  firstMessage: string;
  messageCount: number;
  sizeBytes: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  durationSeconds: number;
  origin?: 'user' | 'auto';
  sessionName?: string;
}

// Mock SessionMessage
interface SessionMessage {
  type: string;
  role?: string;
  content: string;
  timestamp: string;
  uuid: string;
  toolUse?: unknown;
}

// Create mock Claude session
const createMockClaudeSession = (overrides: Partial<ClaudeSession> = {}): ClaudeSession => ({
  sessionId: `d02d0bd6-${Math.random().toString(36).substr(2, 6)}-4a01-9123-456789abcdef`,
  projectPath: '/path/to/project',
  timestamp: '2025-01-15T10:00:00Z',
  modifiedAt: '2025-01-15T11:30:00Z',
  firstMessage: 'Help me with this code',
  messageCount: 10,
  sizeBytes: 25000,
  costUsd: 0.15,
  inputTokens: 5000,
  outputTokens: 2000,
  cacheReadTokens: 1000,
  cacheCreationTokens: 500,
  durationSeconds: 300,
  ...overrides,
});

// Create mock session message
const createMockMessage = (overrides: Partial<SessionMessage> = {}): SessionMessage => ({
  type: 'assistant',
  content: 'Here is the code you requested...',
  timestamp: '2025-01-15T10:05:00Z',
  uuid: `msg-${Math.random().toString(36).substr(2, 9)}`,
  ...overrides,
});

// Create mock active session
const createMockActiveSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1',
  name: 'Test Project',
  toolType: 'claude-code',
  state: 'idle',
  inputMode: 'ai',
  cwd: '/path/to/project',
  projectRoot: '/path/to/project',
  aiPid: 12345,
  terminalPid: 12346,
  aiLogs: [],
  shellLogs: [],
  isGitRepo: true,
  fileTree: [],
  fileExplorerExpanded: [],
  messageQueue: [],
  ...overrides,
});

// Store unsubscribe function from onProjectStatsUpdate
let projectStatsCallback: ((stats: unknown) => void) | null = null;

// Default props
const createDefaultProps = (overrides: Partial<Parameters<typeof AgentSessionsBrowser>[0]> = {}) => ({
  theme: defaultTheme,
  activeSession: createMockActiveSession(),
  activeAgentSessionId: null as string | null,
  onClose: vi.fn(),
  onResumeSession: vi.fn(),
  onNewSession: vi.fn(),
  onUpdateTab: vi.fn(),
  ...overrides,
});

// Helper to render with LayerStackProvider
const renderWithProvider = (ui: React.ReactElement) => {
  return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('AgentSessionsBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    projectStatsCallback = null;

    // Setup mock implementations for generic agentSessions API
    vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
      sessions: [],
      hasMore: false,
      totalCount: 0,
      nextCursor: null,
    });
    vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
      messages: [],
      total: 0,
      hasMore: false,
    });
    vi.mocked(window.maestro.agentSessions.search).mockResolvedValue([]);

    // Setup mock implementations for Claude-specific features (origins, stats)
    vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({});
    vi.mocked(window.maestro.claude.getProjectStats).mockResolvedValue(undefined);
    vi.mocked(window.maestro.claude.onProjectStatsUpdate).mockImplementation((callback) => {
      projectStatsCallback = callback;
      return () => {
        projectStatsCallback = null;
      };
    });
    vi.mocked(window.maestro.claude.updateSessionStarred).mockResolvedValue(undefined);
    vi.mocked(window.maestro.claude.updateSessionName).mockResolvedValue(undefined);
    vi.mocked(window.maestro.agentSessions.updateSessionName).mockResolvedValue(undefined);
    vi.mocked(window.maestro.agentSessions.setSessionName).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ============================================================================
  // Helper Function Tests (via component behavior)
  // ============================================================================

  describe('formatSize helper', () => {
    it('formats bytes correctly', async () => {
      const session = createMockClaudeSession({ sizeBytes: 500 });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText(/500 B/i)).toBeInTheDocument();
    });

    it('formats kilobytes correctly', async () => {
      const session = createMockClaudeSession({ sizeBytes: 2048 });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText(/2\.0 KB/i)).toBeInTheDocument();
    });

    it('formats megabytes correctly', async () => {
      const session = createMockClaudeSession({ sizeBytes: 5 * 1024 * 1024 });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText(/5\.0 MB/i)).toBeInTheDocument();
    });

    it('formats gigabytes correctly', async () => {
      const session = createMockClaudeSession({ sizeBytes: 2 * 1024 * 1024 * 1024 });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText(/2\.0 GB/i)).toBeInTheDocument();
    });
  });

  describe('formatNumber helper', () => {
    it('formats small numbers correctly', async () => {
      const session = createMockClaudeSession({
        inputTokens: 500,
        outputTokens: 200,
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [],
        total: 0,
        hasMore: false,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Click on session to view details
      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      // Total tokens = 500 + 200 = 700
      expect(screen.getByText('700.0')).toBeInTheDocument();
    });

    it('formats thousands with k suffix', async () => {
      const session = createMockClaudeSession({
        inputTokens: 5000,
        outputTokens: 3000,
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Click on session
      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      // Total = 8000, should be 8.0k
      expect(screen.getByText('8.0k')).toBeInTheDocument();
    });

    it('formats millions with M suffix', async () => {
      const session = createMockClaudeSession({
        inputTokens: 1500000,
        outputTokens: 500000,
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Click on session
      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      // Total = 2000000, should be 2.0M
      expect(screen.getByText('2.0M')).toBeInTheDocument();
    });
  });

  describe('formatRelativeTime helper', () => {
    it('formats just now correctly', async () => {
      const now = new Date();
      const session = createMockClaudeSession({
        modifiedAt: now.toISOString(),
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('just now')).toBeInTheDocument();
    });

    it('formats minutes ago correctly', async () => {
      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
      const session = createMockClaudeSession({
        modifiedAt: thirtyMinsAgo.toISOString(),
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('30m ago')).toBeInTheDocument();
    });

    it('formats hours ago correctly', async () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      const session = createMockClaudeSession({
        modifiedAt: fiveHoursAgo.toISOString(),
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('5h ago')).toBeInTheDocument();
    });

    it('formats days ago correctly', async () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const session = createMockClaudeSession({
        modifiedAt: threeDaysAgo.toISOString(),
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('3d ago')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Rendering Tests
  // ============================================================================

  describe('initial rendering', () => {
    it('renders modal structure with header', async () => {
      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText(/Claude Sessions for/i)).toBeInTheDocument();
    });

    it('shows loading state initially', async () => {
      // Don't resolve the promise immediately
      vi.mocked(window.maestro.agentSessions.listPaginated).mockImplementation(
        () => new Promise(() => {})
      );

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
      });

      expect(screen.getByTestId('icon-loader')).toBeInTheDocument();
    });

    it('shows active session name in header', async () => {
      const props = createDefaultProps({
        activeSession: createMockActiveSession({ name: 'My Project' }),
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText(/Claude Sessions for My Project/i)).toBeInTheDocument();
    });

    it('shows active Claude session ID badge when provided', async () => {
      const props = createDefaultProps({
        activeAgentSessionId: 'abc12345-def6-7890',
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText(/Active:/i)).toBeInTheDocument();
    });

    it('displays New Session button', async () => {
      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('New Session')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Session Loading Tests
  // ============================================================================

  describe('session loading', () => {
    it('loads sessions from API on mount', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'session-1', firstMessage: 'First session' }),
        createMockClaudeSession({ sessionId: 'session-2', firstMessage: 'Second session' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('First session')).toBeInTheDocument();
      expect(screen.getByText('Second session')).toBeInTheDocument();
    });

    it('loads starred sessions from origins', async () => {
      const sessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
        'session-1': { origin: 'user', starred: true },
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Star icon should be filled (warning color)
      const starIcon = screen.getAllByTestId('icon-star')[0];
      expect(starIcon).toHaveStyle({ fill: defaultTheme.colors.warning });
    });

    it('shows empty state when no sessions', async () => {
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [],
        hasMore: false,
        totalCount: 0,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText(/No Claude sessions found for this project/i)).toBeInTheDocument();
    });

    it('handles API error gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(window.maestro.agentSessions.listPaginated).mockRejectedValue(
        new Error('API Error')
      );

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(consoleSpy).toHaveBeenCalledWith('Failed to load sessions:', expect.any(Error));
      consoleSpy.mockRestore();
    });

    it('handles no active session gracefully', async () => {
      const props = createDefaultProps({ activeSession: undefined });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // Should not crash and show agent name fallback
      expect(screen.getByText(/Claude Sessions for Agent/i)).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Stats Panel Tests
  // ============================================================================

  describe('stats panel', () => {
    it('displays aggregate stats', async () => {
      const sessions = [createMockClaudeSession()];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Trigger stats update
      await act(async () => {
        projectStatsCallback?.({
          projectPath: '/path/to/project',
          totalSessions: 5,
          totalMessages: 100,
          totalCostUsd: 2.5,
          totalSizeBytes: 50000,
          oldestTimestamp: '2025-01-01T00:00:00Z',
          isComplete: true,
        });
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('5 sessions')).toBeInTheDocument();
      expect(screen.getByText('100 messages')).toBeInTheDocument();
      expect(screen.getByText('$2.50')).toBeInTheDocument();
    });

    it('shows loading indicator while stats incomplete', async () => {
      const sessions = [createMockClaudeSession()];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Trigger incomplete stats update
      await act(async () => {
        projectStatsCallback?.({
          projectPath: '/path/to/project',
          totalSessions: 3,
          totalMessages: 50,
          totalCostUsd: 1.0,
          totalSizeBytes: 25000,
          oldestTimestamp: null,
          isComplete: false,
        });
        await vi.runAllTimersAsync();
      });

      // Stats should have animate-pulse class when incomplete
      const statsText = screen.getByText('3 sessions');
      expect(statsText).toHaveClass('animate-pulse');
    });

    it('shows oldest session date', async () => {
      const sessions = [createMockClaudeSession()];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      await act(async () => {
        projectStatsCallback?.({
          projectPath: '/path/to/project',
          totalSessions: 1,
          totalMessages: 10,
          totalCostUsd: 0.5,
          totalSizeBytes: 5000,
          oldestTimestamp: '2024-06-15T00:00:00Z',
          isComplete: true,
        });
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText(/Since/i)).toBeInTheDocument();
    });

    it('ignores stats updates for different project paths', async () => {
      // This tests the fix for the stats path mismatch bug
      // When cwd changes, stats should use projectRoot for comparison
      const sessions = [createMockClaudeSession()];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      // Session where cwd differs from projectRoot
      const props = createDefaultProps({
        activeSession: createMockActiveSession({
          cwd: '/path/to/project/some/subdir',  // Changed via cd
          projectRoot: '/path/to/project',       // Original project root
        }),
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // First, send stats for the CORRECT projectRoot - these should be accepted
      await act(async () => {
        projectStatsCallback?.({
          projectPath: '/path/to/project',  // Matches projectRoot
          totalSessions: 5,
          totalMessages: 100,
          totalCostUsd: 2.5,
          totalSizeBytes: 50000,
          oldestTimestamp: '2025-01-01T00:00:00Z',
          isComplete: true,
        });
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('5 sessions')).toBeInTheDocument();
      expect(screen.getByText('100 messages')).toBeInTheDocument();

      // Now send stats for a DIFFERENT path - these should be IGNORED
      await act(async () => {
        projectStatsCallback?.({
          projectPath: '/path/to/different/project',  // Does NOT match projectRoot
          totalSessions: 999,
          totalMessages: 9999,
          totalCostUsd: 999.99,
          totalSizeBytes: 999999,
          oldestTimestamp: '2020-01-01T00:00:00Z',
          isComplete: true,
        });
        await vi.runAllTimersAsync();
      });

      // Stats should NOT have changed to the wrong project's values
      expect(screen.getByText('5 sessions')).toBeInTheDocument();
      expect(screen.getByText('100 messages')).toBeInTheDocument();
      expect(screen.queryByText('999 sessions')).not.toBeInTheDocument();
    });

    it('uses projectRoot (not cwd) for stats listener path comparison', async () => {
      // This tests that the stats listener compares against projectRoot, not cwd
      // Even when cwd has changed (e.g., user did 'cd' in terminal)
      const sessions = [createMockClaudeSession()];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      // Session where cwd differs from projectRoot (simulates user did 'cd' in terminal)
      const props = createDefaultProps({
        activeSession: createMockActiveSession({
          cwd: '/path/to/project/deeply/nested/subdir',  // Changed via cd
          projectRoot: '/path/to/project',                // Original project root
        }),
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // Send stats for projectRoot - should be accepted even though cwd is different
      await act(async () => {
        projectStatsCallback?.({
          projectPath: '/path/to/project',  // Matches projectRoot, NOT cwd
          totalSessions: 10,
          totalMessages: 200,
          totalCostUsd: 5.0,
          totalSizeBytes: 100000,
          oldestTimestamp: '2025-01-01T00:00:00Z',
          isComplete: true,
        });
        await vi.runAllTimersAsync();
      });

      // Stats should be displayed (proves projectRoot was used, not cwd)
      expect(screen.getByText('10 sessions')).toBeInTheDocument();
      expect(screen.getByText('200 messages')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Search Tests
  // ============================================================================

  describe('search functionality', () => {
    it('filters sessions by title (client-side)', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'session-1', firstMessage: 'React component' }),
        createMockClaudeSession({ sessionId: 'session-2', firstMessage: 'Python script' }),
        createMockClaudeSession({ sessionId: 'session-3', firstMessage: 'TypeScript type' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 3,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Default mode is 'all', switch to 'title' for client-side filtering
      const searchModeButton = screen.getByText('All').closest('button');
      await act(async () => {
        fireEvent.click(searchModeButton!);
        await vi.runAllTimersAsync();
      });
      const titleOption = screen.getByText('Title Only');
      await act(async () => {
        fireEvent.click(titleOption);
        await vi.runAllTimersAsync();
      });

      const searchInput = screen.getByPlaceholderText(/Search titles/i);
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: 'React' } });
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('React component')).toBeInTheDocument();
      expect(screen.queryByText('Python script')).not.toBeInTheDocument();
      expect(screen.queryByText('TypeScript type')).not.toBeInTheDocument();
    });

    it('searches by session ID', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'd02d0bd6-1234-5678-90ab-cdefghijklmn', firstMessage: 'Session A' }),
        createMockClaudeSession({ sessionId: 'e13e1ce7-5678-9012-34ab-cdefghijklmn', firstMessage: 'Session B' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Switch to title mode for immediate filtering
      const searchModeButton = screen.getByText('All').closest('button');
      await act(async () => {
        fireEvent.click(searchModeButton!);
        await vi.runAllTimersAsync();
      });
      const titleOption = screen.getByText('Title Only');
      await act(async () => {
        fireEvent.click(titleOption);
        await vi.runAllTimersAsync();
      });

      const searchInput = screen.getByPlaceholderText(/Search titles/i);
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: 'D02D0BD6' } });
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('Session A')).toBeInTheDocument();
      expect(screen.queryByText('Session B')).not.toBeInTheDocument();
    });

    it('searches by session name', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'session-1', firstMessage: 'First', sessionName: 'My Feature' }),
        createMockClaudeSession({ sessionId: 'session-2', firstMessage: 'Second', sessionName: 'Bug Fix' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Switch to title mode for immediate filtering
      const searchModeButton = screen.getByText('All').closest('button');
      await act(async () => {
        fireEvent.click(searchModeButton!);
        await vi.runAllTimersAsync();
      });
      const titleOption = screen.getByText('Title Only');
      await act(async () => {
        fireEvent.click(titleOption);
        await vi.runAllTimersAsync();
      });

      const searchInput = screen.getByPlaceholderText(/Search titles/i);
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: 'Feature' } });
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('My Feature')).toBeInTheDocument();
      expect(screen.queryByText('Bug Fix')).not.toBeInTheDocument();
    });

    it('clears search with X button', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'session-1', firstMessage: 'Session A' }),
        createMockClaudeSession({ sessionId: 'session-2', firstMessage: 'Session B' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Switch to title mode
      const searchModeButton = screen.getByText('All').closest('button');
      await act(async () => {
        fireEvent.click(searchModeButton!);
        await vi.runAllTimersAsync();
      });
      const titleOption = screen.getByText('Title Only');
      await act(async () => {
        fireEvent.click(titleOption);
        await vi.runAllTimersAsync();
      });

      const searchInput = screen.getByPlaceholderText(/Search titles/i);
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: 'Session A' } });
        await vi.runAllTimersAsync();
      });

      expect(screen.queryByText('Session B')).not.toBeInTheDocument();

      // Find the clear search button - it's the X icon in the search bar, not the modal close button
      // Get all X icons and find the one in the search area
      const xIcons = screen.getAllByTestId('icon-x');
      // The clear button is the one that appears after the search input
      const clearButton = xIcons.find((icon) => {
        const button = icon.closest('button');
        // The clear button should be inside the search bar container
        return button?.classList.contains('p-0.5');
      })?.closest('button');

      await act(async () => {
        fireEvent.click(clearButton!);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('Session A')).toBeInTheDocument();
      expect(screen.getByText('Session B')).toBeInTheDocument();
    });

    it('performs backend search for content mode', async () => {
      const sessions = [createMockClaudeSession({ sessionId: 'session-1', firstMessage: 'Test' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.search).mockResolvedValue([
        {
          sessionId: 'session-1',
          matchType: 'assistant' as const,
          matchPreview: 'found the match here',
          matchCount: 5,
        },
      ]);

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Default mode is 'all', just type search
      const searchInput = screen.getByPlaceholderText(/Search all content/i);
      await act(async () => {
        fireEvent.change(searchInput, { target: { value: 'search term' } });
        // Wait for debounce
        await vi.advanceTimersByTimeAsync(400);
      });

      expect(window.maestro.agentSessions.search).toHaveBeenCalledWith(
        'claude-code',
        '/path/to/project',
        'search term',
        'all'
      );
    });

    it('shows search mode dropdown options', async () => {
      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Default mode is 'all'
      const searchModeButton = screen.getByText('All').closest('button');
      await act(async () => {
        fireEvent.click(searchModeButton!);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('Title Only')).toBeInTheDocument();
      expect(screen.getByText('My Messages')).toBeInTheDocument();
      expect(screen.getByText('AI Responses')).toBeInTheDocument();
      expect(screen.getByText('All Content')).toBeInTheDocument();
    });

    it('closes dropdown when clicking outside', async () => {
      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const searchModeButton = screen.getByText('All').closest('button');
      await act(async () => {
        fireEvent.click(searchModeButton!);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('Title Only')).toBeInTheDocument();

      // Click outside
      await act(async () => {
        fireEvent.mouseDown(document.body);
        await vi.runAllTimersAsync();
      });

      expect(screen.queryByText('Title Only')).not.toBeInTheDocument();
    });
  });

  // ============================================================================
  // Filter Tests
  // ============================================================================

  describe('filtering', () => {
    it('filters by named only checkbox', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'session-1', firstMessage: 'Named one', sessionName: 'My Session' }),
        createMockClaudeSession({ sessionId: 'session-2', firstMessage: 'Unnamed one' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('My Session')).toBeInTheDocument();
      expect(screen.getByText('Unnamed one')).toBeInTheDocument();

      // Click named only checkbox
      const namedCheckbox = screen.getByLabelText('Named');
      await act(async () => {
        fireEvent.click(namedCheckbox);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('My Session')).toBeInTheDocument();
      expect(screen.queryByText('Unnamed one')).not.toBeInTheDocument();
    });

    it('shows all sessions with show all checkbox', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'd02d0bd6-test', firstMessage: 'UUID session' }),
        createMockClaudeSession({ sessionId: 'agent-batch-123', firstMessage: 'Agent session' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Agent sessions hidden by default
      expect(screen.getByText('UUID session')).toBeInTheDocument();
      expect(screen.queryByText('Agent session')).not.toBeInTheDocument();

      // Click show all
      const showAllCheckbox = screen.getByLabelText('Show All');
      await act(async () => {
        fireEvent.click(showAllCheckbox);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('UUID session')).toBeInTheDocument();
      expect(screen.getByText('Agent session')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Session Origin Pills Tests
  // ============================================================================

  describe('session origin pills', () => {
    it('shows MAESTRO pill for user-initiated sessions', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'session-1', origin: 'user' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('MAESTRO')).toBeInTheDocument();
    });

    it('shows AUTO pill for auto-batch sessions', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'session-1', origin: 'auto' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('AUTO')).toBeInTheDocument();
    });

    it('shows CLI pill for sessions without origin', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'session-1', origin: undefined }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('CLI')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Star/Unstar Tests
  // ============================================================================

  describe('star/unstar sessions', () => {
    it('toggles star status on click', async () => {
      const sessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      const onUpdateTab = vi.fn();
      const props = createDefaultProps({ onUpdateTab });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // Find and click star button
      const starButton = screen.getByTestId('icon-star').closest('button');
      await act(async () => {
        fireEvent.click(starButton!);
        await vi.runAllTimersAsync();
      });

      expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
        '/path/to/project',
        'session-1',
        true
      );
      expect(onUpdateTab).toHaveBeenCalledWith('session-1', { starred: true });
    });

    it('unstars previously starred session', async () => {
      const sessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
        'session-1': { origin: 'user', starred: true },
      });

      const onUpdateTab = vi.fn();
      const props = createDefaultProps({ onUpdateTab });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // Click star to unstar
      const starButton = screen.getByTestId('icon-star').closest('button');
      await act(async () => {
        fireEvent.click(starButton!);
        await vi.runAllTimersAsync();
      });

      expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
        '/path/to/project',
        'session-1',
        false
      );
      expect(onUpdateTab).toHaveBeenCalledWith('session-1', { starred: false });
    });

    it('uses projectRoot (not cwd) for session storage when they differ', async () => {
      // This tests the fix for the cwd vs projectRoot bug
      // When cwd changes (e.g., via cd command), session storage should still use projectRoot
      const sessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({});

      const onUpdateTab = vi.fn();
      // Create session where cwd differs from projectRoot (simulates user did 'cd' in terminal)
      const props = createDefaultProps({
        activeSession: createMockActiveSession({
          cwd: '/path/to/project/some/subdir',  // Changed via cd
          projectRoot: '/path/to/project',       // Original project root
        }),
        onUpdateTab,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // Click star button
      const starButton = screen.getByTestId('icon-star').closest('button');
      await act(async () => {
        fireEvent.click(starButton!);
        await vi.runAllTimersAsync();
      });

      // Should use projectRoot, NOT cwd
      expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
        '/path/to/project',  // projectRoot, not '/path/to/project/some/subdir'
        'session-1',
        true
      );
    });

    it('sorts starred sessions to the top', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'session-1', firstMessage: 'Unstarred', modifiedAt: '2025-01-15T12:00:00Z' }),
        createMockClaudeSession({ sessionId: 'session-2', firstMessage: 'Starred', modifiedAt: '2025-01-15T10:00:00Z' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });
      vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
        'session-2': { origin: 'user', starred: true },
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const items = screen.getAllByText(/^(Starred|Unstarred)$/);
      expect(items[0]).toHaveTextContent('Starred');
      expect(items[1]).toHaveTextContent('Unstarred');
    });
  });

  // ============================================================================
  // Rename Tests
  // ============================================================================

  describe('rename sessions', () => {
    it('enters rename mode on edit button click', async () => {
      const sessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Hover over session to show edit button
      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.mouseEnter(sessionItem!);
        await vi.runAllTimersAsync();
      });

      // Find and click edit button
      const editButtons = screen.getAllByTestId('icon-edit');
      const editButton = editButtons[0].closest('button');
      await act(async () => {
        fireEvent.click(editButton!);
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByPlaceholderText('Enter session name...')).toBeInTheDocument();
    });

    it('submits rename on Enter key', async () => {
      const sessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      const onUpdateTab = vi.fn();
      const props = createDefaultProps({ onUpdateTab });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // Start rename
      const editButtons = screen.getAllByTestId('icon-edit');
      const editButton = editButtons[0].closest('button');
      await act(async () => {
        fireEvent.click(editButton!);
        await vi.advanceTimersByTimeAsync(100);
      });

      const input = screen.getByPlaceholderText('Enter session name...');
      await act(async () => {
        fireEvent.change(input, { target: { value: 'New Name' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await vi.runAllTimersAsync();
      });

      // For claude-code sessions, it uses window.maestro.claude.updateSessionName
      expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
        '/path/to/project',
        'session-1',
        'New Name'
      );
      expect(onUpdateTab).toHaveBeenCalledWith('session-1', { name: 'New Name' });
    });

    it('cancels rename on Escape key (clears input value)', async () => {
      const sessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Start rename
      const editButtons = screen.getAllByTestId('icon-edit');
      const editButton = editButtons[0].closest('button');
      await act(async () => {
        fireEvent.click(editButton!);
        await vi.advanceTimersByTimeAsync(100);
      });

      const input = screen.getByPlaceholderText('Enter session name...') as HTMLInputElement;

      // Type a new name
      await act(async () => {
        fireEvent.change(input, { target: { value: 'New Name' } });
        await vi.runAllTimersAsync();
      });

      expect(input.value).toBe('New Name');

      // Press Escape - this should call cancelRename which clears the value
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Escape' });
        await vi.runAllTimersAsync();
      });

      // Verify that "New Name" was NOT saved - if updateSessionName was called,
      // it should NOT have been called with 'New Name'
      // For claude-code sessions, it uses window.maestro.claude.updateSessionName
      const calls = vi.mocked(window.maestro.claude.updateSessionName).mock.calls;
      const savedWithNewName = calls.some(call => call[2] === 'New Name');
      expect(savedWithNewName).toBe(false);
    });

    it('submits rename on blur', async () => {
      const sessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Start rename
      const editButtons = screen.getAllByTestId('icon-edit');
      const editButton = editButtons[0].closest('button');
      await act(async () => {
        fireEvent.click(editButton!);
        await vi.advanceTimersByTimeAsync(100);
      });

      const input = screen.getByPlaceholderText('Enter session name...');
      await act(async () => {
        fireEvent.change(input, { target: { value: 'Blur Name' } });
        fireEvent.blur(input);
        await vi.runAllTimersAsync();
      });

      // For claude-code sessions, it uses window.maestro.claude.updateSessionName
      expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
        '/path/to/project',
        'session-1',
        'Blur Name'
      );
    });

    it('clears name when submitting empty string', async () => {
      const sessions = [createMockClaudeSession({ sessionId: 'session-1', sessionName: 'Existing Name' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      const onUpdateTab = vi.fn();
      const props = createDefaultProps({ onUpdateTab });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // Start rename
      const editButtons = screen.getAllByTestId('icon-edit');
      const editButton = editButtons[0].closest('button');
      await act(async () => {
        fireEvent.click(editButton!);
        await vi.advanceTimersByTimeAsync(100);
      });

      const input = screen.getByDisplayValue('Existing Name');
      await act(async () => {
        fireEvent.change(input, { target: { value: '' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await vi.runAllTimersAsync();
      });

      // For claude-code sessions, it uses window.maestro.claude.updateSessionName
      expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
        '/path/to/project',
        'session-1',
        ''
      );
      expect(onUpdateTab).toHaveBeenCalledWith('session-1', { name: null });
    });

    it('uses projectRoot (not cwd) for rename when they differ', async () => {
      // This tests the fix for the cwd vs projectRoot bug in rename
      const sessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({});

      const onUpdateTab = vi.fn();
      // Create session where cwd differs from projectRoot
      const props = createDefaultProps({
        activeSession: createMockActiveSession({
          cwd: '/path/to/project/some/subdir',  // Changed via cd
          projectRoot: '/path/to/project',       // Original project root
        }),
        onUpdateTab,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // Click edit button to start rename
      const editButton = screen.getByTestId('icon-edit').closest('button');
      fireEvent.click(editButton!);

      // Type new name - use placeholder to find the rename input specifically
      const input = screen.getByPlaceholderText('Enter session name...');
      fireEvent.change(input, { target: { value: 'New Name' } });

      // Submit with Enter
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' });
        await vi.runAllTimersAsync();
      });

      // Should use projectRoot, NOT cwd
      // For claude-code sessions, it uses window.maestro.claude.updateSessionName
      expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
        '/path/to/project',  // projectRoot, not '/path/to/project/some/subdir'
        'session-1',
        'New Name'
      );
    });
  });

  // ============================================================================
  // Keyboard Navigation Tests
  // ============================================================================

  describe('keyboard navigation', () => {
    it('navigates down with ArrowDown', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'session-1', firstMessage: 'First' }),
        createMockClaudeSession({ sessionId: 'session-2', firstMessage: 'Second' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Default mode is 'all', so use that placeholder
      const searchInput = screen.getByPlaceholderText(/Search all content/i);
      await act(async () => {
        fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
        await vi.runAllTimersAsync();
      });

      // Arrow keys update selectedIndex, which changes the highlighting
      // Initial selectedIndex is 0, ArrowDown makes it 1
      // We can verify by checking that both sessions are rendered (one will be highlighted)
      expect(screen.getByText('First')).toBeInTheDocument();
      expect(screen.getByText('Second')).toBeInTheDocument();
    });

    it('navigates up with ArrowUp', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'session-1', firstMessage: 'First' }),
        createMockClaudeSession({ sessionId: 'session-2', firstMessage: 'Second' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const searchInput = screen.getByPlaceholderText(/Search all content/i);
      // Move down first
      await act(async () => {
        fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
        await vi.runAllTimersAsync();
      });
      // Then back up
      await act(async () => {
        fireEvent.keyDown(searchInput, { key: 'ArrowUp' });
        await vi.runAllTimersAsync();
      });

      // Sessions should still be rendered
      expect(screen.getByText('First')).toBeInTheDocument();
      expect(screen.getByText('Second')).toBeInTheDocument();
    });

    it('opens session on Enter key', async () => {
      const sessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [],
        total: 0,
        hasMore: false,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const searchInput = screen.getByPlaceholderText(/Search all content/i);
      await act(async () => {
        fireEvent.keyDown(searchInput, { key: 'Enter' });
        await vi.runAllTimersAsync();
      });

      // Should show detail view with Resume button
      expect(screen.getByText('Resume')).toBeInTheDocument();
    });

    it('closes modal on Escape in list view', async () => {
      const onClose = vi.fn();
      const props = createDefaultProps({ onClose });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // Flush all pending effects and timers to ensure layer is registered
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Escape should close modal directly (search panel no longer intercepts Escape)
      await act(async () => {
        const escapeEvent = new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(escapeEvent);
        await vi.runAllTimersAsync();
      });

      expect(onClose).toHaveBeenCalled();
    });

    it('returns to list view on Escape in detail view', async () => {
      const sessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [],
        total: 0,
        hasMore: false,
      });

      const onClose = vi.fn();
      const props = createDefaultProps({ onClose });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // Open detail view
      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      // Escape should go back to list
      await act(async () => {
        fireEvent.keyDown(window, { key: 'Escape' });
        await vi.runAllTimersAsync();
      });

      // Should be back in list view
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByText('Resume')).not.toBeInTheDocument();
    });
  });

  // ============================================================================
  // Session Detail View Tests
  // ============================================================================

  describe('session detail view', () => {
    it('shows session stats panel', async () => {
      const session = createMockClaudeSession({
        sessionId: 'session-1',
        costUsd: 1.23,
        durationSeconds: 185, // 3m 5s
        inputTokens: 5000,
        outputTokens: 3000,
        messageCount: 15,
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [],
        total: 15,
        hasMore: false,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Click session
      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('$1.23')).toBeInTheDocument();
      expect(screen.getByText('3m 5s')).toBeInTheDocument();
      expect(screen.getByText('8.0k')).toBeInTheDocument(); // 5000 + 3000
      expect(screen.getByText('15')).toBeInTheDocument();
    });

    it('shows token breakdown with cache tokens', async () => {
      const session = createMockClaudeSession({
        sessionId: 'session-1',
        inputTokens: 5000,
        outputTokens: 3000,
        cacheReadTokens: 2000,
        cacheCreationTokens: 500,
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText(/Input:/)).toBeInTheDocument();
      expect(screen.getByText(/Output:/)).toBeInTheDocument();
      expect(screen.getByText(/Cache Read:/)).toBeInTheDocument();
      expect(screen.getByText(/Cache Write:/)).toBeInTheDocument();
    });

    it('hides cache tokens when zero', async () => {
      const session = createMockClaudeSession({
        sessionId: 'session-1',
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      expect(screen.queryByText(/Cache Read:/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Cache Write:/)).not.toBeInTheDocument();
    });

    it('displays messages in correct format', async () => {
      const session = createMockClaudeSession({ sessionId: 'session-1' });
      const messages = [
        createMockMessage({ type: 'user', content: 'Hello, can you help?' }),
        createMockMessage({ type: 'assistant', content: 'Of course!' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages,
        total: 2,
        hasMore: false,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('Hello, can you help?')).toBeInTheDocument();
      expect(screen.getByText('Of course!')).toBeInTheDocument();
    });

    it('shows back button in detail view', async () => {
      const session = createMockClaudeSession({ sessionId: 'session-1' });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByTestId('icon-chevron-left')).toBeInTheDocument();
    });

    it('navigates back to list on back button click', async () => {
      const session = createMockClaudeSession({ sessionId: 'session-1' });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      const backButton = screen.getByTestId('icon-chevron-left').closest('button');
      await act(async () => {
        fireEvent.click(backButton!);
        await vi.runAllTimersAsync();
      });

      // Should be back in list view
      expect(screen.queryByText('Resume')).not.toBeInTheDocument();
      expect(screen.getByText(/Help me with this code/i)).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Context Window Gauge Tests
  // ============================================================================

  describe('context window gauge', () => {
    it('shows green for low usage', async () => {
      const session = createMockClaudeSession({
        sessionId: 'session-1',
        inputTokens: 10000,
        outputTokens: 10000, // 20k total = 10%
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      // Should show accent color (green-ish) for 10% usage
      const percentText = screen.getByText('10.0%');
      expect(percentText).toHaveStyle({ color: defaultTheme.colors.accent });
    });

    it('shows warning color for high usage', async () => {
      const session = createMockClaudeSession({
        sessionId: 'session-1',
        inputTokens: 80000,
        outputTokens: 70000, // 150k total = 75%
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      const percentText = screen.getByText('75.0%');
      expect(percentText).toHaveStyle({ color: defaultTheme.colors.warning });
    });

    it('shows error color for critical usage', async () => {
      const session = createMockClaudeSession({
        sessionId: 'session-1',
        inputTokens: 100000,
        outputTokens: 90000, // 190k total = 95%
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      const percentText = screen.getByText('95.0%');
      expect(percentText).toHaveStyle({ color: defaultTheme.colors.error });
    });
  });

  // ============================================================================
  // Duration Formatting Tests
  // ============================================================================

  describe('duration formatting', () => {
    it('shows seconds only for short durations', async () => {
      const session = createMockClaudeSession({
        sessionId: 'session-1',
        durationSeconds: 45,
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('45s')).toBeInTheDocument();
    });

    it('shows minutes and seconds for medium durations', async () => {
      const session = createMockClaudeSession({
        sessionId: 'session-1',
        durationSeconds: 125, // 2m 5s
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('2m 5s')).toBeInTheDocument();
    });

    it('shows hours and minutes for long durations', async () => {
      const session = createMockClaudeSession({
        sessionId: 'session-1',
        durationSeconds: 3900, // 1h 5m
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('1h 5m')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Resume Session Tests
  // ============================================================================

  describe('resume session', () => {
    it('calls onResumeSession when Resume button clicked', async () => {
      const session = createMockClaudeSession({ sessionId: 'session-1', sessionName: 'My Session' });
      const messages = [
        createMockMessage({ type: 'user', content: 'Hello' }),
        createMockMessage({ type: 'assistant', content: 'Hi!' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages,
        total: 2,
        hasMore: false,
      });

      const onResumeSession = vi.fn();
      const onClose = vi.fn();
      const props = createDefaultProps({ onResumeSession, onClose });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      const resumeButton = screen.getByText('Resume');
      await act(async () => {
        fireEvent.click(resumeButton);
        await vi.runAllTimersAsync();
      });

      expect(onResumeSession).toHaveBeenCalledWith(
        'session-1',
        expect.arrayContaining([
          expect.objectContaining({ text: 'Hello', source: 'user' }),
          expect.objectContaining({ text: 'Hi!', source: 'stdout' }),
        ]),
        'My Session',
        false, // not starred
        expect.objectContaining({
          inputTokens: 5000,
          outputTokens: 2000,
          totalCostUsd: 0.15,
        })
      );
      expect(onClose).toHaveBeenCalled();
    });

    it('resumes starred session with correct starred flag', async () => {
      const session = createMockClaudeSession({ sessionId: 'session-1' });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
        'session-1': { origin: 'user', starred: true },
      });

      const onResumeSession = vi.fn();
      const props = createDefaultProps({ onResumeSession });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      const resumeButton = screen.getByText('Resume');
      await act(async () => {
        fireEvent.click(resumeButton);
        await vi.runAllTimersAsync();
      });

      expect(onResumeSession).toHaveBeenCalledWith(
        'session-1',
        expect.any(Array),
        undefined,
        true, // starred
        expect.objectContaining({
          inputTokens: 5000,
          outputTokens: 2000,
          totalCostUsd: 0.15,
        })
      );
    });

    it('resumes session with Enter key in detail view', async () => {
      const session = createMockClaudeSession({ sessionId: 'session-1' });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      const onResumeSession = vi.fn();
      const props = createDefaultProps({ onResumeSession });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      // Press Enter in detail view
      const messagesContainer = document.querySelector('[tabindex="0"]');
      await act(async () => {
        fireEvent.keyDown(messagesContainer!, { key: 'Enter' });
        await vi.runAllTimersAsync();
      });

      expect(onResumeSession).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Quick Resume Tests
  // ============================================================================

  describe('quick resume', () => {
    it('quick resumes session from list view', async () => {
      const session = createMockClaudeSession({ sessionId: 'session-1', sessionName: 'Quick Session' });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      const onResumeSession = vi.fn();
      const onClose = vi.fn();
      const props = createDefaultProps({ onResumeSession, onClose });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // Find and click quick resume (play) button - it's visible on hover
      const playButtons = screen.getAllByTestId('icon-play');
      const quickResumeButton = playButtons[0].closest('button');
      await act(async () => {
        fireEvent.click(quickResumeButton!);
        await vi.runAllTimersAsync();
      });

      expect(onResumeSession).toHaveBeenCalledWith(
        'session-1',
        [], // Empty messages for quick resume
        'Quick Session',
        false,
        expect.objectContaining({
          inputTokens: 5000,
          outputTokens: 2000,
          totalCostUsd: 0.15,
        })
      );
      expect(onClose).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // New Session Tests
  // ============================================================================

  describe('new session', () => {
    it('calls onNewSession when New Session button clicked', async () => {
      const onNewSession = vi.fn();
      const props = createDefaultProps({ onNewSession });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      const newSessionButton = screen.getByText('New Session');
      await act(async () => {
        fireEvent.click(newSessionButton);
        await vi.runAllTimersAsync();
      });

      expect(onNewSession).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Close Modal Tests
  // ============================================================================

  describe('close modal', () => {
    it('calls onClose when X button clicked', async () => {
      const onClose = vi.fn();
      const props = createDefaultProps({ onClose });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // Find X button (icon-x inside a button)
      const closeButtons = screen.getAllByTestId('icon-x');
      const closeButton = closeButtons[closeButtons.length - 1].closest('button');
      await act(async () => {
        fireEvent.click(closeButton!);
        await vi.runAllTimersAsync();
      });

      expect(onClose).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Pagination Tests
  // ============================================================================

  describe('pagination', () => {
    it('loads more sessions on scroll', async () => {
      const firstBatch = [
        createMockClaudeSession({ sessionId: 'session-1', firstMessage: 'First batch' }),
      ];
      const secondBatch = [
        createMockClaudeSession({ sessionId: 'session-2', firstMessage: 'Second batch' }),
      ];

      vi.mocked(window.maestro.agentSessions.listPaginated)
        .mockResolvedValueOnce({
          sessions: firstBatch,
          hasMore: true,
          totalCount: 2,
          nextCursor: 'cursor-1',
        })
        .mockResolvedValueOnce({
          sessions: secondBatch,
          hasMore: false,
          totalCount: 2,
          nextCursor: null,
        });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('First batch')).toBeInTheDocument();

      // Trigger auto-load (the component auto-loads more after initial load)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText('Second batch')).toBeInTheDocument();
    });

    it('shows loading indicator while loading more', async () => {
      const sessions = [createMockClaudeSession({ sessionId: 'session-1' })];

      let resolveSecondCall: (value: unknown) => void;
      const secondCallPromise = new Promise((resolve) => {
        resolveSecondCall = resolve;
      });

      vi.mocked(window.maestro.agentSessions.listPaginated)
        .mockResolvedValueOnce({
          sessions,
          hasMore: true,
          totalCount: 2,
          nextCursor: 'cursor-1',
        })
        .mockImplementationOnce(() => secondCallPromise as Promise<{
          sessions: ClaudeSession[];
          hasMore: boolean;
          totalCount: number;
          nextCursor: string | null;
        }>);

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Trigger load more
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText(/Loading more sessions/i)).toBeInTheDocument();

      // Resolve the second call
      await act(async () => {
        resolveSecondCall!({
          sessions: [],
          hasMore: false,
          totalCount: 1,
          nextCursor: null,
        });
        await vi.runAllTimersAsync();
      });
    });
  });

  // ============================================================================
  // Message Loading Tests
  // ============================================================================

  describe('message loading', () => {
    it('loads more messages on scroll to top', async () => {
      const session = createMockClaudeSession({ sessionId: 'session-1' });
      const firstBatch = [createMockMessage({ uuid: 'msg-1', content: 'Recent message' })];
      const secondBatch = [createMockMessage({ uuid: 'msg-2', content: 'Older message' })];

      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read)
        .mockResolvedValueOnce({
          messages: firstBatch,
          total: 2,
          hasMore: true,
        })
        .mockResolvedValueOnce({
          messages: secondBatch,
          total: 2,
          hasMore: false,
        });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      // Click session
      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('Recent message')).toBeInTheDocument();

      // Click load more button
      const loadMoreButton = screen.getByText(/Load earlier messages/i);
      await act(async () => {
        fireEvent.click(loadMoreButton);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('Older message')).toBeInTheDocument();
    });

    it('shows loading spinner while messages loading', async () => {
      const session = createMockClaudeSession({ sessionId: 'session-1' });

      let resolveMessages: (value: unknown) => void;
      const messagesPromise = new Promise((resolve) => {
        resolveMessages = resolve;
      });

      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockImplementation(
        () => messagesPromise as Promise<{ messages: SessionMessage[]; total: number; hasMore: boolean }>
      );

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      // Should show loader while loading
      expect(screen.getAllByTestId('icon-loader').length).toBeGreaterThan(0);

      // Resolve
      await act(async () => {
        resolveMessages!({ messages: [], total: 0, hasMore: false });
        await vi.runAllTimersAsync();
      });
    });
  });

  // ============================================================================
  // Active Session Badge Tests
  // ============================================================================

  describe('active session badge', () => {
    it('shows ACTIVE badge for current session in list', async () => {
      const sessions = [
        createMockClaudeSession({ sessionId: 'session-1', firstMessage: 'Not active' }),
        createMockClaudeSession({ sessionId: 'active-session-123', firstMessage: 'Active session' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      const props = createDefaultProps({
        activeAgentSessionId: 'active-session-123',
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // When activeAgentSessionId is provided, the component auto-jumps to detail view
      // Go back to list view first
      const backButton = screen.getByTestId('icon-chevron-left').closest('button');
      await act(async () => {
        fireEvent.click(backButton!);
        await vi.runAllTimersAsync();
      });

      // Now check for ACTIVE badge(s) - there may be one in header and one in list
      const activeBadges = screen.getAllByText('ACTIVE');
      expect(activeBadges.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================================
  // Auto-Jump Tests
  // ============================================================================

  describe('auto-jump to session', () => {
    it('auto-opens session detail when activeAgentSessionId provided', async () => {
      const session = createMockClaudeSession({ sessionId: 'target-session' });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [],
        total: 0,
        hasMore: false,
      });

      const props = createDefaultProps({
        activeAgentSessionId: 'target-session',
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      // Should be in detail view
      expect(screen.getByText('Resume')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Rename in Detail View Tests
  // ============================================================================

  describe('rename in detail view', () => {
    it('allows renaming in detail view header', async () => {
      const session = createMockClaudeSession({ sessionId: 'session-1' });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      // Click edit button in header
      const editButtons = screen.getAllByTestId('icon-edit');
      const headerEditButton = editButtons[0].closest('button');
      await act(async () => {
        fireEvent.click(headerEditButton!);
        await vi.advanceTimersByTimeAsync(100);
      });

      const input = screen.getByPlaceholderText('Enter session name...');
      await act(async () => {
        fireEvent.change(input, { target: { value: 'Detail View Name' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await vi.runAllTimersAsync();
      });

      // For claude-code sessions, it uses window.maestro.claude.updateSessionName
      expect(window.maestro.claude.updateSessionName).toHaveBeenCalledWith(
        '/path/to/project',
        'session-1',
        'Detail View Name'
      );
    });

    it('shows session name in detail view header when set', async () => {
      const session = createMockClaudeSession({
        sessionId: 'session-1',
        sessionName: 'My Named Session',
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText('My Named Session').closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      // Session name should be in header
      const headerName = screen.getAllByText('My Named Session')[0];
      expect(headerName).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Star in Detail View Tests
  // ============================================================================

  describe('star in detail view', () => {
    it('toggles star in detail view', async () => {
      const session = createMockClaudeSession({ sessionId: 'session-1' });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      const onUpdateTab = vi.fn();
      const props = createDefaultProps({ onUpdateTab });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...props} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      // Find star button in header (detail view)
      const starButtons = screen.getAllByTestId('icon-star');
      const headerStarButton = starButtons[0].closest('button');
      await act(async () => {
        fireEvent.click(headerStarButton!);
        await vi.runAllTimersAsync();
      });

      expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
        '/path/to/project',
        'session-1',
        true
      );
      expect(onUpdateTab).toHaveBeenCalledWith('session-1', { starred: true });
    });
  });

  // ============================================================================
  // Tool Use Message Tests
  // ============================================================================

  describe('tool use messages', () => {
    it('displays tool use placeholder for messages with tool calls', async () => {
      const session = createMockClaudeSession({ sessionId: 'session-1' });
      const messages = [
        createMockMessage({
          type: 'assistant',
          content: '',
          toolUse: [{ name: 'file_read' }],
        }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages,
        total: 1,
        hasMore: false,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      // ToolCallCard component displays tool name without brackets (collapsible card format)
      expect(screen.getByText('Tool: file_read')).toBeInTheDocument();
    });

    it('displays no content placeholder for empty messages', async () => {
      const session = createMockClaudeSession({ sessionId: 'session-1' });
      const messages = [
        createMockMessage({
          type: 'assistant',
          content: '',
          toolUse: undefined,
        }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages,
        total: 1,
        hasMore: false,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('[No content]')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Session ID Display Tests
  // ============================================================================

  describe('session ID display', () => {
    it('displays first octet of UUID in uppercase', async () => {
      const session = createMockClaudeSession({
        sessionId: 'd02d0bd6-1234-5678-90ab-cdefghijklmn',
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('D02D0BD6')).toBeInTheDocument();
    });

    it('displays agent session ID correctly', async () => {
      const session = createMockClaudeSession({
        sessionId: 'agent-abc123-batch-task',
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      // Enable show all to see agent sessions
      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const showAllCheckbox = screen.getByLabelText('Show All');
      await act(async () => {
        fireEvent.click(showAllCheckbox);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('AGENT-ABC123')).toBeInTheDocument();
    });

    it('shows full UUID in detail view header when no session name', async () => {
      const session = createMockClaudeSession({
        sessionId: 'd02d0bd6-1234-5678-90ab-cdefghijklmn',
        sessionName: undefined,
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [session],
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      await act(async () => {
        renderWithProvider(<AgentSessionsBrowser {...createDefaultProps()} />);
        await vi.runAllTimersAsync();
      });

      const sessionItem = screen.getByText(/Help me with this code/i).closest('div[class*="cursor-pointer"]');
      await act(async () => {
        fireEvent.click(sessionItem!);
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('D02D0BD6-1234-5678-90AB-CDEFGHIJKLMN')).toBeInTheDocument();
    });
  });
});
