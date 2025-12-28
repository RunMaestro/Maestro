import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InputArea } from '../../../renderer/components/InputArea';
import type { Session, Theme } from '../../../renderer/types';

// Mock scrollIntoView since jsdom doesn't support it
Element.prototype.scrollIntoView = vi.fn();

// Mock useAgentCapabilities hook - return claude-code capabilities by default
vi.mock('../../../renderer/hooks/agent/useAgentCapabilities', () => ({
  useAgentCapabilities: vi.fn(() => ({
    capabilities: {
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
      supportsStreamJsonInput: false,
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
    hasCapability: vi.fn((cap: string) => {
      // Return true for claude-code capabilities
      const capabilities: Record<string, boolean> = {
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
        supportsStreamJsonInput: false,
      };
      return capabilities[cap] ?? false;
    }),
  })),
}));

// Mock child components to isolate InputArea testing
vi.mock('../../../renderer/components/ThinkingStatusPill', () => ({
  ThinkingStatusPill: vi.fn(({ sessions, onSessionClick }) => (
    <div data-testid="thinking-status-pill">ThinkingStatusPill</div>
  )),
}));

vi.mock('../../../renderer/components/ExecutionQueueIndicator', () => ({
  ExecutionQueueIndicator: vi.fn(({ onClick }) => (
    <button data-testid="execution-queue-indicator" onClick={onClick}>
      ExecutionQueueIndicator
    </button>
  )),
}));

vi.mock('../../../renderer/components/InlineWizard', () => ({
  WizardInputPanel: vi.fn(({ theme, confidence, onExitWizard }) => (
    <div data-testid="wizard-input-panel">
      <span data-testid="wizard-confidence">{confidence}</span>
      <button data-testid="wizard-exit" onClick={onExitWizard}>Exit Wizard</button>
    </div>
  )),
}));

// Default theme for tests
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
    accentForeground: '#282a36',
    border: '#44475a',
    success: '#50fa7b',
    error: '#ff5555',
    warning: '#f1fa8c',
    info: '#8be9fd',
  },
};

// Default session for tests
const createMockSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1',
  name: 'Test Session',
  toolType: 'claude-code',
  state: 'idle',
  inputMode: 'ai',
  cwd: '/Users/test/project',
  projectRoot: '/Users/test/project',
  aiPid: 0,
  terminalPid: 0,
  aiTabs: [{
    id: 'tab-1',
    logs: [],
    agentSessionId: null,
    lastActivityAt: 0,
    scrollTop: 0,
    busyStartTime: null,
    statusMessage: null,
    contextUsage: null,
    isStarred: false,
    name: null,
    readOnlyMode: false,
    draftInput: '',
    saveToHistory: false,
  }],
  activeTabId: 'tab-1',
  shellLogs: [],
  usageStats: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
  agentSessionId: null,
  isGitRepo: false,
  fileTree: [],
  fileExplorerExpanded: [],
  messageQueue: [],
  shellCommandHistory: [],
  aiCommandHistory: [],
  closedTabHistory: [],
  shellCwd: '/Users/test/project',
  busySource: null,
  ...overrides,
});

// Default props factory
const createDefaultProps = (overrides: Partial<Parameters<typeof InputArea>[0]> = {}) => {
  const inputRef = { current: null } as React.RefObject<HTMLTextAreaElement>;
  return {
    session: createMockSession(),
    theme: mockTheme,
    inputValue: '',
    setInputValue: vi.fn(),
    enterToSend: true,
    setEnterToSend: vi.fn(),
    stagedImages: [],
    setStagedImages: vi.fn(),
    setLightboxImage: vi.fn(),
    commandHistoryOpen: false,
    setCommandHistoryOpen: vi.fn(),
    commandHistoryFilter: '',
    setCommandHistoryFilter: vi.fn(),
    commandHistorySelectedIndex: 0,
    setCommandHistorySelectedIndex: vi.fn(),
    slashCommandOpen: false,
    setSlashCommandOpen: vi.fn(),
    slashCommands: [
      { command: '/clear', description: 'Clear chat history' },
      { command: '/help', description: 'Show help', aiOnly: true },
      { command: '/cd', description: 'Change directory', terminalOnly: true },
    ],
    selectedSlashCommandIndex: 0,
    setSelectedSlashCommandIndex: vi.fn(),
    inputRef,
    handleInputKeyDown: vi.fn(),
    handlePaste: vi.fn(),
    handleDrop: vi.fn(),
    toggleInputMode: vi.fn(),
    processInput: vi.fn(),
    handleInterrupt: vi.fn(),
    onInputFocus: vi.fn(),
    onInputBlur: vi.fn(),
    sessions: [],
    ...overrides,
  };
};

