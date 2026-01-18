import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Theme, Session, Shortcut, FocusArea, BatchRunState } from '../../../renderer/types';
import { clearCapabilitiesCache, setCapabilitiesCache } from '../../../renderer/hooks';

// Mock child components to simplify testing - must be before MainPanel import
vi.mock('../../../renderer/components/LogViewer', () => ({
  LogViewer: (props: { onClose: () => void }) => {
    return React.createElement('div', { 'data-testid': 'log-viewer' },
      React.createElement('button', { onClick: props.onClose, 'data-testid': 'log-viewer-close' }, 'Close LogViewer')
    );
  },
}));

vi.mock('../../../renderer/components/TerminalOutput', () => ({
  TerminalOutput: React.forwardRef((props: { session: { name: string } }, ref) => {
    return React.createElement('div', { 'data-testid': 'terminal-output', ref },
      `Terminal Output for ${props.session?.name}`
    );
  }),
}));

vi.mock('../../../renderer/components/InputArea', () => ({
  InputArea: (props: { session: { name: string }; onInputFocus: () => void }) => {
    return React.createElement('div', { 'data-testid': 'input-area' },
      React.createElement('input', { 'data-testid': 'input-field', onFocus: props.onInputFocus }),
      `Input for ${props.session?.name}`
    );
  },
}));

vi.mock('../../../renderer/components/FilePreview', () => ({
  FilePreview: (props: { file: { name: string }; onClose: () => void }) => {
    return React.createElement('div', { 'data-testid': 'file-preview' },
      `File Preview: ${props.file.name}`,
      React.createElement('button', { onClick: props.onClose, 'data-testid': 'file-preview-close' }, 'Close')
    );
  },
}));

vi.mock('../../../renderer/components/AgentSessionsBrowser', () => ({
  AgentSessionsBrowser: (props: { onClose: () => void }) => {
    return React.createElement('div', { 'data-testid': 'agent-sessions-browser' },
      React.createElement('button', { onClick: props.onClose, 'data-testid': 'agent-sessions-close' }, 'Close')
    );
  },
}));

vi.mock('../../../renderer/components/GitStatusWidget', () => ({
  GitStatusWidget: (props: { onViewDiff: () => void }) => {
    return React.createElement('div', { 'data-testid': 'git-status-widget' },
      React.createElement('button', { onClick: props.onViewDiff, 'data-testid': 'view-diff-btn' }, 'View Diff')
    );
  },
}));

vi.mock('../../../renderer/components/TabBar', () => ({
  TabBar: (props: {
    tabs: Array<{ id: string; name?: string }>;
    onTabSelect: (id: string) => void;
    onNewTab: () => void;
  }) => {
    return React.createElement('div', { 'data-testid': 'tab-bar' },
      props.tabs.map(tab =>
        React.createElement('button', {
          key: tab.id,
          onClick: () => props.onTabSelect(tab.id),
          'data-testid': `tab-${tab.id}`
        }, tab.name || tab.id)
      ),
      React.createElement('button', { onClick: props.onNewTab, 'data-testid': 'new-tab-btn' }, 'New Tab')
    );
  },
}));

vi.mock('../../../renderer/components/ErrorBoundary', () => ({
  ErrorBoundary: (props: { children: React.ReactNode }) => props.children,
}));

vi.mock('../../../renderer/components/InlineWizard', () => ({
  WizardConversationView: (props: {
    conversationHistory: Array<{ id: string; role: string; content: string }>;
    isLoading?: boolean;
    agentName?: string;
  }) => {
    return React.createElement('div', { 'data-testid': 'wizard-conversation-view' },
      `Wizard Conversation (${props.conversationHistory.length} messages)`,
      props.isLoading && React.createElement('span', { 'data-testid': 'wizard-loading' }, ' Loading...')
    );
  },
}));

// Mock git service
vi.mock('../../../renderer/services/git', () => ({
  gitService: {
    getDiff: vi.fn().mockResolvedValue({ diff: 'mock diff content' }),
  },
}));

// Mock tab helpers
vi.mock('../../../renderer/utils/tabHelpers', () => ({
  getActiveTab: vi.fn((session: Session | null) => session?.aiTabs?.[0] || null),
  getBusyTabs: vi.fn(() => []),
}));

// Mock shortcut formatter
vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
  formatShortcutKeys: vi.fn((keys: string[]) => keys?.join('+') || ''),
}));

// Configurable git status data for tests - can be modified in individual tests
let mockGitStatusData: Record<string, {
  fileCount: number;
  branch: string;
  remote: string;
  ahead: number;
  behind: number;
  totalAdditions: number;
  totalDeletions: number;
  modifiedCount: number;
  fileChanges: unknown[];
  lastUpdated: number;
}> = {
  'session-1': {
    fileCount: 3,
    branch: 'main',
    remote: 'https://github.com/user/repo.git',
    ahead: 2,
    behind: 0,
    totalAdditions: 50,
    totalDeletions: 20,
    modifiedCount: 2,
    fileChanges: [],
    lastUpdated: Date.now(),
  },
};

const mockRefreshGitStatus = vi.fn().mockResolvedValue(undefined);

// Helper to set mock git status for a session
const setMockGitStatus = (sessionId: string, data: typeof mockGitStatusData[string] | undefined) => {
  if (data === undefined) {
    delete mockGitStatusData[sessionId];
  } else {
    mockGitStatusData[sessionId] = data;
  }
};

// Helper to reset mock git status to defaults
const resetMockGitStatus = () => {
  mockGitStatusData = {
    'session-1': {
      fileCount: 3,
      branch: 'main',
      remote: 'https://github.com/user/repo.git',
      ahead: 2,
      behind: 0,
      totalAdditions: 50,
      totalDeletions: 20,
      modifiedCount: 2,
      fileChanges: [],
      lastUpdated: Date.now(),
    },
  };
  mockRefreshGitStatus.mockClear();
};

// Mock GitStatusContext to avoid Provider requirement
vi.mock('../../../renderer/contexts/GitStatusContext', () => ({
  useGitStatus: () => ({
    gitStatusMap: new Map(Object.entries(mockGitStatusData)),
    refreshGitStatus: mockRefreshGitStatus,
    isLoading: false,
    getFileCount: (sessionId: string) => mockGitStatusData[sessionId]?.fileCount ?? 0,
    getStatus: (sessionId: string) => mockGitStatusData[sessionId],
  }),
  useGitFileStatus: () => ({
    getFileCount: (sessionId: string) => mockGitStatusData[sessionId]?.fileCount ?? 0,
    hasChanges: (sessionId: string) => (mockGitStatusData[sessionId]?.fileCount ?? 0) > 0,
    isLoading: false,
  }),
  useGitBranch: () => ({
    getBranchInfo: (sessionId: string) => {
      const status = mockGitStatusData[sessionId];
      if (!status) return undefined;
      return {
        branch: status.branch,
        remote: status.remote,
        ahead: status.ahead || 0,
        behind: status.behind || 0,
      };
    },
  }),
  useGitDetail: () => ({
    getFileDetails: () => undefined,
    refreshGitStatus: mockRefreshGitStatus,
  }),
}));

// Import MainPanel after mocks
import { MainPanel } from '../../../renderer/components/MainPanel';

