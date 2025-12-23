import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { AgentSessionsModal } from '../../../renderer/components/AgentSessionsModal';
import type { Theme, Session } from '../../../renderer/types';

// Mock LayerStackContext
const mockRegisterLayer = vi.fn(() => 'layer-id-1');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
  useLayerStack: () => ({
    registerLayer: mockRegisterLayer,
    unregisterLayer: mockUnregisterLayer,
    updateLayerHandler: mockUpdateLayerHandler,
  }),
}));

// Mock modal priorities
vi.mock('../../../renderer/constants/modalPriorities', () => ({
  MODAL_PRIORITIES: {
    AGENT_SESSIONS: 200,
  },
}));

// Create a mock theme
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

const lightTheme: Theme = {
  ...mockTheme,
  id: 'github-light',
  name: 'GitHub Light',
  mode: 'light',
};

// Create a mock session
const createMockSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1',
  name: 'Test Session',
  cwd: '/test/project',
  projectRoot: '/test/project',
  inputMode: 'ai',
  state: 'idle',
  toolType: 'claude-code',
  aiPid: 12345,
  terminalPid: 12346,
  aiLogs: [],
  shellLogs: [],
  isGitRepo: true,
  fileTree: [],
  fileExplorerExpanded: [],
  messageQueue: [],
  ...overrides,
} as Session);

// Create a mock Claude session
interface MockClaudeSession {
  sessionId: string;
  projectPath: string;
  timestamp: string;
  modifiedAt: string;
  firstMessage: string;
  messageCount: number;
  sizeBytes: number;
  sessionName?: string;
}

const createMockClaudeSession = (overrides: Partial<MockClaudeSession> = {}): MockClaudeSession => ({
  sessionId: 'claude-session-1',
  projectPath: '/test/project',
  timestamp: new Date().toISOString(),
  modifiedAt: new Date().toISOString(),
  firstMessage: 'Hello, can you help me?',
  messageCount: 10,
  sizeBytes: 1024 * 50, // 50KB
  ...overrides,
});

// Create a mock message
interface MockSessionMessage {
  type: string;
  role?: string;
  content: string;
  timestamp: string;
  uuid: string;
  toolUse?: any;
}

const createMockMessage = (overrides: Partial<MockSessionMessage> = {}): MockSessionMessage => ({
  type: 'user',
  content: 'Test message content',
  timestamp: new Date().toISOString(),
  uuid: `msg-${Math.random().toString(36).substr(2, 9)}`,
  ...overrides,
});