describe('InputArea', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic Rendering', () => {
    it('renders the input textarea', () => {
      const props = createDefaultProps();
      render(<InputArea {...props} />);

      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('renders the mode toggle button', () => {
      const props = createDefaultProps();
      render(<InputArea {...props} />);

      expect(screen.getByTitle('Toggle Mode (Cmd+J)')).toBeInTheDocument();
    });

    it('renders the send button', () => {
      const props = createDefaultProps();
      render(<InputArea {...props} />);

      expect(screen.getByTitle('Send message')).toBeInTheDocument();
    });

    it('renders Enter to send toggle', () => {
      const props = createDefaultProps();
      render(<InputArea {...props} />);

      const button = screen.getByTitle('Switch to Meta+Enter to send');
      expect(button).toBeInTheDocument();
      expect(button).toHaveTextContent('Enter');
    });

    it('renders Cmd+Enter when enterToSend is false', () => {
      const props = createDefaultProps({ enterToSend: false });
      render(<InputArea {...props} />);

      const button = screen.getByTitle('Switch to Enter to send');
      expect(button).toHaveTextContent('⌘ + Enter');
    });
  });

  describe('AI Mode', () => {
    it('shows placeholder for AI mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai', name: 'MySession' }),
      });
      render(<InputArea {...props} />);

      expect(screen.getByPlaceholderText('Talking to MySession powered by Claude Code')).toBeInTheDocument();
    });

    it('shows attach image button in AI mode when agent supports image input', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
      });
      render(<InputArea {...props} />);

      expect(screen.getByTitle('Attach Image')).toBeInTheDocument();
    });

    it('hides attach image button when agent does not support image input', async () => {
      // Mock capabilities to return false for supportsImageInput
      const useAgentCapabilitiesMock = await import('../../../renderer/hooks/agent/useAgentCapabilities');
      vi.mocked(useAgentCapabilitiesMock.useAgentCapabilities).mockReturnValueOnce({
        capabilities: {
          supportsResume: true,
          supportsReadOnlyMode: true,
          supportsJsonOutput: true,
          supportsSessionId: true,
          supportsImageInput: false, // Not supported
          supportsImageInputOnResume: false,
          supportsSlashCommands: true,
          supportsSessionStorage: false,
          supportsCostTracking: false,
          supportsUsageStats: false,
          supportsBatchMode: false,
          requiresPromptToStart: false,
          supportsStreaming: true,
          supportsResultMessages: true,
          supportsModelSelection: false,
          supportsStreamJsonInput: false,
        },
        loading: false,
        error: null,
        refresh: vi.fn(),
        hasCapability: vi.fn((cap: string) => cap !== 'supportsImageInput'),
      });

      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai', toolType: 'opencode' }),
      });
      render(<InputArea {...props} />);

      expect(screen.queryByTitle('Attach Image')).not.toBeInTheDocument();
    });

    it('shows prompt composer button when onOpenPromptComposer is provided', () => {
      const onOpenPromptComposer = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        onOpenPromptComposer,
      });
      render(<InputArea {...props} />);

      expect(screen.getByTitle('Open Prompt Composer')).toBeInTheDocument();
    });

    it('shows read-only toggle when onToggleTabReadOnlyMode is provided', () => {
      const onToggleTabReadOnlyMode = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        onToggleTabReadOnlyMode,
      });
      render(<InputArea {...props} />);

      const toggle = screen.getByTitle(/Toggle read-only mode/);
      expect(toggle).toBeInTheDocument();
      expect(toggle).toHaveTextContent('Read-only');
    });

    it('hides read-only toggle when agent does not support read-only mode', async () => {
      // Mock capabilities to return false for supportsReadOnlyMode
      const useAgentCapabilitiesMock = await import('../../../renderer/hooks/agent/useAgentCapabilities');
      vi.mocked(useAgentCapabilitiesMock.useAgentCapabilities).mockReturnValueOnce({
        capabilities: {
          supportsResume: true,
          supportsReadOnlyMode: false, // Not supported
          supportsJsonOutput: true,
          supportsSessionId: true,
          supportsImageInput: true,
          supportsImageInputOnResume: true,
          supportsSlashCommands: true,
          supportsSessionStorage: false,
          supportsCostTracking: false,
          supportsUsageStats: false,
          supportsBatchMode: false,
          requiresPromptToStart: false,
          supportsStreaming: true,
          supportsResultMessages: true,
          supportsModelSelection: false,
          supportsStreamJsonInput: true,
        },
        loading: false,
        error: null,
        refresh: vi.fn(),
        hasCapability: vi.fn((cap: string) => cap !== 'supportsReadOnlyMode'),
      });

      const onToggleTabReadOnlyMode = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai', toolType: 'opencode' }),
        onToggleTabReadOnlyMode,
      });
      render(<InputArea {...props} />);

      // Read-only toggle should not be present
      expect(screen.queryByTitle(/Toggle read-only mode/)).not.toBeInTheDocument();
    });

    it('shows save to history toggle when onToggleTabSaveToHistory is provided', () => {
      const onToggleTabSaveToHistory = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        onToggleTabSaveToHistory,
      });
      render(<InputArea {...props} />);

      const toggle = screen.getByTitle(/Save to History/);
      expect(toggle).toBeInTheDocument();
      expect(toggle).toHaveTextContent('History');
    });

    it('renders ThinkingStatusPill when sessions exist', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        sessions: [createMockSession()],
      });
      render(<InputArea {...props} />);

      expect(screen.getByTestId('thinking-status-pill')).toBeInTheDocument();
    });

    it('renders ExecutionQueueIndicator when onOpenQueueBrowser is provided', () => {
      const onOpenQueueBrowser = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        onOpenQueueBrowser,
      });
      render(<InputArea {...props} />);

      expect(screen.getByTestId('execution-queue-indicator')).toBeInTheDocument();
    });

    it('does NOT show terminal prefix in AI mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
      });
      render(<InputArea {...props} />);

      // The $ prefix should NOT be present
      expect(screen.queryByText('$')).not.toBeInTheDocument();
    });
  });

  describe('Terminal Mode', () => {
    it('shows placeholder for terminal mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal' }),
      });
      render(<InputArea {...props} />);

      expect(screen.getByPlaceholderText('Run shell command...')).toBeInTheDocument();
    });

    it('shows $ prefix in terminal mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal' }),
      });
      render(<InputArea {...props} />);

      expect(screen.getByText('$')).toBeInTheDocument();
    });

    it('shows current directory (cwd) in terminal mode', () => {
      const props = createDefaultProps({
        session: createMockSession({
          inputMode: 'terminal',
          cwd: '/Users/test/project',
          shellCwd: '/Users/test/project/src',
        }),
      });
      render(<InputArea {...props} />);

      // shellCwd takes priority and is formatted to replace /Users/xxx with ~
      expect(screen.getByText(/~\/project\/src/)).toBeInTheDocument();
    });

    it('does NOT show attach image button in terminal mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal' }),
      });
      render(<InputArea {...props} />);

      expect(screen.queryByTitle('Attach Image')).not.toBeInTheDocument();
    });

    it('does NOT show ThinkingStatusPill in terminal mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal' }),
        sessions: [createMockSession()],
      });
      render(<InputArea {...props} />);

      expect(screen.queryByTestId('thinking-status-pill')).not.toBeInTheDocument();
    });

    it('shows "Run command" send button title in terminal mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal' }),
      });
      render(<InputArea {...props} />);

      expect(screen.getByTitle('Run command (Enter)')).toBeInTheDocument();
    });
  });

  describe('Read-only Mode', () => {
    it('applies warning styling when tabReadOnlyMode is true in AI mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        tabReadOnlyMode: true,
        onToggleTabReadOnlyMode: vi.fn(),
      });
      const { container } = render(<InputArea {...props} />);

      // Check border color is warning color
      const inputContainer = container.querySelector('.flex-1.relative.border');
      expect(inputContainer).toHaveStyle({ borderColor: mockTheme.colors.warning });
    });

    it('applies warning styling when isAutoModeActive is true in AI mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        isAutoModeActive: true,
      });
      const { container } = render(<InputArea {...props} />);

      const inputContainer = container.querySelector('.flex-1.relative.border');
      expect(inputContainer).toHaveStyle({ borderColor: mockTheme.colors.warning });
    });

    it('does NOT apply warning styling in terminal mode even with tabReadOnlyMode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal' }),
        tabReadOnlyMode: true,
      });
      const { container } = render(<InputArea {...props} />);

      // Read-only mode only applies to AI mode
      const inputContainer = container.querySelector('.flex-1.relative.border');
      expect(inputContainer).not.toHaveStyle({ borderColor: mockTheme.colors.warning });
    });

    it('keeps read-only toggle enabled when AutoRun is active', () => {
      const onToggleTabReadOnlyMode = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        isAutoModeActive: true,
        onToggleTabReadOnlyMode,
      });
      render(<InputArea {...props} />);

      const toggle = screen.getByTitle('Toggle read-only mode (agent won\'t modify files)');
      expect(toggle).not.toBeDisabled();

      fireEvent.click(toggle);
      expect(onToggleTabReadOnlyMode).toHaveBeenCalled();
    });

    it('shows the standard tooltip when AutoRun is active', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        isAutoModeActive: true,
        onToggleTabReadOnlyMode: vi.fn(),
      });
      render(<InputArea {...props} />);

      expect(screen.getByTitle('Toggle read-only mode (agent won\'t modify files)')).toBeInTheDocument();
    });

    it('does not apply read-only styling when AutoRun is active and tabReadOnlyMode is false', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        isAutoModeActive: true,
        tabReadOnlyMode: false,
        onToggleTabReadOnlyMode: vi.fn(),
      });
      render(<InputArea {...props} />);

      const toggle = screen.getByTitle('Toggle read-only mode (agent won\'t modify files)');
      expect(toggle).toHaveStyle({ color: mockTheme.colors.textDim });
    });
  });

  describe('Staged Images', () => {
    it('shows staged images in AI mode', () => {
      const stagedImages = [
        'data:image/png;base64,ABC123',
        'data:image/jpeg;base64,DEF456',
      ];
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        stagedImages,
      });
      render(<InputArea {...props} />);

      const images = screen.getAllByRole('img');
      expect(images).toHaveLength(2);
    });

    it('does NOT show staged images in terminal mode', () => {
      const stagedImages = ['data:image/png;base64,ABC123'];
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal' }),
        stagedImages,
      });
      render(<InputArea {...props} />);

      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('calls setLightboxImage when clicking staged image', () => {
      const setLightboxImage = vi.fn();
      const stagedImages = ['data:image/png;base64,ABC123'];
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        stagedImages,
        setLightboxImage,
      });
      render(<InputArea {...props} />);

      fireEvent.click(screen.getByRole('img'));

      expect(setLightboxImage).toHaveBeenCalledWith('data:image/png;base64,ABC123', stagedImages, 'staged');
    });

    it('removes image when clicking X button', () => {
      const setStagedImages = vi.fn();
      const stagedImages = ['data:image/png;base64,ABC123', 'data:image/png;base64,DEF456'];
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        stagedImages,
        setStagedImages,
      });
      render(<InputArea {...props} />);

      // Click the first remove button
      const removeIcon = screen.getAllByTestId('x-icon')[0];
      const removeButton = removeIcon.closest('button');
      expect(removeButton).toBeTruthy();
      fireEvent.click(removeButton!);

      expect(setStagedImages).toHaveBeenCalled();
      // Call the updater function to verify it removes index 0
      const updaterFn = setStagedImages.mock.calls[0][0];
      const result = updaterFn(stagedImages);
      expect(result).toEqual(['data:image/png;base64,DEF456']);
    });
  });

  describe('Slash Command Autocomplete', () => {
    it('shows slash commands when slashCommandOpen is true', () => {
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/',
      });
      render(<InputArea {...props} />);

      // Should show /clear and /help (not /cd which is terminalOnly)
      expect(screen.getByText('/clear')).toBeInTheDocument();
      expect(screen.getByText('/help')).toBeInTheDocument();
      // /cd is terminalOnly, shouldn't appear in AI mode
      expect(screen.queryByText('/cd')).not.toBeInTheDocument();
    });

    it('filters slash commands by input', () => {
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/cle',
      });
      render(<InputArea {...props} />);

      expect(screen.getByText('/clear')).toBeInTheDocument();
      expect(screen.queryByText('/help')).not.toBeInTheDocument();
    });

    it('shows terminalOnly commands in terminal mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal' }),
        slashCommandOpen: true,
        inputValue: '/',
      });
      render(<InputArea {...props} />);

      expect(screen.getByText('/cd')).toBeInTheDocument();
      // /help is aiOnly, shouldn't appear in terminal mode
      expect(screen.queryByText('/help')).not.toBeInTheDocument();
    });

    it('highlights selected command', () => {
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/',
        selectedSlashCommandIndex: 1,
      });
      render(<InputArea {...props} />);

      // The second command (/help) should have accent background
      // Find the parent div that has the background style (px-4 py-3 class)
      const helpCmd = screen.getByText('/help').closest('.px-4');
      expect(helpCmd).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
    });

    it('updates selection on mouse enter', () => {
      const setSelectedSlashCommandIndex = vi.fn();
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/',
        setSelectedSlashCommandIndex,
      });
      render(<InputArea {...props} />);

      const helpCmd = screen.getByText('/help').closest('.px-4');
      fireEvent.mouseEnter(helpCmd!);

      expect(setSelectedSlashCommandIndex).toHaveBeenCalledWith(1);
    });

    it('fills input on double-click', () => {
      const setInputValue = vi.fn();
      const setSlashCommandOpen = vi.fn();
      const inputRef = { current: { focus: vi.fn() } } as any;
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/',
        setInputValue,
        setSlashCommandOpen,
        inputRef,
      });
      render(<InputArea {...props} />);

      const clearCmd = screen.getByText('/clear').closest('.px-4');
      fireEvent.doubleClick(clearCmd!);

      expect(setInputValue).toHaveBeenCalledWith('/clear');
      expect(setSlashCommandOpen).toHaveBeenCalledWith(false);
    });

    it('shows slash command autocomplete for all agents (built-in commands always available)', async () => {
      // Slash commands are now always available regardless of agent capability
      // Built-in commands like /clear are shown for all agents
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai', toolType: 'opencode' }),
        slashCommandOpen: true,
        inputValue: '/',
      });
      render(<InputArea {...props} />);

      // Slash command autocomplete should be shown for all agents
      expect(screen.getByText('/clear')).toBeInTheDocument();
    });

    it('opens slash command autocomplete when typing / for any agent', async () => {
      // Slash commands are now always available regardless of supportsSlashCommands capability
      const setSlashCommandOpen = vi.fn();
      const setSelectedSlashCommandIndex = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai', toolType: 'opencode' }),
        setSlashCommandOpen,
        setSelectedSlashCommandIndex,
      });
      render(<InputArea {...props} />);

      // Type "/" to trigger slash command detection
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '/' } });

      // Should open slash command autocomplete for all agents
      expect(setSlashCommandOpen).toHaveBeenCalledWith(true);
    });

    it('calls handleInputKeyDown when pressing arrow keys in input', () => {
      const handleInputKeyDown = vi.fn();
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/',
        handleInputKeyDown,
      });
      render(<InputArea {...props} />);

      // Slash commands ArrowDown/ArrowUp/Enter/Escape are handled in App.tsx handleInputKeyDown
      // The InputArea should pass these events to the handler
      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'ArrowDown' });
      expect(handleInputKeyDown).toHaveBeenCalled();
    });

    it('shows empty state when no commands match filter', () => {
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/xyz123nonexistent',
        slashCommands: [
          { command: '/clear', description: 'Clear chat history' },
          { command: '/help', description: 'Show help', aiOnly: true },
        ],
      });
      render(<InputArea {...props} />);

      // When no commands match, the dropdown should not render any command items
      expect(screen.queryByText('/clear')).not.toBeInTheDocument();
      expect(screen.queryByText('/help')).not.toBeInTheDocument();
    });

    it('single click updates selection without closing dropdown', () => {
      const setSelectedSlashCommandIndex = vi.fn();
      const setSlashCommandOpen = vi.fn();
      const setInputValue = vi.fn();
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/',
        setSelectedSlashCommandIndex,
        setSlashCommandOpen,
        setInputValue,
      });
      render(<InputArea {...props} />);

      const helpCmd = screen.getByText('/help').closest('.px-4');
      fireEvent.click(helpCmd!);

      // Single click should update selection
      expect(setSelectedSlashCommandIndex).toHaveBeenCalledWith(1);
      // But should NOT close dropdown or fill input
      expect(setSlashCommandOpen).not.toHaveBeenCalled();
      expect(setInputValue).not.toHaveBeenCalled();
    });

    it('renders command description text', () => {
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/',
        slashCommands: [
          { command: '/test', description: 'Test command description' },
        ],
      });
      render(<InputArea {...props} />);

      expect(screen.getByText('Test command description')).toBeInTheDocument();
    });

    it('applies correct styling to unselected items', () => {
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/',
        selectedSlashCommandIndex: 0, // First item selected
      });
      render(<InputArea {...props} />);

      // The second item (/help) should NOT have accent background since index 0 is selected
      const helpCmd = screen.getByText('/help').closest('.px-4');
      // Unselected items don't have the accent color background
      expect(helpCmd).not.toHaveStyle({ backgroundColor: mockTheme.colors.accent });
      // First item (selected) should have accent background
      const clearCmd = screen.getByText('/clear').closest('.px-4');
      expect(clearCmd).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
    });

    it('scrolls selected item into view via refs', () => {
      // This test verifies the ref array for scroll-into-view is populated
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/',
        selectedSlashCommandIndex: 0,
      });
      render(<InputArea {...props} />);

      // Items should be rendered (refs should be attached)
      expect(screen.getByText('/clear')).toBeInTheDocument();
      expect(screen.getByText('/help')).toBeInTheDocument();
      // The scrollIntoView mock should have been called for selected item
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });
  });

  describe('Command History Modal', () => {
    it('shows command history when open', () => {
      const props = createDefaultProps({
        session: createMockSession({
          aiCommandHistory: ['hello world', 'explain this code'],
        }),
        commandHistoryOpen: true,
      });
      render(<InputArea {...props} />);

      expect(screen.getByPlaceholderText('Filter messages...')).toBeInTheDocument();
      expect(screen.getByText('hello world')).toBeInTheDocument();
      expect(screen.getByText('explain this code')).toBeInTheDocument();
    });

    it('shows shell history in terminal mode', () => {
      const props = createDefaultProps({
        session: createMockSession({
          inputMode: 'terminal',
          shellCommandHistory: ['ls -la', 'git status'],
        }),
        commandHistoryOpen: true,
      });
      render(<InputArea {...props} />);

      expect(screen.getByPlaceholderText('Filter commands...')).toBeInTheDocument();
      expect(screen.getByText('ls -la')).toBeInTheDocument();
      expect(screen.getByText('git status')).toBeInTheDocument();
    });

    it('filters history by search term', () => {
      const props = createDefaultProps({
        session: createMockSession({
          aiCommandHistory: ['hello world', 'explain code', 'hello again'],
        }),
        commandHistoryOpen: true,
        commandHistoryFilter: 'hello',
      });
      render(<InputArea {...props} />);

      expect(screen.getByText('hello world')).toBeInTheDocument();
      expect(screen.getByText('hello again')).toBeInTheDocument();
      expect(screen.queryByText('explain code')).not.toBeInTheDocument();
    });

    it('shows empty state when no matching commands', () => {
      const props = createDefaultProps({
        session: createMockSession({ aiCommandHistory: ['hello'] }),
        commandHistoryOpen: true,
        commandHistoryFilter: 'xyz',
      });
      render(<InputArea {...props} />);

      expect(screen.getByText('No matching messages')).toBeInTheDocument();
    });

    it('shows terminal-specific empty message', () => {
      const props = createDefaultProps({
        session: createMockSession({
          inputMode: 'terminal',
          shellCommandHistory: ['ls'],
        }),
        commandHistoryOpen: true,
        commandHistoryFilter: 'xyz',
      });
      render(<InputArea {...props} />);

      expect(screen.getByText('No matching commands')).toBeInTheDocument();
    });

    it('selects command on click', () => {
      const setInputValue = vi.fn();
      const setCommandHistoryOpen = vi.fn();
      const setCommandHistoryFilter = vi.fn();
      const inputRef = { current: { focus: vi.fn() } } as any;
      const props = createDefaultProps({
        session: createMockSession({ aiCommandHistory: ['hello world'] }),
        commandHistoryOpen: true,
        setInputValue,
        setCommandHistoryOpen,
        setCommandHistoryFilter,
        inputRef,
      });
      render(<InputArea {...props} />);

      fireEvent.click(screen.getByText('hello world'));

      expect(setInputValue).toHaveBeenCalledWith('hello world');
      expect(setCommandHistoryOpen).toHaveBeenCalledWith(false);
      expect(setCommandHistoryFilter).toHaveBeenCalledWith('');
    });

    it('deduplicates command history', () => {
      const props = createDefaultProps({
        session: createMockSession({
          aiCommandHistory: ['hello', 'world', 'hello', 'world', 'hello'],
        }),
        commandHistoryOpen: true,
      });
      render(<InputArea {...props} />);

      // Should only show unique commands, reversed, limited to 5
      const helloElements = screen.getAllByText('hello');
      const worldElements = screen.getAllByText('world');
      expect(helloElements).toHaveLength(1);
      expect(worldElements).toHaveLength(1);
    });

    it('handles keyboard navigation - ArrowDown', () => {
      const setCommandHistorySelectedIndex = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ aiCommandHistory: ['one', 'two', 'three'] }),
        commandHistoryOpen: true,
        commandHistorySelectedIndex: 0,
        setCommandHistorySelectedIndex,
      });
      render(<InputArea {...props} />);

      const filterInput = screen.getByPlaceholderText('Filter messages...');
      fireEvent.keyDown(filterInput, { key: 'ArrowDown' });

      expect(setCommandHistorySelectedIndex).toHaveBeenCalledWith(1);
    });

    it('handles keyboard navigation - ArrowUp', () => {
      const setCommandHistorySelectedIndex = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ aiCommandHistory: ['one', 'two', 'three'] }),
        commandHistoryOpen: true,
        commandHistorySelectedIndex: 2,
        setCommandHistorySelectedIndex,
      });
      render(<InputArea {...props} />);

      const filterInput = screen.getByPlaceholderText('Filter messages...');
      fireEvent.keyDown(filterInput, { key: 'ArrowUp' });

      expect(setCommandHistorySelectedIndex).toHaveBeenCalledWith(1);
    });

    it('handles Enter key to select', () => {
      const setInputValue = vi.fn();
      const setCommandHistoryOpen = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ aiCommandHistory: ['one', 'two', 'three'] }),
        commandHistoryOpen: true,
        commandHistorySelectedIndex: 1,
        setInputValue,
        setCommandHistoryOpen,
      });
      render(<InputArea {...props} />);

      const filterInput = screen.getByPlaceholderText('Filter messages...');
      fireEvent.keyDown(filterInput, { key: 'Enter' });

      expect(setInputValue).toHaveBeenCalledWith('two');
      expect(setCommandHistoryOpen).toHaveBeenCalledWith(false);
    });

    it('handles Escape key to close', () => {
      const setCommandHistoryOpen = vi.fn();
      const setCommandHistoryFilter = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ aiCommandHistory: ['one'] }),
        commandHistoryOpen: true,
        setCommandHistoryOpen,
        setCommandHistoryFilter,
      });
      render(<InputArea {...props} />);

      const filterInput = screen.getByPlaceholderText('Filter messages...');
      fireEvent.keyDown(filterInput, { key: 'Escape' });

      expect(setCommandHistoryOpen).toHaveBeenCalledWith(false);
      expect(setCommandHistoryFilter).toHaveBeenCalledWith('');
    });

    it('falls back to legacy commandHistory', () => {
      const sessionWithLegacy = createMockSession();
      (sessionWithLegacy as any).commandHistory = ['legacy command'];
      sessionWithLegacy.aiCommandHistory = [];

      const props = createDefaultProps({
        session: sessionWithLegacy,
        commandHistoryOpen: true,
      });
      render(<InputArea {...props} />);

      expect(screen.getByText('legacy command')).toBeInTheDocument();
    });
  });

  describe('Tab Completion', () => {
    it('shows tab completion in terminal mode when open', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal', isGitRepo: true }),
        tabCompletionOpen: true,
        tabCompletionSuggestions: [
          { value: 'ls -la', type: 'history', displayText: 'ls -la' },
          { value: 'main', type: 'branch', displayText: 'main' },
        ],
        setTabCompletionFilter: vi.fn(),
      });
      render(<InputArea {...props} />);

      expect(screen.getByText('Tab Completion')).toBeInTheDocument();
      expect(screen.getByText('ls -la')).toBeInTheDocument();
      expect(screen.getByText('main')).toBeInTheDocument();
    });

    it('does NOT show tab completion in AI mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        tabCompletionOpen: true,
        tabCompletionSuggestions: [
          { value: 'ls', type: 'history', displayText: 'ls' },
        ],
      });
      render(<InputArea {...props} />);

      expect(screen.queryByText('Tab Completion')).not.toBeInTheDocument();
    });

    it('shows filter buttons for git repos', () => {
      const setTabCompletionFilter = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal', isGitRepo: true }),
        tabCompletionOpen: true,
        tabCompletionSuggestions: [],
        setTabCompletionFilter,
      });
      render(<InputArea {...props} />);

      expect(screen.getByText('All')).toBeInTheDocument();
      expect(screen.getByText('History')).toBeInTheDocument();
      expect(screen.getByText('Branches')).toBeInTheDocument();
      expect(screen.getByText('Tags')).toBeInTheDocument();
      expect(screen.getByText('Files')).toBeInTheDocument();
    });

    it('does NOT show filter buttons for non-git repos', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal', isGitRepo: false }),
        tabCompletionOpen: true,
        tabCompletionSuggestions: [],
        setTabCompletionFilter: vi.fn(),
      });
      render(<InputArea {...props} />);

      expect(screen.queryByText('Branches')).not.toBeInTheDocument();
      expect(screen.queryByText('Tags')).not.toBeInTheDocument();
    });

    it('changes filter on button click', () => {
      const setTabCompletionFilter = vi.fn();
      const setSelectedTabCompletionIndex = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal', isGitRepo: true }),
        tabCompletionOpen: true,
        tabCompletionSuggestions: [],
        setTabCompletionFilter,
        setSelectedTabCompletionIndex,
      });
      render(<InputArea {...props} />);

      fireEvent.click(screen.getByText('Branches'));

      expect(setTabCompletionFilter).toHaveBeenCalledWith('branch');
      expect(setSelectedTabCompletionIndex).toHaveBeenCalledWith(0);
    });

    it('selects suggestion on click', () => {
      const setInputValue = vi.fn();
      const setTabCompletionOpen = vi.fn();
      const inputRef = { current: { focus: vi.fn() } } as any;
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal' }),
        tabCompletionOpen: true,
        tabCompletionSuggestions: [
          { value: 'git checkout main', type: 'history', displayText: 'git checkout main' },
        ],
        setInputValue,
        setTabCompletionOpen,
        inputRef,
      });
      render(<InputArea {...props} />);

      fireEvent.click(screen.getByText('git checkout main'));

      expect(setInputValue).toHaveBeenCalledWith('git checkout main');
      expect(setTabCompletionOpen).toHaveBeenCalledWith(false);
    });

    it('highlights selected suggestion based on selectedTabCompletionIndex', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal' }),
        tabCompletionOpen: true,
        tabCompletionSuggestions: [
          { value: 'ls -la', type: 'history', displayText: 'ls -la' },
          { value: 'cd src', type: 'history', displayText: 'cd src' },
          { value: 'main', type: 'branch', displayText: 'main' },
        ],
        selectedTabCompletionIndex: 1,
        setSelectedTabCompletionIndex: vi.fn(),
      });
      render(<InputArea {...props} />);

      const items = screen.getAllByText(/ls -la|cd src|main/).map(el => el.closest('div[class*="cursor-pointer"]'));

      // The second item (index 1) should have the ring class indicating selection
      expect(items[1]).toHaveClass('ring-1');
      // The first and third items should NOT have the ring class
      expect(items[0]).not.toHaveClass('ring-1');
      expect(items[2]).not.toHaveClass('ring-1');
    });

    it('updates selection on mouse hover', () => {
      const setSelectedTabCompletionIndex = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal' }),
        tabCompletionOpen: true,
        tabCompletionSuggestions: [
          { value: 'ls -la', type: 'history', displayText: 'ls -la' },
          { value: 'cd src', type: 'history', displayText: 'cd src' },
        ],
        selectedTabCompletionIndex: 0,
        setSelectedTabCompletionIndex,
      });
      render(<InputArea {...props} />);

      const secondItem = screen.getByText('cd src').closest('div[class*="cursor-pointer"]');
      fireEvent.mouseEnter(secondItem!);

      expect(setSelectedTabCompletionIndex).toHaveBeenCalledWith(1);
    });

    it('shows appropriate icons for different suggestion types', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal', isGitRepo: true }),
        tabCompletionOpen: true,
        tabCompletionSuggestions: [
          { value: 'ls -la', type: 'history', displayText: 'ls -la' },
          { value: 'git checkout main', type: 'branch', displayText: 'main' },
          { value: 'v1.0.0', type: 'tag', displayText: 'v1.0.0' },
          { value: 'src/components', type: 'folder', displayText: 'components' },
          { value: 'src/index.ts', type: 'file', displayText: 'index.ts' },
        ],
        setTabCompletionFilter: vi.fn(),
      });
      render(<InputArea {...props} />);

      // Each suggestion should be visible
      expect(screen.getByText('ls -la')).toBeInTheDocument();
      expect(screen.getByText('main')).toBeInTheDocument();
      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
      expect(screen.getByText('components')).toBeInTheDocument();
      expect(screen.getByText('index.ts')).toBeInTheDocument();

      // Each suggestion should have its type label
      expect(screen.getByText('history')).toBeInTheDocument();
      expect(screen.getByText('branch')).toBeInTheDocument();
      expect(screen.getByText('tag')).toBeInTheDocument();
      expect(screen.getByText('folder')).toBeInTheDocument();
      expect(screen.getByText('file')).toBeInTheDocument();
    });

    it('shows empty state for filtered results', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal', isGitRepo: true }),
        tabCompletionOpen: true,
        tabCompletionSuggestions: [],
        tabCompletionFilter: 'branch',
        setTabCompletionFilter: vi.fn(),
      });
      render(<InputArea {...props} />);

      expect(screen.getByText('No matching branches')).toBeInTheDocument();
    });
  });

  describe('@ Mention Completion', () => {
    it('shows @ mention dropdown in AI mode when open', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        atMentionOpen: true,
        atMentionFilter: 'src',
        atMentionSuggestions: [
          { value: 'src/index.ts', type: 'file' as const, displayText: 'index.ts', fullPath: 'src/index.ts' },
          { value: 'src/utils', type: 'folder' as const, displayText: 'utils', fullPath: 'src/utils' },
        ],
      });
      render(<InputArea {...props} />);

      expect(screen.getByText('Files')).toBeInTheDocument();
      expect(screen.getByText('src/index.ts')).toBeInTheDocument();
      expect(screen.getByText('src/utils')).toBeInTheDocument();
    });

    it('does NOT show @ mention in terminal mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal' }),
        atMentionOpen: true,
        atMentionSuggestions: [
          { value: 'src/index.ts', type: 'file' as const, displayText: 'index.ts', fullPath: 'src/index.ts' },
        ],
      });
      render(<InputArea {...props} />);

      expect(screen.queryByText('Files')).not.toBeInTheDocument();
    });

    it('shows filter text', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        atMentionOpen: true,
        atMentionFilter: 'utils',
        atMentionSuggestions: [
          { value: 'src/utils.ts', type: 'file' as const, displayText: 'utils.ts', fullPath: 'src/utils.ts' },
        ],
      });
      render(<InputArea {...props} />);

      expect(screen.getByText(/matching "utils"/)).toBeInTheDocument();
    });

    it('selects @ mention on click', () => {
      const setInputValue = vi.fn();
      const setAtMentionOpen = vi.fn();
      const setAtMentionFilter = vi.fn();
      const setAtMentionStartIndex = vi.fn();
      const inputRef = { current: { focus: vi.fn() } } as any;
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        inputValue: 'check @src/ind file',
        atMentionOpen: true,
        atMentionFilter: 'src/ind',
        atMentionStartIndex: 6,
        atMentionSuggestions: [
          { value: 'src/index.ts', type: 'file' as const, displayText: 'index.ts', fullPath: 'src/index.ts' },
        ],
        setInputValue,
        setAtMentionOpen,
        setAtMentionFilter,
        setAtMentionStartIndex,
        inputRef,
      });
      render(<InputArea {...props} />);

      fireEvent.click(screen.getByText('src/index.ts'));

      // Should replace @src/ind with @src/index.ts
      expect(setInputValue).toHaveBeenCalledWith('check @src/index.ts  file');
      expect(setAtMentionOpen).toHaveBeenCalledWith(false);
      expect(setAtMentionFilter).toHaveBeenCalledWith('');
      expect(setAtMentionStartIndex).toHaveBeenCalledWith(-1);
    });
  });

  describe('Input Handling', () => {
    it('calls setInputValue on change', () => {
      const setInputValue = vi.fn();
      const props = createDefaultProps({ setInputValue });
      render(<InputArea {...props} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });

      expect(setInputValue).toHaveBeenCalledWith('hello');
    });

    it('opens slash command autocomplete when typing /', () => {
      const setSlashCommandOpen = vi.fn();
      const setSelectedSlashCommandIndex = vi.fn();
      const props = createDefaultProps({
        setSlashCommandOpen,
        setSelectedSlashCommandIndex,
      });
      render(<InputArea {...props} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: '/' } });

      expect(setSlashCommandOpen).toHaveBeenCalledWith(true);
      expect(setSelectedSlashCommandIndex).toHaveBeenCalledWith(0);
    });

    it('closes slash command when input has space', () => {
      const setSlashCommandOpen = vi.fn();
      const props = createDefaultProps({
        setSlashCommandOpen,
        slashCommandOpen: true,
      });
      render(<InputArea {...props} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: '/clear arg' } });

      expect(setSlashCommandOpen).toHaveBeenCalledWith(false);
    });

    it('triggers @ mention detection in AI mode', () => {
      const setAtMentionOpen = vi.fn();
      const setAtMentionFilter = vi.fn();
      const setAtMentionStartIndex = vi.fn();
      const setSelectedAtMentionIndex = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        setAtMentionOpen,
        setAtMentionFilter,
        setAtMentionStartIndex,
        setSelectedAtMentionIndex,
      });
      render(<InputArea {...props} />);

      // Simulate typing "@src"
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, {
        target: { value: '@src', selectionStart: 4 }
      });

      expect(setAtMentionOpen).toHaveBeenCalledWith(true);
      expect(setAtMentionFilter).toHaveBeenCalledWith('src');
      expect(setAtMentionStartIndex).toHaveBeenCalledWith(0);
      expect(setSelectedAtMentionIndex).toHaveBeenCalledWith(0);
    });

    it('closes @ mention when no @ is found before cursor position', () => {
      const setAtMentionOpen = vi.fn();
      const setAtMentionFilter = vi.fn();
      const setAtMentionStartIndex = vi.fn();
      const setSelectedAtMentionIndex = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        setAtMentionOpen,
        setAtMentionFilter,
        setAtMentionStartIndex,
        setSelectedAtMentionIndex,
      });
      render(<InputArea {...props} />);

      // Type plain text without any @ character
      // When there's no @ in the text, setAtMentionOpen(false) is called (line 597)
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, {
        target: { value: 'hello world' }
      });

      expect(setAtMentionOpen).toHaveBeenCalledWith(false);
    });

    it('calls handleInputKeyDown on key down', () => {
      const handleInputKeyDown = vi.fn();
      const props = createDefaultProps({ handleInputKeyDown });
      render(<InputArea {...props} />);

      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

      expect(handleInputKeyDown).toHaveBeenCalled();
    });

    it('calls handlePaste on paste', () => {
      const handlePaste = vi.fn();
      const props = createDefaultProps({ handlePaste });
      render(<InputArea {...props} />);

      fireEvent.paste(screen.getByRole('textbox'), {
        clipboardData: { getData: () => 'pasted text' },
      });

      expect(handlePaste).toHaveBeenCalled();
    });

    it('calls handleDrop on drop', () => {
      const handleDrop = vi.fn();
      const props = createDefaultProps({ handleDrop });
      render(<InputArea {...props} />);

      fireEvent.drop(screen.getByRole('textbox'), {
        dataTransfer: { files: [] },
      });

      expect(handleDrop).toHaveBeenCalled();
    });

    it('calls onInputFocus on focus', () => {
      const onInputFocus = vi.fn();
      const props = createDefaultProps({ onInputFocus });
      render(<InputArea {...props} />);

      fireEvent.focus(screen.getByRole('textbox'));

      expect(onInputFocus).toHaveBeenCalled();
    });

    it('calls onInputBlur on blur', () => {
      const onInputBlur = vi.fn();
      const props = createDefaultProps({ onInputBlur });
      render(<InputArea {...props} />);

      fireEvent.blur(screen.getByRole('textbox'));

      expect(onInputBlur).toHaveBeenCalled();
    });
  });

  describe('Button Actions', () => {
    it('calls toggleInputMode when clicking mode toggle', () => {
      const toggleInputMode = vi.fn();
      const props = createDefaultProps({ toggleInputMode });
      render(<InputArea {...props} />);

      fireEvent.click(screen.getByTitle('Toggle Mode (Cmd+J)'));

      expect(toggleInputMode).toHaveBeenCalled();
    });

    it('calls processInput when clicking send button', () => {
      const processInput = vi.fn();
      const props = createDefaultProps({ processInput });
      render(<InputArea {...props} />);

      fireEvent.click(screen.getByTitle('Send message'));

      expect(processInput).toHaveBeenCalled();
    });

    it('toggles enterToSend when clicking keyboard button', () => {
      const setEnterToSend = vi.fn();
      const props = createDefaultProps({ enterToSend: true, setEnterToSend });
      render(<InputArea {...props} />);

      fireEvent.click(screen.getByTitle('Switch to Meta+Enter to send'));

      expect(setEnterToSend).toHaveBeenCalledWith(false);
    });

    it('calls onToggleTabReadOnlyMode when clicking read-only toggle', () => {
      const onToggleTabReadOnlyMode = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        onToggleTabReadOnlyMode,
      });
      render(<InputArea {...props} />);

      fireEvent.click(screen.getByTitle(/Toggle read-only mode/));

      expect(onToggleTabReadOnlyMode).toHaveBeenCalled();
    });

    it('calls onToggleTabSaveToHistory when clicking history toggle', () => {
      const onToggleTabSaveToHistory = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        onToggleTabSaveToHistory,
      });
      render(<InputArea {...props} />);

      fireEvent.click(screen.getByTitle(/Save to History/));

      expect(onToggleTabSaveToHistory).toHaveBeenCalled();
    });

    it('calls onOpenPromptComposer when clicking prompt composer button', () => {
      const onOpenPromptComposer = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        onOpenPromptComposer,
      });
      render(<InputArea {...props} />);

      fireEvent.click(screen.getByTitle('Open Prompt Composer'));

      expect(onOpenPromptComposer).toHaveBeenCalled();
    });

    it('calls onOpenQueueBrowser when clicking execution queue indicator', () => {
      const onOpenQueueBrowser = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        onOpenQueueBrowser,
      });
      render(<InputArea {...props} />);

      fireEvent.click(screen.getByTestId('execution-queue-indicator'));

      expect(onOpenQueueBrowser).toHaveBeenCalled();
    });
  });

  describe('Image File Input', () => {
    it('renders hidden file input in AI mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
      });
      render(<InputArea {...props} />);

      // Get the hidden file input
      const fileInput = document.getElementById('image-file-input') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();
      expect(fileInput).toHaveAttribute('type', 'file');
      expect(fileInput).toHaveAttribute('accept', 'image/*');
      expect(fileInput).toHaveAttribute('multiple');
    });

    it('triggers file input click when attach button is clicked', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
      });
      render(<InputArea {...props} />);

      const fileInput = document.getElementById('image-file-input') as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, 'click');

      fireEvent.click(screen.getByTitle('Attach Image'));

      expect(clickSpy).toHaveBeenCalled();
    });

    it('uploads images via FileReader when files are selected', async () => {
      const setStagedImages = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        setStagedImages,
      });
      render(<InputArea {...props} />);

      const fileInput = document.getElementById('image-file-input') as HTMLInputElement;

      // Create a mock file
      const file = new File(['fake image content'], 'test.png', { type: 'image/png' });

      // Trigger file selection
      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [file] } });
        // Wait for FileReader to complete
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      // setStagedImages should have been called with the data URL
      expect(setStagedImages).toHaveBeenCalled();
    });

    it('handles multiple file uploads', async () => {
      const setStagedImages = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        setStagedImages,
      });
      render(<InputArea {...props} />);

      const fileInput = document.getElementById('image-file-input') as HTMLInputElement;

      // Create multiple mock files
      const file1 = new File(['image1'], 'test1.png', { type: 'image/png' });
      const file2 = new File(['image2'], 'test2.png', { type: 'image/png' });

      // Trigger file selection with multiple files
      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [file1, file2] } });
        // Wait for FileReader to complete
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      // setStagedImages should have been called for each file
      expect(setStagedImages).toHaveBeenCalled();
    });

    it('clears file input value after selection', async () => {
      const setStagedImages = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        setStagedImages,
      });
      render(<InputArea {...props} />);

      const fileInput = document.getElementById('image-file-input') as HTMLInputElement;
      const file = new File(['content'], 'test.png', { type: 'image/png' });

      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [file] } });
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      // After processing, the input value should be cleared
      expect(fileInput.value).toBe('');
    });

    it('handles empty file selection gracefully', async () => {
      const setStagedImages = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        setStagedImages,
      });
      render(<InputArea {...props} />);

      const fileInput = document.getElementById('image-file-input') as HTMLInputElement;

      // Trigger with empty/null files
      await act(async () => {
        fireEvent.change(fileInput, { target: { files: null } });
      });

      // Should not call setStagedImages for empty selection
      expect(setStagedImages).not.toHaveBeenCalled();
    });
  });

  describe('Drag and Drop', () => {
    it('allows drag over by preventing default (tested via handleDrop availability)', () => {
      const handleDrop = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        handleDrop,
      });
      render(<InputArea {...props} />);

      const textarea = screen.getByRole('textbox');

      // The onDragOver handler calls e.preventDefault() which is needed to allow drop
      // We can verify the textarea accepts drag events by checking the drop handler is set up
      // Since fireEvent doesn't propagate preventDefault properly, we verify the handler exists
      fireEvent.dragOver(textarea);

      // We verify the drop handler works which confirms drag/drop is properly configured
      fireEvent.drop(textarea, { dataTransfer: { files: [] } });
      expect(handleDrop).toHaveBeenCalled();
    });
  });

  describe('Auto-resize Textarea', () => {
    it('resizes textarea when inputValue changes', () => {
      const inputRef = { current: document.createElement('textarea') } as React.RefObject<HTMLTextAreaElement>;
      const props = createDefaultProps({
        inputRef,
        inputValue: 'line1\nline2\nline3',
      });

      // Mock scrollHeight
      Object.defineProperty(inputRef.current!, 'scrollHeight', { value: 80, configurable: true });

      render(<InputArea {...props} />);

      // The useEffect should have run and set the height
      expect(inputRef.current!.style.height).toBeDefined();
    });
  });

  describe('Mode Icon Display', () => {
    it('shows Terminal icon in terminal mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'terminal' }),
      });
      render(<InputArea {...props} />);

      // Terminal icon should be in the mode toggle button
      const modeButton = screen.getByTitle('Toggle Mode (Cmd+J)');
      expect(modeButton.querySelector('[data-testid="terminal-icon"]')).toBeInTheDocument();
    });

    it('shows Cpu icon in AI mode', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
      });
      render(<InputArea {...props} />);

      const modeButton = screen.getByTitle('Toggle Mode (Cmd+J)');
      expect(modeButton.querySelector('[data-testid="cpu-icon"]')).toBeInTheDocument();
    });
  });

  describe('Toggle Button Styling', () => {
    it('applies active styling to read-only toggle when enabled', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        tabReadOnlyMode: true,
        onToggleTabReadOnlyMode: vi.fn(),
      });
      render(<InputArea {...props} />);

      const toggle = screen.getByTitle(/Toggle read-only mode/);
      // Should have warning color and background
      expect(toggle).toHaveStyle({ color: mockTheme.colors.warning });
    });

    it('applies active styling to history toggle when enabled', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai' }),
        tabSaveToHistory: true,
        onToggleTabSaveToHistory: vi.fn(),
      });
      render(<InputArea {...props} />);

      const toggle = screen.getByTitle(/Save to History/);
      expect(toggle).toHaveStyle({ color: mockTheme.colors.accent });
    });
  });

  describe('safeSelectedIndex Clamping', () => {
    it('clamps selectedSlashCommandIndex to valid range', () => {
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/',
        selectedSlashCommandIndex: 100, // Way beyond available commands
      });
      render(<InputArea {...props} />);

      // Should still render without errors, clamped to last valid index
      expect(screen.getByText('/clear')).toBeInTheDocument();
    });

    it('handles negative selectedSlashCommandIndex', () => {
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/',
        selectedSlashCommandIndex: -5,
      });
      render(<InputArea {...props} />);

      // Should clamp to 0
      expect(screen.getByText('/clear')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('handles empty slashCommands array', () => {
      const props = createDefaultProps({
        slashCommandOpen: true,
        inputValue: '/',
        slashCommands: [],
      });
      render(<InputArea {...props} />);

      // Should not render the autocomplete container
      expect(screen.queryByText('Clear chat history')).not.toBeInTheDocument();
    });

    it('handles empty command history', () => {
      const props = createDefaultProps({
        session: createMockSession({ aiCommandHistory: [] }),
        commandHistoryOpen: true,
      });
      render(<InputArea {...props} />);

      expect(screen.getByText('No matching messages')).toBeInTheDocument();
    });

    it('handles session without fileTree for @ mentions', () => {
      const props = createDefaultProps({
        session: createMockSession({ inputMode: 'ai', fileTree: [] }),
        atMentionOpen: true,
        atMentionSuggestions: [],
      });
      render(<InputArea {...props} />);

      // Should not render @ mention dropdown if no suggestions
      expect(screen.queryByText('Files')).not.toBeInTheDocument();
    });

    it('handles special characters in command history', () => {
      const props = createDefaultProps({
        session: createMockSession({
          aiCommandHistory: ['<script>alert("xss")</script>', '`backticks`'],
        }),
        commandHistoryOpen: true,
      });
      render(<InputArea {...props} />);

      // Should render safely without XSS
      expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument();
      expect(screen.getByText('`backticks`')).toBeInTheDocument();
    });

    it('handles unicode in input', () => {
      const setInputValue = vi.fn();
      const props = createDefaultProps({ setInputValue });
      render(<InputArea {...props} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: '你好世界 🎉' } });

      expect(setInputValue).toHaveBeenCalledWith('你好世界 🎉');
    });

    it('handles very long input', () => {
      const longText = 'a'.repeat(10000);
      const props = createDefaultProps({ inputValue: longText });
      render(<InputArea {...props} />);

      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveValue(longText);
    });
  });

  describe('Component Memoization', () => {
    it('is wrapped in React.memo', () => {
      // InputArea is exported as React.memo(function InputArea(...))
      expect(InputArea).toBeDefined();
      // React.memo wraps the component and has a $$typeof property
      expect((InputArea as any).$$typeof).toBe(Symbol.for('react.memo'));
    });
  });

  describe('Wizard Mode', () => {
    it('renders WizardInputPanel when wizard is active and onExitWizard is provided', () => {
      const onExitWizard = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({
          inputMode: 'ai',
          wizardState: {
            isActive: true,
            mode: 'new',
            confidence: 75,
            conversationHistory: [],
            previousUIState: {
              readOnlyMode: false,
              saveToHistory: false,
              showThinking: false,
            },
          },
        }),
        onExitWizard,
      });
      render(<InputArea {...props} />);

      expect(screen.getByTestId('wizard-input-panel')).toBeInTheDocument();
      expect(screen.getByTestId('wizard-confidence')).toHaveTextContent('75');
    });

    it('does NOT render WizardInputPanel when wizard is not active', () => {
      const onExitWizard = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({
          inputMode: 'ai',
          wizardState: {
            isActive: false,
            mode: null,
            confidence: 0,
            conversationHistory: [],
            previousUIState: {
              readOnlyMode: false,
              saveToHistory: false,
              showThinking: false,
            },
          },
        }),
        onExitWizard,
      });
      render(<InputArea {...props} />);

      expect(screen.queryByTestId('wizard-input-panel')).not.toBeInTheDocument();
      // Should show normal input area
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('does NOT render WizardInputPanel when onExitWizard is not provided', () => {
      const props = createDefaultProps({
        session: createMockSession({
          inputMode: 'ai',
          wizardState: {
            isActive: true,
            mode: 'new',
            confidence: 75,
            conversationHistory: [],
            previousUIState: {
              readOnlyMode: false,
              saveToHistory: false,
              showThinking: false,
            },
          },
        }),
        // No onExitWizard provided
      });
      render(<InputArea {...props} />);

      expect(screen.queryByTestId('wizard-input-panel')).not.toBeInTheDocument();
      // Should show normal input area
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('does NOT render WizardInputPanel when wizardState is undefined', () => {
      const onExitWizard = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({
          inputMode: 'ai',
          // No wizardState
        }),
        onExitWizard,
      });
      render(<InputArea {...props} />);

      expect(screen.queryByTestId('wizard-input-panel')).not.toBeInTheDocument();
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });

    it('calls onExitWizard when exit button is clicked', () => {
      const onExitWizard = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({
          inputMode: 'ai',
          wizardState: {
            isActive: true,
            mode: 'new',
            confidence: 50,
            conversationHistory: [],
            previousUIState: {
              readOnlyMode: false,
              saveToHistory: false,
              showThinking: false,
            },
          },
        }),
        onExitWizard,
      });
      render(<InputArea {...props} />);

      fireEvent.click(screen.getByTestId('wizard-exit'));

      expect(onExitWizard).toHaveBeenCalled();
    });

    it('renders WizardInputPanel with iterate mode', () => {
      const onExitWizard = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({
          inputMode: 'ai',
          wizardState: {
            isActive: true,
            mode: 'iterate',
            goal: 'Add a new feature',
            confidence: 85,
            conversationHistory: [],
            previousUIState: {
              readOnlyMode: true,
              saveToHistory: true,
              showThinking: true,
            },
          },
        }),
        onExitWizard,
      });
      render(<InputArea {...props} />);

      expect(screen.getByTestId('wizard-input-panel')).toBeInTheDocument();
      expect(screen.getByTestId('wizard-confidence')).toHaveTextContent('85');
    });

    it('hides normal input area components when wizard is active', () => {
      const onExitWizard = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({
          inputMode: 'ai',
          wizardState: {
            isActive: true,
            mode: 'new',
            confidence: 60,
            conversationHistory: [],
            previousUIState: {
              readOnlyMode: false,
              saveToHistory: false,
              showThinking: false,
            },
          },
        }),
        sessions: [createMockSession()],
        onExitWizard,
        onToggleTabReadOnlyMode: vi.fn(),
        onToggleTabSaveToHistory: vi.fn(),
      });
      render(<InputArea {...props} />);

      // WizardInputPanel should be rendered
      expect(screen.getByTestId('wizard-input-panel')).toBeInTheDocument();
      // Normal components should NOT be rendered
      expect(screen.queryByTestId('thinking-status-pill')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Toggle Mode (Cmd+J)')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Send message')).not.toBeInTheDocument();
    });

    it('prioritizes summarization overlay over wizard mode', () => {
      const onExitWizard = vi.fn();
      const onCancelSummarize = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({
          inputMode: 'ai',
          wizardState: {
            isActive: true,
            mode: 'new',
            confidence: 75,
            conversationHistory: [],
            previousUIState: {
              readOnlyMode: false,
              saveToHistory: false,
              showThinking: false,
            },
          },
        }),
        isSummarizing: true,
        onCancelSummarize,
        onExitWizard,
      });
      render(<InputArea {...props} />);

      // Summarization overlay takes precedence
      expect(screen.queryByTestId('wizard-input-panel')).not.toBeInTheDocument();
    });

    it('prioritizes merge overlay over wizard mode', () => {
      const onExitWizard = vi.fn();
      const onCancelMerge = vi.fn();
      const props = createDefaultProps({
        session: createMockSession({
          inputMode: 'ai',
          wizardState: {
            isActive: true,
            mode: 'new',
            confidence: 75,
            conversationHistory: [],
            previousUIState: {
              readOnlyMode: false,
              saveToHistory: false,
              showThinking: false,
            },
          },
        }),
        isMerging: true,
        onCancelMerge,
        onExitWizard,
      });
      render(<InputArea {...props} />);

      // Merge overlay takes precedence
      expect(screen.queryByTestId('wizard-input-panel')).not.toBeInTheDocument();
    });
  });
});