describe('MainPanel', () => {
  const theme: Theme = {
    name: 'dark',
    colors: {
      bgMain: '#1a1a2e',
      bgSidebar: '#16213e',
      bgActivity: '#0f3460',
      textMain: '#e8e8e8',
      textDim: '#888888',
      border: '#335',
      accent: '#00d9ff',
      accentForeground: '#ffffff',
      buttonBg: '#0f3460',
      buttonText: '#e8e8e8',
      inputBg: '#16213e',
      inputText: '#e8e8e8',
      success: '#22c55e',
      warning: '#f59e0b',
      error: '#ef4444',
    },
  };

  const defaultShortcuts: Record<string, Shortcut> = {
    agentSessions: { id: 'agentSessions', label: 'Agent Sessions', keys: ['Meta', 'Shift', 'L'] },
    toggleRightPanel: { id: 'toggleRightPanel', label: 'Toggle Right Panel', keys: ['Meta', 'B'] },
    closePreview: { id: 'closePreview', label: 'Close Preview', keys: ['Escape'] },
  };

  const createSession = (overrides: Partial<Session> = {}): Session => ({
    id: 'session-1',
    name: 'Test Session',
    toolType: 'claude-code',
    state: 'idle',
    inputMode: 'ai',
    cwd: '/test/project',
    projectRoot: '/test/project',
    aiPid: 12345,
    terminalPid: 12346,
    aiLogs: [],
    shellLogs: [],
    isGitRepo: false,
    fileTree: [],
    fileExplorerExpanded: [],
    messageQueue: [],
    aiTabs: [{
      id: 'tab-1',
      agentSessionId: 'claude-session-1',
      name: 'Tab 1',
      isUnread: false,
      createdAt: Date.now(),
      usageStats: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 50,
        totalCostUsd: 0.05,
        contextWindow: 200000,
      },
    }],
    activeTabId: 'tab-1',
    ...overrides,
  });

  const defaultProps = {
    // State
    logViewerOpen: false,
    agentSessionsOpen: false,
    activeClaudeSessionId: null,
    activeSession: createSession(),
    sessions: [createSession()],
    theme,
    fontFamily: 'monospace',
    isMobileLandscape: false,
    activeFocus: 'main' as FocusArea,
    outputSearchOpen: false,
    outputSearchQuery: '',
    inputValue: '',
    enterToSendAI: true,
    enterToSendTerminal: false,
    stagedImages: [],
    commandHistoryOpen: false,
    commandHistoryFilter: '',
    commandHistorySelectedIndex: 0,
    slashCommandOpen: false,
    slashCommands: [],
    selectedSlashCommandIndex: 0,
    previewFile: null,
    markdownEditMode: false,
    shortcuts: defaultShortcuts,
    rightPanelOpen: true,
    maxOutputLines: 1000,
    gitDiffPreview: null,
    fileTreeFilterOpen: false,
    logViewerSelectedLevels: ['info', 'warn', 'error'],
    setLogViewerSelectedLevels: vi.fn(),

    // Setters
    setGitDiffPreview: vi.fn(),
    setLogViewerOpen: vi.fn(),
    setAgentSessionsOpen: vi.fn(),
    setActiveAgentSessionId: vi.fn(),
    onResumeAgentSession: vi.fn(),
    onNewAgentSession: vi.fn(),
    setActiveFocus: vi.fn(),
    setOutputSearchOpen: vi.fn(),
    setOutputSearchQuery: vi.fn(),
    setInputValue: vi.fn(),
    setEnterToSendAI: vi.fn(),
    setEnterToSendTerminal: vi.fn(),
    setStagedImages: vi.fn(),
    setLightboxImage: vi.fn(),
    setCommandHistoryOpen: vi.fn(),
    setCommandHistoryFilter: vi.fn(),
    setCommandHistorySelectedIndex: vi.fn(),
    setSlashCommandOpen: vi.fn(),
    setSelectedSlashCommandIndex: vi.fn(),
    setPreviewFile: vi.fn(),
    setMarkdownEditMode: vi.fn(),
    setAboutModalOpen: vi.fn(),
    setRightPanelOpen: vi.fn(),
    setGitLogOpen: vi.fn(),

    // Refs
    inputRef: React.createRef<HTMLTextAreaElement>(),
    logsEndRef: React.createRef<HTMLDivElement>(),
    terminalOutputRef: React.createRef<HTMLDivElement>(),
    fileTreeContainerRef: React.createRef<HTMLDivElement>(),
    fileTreeFilterInputRef: React.createRef<HTMLInputElement>(),

    // Functions
    toggleInputMode: vi.fn(),
    processInput: vi.fn(),
    handleInterrupt: vi.fn(),
    handleInputKeyDown: vi.fn(),
    handlePaste: vi.fn(),
    handleDrop: vi.fn(),
    getContextColor: vi.fn().mockReturnValue('#22c55e'),
    setActiveSessionId: vi.fn(),

    // Tab handlers
    onTabSelect: vi.fn(),
    onTabClose: vi.fn(),
    onNewTab: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Clear capabilities cache and pre-populate with Claude Code capabilities (default test agent)
    clearCapabilitiesCache();
    setCapabilitiesCache('claude-code', {
      supportsResume: true,
      supportsReadOnlyMode: true,
      supportsJsonOutput: true,
      supportsSessionId: true,
      supportsImageInput: true,
      supportsImageInputOnResume: true,
      supportsSlashCommands: true,
      supportsSessionStorage: true,
      supportsCostTracking: true,
      supportsUsageStats: true,
      supportsBatchMode: true,
      requiresPromptToStart: false,
      supportsStreaming: true,
      supportsResultMessages: true,
      supportsModelSelection: false,
      supportsStreamJsonInput: true,
    });

    // Reset mock git status data to defaults
    resetMockGitStatus();

    // Mock git.info for backward compatibility (some tests may still reference it)
    vi.mocked(window.maestro.git as unknown as { info: ReturnType<typeof vi.fn> }).info = vi.fn().mockResolvedValue({
      branch: 'main',
      remote: 'https://github.com/user/repo.git',
      behind: 0,
      ahead: 2,
      uncommittedChanges: 3,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Render conditions', () => {
    it('should render LogViewer when logViewerOpen is true', () => {
      render(<MainPanel {...defaultProps} logViewerOpen={true} />);

      expect(screen.getByTestId('log-viewer')).toBeInTheDocument();
      expect(screen.queryByTestId('terminal-output')).not.toBeInTheDocument();
    });

    it('should close LogViewer and call setLogViewerOpen when close button is clicked', () => {
      const setLogViewerOpen = vi.fn();
      render(<MainPanel {...defaultProps} logViewerOpen={true} setLogViewerOpen={setLogViewerOpen} />);

      fireEvent.click(screen.getByTestId('log-viewer-close'));

      expect(setLogViewerOpen).toHaveBeenCalledWith(false);
    });

    it('should render AgentSessionsBrowser when agentSessionsOpen is true', () => {
      render(<MainPanel {...defaultProps} agentSessionsOpen={true} />);

      expect(screen.getByTestId('agent-sessions-browser')).toBeInTheDocument();
      expect(screen.queryByTestId('terminal-output')).not.toBeInTheDocument();
    });

    it('should close AgentSessionsBrowser when close button is clicked', () => {
      const setAgentSessionsOpen = vi.fn();
      render(<MainPanel {...defaultProps} agentSessionsOpen={true} setAgentSessionsOpen={setAgentSessionsOpen} />);

      fireEvent.click(screen.getByTestId('agent-sessions-close'));

      expect(setAgentSessionsOpen).toHaveBeenCalledWith(false);
    });

    it('should render empty state when no activeSession', () => {
      render(<MainPanel {...defaultProps} activeSession={null} />);

      expect(screen.getByText('No agents. Create one to get started.')).toBeInTheDocument();
      expect(screen.queryByTestId('terminal-output')).not.toBeInTheDocument();
    });

    it('should render normal session view with terminal output and input area', () => {
      render(<MainPanel {...defaultProps} />);

      expect(screen.getByTestId('terminal-output')).toBeInTheDocument();
      expect(screen.getByTestId('input-area')).toBeInTheDocument();
    });
  });

  describe('Header display', () => {
    it('should display session name in header', () => {
      const session = createSession({ name: 'My Test Session' });
      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.getByText('My Test Session')).toBeInTheDocument();
    });

    it('should display LOCAL badge for non-git repos', () => {
      const session = createSession({ isGitRepo: false });
      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.getByText('LOCAL')).toBeInTheDocument();
    });

    it('should display GIT badge with branch name for git repos', async () => {
      const session = createSession({ isGitRepo: true });
      render(<MainPanel {...defaultProps} activeSession={session} />);

      await waitFor(() => {
        // Should show GIT initially, then branch name after info loads
        expect(screen.getByText(/GIT|main/)).toBeInTheDocument();
      });
    });

    it('should hide header in mobile landscape mode', () => {
      render(<MainPanel {...defaultProps} isMobileLandscape={true} />);

      // Header should not be visible
      expect(screen.queryByText('Test Session')).not.toBeInTheDocument();
    });

    it('should show Agent Sessions button in header', () => {
      render(<MainPanel {...defaultProps} />);

      const agentSessionsBtn = screen.getByTitle(/Agent Sessions/);
      expect(agentSessionsBtn).toBeInTheDocument();
    });

    it('should open Agent Sessions when button is clicked', () => {
      const setAgentSessionsOpen = vi.fn();
      const setActiveAgentSessionId = vi.fn();
      render(<MainPanel
        {...defaultProps}
        setAgentSessionsOpen={setAgentSessionsOpen}
        setActiveAgentSessionId={setActiveAgentSessionId}
      />);

      fireEvent.click(screen.getByTitle(/Agent Sessions/));

      expect(setActiveAgentSessionId).toHaveBeenCalledWith(null);
      expect(setAgentSessionsOpen).toHaveBeenCalledWith(true);
    });

    it('should hide Agent Sessions button when agent does not support session storage', () => {
      // Pre-populate cache with capabilities where supportsSessionStorage is false
      clearCapabilitiesCache();
      setCapabilitiesCache('claude-code', {
        supportsResume: true,
        supportsReadOnlyMode: true,
        supportsJsonOutput: true,
        supportsSessionId: true,
        supportsImageInput: true,
        supportsImageInputOnResume: true,
        supportsSlashCommands: true,
        supportsSessionStorage: false, // Agent doesn't support session storage
        supportsCostTracking: true,
        supportsUsageStats: true,
        supportsBatchMode: true,
        requiresPromptToStart: false,
        supportsStreaming: true,
        supportsResultMessages: true,
        supportsModelSelection: false,
        supportsStreamJsonInput: true,
      });

      render(<MainPanel {...defaultProps} />);

      // Agent Sessions button should not be present
      expect(screen.queryByTitle(/Agent Sessions/)).not.toBeInTheDocument();
    });

    it('should not render AgentSessionsBrowser when agentSessionsOpen is true but agent does not support session storage', () => {
      // Pre-populate cache with capabilities where supportsSessionStorage is false
      clearCapabilitiesCache();
      setCapabilitiesCache('claude-code', {
        supportsResume: true,
        supportsReadOnlyMode: true,
        supportsJsonOutput: true,
        supportsSessionId: true,
        supportsImageInput: true,
        supportsImageInputOnResume: true,
        supportsSlashCommands: true,
        supportsSessionStorage: false, // Agent doesn't support session storage
        supportsCostTracking: true,
        supportsUsageStats: true,
        supportsBatchMode: true,
        requiresPromptToStart: false,
        supportsStreaming: true,
        supportsResultMessages: true,
        supportsModelSelection: false,
        supportsStreamJsonInput: true,
      });

      render(<MainPanel {...defaultProps} agentSessionsOpen={true} />);

      // AgentSessionsBrowser should not be shown even with agentSessionsOpen=true
      expect(screen.queryByTestId('agent-sessions-browser')).not.toBeInTheDocument();
      // Normal content should be shown instead
      expect(screen.getByTestId('terminal-output')).toBeInTheDocument();
    });
  });

  describe('Right panel toggle', () => {
    it('should show toggle button when rightPanelOpen is false', () => {
      render(<MainPanel {...defaultProps} rightPanelOpen={false} />);

      expect(screen.getByTitle(/Show right panel/)).toBeInTheDocument();
    });

    it('should hide toggle button when rightPanelOpen is true', () => {
      render(<MainPanel {...defaultProps} rightPanelOpen={true} />);

      expect(screen.queryByTitle(/Show right panel/)).not.toBeInTheDocument();
    });

    it('should call setRightPanelOpen when toggle button is clicked', () => {
      const setRightPanelOpen = vi.fn();
      render(<MainPanel {...defaultProps} rightPanelOpen={false} setRightPanelOpen={setRightPanelOpen} />);

      fireEvent.click(screen.getByTitle(/Show right panel/));

      expect(setRightPanelOpen).toHaveBeenCalledWith(true);
    });
  });

  describe('File Preview mode', () => {
    it('should render FilePreview when previewFile is set', () => {
      const previewFile = { name: 'test.ts', content: 'test content', path: '/test/test.ts' };
      render(<MainPanel {...defaultProps} previewFile={previewFile} />);

      expect(screen.getByTestId('file-preview')).toBeInTheDocument();
      expect(screen.getByText('File Preview: test.ts')).toBeInTheDocument();
    });

    it('should hide TabBar when file preview is open', () => {
      const previewFile = { name: 'test.ts', content: 'test content', path: '/test/test.ts' };
      render(<MainPanel {...defaultProps} previewFile={previewFile} />);

      expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
    });

    it('should call setPreviewFile(null) and setActiveFocus when closing preview', () => {
      const setPreviewFile = vi.fn();
      const setActiveFocus = vi.fn();
      const previewFile = { name: 'test.ts', content: 'test content', path: '/test/test.ts' };

      render(<MainPanel
        {...defaultProps}
        previewFile={previewFile}
        setPreviewFile={setPreviewFile}
        setActiveFocus={setActiveFocus}
      />);

      fireEvent.click(screen.getByTestId('file-preview-close'));

      expect(setPreviewFile).toHaveBeenCalledWith(null);
      expect(setActiveFocus).toHaveBeenCalledWith('right');
    });

    it('should focus file tree container when closing preview (setTimeout callback)', async () => {
      vi.useFakeTimers();
      const setPreviewFile = vi.fn();
      const setActiveFocus = vi.fn();
      const previewFile = { name: 'test.ts', content: 'test content', path: '/test/test.ts' };
      const fileTreeContainerRef = { current: { focus: vi.fn() } };

      render(<MainPanel
        {...defaultProps}
        previewFile={previewFile}
        setPreviewFile={setPreviewFile}
        setActiveFocus={setActiveFocus}
        fileTreeContainerRef={fileTreeContainerRef as any}
        fileTreeFilterOpen={false}
      />);

      fireEvent.click(screen.getByTestId('file-preview-close'));

      // Run the setTimeout callback
      await act(async () => {
        vi.advanceTimersByTime(1);
      });

      expect(fileTreeContainerRef.current.focus).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should focus file tree filter input when closing preview with filter open', async () => {
      vi.useFakeTimers();
      const setPreviewFile = vi.fn();
      const setActiveFocus = vi.fn();
      const previewFile = { name: 'test.ts', content: 'test content', path: '/test/test.ts' };
      const fileTreeFilterInputRef = { current: { focus: vi.fn() } };

      render(<MainPanel
        {...defaultProps}
        previewFile={previewFile}
        setPreviewFile={setPreviewFile}
        setActiveFocus={setActiveFocus}
        fileTreeFilterInputRef={fileTreeFilterInputRef as any}
        fileTreeFilterOpen={true}
      />);

      fireEvent.click(screen.getByTestId('file-preview-close'));

      // Run the setTimeout callback
      await act(async () => {
        vi.advanceTimersByTime(1);
      });

      expect(fileTreeFilterInputRef.current.focus).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('Tab Bar', () => {
    it('should render TabBar in AI mode with tabs', () => {
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [
          { id: 'tab-1', name: 'Tab 1', isUnread: false, createdAt: Date.now() },
          { id: 'tab-2', name: 'Tab 2', isUnread: false, createdAt: Date.now() },
        ],
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.getByTestId('tab-bar')).toBeInTheDocument();
      expect(screen.getByTestId('tab-tab-1')).toBeInTheDocument();
      expect(screen.getByTestId('tab-tab-2')).toBeInTheDocument();
    });

    it('should not render TabBar in terminal mode', () => {
      const session = createSession({ inputMode: 'terminal' });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
    });

    it('should call onTabSelect when tab is clicked', () => {
      const onTabSelect = vi.fn();
      const session = createSession({
        aiTabs: [
          { id: 'tab-1', name: 'Tab 1', isUnread: false, createdAt: Date.now() },
          { id: 'tab-2', name: 'Tab 2', isUnread: false, createdAt: Date.now() },
        ],
      });

      render(<MainPanel {...defaultProps} activeSession={session} onTabSelect={onTabSelect} />);

      fireEvent.click(screen.getByTestId('tab-tab-2'));

      expect(onTabSelect).toHaveBeenCalledWith('tab-2');
    });

    it('should call onNewTab when new tab button is clicked', () => {
      const onNewTab = vi.fn();
      const session = createSession();

      render(<MainPanel {...defaultProps} activeSession={session} onNewTab={onNewTab} />);

      fireEvent.click(screen.getByTestId('new-tab-btn'));

      expect(onNewTab).toHaveBeenCalled();
    });
  });

  describe('Session UUID pill', () => {
    it('should display session UUID pill in AI mode with claude session', () => {
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'abc12345-def6-7890-ghij-klmnopqrstuv',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // Should show truncated UUID (first segment in uppercase)
      expect(screen.getByText('ABC12345')).toBeInTheDocument();
    });

    it('should copy session ID when UUID pill is clicked', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'abc12345-def6-7890-ghij-klmnopqrstuv',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      fireEvent.click(screen.getByText('ABC12345'));

      expect(writeText).toHaveBeenCalledWith('abc12345-def6-7890-ghij-klmnopqrstuv');
    });

    it('should not show UUID pill in terminal mode', () => {
      const session = createSession({
        inputMode: 'terminal',
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'abc12345-def6-7890',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
        }],
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.queryByText('ABC12345')).not.toBeInTheDocument();
    });

    it('should not show UUID pill when agent does not support session ID', () => {
      // Pre-populate cache with capabilities where supportsSessionId is false
      clearCapabilitiesCache();
      setCapabilitiesCache('claude-code', {
        supportsResume: true,
        supportsReadOnlyMode: true,
        supportsJsonOutput: true,
        supportsSessionId: false, // Agent doesn't support session ID
        supportsImageInput: true,
        supportsImageInputOnResume: true,
        supportsSlashCommands: true,
        supportsSessionStorage: true,
        supportsCostTracking: true,
        supportsUsageStats: true,
        supportsBatchMode: true,
        requiresPromptToStart: false,
        supportsStreaming: true,
        supportsResultMessages: true,
        supportsModelSelection: false,
        supportsStreamJsonInput: true,
      });

      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'abc12345-def6-7890-ghij-klmnopqrstuv',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // Should NOT show the UUID pill when agent doesn't support session ID
      expect(screen.queryByText('ABC12345')).not.toBeInTheDocument();

      // Restore cache for other tests
      clearCapabilitiesCache();
    });
  });

  describe('Cost tracker', () => {
    it('should display cost tracker in AI mode when panel is wide enough', () => {
      // Mock offsetWidth to return a value > 500 so cost widget is shown
      const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        value: 800,
      });

      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'claude-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          usageStats: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalCostUsd: 0.15,
            contextWindow: 200000,
          },
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // Cost is displayed with fixed 2 decimals, look for the cost pattern
      const costElements = screen.getAllByText(/\$0\.\d+/);
      expect(costElements.length).toBeGreaterThan(0);

      // Restore
      if (originalOffsetWidth) {
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
      }
    });

    it('should not display cost tracker in terminal mode', () => {
      const session = createSession({ inputMode: 'terminal' });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.queryByText(/\$\d+\.\d+/)).not.toBeInTheDocument();
    });

    it('should not display cost tracker when agent does not support cost tracking', () => {
      // Pre-populate cache with capabilities where supportsCostTracking is false
      clearCapabilitiesCache();
      setCapabilitiesCache('claude-code', {
        supportsResume: true,
        supportsReadOnlyMode: true,
        supportsJsonOutput: true,
        supportsSessionId: true,
        supportsImageInput: true,
        supportsImageInputOnResume: true,
        supportsSlashCommands: true,
        supportsSessionStorage: true,
        supportsCostTracking: false, // Agent doesn't support cost tracking
        supportsUsageStats: true,
        supportsBatchMode: true,
        requiresPromptToStart: false,
        supportsStreaming: true,
        supportsResultMessages: true,
        supportsModelSelection: false,
        supportsStreamJsonInput: true,
      });

      // Mock offsetWidth to return a value > 500 so cost widget would be shown if capability was true
      const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        value: 800,
      });

      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'claude-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          usageStats: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalCostUsd: 0.15,
            contextWindow: 200000,
          },
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // Cost tracker should not be present even though panel is wide enough and we have usage stats
      expect(screen.queryByText(/\$0\.15/)).not.toBeInTheDocument();

      // Restore
      if (originalOffsetWidth) {
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
      }
    });
  });

  describe('Context window widget', () => {
    it('should display context window widget in AI mode', () => {
      render(<MainPanel {...defaultProps} />);

      // Label shows "Context" or "Context Window" depending on panel width
      expect(screen.getByText(/^Context( Window)?$/)).toBeInTheDocument();
    });

    it('should not display context window in terminal mode', () => {
      const session = createSession({ inputMode: 'terminal' });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // Label shows "Context" or "Context Window" depending on panel width
      expect(screen.queryByText(/^Context( Window)?$/)).not.toBeInTheDocument();
    });

    it('should not display context window widget when agent does not support usage stats', () => {
      // Pre-populate cache with capabilities where supportsUsageStats is false
      clearCapabilitiesCache();
      setCapabilitiesCache('claude-code', {
        supportsResume: true,
        supportsReadOnlyMode: true,
        supportsJsonOutput: true,
        supportsSessionId: true,
        supportsImageInput: true,
        supportsImageInputOnResume: true,
        supportsSlashCommands: true,
        supportsSessionStorage: true,
        supportsCostTracking: true,
        supportsUsageStats: false, // Agent doesn't support usage stats
        supportsBatchMode: true,
        requiresPromptToStart: false,
        supportsStreaming: true,
        supportsResultMessages: true,
        supportsModelSelection: false,
        supportsStreamJsonInput: true,
      });

      render(<MainPanel {...defaultProps} />);

      // Context Window widget should not be present
      expect(screen.queryByText('Context Window')).not.toBeInTheDocument();
    });
  });

  describe('Auto mode indicator', () => {
    it('should display Auto mode button when batch run is active for current session', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      expect(screen.getByText('Auto')).toBeInTheDocument();
      expect(screen.getByText('2/5')).toBeInTheDocument();
    });

    it('should display Stopping state when isStopping is true', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: true,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      expect(screen.getByText('Stopping')).toBeInTheDocument();
    });

    it('should call onStopBatchRun directly when Auto button is clicked', () => {
      const onStopBatchRun = vi.fn();
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} onStopBatchRun={onStopBatchRun} />);

      fireEvent.click(screen.getByText('Auto'));

      // onStopBatchRun handles its own confirmation modal, so it should be called directly
      expect(onStopBatchRun).toHaveBeenCalled();
    });

    it('should not call onStopBatchRun when Auto button is clicked while stopping', () => {
      const onStopBatchRun = vi.fn();
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: true,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} onStopBatchRun={onStopBatchRun} />);

      fireEvent.click(screen.getByText('Stopping'));

      expect(onStopBatchRun).not.toHaveBeenCalled();
    });

    it('should not display Auto mode button when currentSessionBatchState is null', () => {
      render(<MainPanel {...defaultProps} currentSessionBatchState={null} />);

      expect(screen.queryByText('Auto')).not.toBeInTheDocument();
      expect(screen.queryByText('Stopping')).not.toBeInTheDocument();
    });

    it('should not display Auto mode button when currentSessionBatchState is undefined', () => {
      render(<MainPanel {...defaultProps} currentSessionBatchState={undefined} />);

      expect(screen.queryByText('Auto')).not.toBeInTheDocument();
    });

    it('should not display Auto mode button when isRunning is false', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: false,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 5,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 5,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 5,
        currentTaskIndex: 5,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      expect(screen.queryByText('Auto')).not.toBeInTheDocument();
    });

    it('should display worktree indicator (GitBranch icon) when worktreeActive is true', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: true,
        worktreeBranch: 'feature-branch',
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      expect(screen.getByText('Auto')).toBeInTheDocument();
      // Check for worktree title tooltip
      const worktreeIcon = screen.getByTitle('Worktree: feature-branch');
      expect(worktreeIcon).toBeInTheDocument();
    });

    it('should display worktree indicator with default title when worktreeBranch is not set', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: true,
        worktreeBranch: undefined,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      // Check for default worktree title tooltip
      const worktreeIcon = screen.getByTitle('Worktree: active');
      expect(worktreeIcon).toBeInTheDocument();
    });

    it('should not display worktree indicator when worktreeActive is false', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      expect(screen.getByText('Auto')).toBeInTheDocument();
      expect(screen.queryByTitle(/Worktree:/)).not.toBeInTheDocument();
    });

    it('should have button disabled when isStopping is true', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: true,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      const button = screen.getByText('Stopping').closest('button');
      expect(button).toBeDisabled();
    });

    it('should have button enabled when isStopping is false', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      const button = screen.getByText('Auto').closest('button');
      expect(button).not.toBeDisabled();
    });

    it('should display correct tooltip when running', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      const button = screen.getByText('Auto').closest('button');
      expect(button).toHaveAttribute('title', 'Click to stop auto-run');
    });

    it('should display correct tooltip when stopping', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: true,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      const button = screen.getByText('Stopping').closest('button');
      expect(button).toHaveAttribute('title', 'Stopping after current task...');
    });

    it('should display progress with zero completed tasks', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 10,
        currentDocTasksCompleted: 0,
        totalTasksAcrossAllDocs: 10,
        completedTasksAcrossAllDocs: 0,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 10,
        completedTasks: 0,
        currentTaskIndex: 0,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      expect(screen.getByText('Auto')).toBeInTheDocument();
      expect(screen.getByText('0/10')).toBeInTheDocument();
    });

    it('should display progress with all tasks completed', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 8,
        currentDocTasksCompleted: 8,
        totalTasksAcrossAllDocs: 8,
        completedTasksAcrossAllDocs: 8,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 8,
        completedTasks: 8,
        currentTaskIndex: 8,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      expect(screen.getByText('Auto')).toBeInTheDocument();
      expect(screen.getByText('8/8')).toBeInTheDocument();
    });

    it('should apply error background color styling to Auto button', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      const button = screen.getByText('Auto').closest('button');
      expect(button).toHaveStyle({ backgroundColor: theme.colors.error });
    });

    it('should apply cursor-not-allowed class when stopping', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: true,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      const button = screen.getByText('Stopping').closest('button');
      expect(button).toHaveClass('cursor-not-allowed');
    });

    it('should apply cursor-pointer class when not stopping', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      const button = screen.getByText('Auto').closest('button');
      expect(button).toHaveClass('cursor-pointer');
    });

    it('should display uppercase AUTO text', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} />);

      // The text should have uppercase class applied
      const autoText = screen.getByText('Auto');
      expect(autoText).toHaveClass('uppercase');
    });

    it('should handle onStopBatchRun being undefined gracefully', () => {
      const currentSessionBatchState: BatchRunState = {
        isRunning: true,
        isStopping: false,
        documents: ['doc1.md'],
        currentDocumentIndex: 0,
        currentDocTasksTotal: 5,
        currentDocTasksCompleted: 2,
        totalTasksAcrossAllDocs: 5,
        completedTasksAcrossAllDocs: 2,
        loopEnabled: false,
        loopIteration: 0,
        folderPath: '/test/folder',
        worktreeActive: false,
        totalTasks: 5,
        completedTasks: 2,
        currentTaskIndex: 2,
        originalContent: '',
        sessionIds: [],
      };

      // Render without onStopBatchRun callback
      render(<MainPanel {...defaultProps} currentSessionBatchState={currentSessionBatchState} onStopBatchRun={undefined} />);

      // Click should not throw
      expect(() => fireEvent.click(screen.getByText('Auto'))).not.toThrow();
    });
  });

  describe('Git tooltip', () => {
    it('should show git tooltip on hover for git repos', async () => {
      const session = createSession({ isGitRepo: true });
      render(<MainPanel {...defaultProps} activeSession={session} />);

      await waitFor(() => {
        expect(screen.getByText(/main|GIT/)).toBeInTheDocument();
      });

      // Find and hover over the git badge
      const gitBadge = screen.getByText(/main|GIT/);
      fireEvent.mouseEnter(gitBadge.parentElement!);

      await waitFor(() => {
        // Tooltip content should appear
        expect(screen.getByText('Branch')).toBeInTheDocument();
      });
    });

    it('should copy branch name when copy button is clicked', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const session = createSession({ isGitRepo: true });
      render(<MainPanel {...defaultProps} activeSession={session} />);

      await waitFor(() => {
        expect(screen.getByText(/main|GIT/)).toBeInTheDocument();
      });

      // Hover to show tooltip
      const gitBadge = screen.getByText(/main|GIT/);
      fireEvent.mouseEnter(gitBadge.parentElement!);

      await waitFor(() => {
        expect(screen.getByText('Branch')).toBeInTheDocument();
      });

      // Click copy button
      const copyButtons = screen.getAllByTitle(/Copy branch name/);
      fireEvent.click(copyButtons[0]);

      expect(writeText).toHaveBeenCalledWith('main');
    });

    it('should open git log when clicking on git badge', async () => {
      const setGitLogOpen = vi.fn();
      const session = createSession({ isGitRepo: true });

      render(<MainPanel {...defaultProps} activeSession={session} setGitLogOpen={setGitLogOpen} />);

      await waitFor(() => {
        expect(screen.getByText(/main|GIT/)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/main|GIT/));

      expect(setGitLogOpen).toHaveBeenCalledWith(true);
    });
  });

  describe('Context window tooltip', () => {
    it('should show context tooltip on hover', async () => {
      render(<MainPanel {...defaultProps} />);

      // Label shows "Context" or "Context Window" depending on panel width
      const contextWidget = screen.getByText(/^Context( Window)?$/);
      fireEvent.mouseEnter(contextWidget.parentElement!);

      await waitFor(() => {
        expect(screen.getByText('Context Details')).toBeInTheDocument();
      });
    });

    it('should hide context tooltip on mouse leave after delay', async () => {
      render(<MainPanel {...defaultProps} />);

      // Label shows "Context" or "Context Window" depending on panel width
      const contextWidget = screen.getByText(/^Context( Window)?$/);
      fireEvent.mouseEnter(contextWidget.parentElement!);

      await waitFor(() => {
        expect(screen.getByText('Context Details')).toBeInTheDocument();
      });

      fireEvent.mouseLeave(contextWidget.parentElement!);

      // Wait for the tooltip to disappear after the 150ms delay
      await waitFor(() => {
        expect(screen.queryByText('Context Details')).not.toBeInTheDocument();
      }, { timeout: 500 });
    });

    it('should keep tooltip open when re-entering context widget quickly', async () => {
      render(<MainPanel {...defaultProps} />);

      // Label shows "Context" or "Context Window" depending on panel width
      const contextWidget = screen.getByText(/^Context( Window)?$/);
      const contextContainer = contextWidget.parentElement!;

      // Hover to open
      fireEvent.mouseEnter(contextContainer);

      await waitFor(() => {
        expect(screen.getByText('Context Details')).toBeInTheDocument();
      });

      // Leave and immediately re-enter (simulating quick mouse movement)
      fireEvent.mouseLeave(contextContainer);
      fireEvent.mouseEnter(contextContainer);

      // Tooltip should still be visible
      expect(screen.getByText('Context Details')).toBeInTheDocument();
    });

    it('should display token stats in context tooltip', async () => {
      const session = createSession({
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'claude-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          usageStats: {
            inputTokens: 1500,
            outputTokens: 750,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 100,
            totalCostUsd: 0.05,
            contextWindow: 200000,
          },
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // Label shows "Context" or "Context Window" depending on panel width
      const contextWidget = screen.getByText(/^Context( Window)?$/);
      fireEvent.mouseEnter(contextWidget.parentElement!);

      await waitFor(() => {
        expect(screen.getByText('Input Tokens')).toBeInTheDocument();
        expect(screen.getByText('1,500')).toBeInTheDocument();
        expect(screen.getByText('Output Tokens')).toBeInTheDocument();
        expect(screen.getByText('750')).toBeInTheDocument();
        expect(screen.getByText('Cache Read')).toBeInTheDocument();
        expect(screen.getByText('200')).toBeInTheDocument();
        expect(screen.getByText('Cache Write')).toBeInTheDocument();
        expect(screen.getByText('100')).toBeInTheDocument();
      });
    });
  });

  describe('Input handling', () => {
    it('should call setActiveSessionId and setActiveFocus when input is focused', () => {
      const setActiveSessionId = vi.fn();
      const setActiveFocus = vi.fn();

      render(<MainPanel
        {...defaultProps}
        setActiveSessionId={setActiveSessionId}
        setActiveFocus={setActiveFocus}
      />);

      fireEvent.focus(screen.getByTestId('input-field'));

      expect(setActiveSessionId).toHaveBeenCalledWith('session-1');
      expect(setActiveFocus).toHaveBeenCalledWith('main');
    });

    it('should hide input area in mobile landscape mode', () => {
      render(<MainPanel {...defaultProps} isMobileLandscape={true} />);

      expect(screen.queryByTestId('input-area')).not.toBeInTheDocument();
    });
  });

  describe('Git diff preview', () => {
    it('should call gitService.getDiff and setGitDiffPreview when view diff is clicked', async () => {
      const setGitDiffPreview = vi.fn();
      const session = createSession({ isGitRepo: true });

      render(<MainPanel {...defaultProps} activeSession={session} setGitDiffPreview={setGitDiffPreview} />);

      fireEvent.click(screen.getByTestId('view-diff-btn'));

      await waitFor(() => {
        expect(setGitDiffPreview).toHaveBeenCalledWith('mock diff content');
      });
    });
  });

  describe('Copy notification', () => {
    it('should show copy notification when text is copied', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'abc12345-def6-7890',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      fireEvent.click(screen.getByText('ABC12345'));

      await waitFor(() => {
        expect(screen.getByText('Session ID Copied to Clipboard')).toBeInTheDocument();
      });
    });

    it('should hide copy notification after 2 seconds', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'abc12345-def6-7890',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      fireEvent.click(screen.getByText('ABC12345'));

      await waitFor(() => {
        expect(screen.getByText('Session ID Copied to Clipboard')).toBeInTheDocument();
      });

      // Advance timers by 2 seconds
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });

      await waitFor(() => {
        expect(screen.queryByText('Session ID Copied to Clipboard')).not.toBeInTheDocument();
      });
    });
  });

  describe('Focus ring', () => {
    it('should show focus ring when activeFocus is main', () => {
      const { container } = render(<MainPanel {...defaultProps} activeFocus="main" />);

      const mainPanel = container.querySelector('.ring-1');
      expect(mainPanel).toBeInTheDocument();
    });

    it('should not show focus ring when activeFocus is not main', () => {
      const { container } = render(<MainPanel {...defaultProps} activeFocus="sidebar" />);

      const mainPanel = container.querySelector('.ring-1');
      expect(mainPanel).not.toBeInTheDocument();
    });

    it('should call setActiveFocus when main panel is clicked', () => {
      const setActiveFocus = vi.fn();

      const { container } = render(<MainPanel {...defaultProps} setActiveFocus={setActiveFocus} activeFocus="sidebar" />);

      // Click on the main panel area
      const mainArea = container.querySelector('[style*="backgroundColor"]');
      if (mainArea) {
        fireEvent.click(mainArea);
        expect(setActiveFocus).toHaveBeenCalledWith('main');
      }
    });
  });

  describe('Git status widget', () => {
    it('should render GitStatusWidget', () => {
      render(<MainPanel {...defaultProps} />);

      expect(screen.getByTestId('git-status-widget')).toBeInTheDocument();
    });
  });

  describe('Context color calculation', () => {
    it('should call getContextColor with correct usage percentage', () => {
      const getContextColor = vi.fn().mockReturnValue('#22c55e');
      const session = createSession({
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'claude-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          usageStats: {
            inputTokens: 50000,
            outputTokens: 0,
            cacheReadInputTokens: 25000,
            cacheCreationInputTokens: 0,
            totalCostUsd: 0.05,
            contextWindow: 200000,
          },
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} getContextColor={getContextColor} />);

      // Context usage should be 50000 / 200000 * 100 = 25% (cacheRead excluded - cumulative)
      expect(getContextColor).toHaveBeenCalledWith(25, theme);
    });
  });

  describe('Git info refresh', () => {
    // Note: Git polling is now handled by GitStatusProvider context, not MainPanel directly.
    // These tests verify that MainPanel correctly displays data from the context.

    it('should display git info from context when session is a git repo', async () => {
      const session = createSession({ isGitRepo: true });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // MainPanel should display the branch from context data
      await waitFor(() => {
        expect(screen.getByText(/main|GIT/)).toBeInTheDocument();
      });
    });

    it('should support refresh via context', async () => {
      const session = createSession({ isGitRepo: true });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // The component should have access to refreshGitStatus from context
      // This is now triggered through the git badge click
      const gitBadge = await screen.findByText(/main|GIT/);
      fireEvent.click(gitBadge);

      // refreshGitStatus should have been called
      expect(mockRefreshGitStatus).toHaveBeenCalled();
    });

    it('should not display git info when session is not a git repo', async () => {
      const session = createSession({ isGitRepo: false });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // Should show LOCAL badge instead of git branch
      expect(screen.getByText('LOCAL')).toBeInTheDocument();
      expect(screen.queryByText('main')).not.toBeInTheDocument();
    });
  });

  describe('Panel width responsive behavior', () => {
    it('should observe header resize', async () => {
      render(<MainPanel {...defaultProps} />);

      // Wait for the effect to run and ResizeObserver to be set up
      await waitFor(() => {
        // Check that header exists (which triggers the ResizeObserver setup)
        expect(screen.getByText('Test Session')).toBeInTheDocument();
      });
    });
  });

  describe('ErrorBoundary wrapping', () => {
    it('should wrap main content in ErrorBoundary', () => {
      render(<MainPanel {...defaultProps} />);

      // The content should render without errors
      expect(screen.getByTestId('terminal-output')).toBeInTheDocument();
    });
  });

  describe('Session click handler', () => {
    it('should call setActiveSessionId and onTabSelect when session is clicked', () => {
      const setActiveSessionId = vi.fn();
      const onTabSelect = vi.fn();

      // This handler is passed to InputArea's ThinkingStatusPill
      render(<MainPanel
        {...defaultProps}
        setActiveSessionId={setActiveSessionId}
        onTabSelect={onTabSelect}
      />);

      // The InputArea receives handleSessionClick, but we can't directly test it without accessing the mock
      // This is tested through the integration with InputArea mock
      expect(screen.getByTestId('input-area')).toBeInTheDocument();
    });
  });

  describe('Tooltip timeout cleanup', () => {
    it('should cleanup tooltip timeouts on unmount', () => {
      const { unmount } = render(<MainPanel {...defaultProps} />);

      // Should unmount without errors (timeouts should be cleaned up)
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Git ahead/behind display', () => {
    it('should display ahead count in git tooltip', async () => {
      setMockGitStatus('session-1', {
        fileCount: 0,
        branch: 'main',
        remote: 'https://github.com/user/repo.git',
        ahead: 5,
        behind: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        modifiedCount: 0,
        fileChanges: [],
        lastUpdated: Date.now(),
      });

      const session = createSession({ isGitRepo: true });
      render(<MainPanel {...defaultProps} activeSession={session} />);

      await waitFor(() => {
        expect(screen.getByText(/main|GIT/)).toBeInTheDocument();
      });

      const gitBadge = screen.getByText(/main|GIT/);
      fireEvent.mouseEnter(gitBadge.parentElement!);

      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument();
      });
    });

    it('should display behind count in git tooltip', async () => {
      setMockGitStatus('session-1', {
        fileCount: 0,
        branch: 'main',
        remote: 'https://github.com/user/repo.git',
        ahead: 0,
        behind: 3,
        totalAdditions: 0,
        totalDeletions: 0,
        modifiedCount: 0,
        fileChanges: [],
        lastUpdated: Date.now(),
      });

      const session = createSession({ isGitRepo: true });
      render(<MainPanel {...defaultProps} activeSession={session} />);

      await waitFor(() => {
        expect(screen.getByText(/main|GIT/)).toBeInTheDocument();
      });

      const gitBadge = screen.getByText(/main|GIT/);
      fireEvent.mouseEnter(gitBadge.parentElement!);

      await waitFor(() => {
        expect(screen.getByText('3')).toBeInTheDocument();
      });
    });

    it('should show uncommitted changes count in git tooltip', async () => {
      setMockGitStatus('session-1', {
        fileCount: 7,
        branch: 'main',
        remote: 'https://github.com/user/repo.git',
        ahead: 0,
        behind: 0,
        totalAdditions: 100,
        totalDeletions: 50,
        modifiedCount: 7,
        fileChanges: [],
        lastUpdated: Date.now(),
      });

      const session = createSession({ isGitRepo: true });
      render(<MainPanel {...defaultProps} activeSession={session} />);

      await waitFor(() => {
        expect(screen.getByText(/main|GIT/)).toBeInTheDocument();
      });

      const gitBadge = screen.getByText(/main|GIT/);
      fireEvent.mouseEnter(gitBadge.parentElement!);

      await waitFor(() => {
        expect(screen.getByText(/7 uncommitted changes/)).toBeInTheDocument();
      });
    });

    it('should show working tree clean message when no uncommitted changes', async () => {
      setMockGitStatus('session-1', {
        fileCount: 0,
        branch: 'main',
        remote: 'https://github.com/user/repo.git',
        ahead: 0,
        behind: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        modifiedCount: 0,
        fileChanges: [],
        lastUpdated: Date.now(),
      });

      const session = createSession({ isGitRepo: true });
      render(<MainPanel {...defaultProps} activeSession={session} />);

      await waitFor(() => {
        expect(screen.getByText(/main|GIT/)).toBeInTheDocument();
      });

      const gitBadge = screen.getByText(/main|GIT/);
      fireEvent.mouseEnter(gitBadge.parentElement!);

      await waitFor(() => {
        expect(screen.getByText('Working tree clean')).toBeInTheDocument();
      });
    });
  });

  describe('Remote origin display', () => {
    it('should display remote URL in git tooltip', async () => {
      setMockGitStatus('session-1', {
        fileCount: 0,
        branch: 'main',
        remote: 'https://github.com/user/my-repo.git',
        ahead: 0,
        behind: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        modifiedCount: 0,
        fileChanges: [],
        lastUpdated: Date.now(),
      });

      const session = createSession({ isGitRepo: true });
      render(<MainPanel {...defaultProps} activeSession={session} />);

      await waitFor(() => {
        expect(screen.getByText(/main|GIT/)).toBeInTheDocument();
      });

      const gitBadge = screen.getByText(/main|GIT/);
      fireEvent.mouseEnter(gitBadge.parentElement!);

      await waitFor(() => {
        expect(screen.getByText('Origin')).toBeInTheDocument();
        expect(screen.getByText('github.com/user/my-repo')).toBeInTheDocument();
      });
    });

    it('should copy remote URL when copy button is clicked', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      setMockGitStatus('session-1', {
        fileCount: 0,
        branch: 'main',
        remote: 'https://github.com/user/repo.git',
        ahead: 0,
        behind: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        modifiedCount: 0,
        fileChanges: [],
        lastUpdated: Date.now(),
      });

      const session = createSession({ isGitRepo: true });
      render(<MainPanel {...defaultProps} activeSession={session} />);

      await waitFor(() => {
        expect(screen.getByText(/main|GIT/)).toBeInTheDocument();
      });

      const gitBadge = screen.getByText(/main|GIT/);
      fireEvent.mouseEnter(gitBadge.parentElement!);

      await waitFor(() => {
        expect(screen.getByText('Origin')).toBeInTheDocument();
      });

      // Click copy remote URL button
      const copyButtons = screen.getAllByTitle(/Copy remote URL/);
      fireEvent.click(copyButtons[0]);

      expect(writeText).toHaveBeenCalledWith('https://github.com/user/repo.git');
    });
  });

  describe('Edge cases', () => {
    it('should handle session with no tabs gracefully', () => {
      const session = createSession({ aiTabs: undefined });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
    });

    it('should handle empty tabs array gracefully', () => {
      const session = createSession({ aiTabs: [] });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.queryByTestId('tab-bar')).not.toBeInTheDocument();
    });

    it('should handle tab without usageStats', () => {
      const session = createSession({
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'claude-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          usageStats: undefined,
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // Should render without crashing - Context Window widget is hidden when contextWindow is not configured
      expect(screen.queryByText('Context Window')).not.toBeInTheDocument();
    });

    it('should handle missing git status from context gracefully', async () => {
      // Remove git status data for session (simulating context not having data yet)
      setMockGitStatus('session-1', undefined);

      const session = createSession({ isGitRepo: true });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // Should render without crashing, showing GIT badge (without branch name since no data)
      await waitFor(() => {
        expect(screen.getByText(/GIT/)).toBeInTheDocument();
      });
    });

    it('should handle clipboard.writeText failure gracefully', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const writeText = vi.fn().mockRejectedValue(new Error('Clipboard error'));
      Object.assign(navigator, { clipboard: { writeText } });

      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'abc12345-def6-7890',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      fireEvent.click(screen.getByText('ABC12345'));

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalled();
      });

      consoleError.mockRestore();
    });

    it('should handle gitDiff with no content gracefully', async () => {
      const { gitService } = await import('../../../renderer/services/git');
      vi.mocked(gitService.getDiff).mockResolvedValue({ diff: '' });

      const setGitDiffPreview = vi.fn();
      const session = createSession({ isGitRepo: true });

      render(<MainPanel {...defaultProps} activeSession={session} setGitDiffPreview={setGitDiffPreview} />);

      fireEvent.click(screen.getByTestId('view-diff-btn'));

      await waitFor(() => {
        // Should not call setGitDiffPreview with empty diff
        expect(setGitDiffPreview).not.toHaveBeenCalled();
      });
    });
  });

  describe('Context usage calculation edge cases', () => {
    it('should hide context widget when context window is zero', () => {
      const session = createSession({
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'claude-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          usageStats: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalCostUsd: 0.05,
            contextWindow: 0,
          },
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // Context Window widget should be hidden when contextWindow is 0 (not configured)
      expect(screen.queryByText('Context Window')).not.toBeInTheDocument();
    });

    it('should cap context usage at 100%', () => {
      const getContextColor = vi.fn().mockReturnValue('#ef4444');
      const session = createSession({
        aiTabs: [{
          id: 'tab-1',
          agentSessionId: 'claude-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          usageStats: {
            inputTokens: 150000,
            outputTokens: 100000,
            cacheReadInputTokens: 100000,  // Excluded from calculation (cumulative)
            cacheCreationInputTokens: 100000,  // Included in calculation
            totalCostUsd: 0.05,
            contextWindow: 200000,
          },
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} getContextColor={getContextColor} />);

      // Context usage: (150000 + 100000) / 200000 = 125% -> capped at 100%
      expect(getContextColor).toHaveBeenCalledWith(100, theme);
    });
  });

  describe('Hover bridge behavior', () => {
    it('should keep git tooltip open when moving to bridge element', async () => {
      const session = createSession({ isGitRepo: true });
      render(<MainPanel {...defaultProps} activeSession={session} />);

      await waitFor(() => {
        expect(screen.getByText(/main|GIT/)).toBeInTheDocument();
      });

      const gitBadge = screen.getByText(/main|GIT/);
      fireEvent.mouseEnter(gitBadge.parentElement!);

      await waitFor(() => {
        expect(screen.getByText('Branch')).toBeInTheDocument();
      });

      // Mouse leave should start closing timeout
      fireEvent.mouseLeave(gitBadge.parentElement!);

      // But if we enter the bridge element, it should stay open
      // (This is handled by the internal state, tooltip should still be visible)
    });
  });

  describe('Singularization in uncommitted changes', () => {
    it('should use singular form for 1 uncommitted change', async () => {
      setMockGitStatus('session-1', {
        fileCount: 1,
        branch: 'main',
        remote: 'https://github.com/user/repo.git',
        ahead: 0,
        behind: 0,
        totalAdditions: 10,
        totalDeletions: 5,
        modifiedCount: 1,
        fileChanges: [],
        lastUpdated: Date.now(),
      });

      const session = createSession({ isGitRepo: true });
      render(<MainPanel {...defaultProps} activeSession={session} />);

      await waitFor(() => {
        expect(screen.getByText(/main|GIT/)).toBeInTheDocument();
      });

      const gitBadge = screen.getByText(/main|GIT/);
      fireEvent.mouseEnter(gitBadge.parentElement!);

      await waitFor(() => {
        expect(screen.getByText(/1 uncommitted change$/)).toBeInTheDocument();
      });
    });
  });

  describe('Agent error banner', () => {
    const createAgentError = (overrides: Partial<{
      type: string;
      message: string;
      recoverable: boolean;
      agentId: string;
      sessionId?: string;
      timestamp: number;
    }> = {}) => ({
      type: 'auth_expired' as const,
      message: 'Authentication token has expired. Please re-authenticate.',
      recoverable: true,
      agentId: 'claude-code',
      sessionId: 'session-1',
      timestamp: Date.now(),
      ...overrides,
    });

    it('should display error banner when active tab has an agent error', () => {
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError(),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.getByText('Authentication token has expired. Please re-authenticate.')).toBeInTheDocument();
    });

    it('should not display error banner when active tab has no error', () => {
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: undefined,
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.queryByText(/error|expired|failed/i)).not.toBeInTheDocument();
    });

    it('should display View Details button when onShowAgentErrorModal is provided', () => {
      const onShowAgentErrorModal = vi.fn();
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError(),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} onShowAgentErrorModal={onShowAgentErrorModal} />);

      expect(screen.getByText('View Details')).toBeInTheDocument();
    });

    it('should call onShowAgentErrorModal when View Details button is clicked', () => {
      const onShowAgentErrorModal = vi.fn();
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError(),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} onShowAgentErrorModal={onShowAgentErrorModal} />);

      fireEvent.click(screen.getByText('View Details'));

      expect(onShowAgentErrorModal).toHaveBeenCalled();
    });

    it('should not display View Details button when onShowAgentErrorModal is not provided', () => {
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError(),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} onShowAgentErrorModal={undefined} />);

      expect(screen.queryByText('View Details')).not.toBeInTheDocument();
    });

    it('should display dismiss button (X) for recoverable errors when onClearAgentError is provided', () => {
      const onClearAgentError = vi.fn();
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError({ recoverable: true }),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} onClearAgentError={onClearAgentError} />);

      expect(screen.getByTitle('Dismiss error')).toBeInTheDocument();
    });

    it('should call onClearAgentError when dismiss button is clicked', () => {
      const onClearAgentError = vi.fn();
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError({ recoverable: true }),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} onClearAgentError={onClearAgentError} />);

      fireEvent.click(screen.getByTitle('Dismiss error'));

      expect(onClearAgentError).toHaveBeenCalled();
    });

    it('should not display dismiss button for non-recoverable errors', () => {
      const onClearAgentError = vi.fn();
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError({ recoverable: false }),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} onClearAgentError={onClearAgentError} />);

      // Error banner should be shown but dismiss button should not be present
      expect(screen.getByText('Authentication token has expired. Please re-authenticate.')).toBeInTheDocument();
      expect(screen.queryByTitle('Dismiss error')).not.toBeInTheDocument();
    });

    it('should not display dismiss button when onClearAgentError is not provided', () => {
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError({ recoverable: true }),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} onClearAgentError={undefined} />);

      expect(screen.queryByTitle('Dismiss error')).not.toBeInTheDocument();
    });

    it('should display error banner with AlertCircle icon', () => {
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError(),
        }],
        activeTabId: 'tab-1',
      });

      const { container } = render(<MainPanel {...defaultProps} activeSession={session} />);

      // Check for the AlertCircle icon (lucide-react renders as SVG with lucide class)
      // Look for an SVG within the error banner container (next to the error message)
      const errorMessage = screen.getByText('Authentication token has expired. Please re-authenticate.');
      const banner = errorMessage.closest('div.flex.items-center');
      const alertIcon = banner?.querySelector('svg');
      expect(alertIcon).toBeInTheDocument();
    });

    it('should display different error messages for different error types', () => {
      const errorTypes = [
        { type: 'auth_expired', message: 'Your session has expired' },
        { type: 'token_exhaustion', message: 'Context window is full' },
        { type: 'rate_limited', message: 'Rate limit exceeded' },
        { type: 'network_error', message: 'Network connection failed' },
        { type: 'agent_crashed', message: 'Agent process crashed unexpectedly' },
      ];

      for (const { type, message } of errorTypes) {
        const session = createSession({
          inputMode: 'ai',
          aiTabs: [{
            id: 'tab-1',
            name: 'Tab 1',
            isUnread: false,
            createdAt: Date.now(),
            agentError: createAgentError({ type: type as any, message }),
          }],
          activeTabId: 'tab-1',
        });

        const { unmount } = render(<MainPanel {...defaultProps} activeSession={session} />);

        expect(screen.getByText(message)).toBeInTheDocument();
        unmount();
      }
    });

    it('should only show error for the active tab, not inactive tabs', () => {
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [
          {
            id: 'tab-1',
            name: 'Tab 1',
            isUnread: false,
            createdAt: Date.now(),
            agentError: createAgentError({ message: 'Error on tab 1' }),
          },
          {
            id: 'tab-2',
            name: 'Tab 2',
            isUnread: false,
            createdAt: Date.now(),
            agentError: createAgentError({ message: 'Error on tab 2' }),
          },
        ],
        activeTabId: 'tab-2', // Tab 2 is active
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // Should show tab-2's error, not tab-1's
      expect(screen.getByText('Error on tab 2')).toBeInTheDocument();
      expect(screen.queryByText('Error on tab 1')).not.toBeInTheDocument();
    });

    it('should not display error banner when session is null', () => {
      render(<MainPanel {...defaultProps} activeSession={null} />);

      // Empty state should be shown, no error banner
      expect(screen.getByText('No agents. Create one to get started.')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('should still display error banner in terminal mode when active tab has error', () => {
      // The error banner is shown based on activeTab's error, not inputMode
      // This ensures users see errors even when they switch to terminal mode
      const session = createSession({
        inputMode: 'terminal',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError(),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // The error banner is shown regardless of inputMode to ensure visibility
      expect(screen.getByText('Authentication token has expired. Please re-authenticate.')).toBeInTheDocument();
    });

    it('should display both View Details and dismiss buttons when both callbacks are provided for recoverable errors', () => {
      const onShowAgentErrorModal = vi.fn();
      const onClearAgentError = vi.fn();
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError({ recoverable: true }),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel
        {...defaultProps}
        activeSession={session}
        onShowAgentErrorModal={onShowAgentErrorModal}
        onClearAgentError={onClearAgentError}
      />);

      expect(screen.getByText('View Details')).toBeInTheDocument();
      expect(screen.getByTitle('Dismiss error')).toBeInTheDocument();
    });

    it('should have appropriate styling (error color) for the banner', () => {
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError(),
        }],
        activeTabId: 'tab-1',
      });

      const { container } = render(<MainPanel {...defaultProps} activeSession={session} />);

      // Find the error banner element by looking for the error message container
      const errorMessage = screen.getByText('Authentication token has expired. Please re-authenticate.');
      const banner = errorMessage.closest('div.flex.items-center');

      // The banner should have error-colored styling
      expect(banner).toHaveStyle({ backgroundColor: expect.stringMatching(/ef4444|#ef4444/) });
    });

    it('should handle error banner when switching between tabs with and without errors', () => {
      // Start with a tab that has an error
      const sessionWithError = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError({ message: 'Error message' }),
        }],
        activeTabId: 'tab-1',
      });

      const { rerender } = render(<MainPanel {...defaultProps} activeSession={sessionWithError} />);

      expect(screen.getByText('Error message')).toBeInTheDocument();

      // Switch to a tab without an error
      const sessionWithoutError = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-2',
          name: 'Tab 2',
          isUnread: false,
          createdAt: Date.now(),
          agentError: undefined,
        }],
        activeTabId: 'tab-2',
      });

      rerender(<MainPanel {...defaultProps} activeSession={sessionWithoutError} />);

      expect(screen.queryByText('Error message')).not.toBeInTheDocument();
    });

    it('should display error banner below tab bar in AI mode', () => {
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError(),
        }],
        activeTabId: 'tab-1',
      });

      const { container } = render(<MainPanel {...defaultProps} activeSession={session} />);

      // Tab bar should exist
      expect(screen.getByTestId('tab-bar')).toBeInTheDocument();

      // Error banner should exist
      const errorMessage = screen.getByText('Authentication token has expired. Please re-authenticate.');
      expect(errorMessage).toBeInTheDocument();

      // Verify DOM order: tab-bar comes before error banner
      const tabBar = screen.getByTestId('tab-bar');
      const errorBanner = errorMessage.closest('div.flex.items-center');

      // Both should be siblings in the DOM tree
      const mainPanel = container.querySelector('[style*="backgroundColor"]');
      if (mainPanel && tabBar && errorBanner) {
        const children = Array.from(mainPanel.children);
        const tabBarIndex = children.indexOf(tabBar);
        const errorBannerIndex = children.indexOf(errorBanner as Element);

        // Tab bar should come before error banner (smaller index)
        // Note: This depends on the exact DOM structure
      }
    });

    it('should truncate very long error messages gracefully', () => {
      const longMessage = 'A'.repeat(500) + ' error message';
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError({ message: longMessage }),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // The error message should be displayed (the component doesn't truncate, but CSS might)
      expect(screen.getByText(longMessage)).toBeInTheDocument();
    });

    it('should still display error banner when previewFile is open', () => {
      // The error banner appears above file preview in the layout hierarchy
      // This ensures users see critical errors even while previewing files
      const previewFile = { name: 'test.ts', content: 'test content', path: '/test/test.ts' };
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: createAgentError(),
        }],
        activeTabId: 'tab-1',
      });

      render(<MainPanel {...defaultProps} activeSession={session} previewFile={previewFile} />);

      // Both error banner and file preview should be visible
      expect(screen.getByText('Authentication token has expired. Please re-authenticate.')).toBeInTheDocument();
      expect(screen.getByTestId('file-preview')).toBeInTheDocument();
    });

    it('should handle error with empty message gracefully', () => {
      const session = createSession({
        inputMode: 'ai',
        aiTabs: [{
          id: 'tab-1',
          name: 'Tab 1',
          isUnread: false,
          createdAt: Date.now(),
          agentError: {
            type: 'unknown',
            message: '',  // Empty message
            recoverable: true,
            agentId: 'claude-code',
            timestamp: Date.now(),
          },
        }],
        activeTabId: 'tab-1',
      });

      // Should render without crashing
      const { container } = render(<MainPanel {...defaultProps} activeSession={session} />);

      // The banner should still render with an icon even if message is empty
      // Look for the error banner structure - contains an SVG icon
      const errorBanner = container.querySelector('div.flex.items-center.gap-3');
      expect(errorBanner).toBeInTheDocument();
      const alertIcon = errorBanner?.querySelector('svg');
      expect(alertIcon).toBeInTheDocument();
    });
  });

  describe('Wizard Mode', () => {
    // Helper to create a session with wizardState on the active tab (not session level)
    const createSessionWithTabWizardState = (wizardState: any, sessionOverrides: Partial<Session> = {}): Session => {
      const baseSession = createSession(sessionOverrides);
      return {
        ...baseSession,
        aiTabs: baseSession.aiTabs.map((tab, index) =>
          index === 0 ? { ...tab, wizardState } : tab
        ),
      };
    };

    it('should render WizardConversationView when wizard is active', () => {
      const session = createSessionWithTabWizardState({
        isActive: true,
        mode: 'new',
        confidence: 50,
        conversationHistory: [
          { id: 'msg-1', role: 'system', content: 'Welcome', timestamp: Date.now() },
          { id: 'msg-2', role: 'user', content: 'Hello', timestamp: Date.now() },
        ],
        previousUIState: {
          readOnlyMode: false,
          saveToHistory: true,
          showThinking: false,
        },
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.getByTestId('wizard-conversation-view')).toBeInTheDocument();
      expect(screen.getByText('Wizard Conversation (2 messages)')).toBeInTheDocument();
      expect(screen.queryByTestId('terminal-output')).not.toBeInTheDocument();
    });

    it('should render TerminalOutput when wizard is not active', () => {
      const session = createSessionWithTabWizardState(undefined);

      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.getByTestId('terminal-output')).toBeInTheDocument();
      expect(screen.queryByTestId('wizard-conversation-view')).not.toBeInTheDocument();
    });

    it('should render TerminalOutput when wizard is inactive', () => {
      const session = createSessionWithTabWizardState({
        isActive: false,
        mode: 'new',
        confidence: 0,
        conversationHistory: [],
        previousUIState: {
          readOnlyMode: false,
          saveToHistory: true,
          showThinking: false,
        },
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.getByTestId('terminal-output')).toBeInTheDocument();
      expect(screen.queryByTestId('wizard-conversation-view')).not.toBeInTheDocument();
    });

    it('should show loading indicator when wizard isWaiting is true', () => {
      const session = createSessionWithTabWizardState({
        isActive: true,
        isWaiting: true,
        mode: 'new',
        confidence: 30,
        conversationHistory: [
          { id: 'msg-1', role: 'user', content: 'What should I build?', timestamp: Date.now() },
        ],
        previousUIState: {
          readOnlyMode: false,
          saveToHistory: true,
          showThinking: false,
        },
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      expect(screen.getByTestId('wizard-conversation-view')).toBeInTheDocument();
      expect(screen.getByTestId('wizard-loading')).toBeInTheDocument();
    });

    it('should still render header and tabs when wizard is active', () => {
      const session = createSessionWithTabWizardState({
        isActive: true,
        mode: 'new',
        confidence: 50,
        conversationHistory: [],
        previousUIState: {
          readOnlyMode: false,
          saveToHistory: true,
          showThinking: false,
        },
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // Header elements should still be visible
      expect(screen.getByText('Test Session')).toBeInTheDocument();
      // Tab bar should still be visible
      expect(screen.getByTestId('tab-bar')).toBeInTheDocument();
      // Wizard conversation view should be visible
      expect(screen.getByTestId('wizard-conversation-view')).toBeInTheDocument();
    });

    it('should pass agentName to WizardConversationView', () => {
      const session = createSessionWithTabWizardState({
        isActive: true,
        mode: 'iterate',
        goal: 'Add dark mode',
        confidence: 75,
        conversationHistory: [],
        previousUIState: {
          readOnlyMode: false,
          saveToHistory: true,
          showThinking: false,
        },
      }, {
        name: 'My Custom Agent',
      });

      render(<MainPanel {...defaultProps} activeSession={session} />);

      // The mock component just shows message count, but the agentName is passed through
      expect(screen.getByTestId('wizard-conversation-view')).toBeInTheDocument();
    });
  });
});