describe('AgentSessionsModal', () => {
  let mockOnClose: ReturnType<typeof vi.fn>;
  let mockOnResumeSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOnClose = vi.fn();
    mockOnResumeSession = vi.fn();
    mockRegisterLayer.mockClear();
    mockUnregisterLayer.mockClear();
    mockUpdateLayerHandler.mockClear();

    // Reset window.maestro mocks
    vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);
    vi.mocked(window.maestro.settings.set).mockResolvedValue(undefined);
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
    // Origin tracking remains Claude-specific
    vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initial Render', () => {
    it('should render with required props', async () => {
      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
    });

    it('should have correct dialog aria attributes', async () => {
      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-label', 'Agent Sessions');
      });
    });

    it('should show loading state initially', async () => {
      vi.mocked(window.maestro.agentSessions.listPaginated).mockImplementation(() =>
        new Promise(() => {})
      );

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      // Should show loading spinner
      expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    });

    it('should display search input with session name placeholder', async () => {
      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession({ name: 'My Project' })}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search My Project sessions...')).toBeInTheDocument();
      });
    });

    it('should display ESC badge', async () => {
      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('ESC')).toBeInTheDocument();
      });
    });

    it('should focus search input on mount', async () => {
      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      // Wait for the setTimeout(50) focus delay
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Search.*sessions/)).toHaveFocus();
      }, { timeout: 200 });
    });
  });

  describe('Layer Stack Integration', () => {
    it('should register layer on mount', async () => {
      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(mockRegisterLayer).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'modal',
            blocksLowerLayers: true,
            capturesFocus: true,
            focusTrap: 'strict',
            ariaLabel: 'Agent Sessions',
          })
        );
      });
    });

    it('should unregister layer on unmount', async () => {
      const { unmount } = render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(mockRegisterLayer).toHaveBeenCalled();
      });

      unmount();

      expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-id-1');
    });

    it('should call onClose via escape handler in list view', async () => {
      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(mockRegisterLayer).toHaveBeenCalled();
      });

      // Get the escape handler from registerLayer call
      const escapeHandler = mockRegisterLayer.mock.calls[0][0].onEscape;
      escapeHandler();

      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe('Sessions Loading', () => {
    it('should load sessions for active project', async () => {
      const mockSessions = [createMockClaudeSession()];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession({ cwd: '/my/project', projectRoot: '/my/project' })}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(window.maestro.agentSessions.listPaginated).toHaveBeenCalledWith(
          'claude-code',
          '/my/project',
          { limit: 100 }
        );
      });
    });

    it('should not load sessions when no activeSession', async () => {
      const listSessionsMock = vi.fn().mockResolvedValue({
        sessions: [],
        hasMore: false,
        totalCount: 0,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockImplementation(listSessionsMock);

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={undefined}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      // Wait a bit for potential async calls
      await new Promise(r => setTimeout(r, 50));

      expect(listSessionsMock).not.toHaveBeenCalled();
    });

    it('should display empty state when no sessions', async () => {
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: [],
        hasMore: false,
        totalCount: 0,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('No Claude sessions found for this project')).toBeInTheDocument();
      });
    });

    it('should display sessions when loaded', async () => {
      const mockSessions = [
        createMockClaudeSession({ sessionId: 's1', firstMessage: 'First session message' }),
        createMockClaudeSession({ sessionId: 's2', firstMessage: 'Second session message' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('First session message')).toBeInTheDocument();
        expect(screen.getByText('Second session message')).toBeInTheDocument();
      });
    });

    it('should display session with sessionName instead of firstMessage', async () => {
      const mockSessions = [
        createMockClaudeSession({ sessionName: 'Named Session', firstMessage: 'Should not show' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Named Session')).toBeInTheDocument();
      });
    });

    it('should display session ID fallback when no name or message', async () => {
      const mockSessions = [
        createMockClaudeSession({ sessionId: 'abcdef12345678', sessionName: undefined, firstMessage: '' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Session abcdef12...')).toBeInTheDocument();
      });
    });
  });

  describe('Session Metadata Display', () => {
    it('should display message count', async () => {
      const mockSessions = [createMockClaudeSession({ messageCount: 42 })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('42 msgs')).toBeInTheDocument();
      });
    });

    it('should format size in bytes', async () => {
      const mockSessions = [createMockClaudeSession({ sizeBytes: 500 })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('500 B')).toBeInTheDocument();
      });
    });

    it('should format size in KB', async () => {
      const mockSessions = [createMockClaudeSession({ sizeBytes: 5120 })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('5.0 KB')).toBeInTheDocument();
      });
    });

    it('should format size in MB', async () => {
      const mockSessions = [createMockClaudeSession({ sizeBytes: 2 * 1024 * 1024 })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('2.0 MB')).toBeInTheDocument();
      });
    });
  });

  describe('Relative Time Formatting', () => {
    it('should display "just now" for recent timestamps', async () => {
      const mockSessions = [createMockClaudeSession({ modifiedAt: new Date().toISOString() })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('just now')).toBeInTheDocument();
      });
    });

    it('should display minutes ago', async () => {
      const date = new Date();
      date.setMinutes(date.getMinutes() - 15);
      const mockSessions = [createMockClaudeSession({ modifiedAt: date.toISOString() })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('15m ago')).toBeInTheDocument();
      });
    });

    it('should display hours ago', async () => {
      const date = new Date();
      date.setHours(date.getHours() - 5);
      const mockSessions = [createMockClaudeSession({ modifiedAt: date.toISOString() })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('5h ago')).toBeInTheDocument();
      });
    });

    it('should display days ago', async () => {
      const date = new Date();
      date.setDate(date.getDate() - 3);
      const mockSessions = [createMockClaudeSession({ modifiedAt: date.toISOString() })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('3d ago')).toBeInTheDocument();
      });
    });

    it('should display full date for old timestamps', async () => {
      const date = new Date();
      date.setDate(date.getDate() - 30);
      const mockSessions = [createMockClaudeSession({ modifiedAt: date.toISOString() })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        // Should show short date format (e.g., "Nov 13")
        const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        expect(screen.getByText(dateStr)).toBeInTheDocument();
      });
    });
  });

  describe('Search Functionality', () => {
    it('should filter sessions by firstMessage', async () => {
      const mockSessions = [
        createMockClaudeSession({ sessionId: 's1', firstMessage: 'Help with React' }),
        createMockClaudeSession({ sessionId: 's2', firstMessage: 'Fix Python bug' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Help with React')).toBeInTheDocument();
      });

      // Type in search
      const input = screen.getByPlaceholderText(/Search.*sessions/);
      fireEvent.change(input, { target: { value: 'python' } });

      await waitFor(() => {
        expect(screen.queryByText('Help with React')).not.toBeInTheDocument();
        expect(screen.getByText('Fix Python bug')).toBeInTheDocument();
      });
    });

    it('should filter sessions by sessionName', async () => {
      const mockSessions = [
        createMockClaudeSession({ sessionId: 's1', sessionName: 'Auth Feature', firstMessage: 'test' }),
        createMockClaudeSession({ sessionId: 's2', sessionName: 'Database Migration', firstMessage: 'test' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Auth Feature')).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/Search.*sessions/);
      fireEvent.change(input, { target: { value: 'database' } });

      await waitFor(() => {
        expect(screen.queryByText('Auth Feature')).not.toBeInTheDocument();
        expect(screen.getByText('Database Migration')).toBeInTheDocument();
      });
    });

    it('should filter sessions by sessionId', async () => {
      const mockSessions = [
        createMockClaudeSession({ sessionId: 'abc123xyz', firstMessage: 'Session 1' }),
        createMockClaudeSession({ sessionId: 'def456uvw', firstMessage: 'Session 2' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Session 1')).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/Search.*sessions/);
      fireEvent.change(input, { target: { value: 'def456' } });

      await waitFor(() => {
        expect(screen.queryByText('Session 1')).not.toBeInTheDocument();
        expect(screen.getByText('Session 2')).toBeInTheDocument();
      });
    });

    it('should show no results message when search matches nothing', async () => {
      const mockSessions = [createMockClaudeSession({ firstMessage: 'Test session' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test session')).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/Search.*sessions/);
      fireEvent.change(input, { target: { value: 'nonexistent' } });

      await waitFor(() => {
        expect(screen.getByText('No sessions match your search')).toBeInTheDocument();
      });
    });

    it('should reset selection when search changes', async () => {
      const mockSessions = [
        createMockClaudeSession({ sessionId: 's1', firstMessage: 'First' }),
        createMockClaudeSession({ sessionId: 's2', firstMessage: 'Second' }),
        createMockClaudeSession({ sessionId: 's3', firstMessage: 'Third' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 3,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('First')).toBeInTheDocument();
      });

      // Navigate down twice
      const input = screen.getByPlaceholderText(/Search.*sessions/);
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'ArrowDown' });

      // Now search - should reset to index 0
      fireEvent.change(input, { target: { value: 'ird' } });

      // The first visible item should be selected (Third)
      await waitFor(() => {
        const buttons = screen.getAllByRole('button');
        const sessionButton = buttons.find(b => b.textContent?.includes('Third'));
        expect(sessionButton).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
      });
    });
  });

  describe('Keyboard Navigation', () => {
    it('should navigate down with ArrowDown', async () => {
      const mockSessions = [
        createMockClaudeSession({ sessionId: 's1', firstMessage: 'First' }),
        createMockClaudeSession({ sessionId: 's2', firstMessage: 'Second' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('First')).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/Search.*sessions/);

      // First item should be selected initially
      const firstButton = screen.getByText('First').closest('button');
      expect(firstButton).toHaveStyle({ backgroundColor: mockTheme.colors.accent });

      fireEvent.keyDown(input, { key: 'ArrowDown' });

      await waitFor(() => {
        const secondButton = screen.getByText('Second').closest('button');
        expect(secondButton).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
      });
    });

    it('should navigate up with ArrowUp', async () => {
      const mockSessions = [
        createMockClaudeSession({ sessionId: 's1', firstMessage: 'First' }),
        createMockClaudeSession({ sessionId: 's2', firstMessage: 'Second' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('First')).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/Search.*sessions/);

      // Navigate down then up
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'ArrowUp' });

      await waitFor(() => {
        const firstButton = screen.getByText('First').closest('button');
        expect(firstButton).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
      });
    });

    it('should not go below last item', async () => {
      const mockSessions = [
        createMockClaudeSession({ sessionId: 's1', firstMessage: 'First' }),
        createMockClaudeSession({ sessionId: 's2', firstMessage: 'Second' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('First')).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/Search.*sessions/);

      // Try to navigate way down
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'ArrowDown' });

      await waitFor(() => {
        const secondButton = screen.getByText('Second').closest('button');
        expect(secondButton).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
      });
    });

    it('should not go above first item', async () => {
      const mockSessions = [
        createMockClaudeSession({ sessionId: 's1', firstMessage: 'First' }),
        createMockClaudeSession({ sessionId: 's2', firstMessage: 'Second' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('First')).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/Search.*sessions/);

      // Try to navigate up when at first
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      fireEvent.keyDown(input, { key: 'ArrowUp' });

      await waitFor(() => {
        const firstButton = screen.getByText('First').closest('button');
        expect(firstButton).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
      });
    });

    it('should open session view on Enter', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1', firstMessage: 'Test Session' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session')).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/Search.*sessions/);
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        // Should switch to message view (Resume button appears)
        expect(screen.getByText('Resume')).toBeInTheDocument();
      });
    });
  });

  describe('Session View', () => {
    it('should click to view session', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1', firstMessage: 'Test Session' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [createMockMessage({ content: 'Hello' })],
        total: 1,
        hasMore: false,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session')).toBeInTheDocument();
      });

      // Click on session
      fireEvent.click(screen.getByText('Test Session'));

      await waitFor(() => {
        expect(window.maestro.agentSessions.read).toHaveBeenCalled();
        expect(screen.getByText('Resume')).toBeInTheDocument();
      });
    });

    it('should display back button in session view', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1', firstMessage: 'Test Session' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Test Session'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: '' })).toBeInTheDocument(); // ChevronLeft icon button
      });
    });

    it('should go back to list view when clicking back button', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1', firstMessage: 'Test Session' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test Session')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Test Session'));

      await waitFor(() => {
        expect(screen.getByText('Resume')).toBeInTheDocument();
      });

      // Click back button (first button in header)
      const buttons = screen.getAllByRole('button');
      fireEvent.click(buttons[0]); // ChevronLeft button

      await waitFor(() => {
        // Should be back in list view
        expect(screen.getByPlaceholderText(/Search.*sessions/)).toBeInTheDocument();
      });
    });

    it('should display session header info', async () => {
      const mockSessions = [createMockClaudeSession({
        sessionId: 's1',
        sessionName: 'My Session',
        modifiedAt: new Date().toISOString(),
      })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [],
        total: 5,
        hasMore: false,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('My Session')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('My Session'));

      await waitFor(() => {
        expect(screen.getByText(/5 messages/)).toBeInTheDocument();
        expect(screen.getByText(/just now/)).toBeInTheDocument();
      });
    });

    it('should display session preview fallback in header', async () => {
      const mockSessions = [createMockClaudeSession({
        sessionId: 's1',
        sessionName: undefined,
        firstMessage: '',
      })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/Session s1/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/Session s1/));

      await waitFor(() => {
        // Header should show "Session Preview" fallback
        expect(screen.getByText('Session Preview')).toBeInTheDocument();
      });
    });
  });

  describe('Message Display', () => {
    it('should display user messages aligned right', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [createMockMessage({ type: 'user', content: 'User message' })],
        total: 1,
        hasMore: false,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        fireEvent.click(screen.getByText(/Hello, can you help me/));
      });

      await waitFor(() => {
        expect(screen.getByText('User message')).toBeInTheDocument();
        const messageContainer = screen.getByText('User message').closest('.flex');
        expect(messageContainer).toHaveClass('justify-end');
      });
    });

    it('should display assistant messages aligned left', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [createMockMessage({ type: 'assistant', content: 'Assistant message' })],
        total: 1,
        hasMore: false,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        fireEvent.click(screen.getByText(/Hello, can you help me/));
      });

      await waitFor(() => {
        expect(screen.getByText('Assistant message')).toBeInTheDocument();
        const messageContainer = screen.getByText('Assistant message').closest('.flex');
        expect(messageContainer).toHaveClass('justify-start');
      });
    });

    it('should display tool use fallback when no content', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [createMockMessage({
          type: 'assistant',
          content: '',
          toolUse: [{ name: 'read_file' }],
        })],
        total: 1,
        hasMore: false,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        fireEvent.click(screen.getByText(/Hello, can you help me/));
      });

      await waitFor(() => {
        // ToolCallCard component displays tool name without brackets (collapsible card format)
        expect(screen.getByText('Tool: read_file')).toBeInTheDocument();
      });
    });

    it('should display no content fallback', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [createMockMessage({
          type: 'assistant',
          content: '',
          toolUse: undefined,
        })],
        total: 1,
        hasMore: false,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        fireEvent.click(screen.getByText(/Hello, can you help me/));
      });

      await waitFor(() => {
        expect(screen.getByText('[No content]')).toBeInTheDocument();
      });
    });

    it('should display loading state for messages', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockImplementation(() =>
        new Promise(() => {})
      );

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        fireEvent.click(screen.getByText(/Hello, can you help me/));
      });

      await waitFor(() => {
        expect(document.querySelector('.animate-spin')).toBeInTheDocument();
      });
    });

    it('should apply user message styling in dark mode', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [createMockMessage({ type: 'user', content: 'Dark mode message' })],
        total: 1,
        hasMore: false,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        fireEvent.click(screen.getByText(/Hello, can you help me/));
      });

      await waitFor(() => {
        const messageBubble = screen.getByText('Dark mode message').closest('.rounded-lg');
        expect(messageBubble).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
        expect(messageBubble).toHaveStyle({ color: '#000' }); // Dark mode uses black text
      });
    });

    it('should apply user message styling in light mode', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [createMockMessage({ type: 'user', content: 'Light mode message' })],
        total: 1,
        hasMore: false,
      });

      render(
        <AgentSessionsModal
          theme={lightTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        fireEvent.click(screen.getByText(/Hello, can you help me/));
      });

      await waitFor(() => {
        const messageBubble = screen.getByText('Light mode message').closest('.rounded-lg');
        expect(messageBubble).toHaveStyle({ color: '#fff' }); // Light mode uses white text
      });
    });
  });

  describe('Message Pagination', () => {
    it('should load more messages button when hasMoreMessages', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockResolvedValue({
        messages: [createMockMessage({ content: 'First batch' })],
        total: 50,
        hasMore: true,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        fireEvent.click(screen.getByText(/Hello, can you help me/));
      });

      await waitFor(() => {
        expect(screen.getByText('Load earlier messages...')).toBeInTheDocument();
      });
    });

    it('should load more messages when clicking load more', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      let callCount = 0;
      vi.mocked(window.maestro.agentSessions.read).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            messages: [createMockMessage({ content: 'Recent message' })],
            total: 50,
            hasMore: true,
          };
        }
        return {
          messages: [createMockMessage({ content: 'Older message' })],
          total: 50,
          hasMore: false,
        };
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        fireEvent.click(screen.getByText(/Hello, can you help me/));
      });

      await waitFor(() => {
        expect(screen.getByText('Load earlier messages...')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Load earlier messages...'));

      await waitFor(() => {
        expect(screen.getByText('Older message')).toBeInTheDocument();
      });
    });
  });

  describe('Resume Session', () => {
    it('should call onResumeSession when clicking Resume button', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 'session-123' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        fireEvent.click(screen.getByText(/Hello, can you help me/));
      });

      await waitFor(() => {
        expect(screen.getByText('Resume')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Resume'));

      expect(mockOnResumeSession).toHaveBeenCalledWith('session-123');
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe('Starred Sessions', () => {
    it('should load starred sessions from session origins', async () => {
      vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
        'session-1': { origin: 'user', starred: true },
      });

      const mockSessions = [
        createMockClaudeSession({ sessionId: 'session-1', firstMessage: 'Starred session' }),
        createMockClaudeSession({ sessionId: 'session-2', firstMessage: 'Not starred' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession({ cwd: '/test/project' })}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(window.maestro.claude.getSessionOrigins).toHaveBeenCalledWith('/test/project');
      });
    });

    it('should sort starred sessions to top', async () => {
      vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
        'session-2': { origin: 'user', starred: true },
      });

      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const mockSessions = [
        createMockClaudeSession({
          sessionId: 'session-1',
          firstMessage: 'Not starred but newer',
          modifiedAt: now.toISOString(),
        }),
        createMockClaudeSession({
          sessionId: 'session-2',
          firstMessage: 'Starred but older',
          modifiedAt: oneHourAgo.toISOString(),
        }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 2,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession({ cwd: '/test/project' })}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        const buttons = screen.getAllByRole('button');
        const sessionButtons = buttons.filter(b =>
          b.textContent?.includes('Not starred') || b.textContent?.includes('Starred')
        );
        // Starred session should come first even though it's older
        expect(sessionButtons[0].textContent).toContain('Starred');
      });
    });

    it('should toggle star on click', async () => {
      vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({});

      const mockSessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession({ cwd: '/test/project' })}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle('Add to favorites')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Add to favorites'));

      await waitFor(() => {
        expect(screen.getByTitle('Remove from favorites')).toBeInTheDocument();
        expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
          '/test/project',
          'session-1',
          true
        );
      });
    });

    it('should unstar session on second click', async () => {
      vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
        'session-1': { origin: 'user', starred: true },
      });

      const mockSessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession({ cwd: '/test/project' })}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle('Remove from favorites')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Remove from favorites'));

      await waitFor(() => {
        expect(screen.getByTitle('Add to favorites')).toBeInTheDocument();
        expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
          '/test/project',
          'session-1',
          false
        );
      });
    });

    it('uses projectRoot (not cwd) for starring when they differ', async () => {
      // This tests the fix for the cwd vs projectRoot bug
      vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({});

      const mockSessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession({
            cwd: '/test/project/some/subdir',  // Changed via cd
            projectRoot: '/test/project',       // Original project root
          })}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle('Add to favorites')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Add to favorites'));

      await waitFor(() => {
        expect(window.maestro.claude.updateSessionStarred).toHaveBeenCalledWith(
          '/test/project',  // projectRoot, not '/test/project/some/subdir'
          'session-1',
          true
        );
      });
    });

    it('should not open session view when clicking star', async () => {
      vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({});

      const mockSessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle('Add to favorites')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Add to favorites'));

      await waitFor(() => {
        // Should still be in list view
        expect(screen.getByPlaceholderText(/Search.*sessions/)).toBeInTheDocument();
        expect(screen.queryByText('Resume')).not.toBeInTheDocument();
      });
    });
  });

  describe('Sessions Pagination', () => {
    it('should show pagination indicator when hasMoreSessions', async () => {
      const mockSessions = Array.from({ length: 100 }, (_, i) =>
        createMockClaudeSession({ sessionId: `s${i}`, firstMessage: `Session ${i}` })
      );
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: true,
        totalCount: 250,
        nextCursor: 'cursor-100',
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('100 of 250 sessions loaded')).toBeInTheDocument();
      });
    });

    it('should not show pagination indicator when searching', async () => {
      const mockSessions = [createMockClaudeSession({ firstMessage: 'Test' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: true,
        totalCount: 250,
        nextCursor: 'cursor-100',
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test')).toBeInTheDocument();
      });

      const input = screen.getByPlaceholderText(/Search.*sessions/);
      fireEvent.change(input, { target: { value: 'test' } });

      await waitFor(() => {
        expect(screen.queryByText(/sessions loaded/)).not.toBeInTheDocument();
      });
    });

    it('should load more sessions on scroll', async () => {
      const mockSessions = Array.from({ length: 100 }, (_, i) =>
        createMockClaudeSession({ sessionId: `s${i}`, firstMessage: `Session ${i}` })
      );

      let callCount = 0;
      vi.mocked(window.maestro.agentSessions.listPaginated).mockImplementation(async (cwd, opts) => {
        callCount++;
        if (callCount === 1) {
          return {
            sessions: mockSessions,
            hasMore: true,
            totalCount: 200,
            nextCursor: 'cursor-100',
          };
        }
        return {
          sessions: mockSessions.map(s => ({ ...s, sessionId: s.sessionId + '-more' })),
          hasMore: false,
          totalCount: 200,
          nextCursor: null,
        };
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('100 of 200 sessions loaded')).toBeInTheDocument();
      });

      // Simulate scroll to 70%
      const container = document.querySelector('.overflow-y-auto.py-2');
      if (container) {
        Object.defineProperty(container, 'scrollTop', { value: 700, writable: true });
        Object.defineProperty(container, 'scrollHeight', { value: 1000, writable: true });
        Object.defineProperty(container, 'clientHeight', { value: 100, writable: true });
        fireEvent.scroll(container);
      }

      await waitFor(() => {
        expect(window.maestro.agentSessions.listPaginated).toHaveBeenCalledWith(
          'claude-code',
          expect.anything(),
          { cursor: 'cursor-100', limit: 100 }
        );
      });
    });

    it('should show loading indicator while loading more sessions', async () => {
      const mockSessions = [createMockClaudeSession()];
      vi.mocked(window.maestro.agentSessions.listPaginated)
        .mockResolvedValueOnce({
          sessions: mockSessions,
          hasMore: true,
          totalCount: 200,
          nextCursor: 'cursor-100',
        })
        .mockImplementation(() => new Promise(() => {}));

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/sessions loaded/)).toBeInTheDocument();
      });

      // Simulate scroll to 70%
      const container = document.querySelector('.overflow-y-auto.py-2');
      if (container) {
        Object.defineProperty(container, 'scrollTop', { value: 700, writable: true });
        Object.defineProperty(container, 'scrollHeight', { value: 1000, writable: true });
        Object.defineProperty(container, 'clientHeight', { value: 100, writable: true });
        fireEvent.scroll(container);
      }

      await waitFor(() => {
        expect(screen.getByText('Loading more sessions...')).toBeInTheDocument();
      });
    });

    it('should not load more if already loading', async () => {
      const mockSessions = [createMockClaudeSession()];
      let resolveSecond: (() => void) | undefined;
      const secondPromise = new Promise<void>(r => { resolveSecond = r; });
      let callCount = 0;

      const listSessionsMock = vi.fn().mockImplementation(async (cwd: string, opts?: { cursor?: string }) => {
        callCount++;
        if (callCount === 1) {
          return {
            sessions: mockSessions,
            hasMore: true,
            totalCount: 200,
            nextCursor: 'cursor-100',
          };
        }
        await secondPromise;
        return {
          sessions: mockSessions,
          hasMore: false,
          totalCount: 200,
          nextCursor: null,
        };
      });
      vi.mocked(window.maestro.agentSessions.listPaginated).mockImplementation(listSessionsMock);

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/sessions loaded/)).toBeInTheDocument();
      });

      const container = document.querySelector('.overflow-y-auto.py-2');
      if (container) {
        Object.defineProperty(container, 'scrollTop', { value: 700, writable: true });
        Object.defineProperty(container, 'scrollHeight', { value: 1000, writable: true });
        Object.defineProperty(container, 'clientHeight', { value: 100, writable: true });

        // Trigger multiple scrolls
        fireEvent.scroll(container);
        fireEvent.scroll(container);
        fireEvent.scroll(container);
      }

      // Should only have been called twice (initial + 1 load more)
      // Even with multiple scroll events, it shouldn't call again while loading
      expect(listSessionsMock).toHaveBeenCalledTimes(2);

      resolveSecond!();
    });

    it('should deduplicate sessions when loading more', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 'unique-1' })];

      vi.mocked(window.maestro.agentSessions.listPaginated)
        .mockResolvedValueOnce({
          sessions: mockSessions,
          hasMore: true,
          totalCount: 2,
          nextCursor: 'cursor-1',
        })
        .mockResolvedValueOnce({
          sessions: [
            createMockClaudeSession({ sessionId: 'unique-1', firstMessage: 'Duplicate' }),
            createMockClaudeSession({ sessionId: 'unique-2', firstMessage: 'New' }),
          ],
          hasMore: false,
          totalCount: 2,
          nextCursor: null,
        });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/sessions loaded/)).toBeInTheDocument();
      });

      const container = document.querySelector('.overflow-y-auto.py-2');
      if (container) {
        Object.defineProperty(container, 'scrollTop', { value: 700, writable: true });
        Object.defineProperty(container, 'scrollHeight', { value: 1000, writable: true });
        Object.defineProperty(container, 'clientHeight', { value: 100, writable: true });
        fireEvent.scroll(container);
      }

      await waitFor(() => {
        expect(screen.getByText('New')).toBeInTheDocument();
      });

      // Should only show each session once
      const sessionButtons = screen.getAllByRole('button').filter(b =>
        b.textContent?.includes('Hello, can you help me') || b.textContent?.includes('New')
      );
      expect(sessionButtons.length).toBe(2);
    });
  });

  describe('Escape Handler Updates', () => {
    it('should update layer handler when viewingSession changes', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/Hello, can you help me/)).toBeInTheDocument();
      });

      mockUpdateLayerHandler.mockClear();

      fireEvent.click(screen.getByText(/Hello, can you help me/));

      await waitFor(() => {
        expect(mockUpdateLayerHandler).toHaveBeenCalled();
      });
    });

    it('should go back to list view on Escape when viewing session', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/Hello, can you help me/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/Hello, can you help me/));

      await waitFor(() => {
        expect(screen.getByText('Resume')).toBeInTheDocument();
      });

      // Get updated handler (after viewingSession changed)
      expect(mockUpdateLayerHandler).toHaveBeenCalled();
      const lastCall = mockUpdateLayerHandler.mock.calls[mockUpdateLayerHandler.mock.calls.length - 1];
      const updatedHandler = lastCall[1];

      // Call the escape handler - this should clear viewingSession
      await act(async () => {
        updatedHandler();
      });

      await waitFor(() => {
        // Should be back in list view with search input
        expect(screen.getByPlaceholderText(/Search.*sessions/)).toBeInTheDocument();
      });

      // onClose should not have been called - escape in session view goes back to list
      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle session loading error gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(window.maestro.agentSessions.listPaginated).mockRejectedValue(new Error('Load failed'));

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('Failed to load sessions:', expect.any(Error));
      });

      // Should show empty state
      await waitFor(() => {
        expect(screen.getByText('No Claude sessions found for this project')).toBeInTheDocument();
      });

      consoleSpy.mockRestore();
    });

    it('should handle message loading error gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockSessions = [createMockClaudeSession({ sessionId: 's1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });
      vi.mocked(window.maestro.agentSessions.read).mockRejectedValue(new Error('Read failed'));

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        fireEvent.click(screen.getByText(/Hello, can you help me/));
      });

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('Failed to load messages:', expect.any(Error));
      });

      consoleSpy.mockRestore();
    });

    it('should handle load more sessions error gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockSessions = [createMockClaudeSession()];
      vi.mocked(window.maestro.agentSessions.listPaginated)
        .mockResolvedValueOnce({
          sessions: mockSessions,
          hasMore: true,
          totalCount: 200,
          nextCursor: 'cursor-100',
        })
        .mockRejectedValueOnce(new Error('Load more failed'));

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/sessions loaded/)).toBeInTheDocument();
      });

      const container = document.querySelector('.overflow-y-auto.py-2');
      if (container) {
        Object.defineProperty(container, 'scrollTop', { value: 700, writable: true });
        Object.defineProperty(container, 'scrollHeight', { value: 1000, writable: true });
        Object.defineProperty(container, 'clientHeight', { value: 100, writable: true });
        fireEvent.scroll(container);
      }

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('Failed to load more sessions:', expect.any(Error));
      });

      consoleSpy.mockRestore();
    });
  });

  describe('Theme Styling', () => {
    it('should apply theme colors to modal', async () => {
      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveStyle({
          backgroundColor: mockTheme.colors.bgActivity,
          borderColor: mockTheme.colors.border,
        });
      });
    });

    it('should apply accent color to Resume button', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        fireEvent.click(screen.getByText(/Hello, can you help me/));
      });

      await waitFor(() => {
        const resumeButton = screen.getByText('Resume');
        expect(resumeButton).toHaveStyle({
          backgroundColor: mockTheme.colors.accent,
          color: mockTheme.colors.accentForeground,
        });
      });
    });

    it('should apply warning color to starred icon', async () => {
      vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
        'session-1': { origin: 'user', starred: true },
      });

      const mockSessions = [createMockClaudeSession({ sessionId: 'session-1' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession({ cwd: '/test/project' })}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        const starButton = screen.getByTitle('Remove from favorites');
        const starIcon = starButton.querySelector('svg');
        expect(starIcon).toHaveStyle({
          color: mockTheme.colors.warning,
          fill: mockTheme.colors.warning,
        });
      });
    });
  });

  describe('Scroll Behavior', () => {
    it('should scroll selected item into view', async () => {
      const scrollIntoViewMock = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoViewMock;

      const mockSessions = [
        createMockClaudeSession({ sessionId: 's1', firstMessage: 'First' }),
        createMockClaudeSession({ sessionId: 's2', firstMessage: 'Second' }),
        createMockClaudeSession({ sessionId: 's3', firstMessage: 'Third' }),
      ];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 3,
        nextCursor: null,
      });

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('First')).toBeInTheDocument();
      });

      scrollIntoViewMock.mockClear();

      const input = screen.getByPlaceholderText(/Search.*sessions/);
      fireEvent.keyDown(input, { key: 'ArrowDown' });

      await waitFor(() => {
        expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
      });
    });
  });

  describe('Modal Reset on Reopen', () => {
    it('should reset to list view when modal reopens', async () => {
      const mockSessions = [createMockClaudeSession({ sessionId: 's1', firstMessage: 'Test' })];
      vi.mocked(window.maestro.agentSessions.listPaginated).mockResolvedValue({
        sessions: mockSessions,
        hasMore: false,
        totalCount: 1,
        nextCursor: null,
      });

      const { rerender, unmount } = render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        fireEvent.click(screen.getByText('Test'));
      });

      await waitFor(() => {
        expect(screen.getByText('Resume')).toBeInTheDocument();
      });

      // Unmount and remount
      unmount();

      render(
        <AgentSessionsModal
          theme={mockTheme}
          activeSession={createMockSession()}
          onClose={mockOnClose}
          onResumeSession={mockOnResumeSession}
        />
      );

      await waitFor(() => {
        // Should be in list view
        expect(screen.getByPlaceholderText(/Search.*sessions/)).toBeInTheDocument();
      });
    });
  });

  describe('Default Export', () => {
    it('should export AgentSessionsModal as named export', async () => {
      expect(AgentSessionsModal).toBeDefined();
      expect(typeof AgentSessionsModal).toBe('function');
    });
  });
});
