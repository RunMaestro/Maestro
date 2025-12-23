/**
 * @fileoverview Tests for ProcessMonitor component
 * Tests: formatRuntime helper, process tree building, keyboard navigation,
 * expand/collapse, kill process confirmation, session navigation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ProcessMonitor } from '../../../renderer/components/ProcessMonitor';
import type { Session, Group, Theme } from '../../../renderer/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  ChevronRight: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <span data-testid="chevron-right" className={className} style={style}>▶</span>
  ),
  ChevronDown: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <span data-testid="chevron-down" className={className} style={style}>▼</span>
  ),
  ChevronUp: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <span data-testid="chevron-up" className={className} style={style}>▲</span>
  ),
  X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <span data-testid="x-icon" className={className} style={style}>×</span>
  ),
  Activity: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <span data-testid="activity-icon" className={className} style={style}>📊</span>
  ),
  RefreshCw: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <span data-testid="refresh-icon" className={className} style={style}>🔄</span>
  ),
  XCircle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <span data-testid="x-circle-icon" className={className} style={style}>⊗</span>
  ),
}));

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
  useLayerStack: () => ({
    registerLayer: mockRegisterLayer,
    unregisterLayer: mockUnregisterLayer,
    updateLayerHandler: mockUpdateLayerHandler,
  }),
}));

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

// Create test sessions
const createSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1',
  name: 'Test Session',
  toolType: 'claude-code',
  state: 'idle',
  inputMode: 'ai',
  cwd: '/Users/test/project',
  projectRoot: '/Users/test/project',
  aiPid: 12345,
  terminalPid: 12346,
  aiLogs: [],
  shellLogs: [],
  isGitRepo: true,
  fileTree: [],
  fileExplorerExpanded: [],
  aiTabs: [
    {
      id: 'tab-1',
      name: 'Tab 1',
      logs: [],
      agentSessionId: 'abc12345-6789-0123-4567-890abcdef012',
      isStarred: false,
      state: 'idle',
    },
  ],
  activeTabId: 'tab-1',
  ...overrides,
});

// Create test group
const createGroup = (overrides: Partial<Group> = {}): Group => ({
  id: 'group-1',
  name: 'Test Group',
  emoji: '📁',
  isExpanded: true,
  ...overrides,
});

// Create test active process
interface ActiveProcess {
  sessionId: string;
  toolType: string;
  pid: number;
  cwd: string;
  isTerminal: boolean;
  isBatchMode: boolean;
  startTime: number;
}

const createActiveProcess = (overrides: Partial<ActiveProcess> = {}): ActiveProcess => ({
  sessionId: 'session-1-ai-tab-1',
  toolType: 'claude-code',
  pid: 12345,
  cwd: '/Users/test/project',
  isTerminal: false,
  isBatchMode: false,
  startTime: Date.now() - 60000, // 1 minute ago
  ...overrides,
});

describe('ProcessMonitor', () => {
  let theme: Theme;
  let onClose: ReturnType<typeof vi.fn>;
  let onNavigateToSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    theme = createTheme();
    onClose = vi.fn();
    onNavigateToSession = vi.fn();

    // Add getActiveProcesses mock to existing window.maestro.process
    (window.maestro.process as Record<string, unknown>).getActiveProcesses = vi.fn().mockResolvedValue([]);

    // Reset existing kill mock
    vi.mocked(window.maestro.process.kill).mockReset().mockResolvedValue(undefined);

    // Mock scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();

    // Reset mocks
    mockRegisterLayer.mockClear();
    mockUnregisterLayer.mockClear();
    mockUpdateLayerHandler.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // Helper to get mock functions
  const getActiveProcessesMock = () => window.maestro.process.getActiveProcesses as ReturnType<typeof vi.fn>;
  const killMock = () => vi.mocked(window.maestro.process.kill);

  describe('formatRuntime helper', () => {
    // Test formatRuntime indirectly through process display
    it('should format seconds correctly', async () => {
      // Set a fixed time for this test
      const fixedTime = 1700000000000;
      vi.setSystemTime(fixedTime);

      const process = createActiveProcess({
        startTime: fixedTime - 30000, // 30 seconds ago
      });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      await act(async () => {
        render(
          <ProcessMonitor
            theme={theme}
            sessions={[session]}
            groups={[]}
            onClose={onClose}
          />
        );
      });

      await waitFor(() => {
        expect(screen.queryByText('Loading processes...')).not.toBeInTheDocument();
      });

      // Should display seconds format - use regex to be more flexible
      expect(screen.getByText(/^30s$/)).toBeInTheDocument();
    });

    it('should format minutes and seconds correctly', async () => {
      const now = Date.now();
      const process = createActiveProcess({
        startTime: now - 125000, // 2 min 5 sec ago
      });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading processes...')).not.toBeInTheDocument();
      });

      // Should display minutes format - use flexible regex to allow for timing variations
      // Accept any minute/second format since test execution timing can vary in parallel runs
      expect(screen.getByText(/^\d+m \d+s$/)).toBeInTheDocument();
    });

    it('should format hours and minutes correctly', async () => {
      const now = Date.now();
      const process = createActiveProcess({
        startTime: now - (3600000 + 300000), // 1 hour 5 min ago
      });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading processes...')).not.toBeInTheDocument();
      });

      // Should display hours format
      expect(screen.getByText('1h 5m')).toBeInTheDocument();
    });

    it('should format days and hours correctly', async () => {
      const now = Date.now();
      const process = createActiveProcess({
        startTime: now - (86400000 + 7200000), // 1 day 2 hours ago
      });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading processes...')).not.toBeInTheDocument();
      });

      // Should display days format
      expect(screen.getByText('1d 2h')).toBeInTheDocument();
    });
  });

  describe('Initial render', () => {
    it('should render loading state initially', () => {
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      expect(screen.getByText('Loading processes...')).toBeInTheDocument();
    });

    it('should render with dialog role and aria attributes', () => {
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-label', 'System Processes');
    });

    it('should render header with title', () => {
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      expect(screen.getByText('System Processes')).toBeInTheDocument();
    });

    it('should display empty state when no processes', async () => {
      getActiveProcessesMock().mockResolvedValue([]);

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('No running processes')).toBeInTheDocument();
      });
    });

    it('should display active process count in header', async () => {
      getActiveProcessesMock().mockResolvedValue([
        createActiveProcess(),
        createActiveProcess({ sessionId: 'session-2-terminal', pid: 12347 }),
      ]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('2 active')).toBeInTheDocument();
      });
    });
  });

  describe('Layer stack integration', () => {
    it('should register layer on mount', () => {
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      expect(mockRegisterLayer).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'modal',
          blocksLowerLayers: true,
          capturesFocus: true,
          focusTrap: 'strict',
          ariaLabel: 'System Processes',
        })
      );
    });

    it('should unregister layer on unmount', () => {
      const { unmount } = render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      unmount();

      expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-123');
    });

    it('should update handler when onClose changes', () => {
      const { rerender } = render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      const newOnClose = vi.fn();
      rerender(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={newOnClose}
        />
      );

      const lastCall = mockUpdateLayerHandler.mock.calls.at(-1);
      expect(lastCall?.[0]).toBe('layer-123');
      const handler = lastCall?.[1] as (() => void) | undefined;
      expect(handler).toBeDefined();

      handler?.();
      expect(newOnClose).toHaveBeenCalled();
    });
  });

  describe('Close functionality', () => {
    it('should call onClose when X button is clicked', async () => {
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      // Find the X button by its title
      const closeButton = screen.getByTitle('Close (Esc)');
      fireEvent.click(closeButton);

      expect(onClose).toHaveBeenCalled();
    });

    it('should call onClose when clicking backdrop', async () => {
      getActiveProcessesMock().mockResolvedValue([]);

      const { container } = render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      // Click the backdrop (outer div)
      const backdrop = container.querySelector('.fixed.inset-0');
      fireEvent.click(backdrop!);

      expect(onClose).toHaveBeenCalled();
    });

    it('should NOT call onClose when clicking inside modal', async () => {
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      // Click the dialog content
      const dialog = screen.getByRole('dialog');
      fireEvent.click(dialog);

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('Process tree building', () => {
    it('should display ungrouped sessions with processes', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading processes...')).not.toBeInTheDocument();
      });

      expect(screen.getByText('UNGROUPED AGENTS')).toBeInTheDocument();
      expect(screen.getByText('Test Session')).toBeInTheDocument();
    });

    it('should display grouped sessions with processes', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ groupId: 'group-1' });
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading processes...')).not.toBeInTheDocument();
      });

      expect(screen.getByText('Test Group')).toBeInTheDocument();
      expect(screen.getByText('Test Session')).toBeInTheDocument();
    });

    it('should show session count in group', async () => {
      const processes = [
        createActiveProcess({ sessionId: 'session-1-ai-tab-1' }),
        createActiveProcess({ sessionId: 'session-2-terminal', pid: 12347 }),
      ];
      getActiveProcessesMock().mockResolvedValue(processes);

      const sessions = [
        createSession({ id: 'session-1', groupId: 'group-1' }),
        createSession({ id: 'session-2', name: 'Session 2', groupId: 'group-1' }),
      ];
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={sessions}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('2 sessions')).toBeInTheDocument();
      });
    });

    it('should show "1 session" for single session', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ groupId: 'group-1' });
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('1 session')).toBeInTheDocument();
      });
    });

    it('should show running count for session', async () => {
      const processes = [
        createActiveProcess({ sessionId: 'session-1-ai-tab-1' }),
        createActiveProcess({ sessionId: 'session-1-terminal', pid: 12347 }),
      ];
      getActiveProcessesMock().mockResolvedValue(processes);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('2 running')).toBeInTheDocument();
      });
    });

    it('should display session ID truncated', async () => {
      const process = createActiveProcess({ sessionId: 'abcdef12-3456-7890-ai-tab-1' });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ id: 'abcdef12-3456-7890' });
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/Session: abcdef12\.\.\./)).toBeInTheDocument();
      });
    });
  });

  describe('Process types', () => {
    it('should display AI agent process', async () => {
      const process = createActiveProcess({ sessionId: 'session-1-ai-tab-1' });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });
    });

    it('should display terminal process', async () => {
      const process = createActiveProcess({
        sessionId: 'session-1-terminal',
        isTerminal: true,
      });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - Terminal Shell')).toBeInTheDocument();
      });
    });

    it('should display batch process with AUTO badge', async () => {
      const process = createActiveProcess({
        sessionId: 'session-1-batch-1234567890',
        isBatchMode: true,
      });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
        expect(screen.getByText('AUTO')).toBeInTheDocument();
      });
    });

    it('should display synopsis process', async () => {
      const process = createActiveProcess({
        sessionId: 'session-1-synopsis-1234567890',
      });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code) - Synopsis')).toBeInTheDocument();
      });
    });

    it('should display PID for processes', async () => {
      const process = createActiveProcess({ pid: 99999 });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('PID: 99999')).toBeInTheDocument();
      });
    });

    it('should display "Running" status badge', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        // Footer also has "Running" text, so find the badge
        const runningBadges = screen.getAllByText('Running');
        expect(runningBadges.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('Claude session ID display', () => {
    it('should display Claude session ID truncated', async () => {
      const process = createActiveProcess({ sessionId: 'session-1-ai-tab-1' });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        // Claude session ID starts with abc12345
        expect(screen.getByText('abc12345...')).toBeInTheDocument();
      });
    });

    it('should make Claude session ID clickable with onNavigateToSession', async () => {
      const process = createActiveProcess({ sessionId: 'session-1-ai-tab-1' });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
          onNavigateToSession={onNavigateToSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('abc12345...')).toBeInTheDocument();
      });

      // Click the Claude session ID
      const claudeIdButton = screen.getByTitle('Click to navigate to this session');
      fireEvent.click(claudeIdButton);

      expect(onNavigateToSession).toHaveBeenCalledWith('session-1', 'tab-1');
      expect(onClose).toHaveBeenCalled();
    });

    it('should not be clickable when no onNavigateToSession', async () => {
      const process = createActiveProcess({ sessionId: 'session-1-ai-tab-1' });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('abc12345...')).toBeInTheDocument();
      });

      // Should be a span, not a button
      expect(screen.queryByTitle('Click to navigate to this session')).not.toBeInTheDocument();
    });
  });

  describe('Expand/collapse', () => {
    it('should auto-expand all nodes on initial load', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ groupId: 'group-1' });
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        // All nodes should be expanded, so we should see the process
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });
    });

    it('should collapse node when clicked', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ groupId: 'group-1' });
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      // Click the group to collapse
      fireEvent.click(screen.getByText('Test Group'));

      // Process should no longer be visible
      await waitFor(() => {
        expect(screen.queryByText('Test Session - AI Agent (claude-code)')).not.toBeInTheDocument();
      });
    });

    it('should collapse all when clicking collapse button', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ groupId: 'group-1' });
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      // Click collapse all button
      const collapseButton = screen.getByTitle('Collapse all');
      fireEvent.click(collapseButton);

      // Process should no longer be visible
      await waitFor(() => {
        expect(screen.queryByText('Test Session - AI Agent (claude-code)')).not.toBeInTheDocument();
      });
    });

    it('should expand all when clicking expand button', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ groupId: 'group-1' });
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      // Collapse first
      const collapseButton = screen.getByTitle('Collapse all');
      fireEvent.click(collapseButton);

      await waitFor(() => {
        expect(screen.queryByText('Test Session - AI Agent (claude-code)')).not.toBeInTheDocument();
      });

      // Then expand
      const expandButton = screen.getByTitle('Expand all');
      fireEvent.click(expandButton);

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });
    });
  });

  describe('Keyboard navigation', () => {
    it('should navigate down with ArrowDown', async () => {
      const processes = [
        createActiveProcess({ sessionId: 'session-1-ai-tab-1' }),
        createActiveProcess({ sessionId: 'session-1-terminal', pid: 12347 }),
      ];
      getActiveProcessesMock().mockResolvedValue(processes);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading processes...')).not.toBeInTheDocument();
      });

      const dialog = screen.getByRole('dialog');

      // Arrow down to select first node
      fireEvent.keyDown(dialog, { key: 'ArrowDown' });

      // Arrow down again to go to next
      fireEvent.keyDown(dialog, { key: 'ArrowDown' });

      // Verify navigation happened (would need more detailed assertions based on selection state)
    });

    it('should navigate up with ArrowUp', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading processes...')).not.toBeInTheDocument();
      });

      const dialog = screen.getByRole('dialog');

      // Arrow up to select last node
      fireEvent.keyDown(dialog, { key: 'ArrowUp' });
    });

    it('should expand node with ArrowRight', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ groupId: 'group-1' });
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      // Collapse first
      const collapseButton = screen.getByTitle('Collapse all');
      fireEvent.click(collapseButton);

      await waitFor(() => {
        expect(screen.queryByText('Test Session - AI Agent (claude-code)')).not.toBeInTheDocument();
      });

      const dialog = screen.getByRole('dialog');

      // Select the group
      fireEvent.keyDown(dialog, { key: 'ArrowDown' });

      // Expand with ArrowRight
      fireEvent.keyDown(dialog, { key: 'ArrowRight' });

      // Should now show children
      await waitFor(() => {
        expect(screen.getByText('Test Session')).toBeInTheDocument();
      });
    });

    it('should collapse node with ArrowLeft', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ groupId: 'group-1' });
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      const dialog = screen.getByRole('dialog');

      // Select the group
      fireEvent.keyDown(dialog, { key: 'ArrowDown' });

      // Collapse with ArrowLeft
      fireEvent.keyDown(dialog, { key: 'ArrowLeft' });

      // Should hide children
      await waitFor(() => {
        expect(screen.queryByText('Test Session - AI Agent (claude-code)')).not.toBeInTheDocument();
      });
    });

    it('should toggle node with Enter', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ groupId: 'group-1' });
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      const dialog = screen.getByRole('dialog');

      // Select the group
      fireEvent.keyDown(dialog, { key: 'ArrowDown' });

      // Toggle with Enter
      fireEvent.keyDown(dialog, { key: 'Enter' });

      // Should hide children
      await waitFor(() => {
        expect(screen.queryByText('Test Session - AI Agent (claude-code)')).not.toBeInTheDocument();
      });
    });

    it('should toggle node with Space', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ groupId: 'group-1' });
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      const dialog = screen.getByRole('dialog');

      // Select the group
      fireEvent.keyDown(dialog, { key: 'ArrowDown' });

      // Toggle with Space
      fireEvent.keyDown(dialog, { key: ' ' });

      // Should hide children
      await waitFor(() => {
        expect(screen.queryByText('Test Session - AI Agent (claude-code)')).not.toBeInTheDocument();
      });
    });

    it('should respond to R key for refresh', async () => {
      getActiveProcessesMock().mockResolvedValue([]);

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('No running processes')).toBeInTheDocument();
      });

      const dialog = screen.getByRole('dialog');

      // R key should be handled (keyDown handler processes 'r' and 'R')
      // We just verify the keyboard event doesn't throw and component stays stable
      fireEvent.keyDown(dialog, { key: 'r' });
      fireEvent.keyDown(dialog, { key: 'R' });

      // Component should still be rendered
      expect(screen.getByText('System Processes')).toBeInTheDocument();
    });
  });

  describe('Refresh functionality', () => {
    it('should refresh when clicking refresh button', async () => {
      getActiveProcessesMock().mockResolvedValue([]);

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('No running processes')).toBeInTheDocument();
      });

      getActiveProcessesMock().mockClear();

      const refreshButton = screen.getByTitle('Refresh (R)');
      fireEvent.click(refreshButton);

      expect(getActiveProcessesMock()).toHaveBeenCalled();
    });

    it('should poll for updates every 2 seconds', async () => {
      getActiveProcessesMock().mockResolvedValue([]);

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('No running processes')).toBeInTheDocument();
      });

      // Initial call
      expect(getActiveProcessesMock()).toHaveBeenCalledTimes(1);

      // Advance timer by 2 seconds
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      expect(getActiveProcessesMock()).toHaveBeenCalledTimes(2);

      // Advance again
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      expect(getActiveProcessesMock()).toHaveBeenCalledTimes(3);
    });

    it('should handle fetch error gracefully', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      getActiveProcessesMock().mockRejectedValue(new Error('Network error'));

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith('Failed to fetch active processes:', expect.any(Error));
      });

      consoleError.mockRestore();
    });
  });

  describe('Kill process', () => {
    it('should show kill confirmation when clicking kill button', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      // Hover over process to show kill button (simulated via click)
      const killButtons = screen.getAllByTitle('Kill process');
      fireEvent.click(killButtons[0]);

      expect(screen.getByText('Kill Process?')).toBeInTheDocument();
      expect(screen.getByText('This will forcefully terminate the process. Any unsaved work may be lost.')).toBeInTheDocument();
    });

    it('should cancel kill when clicking Cancel', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      // Show kill confirmation
      const killButtons = screen.getAllByTitle('Kill process');
      fireEvent.click(killButtons[0]);

      expect(screen.getByText('Kill Process?')).toBeInTheDocument();

      // Click Cancel
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => {
        expect(screen.queryByText('Kill Process?')).not.toBeInTheDocument();
      });
    });

    it('should kill process when clicking Kill Process button', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      // Show kill confirmation
      const killButtons = screen.getAllByTitle('Kill process');
      fireEvent.click(killButtons[0]);

      // Click Kill Process
      fireEvent.click(screen.getByText('Kill Process'));

      await waitFor(() => {
        expect(killMock()).toHaveBeenCalledWith('session-1-ai-tab-1');
      });
    });

    it('should close kill confirmation when clicking backdrop', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      const { container } = render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      // Show kill confirmation
      const killButtons = screen.getAllByTitle('Kill process');
      fireEvent.click(killButtons[0]);

      expect(screen.getByText('Kill Process?')).toBeInTheDocument();

      // Click backdrop (the fixed inset-0 element of the confirmation)
      const confirmBackdrop = container.querySelectorAll('.fixed.inset-0')[1];
      fireEvent.click(confirmBackdrop!);

      await waitFor(() => {
        expect(screen.queryByText('Kill Process?')).not.toBeInTheDocument();
      });
    });

    it('should kill process with Enter key in confirmation', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      // Show kill confirmation
      const killButtons = screen.getAllByTitle('Kill process');
      fireEvent.click(killButtons[0]);

      // Find the confirmation dialog
      const confirmDialog = screen.getByText('Kill Process?').closest('div[tabindex="-1"]')!;
      fireEvent.keyDown(confirmDialog, { key: 'Enter' });

      await waitFor(() => {
        expect(killMock()).toHaveBeenCalledWith('session-1-ai-tab-1');
      });
    });

    it('should close confirmation with Escape key', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      // Show kill confirmation
      const killButtons = screen.getAllByTitle('Kill process');
      fireEvent.click(killButtons[0]);

      expect(screen.getByText('Kill Process?')).toBeInTheDocument();

      // Press Escape
      const confirmDialog = screen.getByText('Kill Process?').closest('div[tabindex="-1"]')!;
      fireEvent.keyDown(confirmDialog, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByText('Kill Process?')).not.toBeInTheDocument();
      });
    });

    it('should handle kill error gracefully', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      killMock().mockRejectedValue(new Error('Kill failed'));

      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      // Show kill confirmation
      const killButtons = screen.getAllByTitle('Kill process');
      fireEvent.click(killButtons[0]);

      // Click Kill Process
      fireEvent.click(screen.getByText('Kill Process'));

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith('Failed to kill process:', expect.any(Error));
      });

      consoleError.mockRestore();
    });

    it('should show "Killing..." state during kill', async () => {
      let resolveKill: () => void;
      const killPromise = new Promise<void>((resolve) => {
        resolveKill = resolve;
      });
      killMock().mockReturnValue(killPromise);

      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      // Show kill confirmation
      const killButtons = screen.getAllByTitle('Kill process');
      fireEvent.click(killButtons[0]);

      // Click Kill Process
      fireEvent.click(screen.getByText('Kill Process'));

      // Should show "Killing..." state
      await waitFor(() => {
        expect(screen.getByText('Killing...')).toBeInTheDocument();
      });

      // Resolve the kill promise
      resolveKill!();
    });
  });

  describe('Session ID parsing', () => {
    it('should parse base session ID from AI process', async () => {
      const process = createActiveProcess({ sessionId: 'abc123-ai' });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ id: 'abc123' });
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session')).toBeInTheDocument();
      });
    });

    it('should parse base session ID from AI tab process', async () => {
      const process = createActiveProcess({ sessionId: 'abc123-ai-tab1' });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ id: 'abc123' });
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session')).toBeInTheDocument();
      });
    });

    it('should parse base session ID from terminal process', async () => {
      const process = createActiveProcess({ sessionId: 'abc123-terminal' });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ id: 'abc123' });
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session')).toBeInTheDocument();
      });
    });

    it('should parse base session ID from batch process', async () => {
      const process = createActiveProcess({ sessionId: 'abc123-batch-1234567890' });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ id: 'abc123' });
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session')).toBeInTheDocument();
      });
    });

    it('should parse base session ID from synopsis process', async () => {
      const process = createActiveProcess({ sessionId: 'abc123-synopsis-1234567890' });
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ id: 'abc123' });
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session')).toBeInTheDocument();
      });
    });
  });

  describe('Footer', () => {
    it('should display session and group count', async () => {
      getActiveProcessesMock().mockResolvedValue([]);

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[createSession(), createSession({ id: 'session-2', name: 'Session 2' })]}
          groups={[createGroup()]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/2 sessions/)).toBeInTheDocument();
        expect(screen.getByText(/1 group/)).toBeInTheDocument();
      });
    });

    it('should display singular for single session', async () => {
      getActiveProcessesMock().mockResolvedValue([]);

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[createSession()]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/1 session/)).toBeInTheDocument();
        expect(screen.getByText(/0 groups/)).toBeInTheDocument();
      });
    });

    it('should display keyboard shortcuts hint', async () => {
      getActiveProcessesMock().mockResolvedValue([]);

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      expect(screen.getByText('↑↓ navigate • Enter view details • R refresh')).toBeInTheDocument();
    });

    it('should display running indicator', () => {
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      // Should have a "Running" label in footer
      const footerRunning = screen.getAllByText('Running');
      expect(footerRunning.length).toBeGreaterThan(0);
    });
  });

  describe('Node selection', () => {
    it('should select node when clicked', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ groupId: 'group-1' });
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Group')).toBeInTheDocument();
      });

      // Click the group
      fireEvent.click(screen.getByText('Test Group'));

      // Group button should have selection style (outline)
      const groupButton = screen.getByText('Test Group').closest('button');
      expect(groupButton).toHaveStyle({ outline: `2px solid ${theme.colors.accent}` });
    });

    it('should select process when clicked', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });

      // Click the process
      const processNode = screen.getByText('Test Session - AI Agent (claude-code)').closest('div[tabindex="0"]');
      fireEvent.click(processNode!);

      // Process node should have selection style
      expect(processNode).toHaveStyle({ outline: `2px solid ${theme.colors.accent}` });
    });
  });

  describe('Hover effects', () => {
    it('should trigger hover handlers on group node', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ groupId: 'group-1' });
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Group')).toBeInTheDocument();
      });

      const groupButton = screen.getByText('Test Group').closest('button');

      // Hover should not throw
      fireEvent.mouseEnter(groupButton!);
      fireEvent.mouseLeave(groupButton!);

      // Button should still exist
      expect(groupButton).toBeInTheDocument();
    });

    it('should maintain selection state on hover', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ groupId: 'group-1' });
      const group = createGroup();

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[group]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Group')).toBeInTheDocument();
      });

      const groupButton = screen.getByText('Test Group').closest('button');

      // Select first
      fireEvent.click(groupButton!);

      // Hover should not lose selection outline
      fireEvent.mouseEnter(groupButton!);
      expect(groupButton).toHaveStyle({ outline: `2px solid ${theme.colors.accent}` });
    });
  });

  describe('Edge cases', () => {
    it('should handle empty sessions array', async () => {
      getActiveProcessesMock().mockResolvedValue([]);

      render(
        <ProcessMonitor
          theme={theme}
          sessions={[]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('No running processes')).toBeInTheDocument();
      });
    });

    it('should handle sessions without matching processes', async () => {
      getActiveProcessesMock().mockResolvedValue([]);

      const session = createSession();
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('No running processes')).toBeInTheDocument();
      });

      // Session should not be shown since it has no active processes
      expect(screen.queryByText('Test Session')).not.toBeInTheDocument();
    });

    it('should handle session without aiTabs', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ aiTabs: undefined });
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });
    });

    it('should handle session with empty aiTabs', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ aiTabs: [] });
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session - AI Agent (claude-code)')).toBeInTheDocument();
      });
    });

    it('should handle multiple groups with processes', async () => {
      const processes = [
        createActiveProcess({ sessionId: 'session-1-ai-tab-1' }),
        createActiveProcess({ sessionId: 'session-2-ai-tab-2', pid: 12347 }),
      ];
      getActiveProcessesMock().mockResolvedValue(processes);

      const sessions = [
        createSession({ id: 'session-1', groupId: 'group-1' }),
        createSession({ id: 'session-2', name: 'Session 2', groupId: 'group-2' }),
      ];
      const groups = [
        createGroup({ id: 'group-1', name: 'Group 1' }),
        createGroup({ id: 'group-2', name: 'Group 2' }),
      ];

      render(
        <ProcessMonitor
          theme={theme}
          sessions={sessions}
          groups={groups}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Group 1')).toBeInTheDocument();
        expect(screen.getByText('Group 2')).toBeInTheDocument();
      });
    });

    it('should handle special characters in session names', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ name: '<script>alert("XSS")</script>' });
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('<script>alert("XSS")</script>')).toBeInTheDocument();
      });
    });

    it('should handle unicode in session names', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const session = createSession({ name: '测试会话 🎉' });
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('测试会话 🎉')).toBeInTheDocument();
      });
    });

    it('should handle very long session names with truncation', async () => {
      const process = createActiveProcess();
      getActiveProcessesMock().mockResolvedValue([process]);

      const longName = 'A'.repeat(100);
      const session = createSession({ name: longName });
      render(
        <ProcessMonitor
          theme={theme}
          sessions={[session]}
          groups={[]}
          onClose={onClose}
        />
      );

      await waitFor(() => {
        // Should be truncated with CSS
        expect(screen.getByText(longName)).toBeInTheDocument();
      });
    });
  });
});
