/**
 * Tests for SettingsModal.tsx
 *
 * Tests the SettingsModal component, including:
 * - Modal rendering and isOpen conditional
 * - Tab navigation (general, shortcuts, theme, notifications, aicommands)
 * - Tab keyboard navigation (Cmd+Shift+[ and ])
 * - Layer stack integration
 * - Agent loading and configuration
 * - Font loading and management
 * - Shell loading and selection
 * - Shortcut recording
 * - Theme picker with Tab navigation
 * - Various setting controls
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { SettingsModal } from '../../../renderer/components/SettingsModal';
import type { Theme, Shortcut, ShellInfo, CustomAICommand, AgentConfig } from '../../../renderer/types';

// Mock the LayerStackContext
vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
  useLayerStack: vi.fn(() => ({
    registerLayer: vi.fn(() => 'layer-123'),
    unregisterLayer: vi.fn(),
    updateLayerHandler: vi.fn(),
  })),
}));

// Mock formatShortcutKeys
vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
  formatShortcutKeys: vi.fn((keys: string[]) => keys.join('+')),
}));

// Mock AICommandsPanel
vi.mock('../../../renderer/components/AICommandsPanel', () => ({
  AICommandsPanel: ({ theme }: { theme: Theme }) => (
    <div data-testid="ai-commands-panel">AI Commands Panel</div>
  ),
}));

// Mock SpecKitCommandsPanel
vi.mock('../../../renderer/components/SpecKitCommandsPanel', () => ({
  SpecKitCommandsPanel: ({ theme }: { theme: Theme }) => (
    <div data-testid="spec-kit-commands-panel">Spec Kit Commands Panel</div>
  ),
}));

// Mock CustomThemeBuilder
vi.mock('../../../renderer/components/CustomThemeBuilder', () => ({
  CustomThemeBuilder: ({ isSelected, onSelect }: { isSelected: boolean; onSelect: () => void }) => (
    <div data-testid="custom-theme-builder">
      <button onClick={onSelect} data-theme-id="custom" className={isSelected ? 'ring-2' : ''}>
        Custom Theme
      </button>
    </div>
  ),
}));

// Sample theme for testing
const mockTheme: Theme = {
  id: 'dracula',
  name: 'Dracula',
  mode: 'dark',
  colors: {
    bgMain: '#282a36',
    bgSidebar: '#21222c',
    bgActivity: '#343746',
    border: '#44475a',
    textMain: '#f8f8f2',
    textDim: '#6272a4',
    accent: '#bd93f9',
    accentDim: '#bd93f920',
    accentText: '#ff79c6',
    accentForeground: '#ffffff',
    success: '#50fa7b',
    warning: '#ffb86c',
    error: '#ff5555',
  },
};

const mockLightTheme: Theme = {
  id: 'github-light',
  name: 'GitHub Light',
  mode: 'light',
  colors: {
    bgMain: '#ffffff',
    bgSidebar: '#f6f8fa',
    bgActivity: '#e1e4e8',
    border: '#e1e4e8',
    textMain: '#24292e',
    textDim: '#586069',
    accent: '#0366d6',
    accentDim: '#0366d620',
    accentText: '#0366d6',
    accentForeground: '#ffffff',
    success: '#28a745',
    warning: '#f59e0b',
    error: '#d73a49',
  },
};

const mockVibeTheme: Theme = {
  id: 'pedurple',
  name: 'Pedurple',
  mode: 'vibe',
  colors: {
    bgMain: '#1a1a2e',
    bgSidebar: '#16213e',
    bgActivity: '#0f3460',
    border: '#e94560',
    textMain: '#eaeaea',
    textDim: '#a8a8a8',
    accent: '#e94560',
    accentDim: '#e9456020',
    accentText: '#ff8dc7',
    accentForeground: '#ffffff',
    success: '#50fa7b',
    warning: '#ffb86c',
    error: '#ff5555',
  },
};

const mockThemes: Record<string, Theme> = {
  dracula: mockTheme,
  'github-light': mockLightTheme,
  pedurple: mockVibeTheme,
};

const mockShortcuts: Record<string, Shortcut> = {
  'new-session': { id: 'new-session', label: 'New Session', keys: ['Meta', 'n'] },
  'close-session': { id: 'close-session', label: 'Close Session', keys: ['Meta', 'w'] },
  'toggle-mode': { id: 'toggle-mode', label: 'Toggle Mode', keys: ['Meta', 'j'] },
};

const createDefaultProps = (overrides = {}) => ({
  isOpen: true,
  onClose: vi.fn(),
  theme: mockTheme,
  themes: mockThemes,
  activeThemeId: 'dracula',
  setActiveThemeId: vi.fn(),
  customThemeColors: mockTheme.colors,
  setCustomThemeColors: vi.fn(),
  customThemeBaseId: 'dracula' as const,
  setCustomThemeBaseId: vi.fn(),
  llmProvider: 'openrouter',
  setLlmProvider: vi.fn(),
  modelSlug: '',
  setModelSlug: vi.fn(),
  apiKey: '',
  setApiKey: vi.fn(),
  shortcuts: mockShortcuts,
  setShortcuts: vi.fn(),
  tabShortcuts: {} as Record<string, Shortcut>,
  setTabShortcuts: vi.fn(),
  fontFamily: 'Menlo',
  setFontFamily: vi.fn(),
  fontSize: 14,
  setFontSize: vi.fn(),
  terminalWidth: 100,
  setTerminalWidth: vi.fn(),
  logLevel: 'info',
  setLogLevel: vi.fn(),
  maxLogBuffer: 5000,
  setMaxLogBuffer: vi.fn(),
  maxOutputLines: 25,
  setMaxOutputLines: vi.fn(),
  defaultShell: 'zsh',
  setDefaultShell: vi.fn(),
  ghPath: '',
  setGhPath: vi.fn(),
  enterToSendAI: true,
  setEnterToSendAI: vi.fn(),
  enterToSendTerminal: true,
  setEnterToSendTerminal: vi.fn(),
  defaultSaveToHistory: true,
  setDefaultSaveToHistory: vi.fn(),
  osNotificationsEnabled: true,
  setOsNotificationsEnabled: vi.fn(),
  audioFeedbackEnabled: false,
  setAudioFeedbackEnabled: vi.fn(),
  audioFeedbackCommand: 'say',
  setAudioFeedbackCommand: vi.fn(),
  toastDuration: 10,
  setToastDuration: vi.fn(),
  customAICommands: [],
  setCustomAICommands: vi.fn(),
  ...overrides,
});

describe('SettingsModal', () => {
  beforeEach(() => {
    vi.useFakeTimers();

    // Reset window.maestro mocks
    vi.mocked(window.maestro.agents.detect).mockResolvedValue([
      { id: 'claude-code', name: 'Claude Code', available: true, path: '/usr/local/bin/claude', hidden: false },
      { id: 'openai-codex', name: 'OpenAI Codex', available: false, hidden: false },
    ] as AgentConfig[]);
    vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
    vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);
    vi.mocked(window.maestro.shells.detect).mockResolvedValue([
      { id: 'zsh', name: 'Zsh', path: '/bin/zsh', available: true },
      { id: 'bash', name: 'Bash', path: '/bin/bash', available: true },
    ] as ShellInfo[]);

    // Add missing mocks to window.maestro
    (window.maestro as any).fonts = {
      detect: vi.fn().mockResolvedValue(['Menlo', 'Monaco', 'Courier New']),
    };
    (window.maestro as any).agents.getAllCustomPaths = vi.fn().mockResolvedValue({});
    (window.maestro as any).agents.setCustomPath = vi.fn().mockResolvedValue(undefined);
    (window.maestro as any).agents.setConfig = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('render conditions', () => {
    it('should return null when isOpen is false', () => {
      const { container } = render(<SettingsModal {...createDefaultProps({ isOpen: false })} />);
      expect(container.firstChild).toBeNull();
    });

    it('should render modal when isOpen is true', () => {
      render(<SettingsModal {...createDefaultProps()} />);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('should have correct aria attributes', () => {
      render(<SettingsModal {...createDefaultProps()} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-label', 'Settings');
    });
  });

  describe('tab navigation', () => {
    it('should render all tab buttons', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(screen.getByTitle('General')).toBeInTheDocument();
      expect(screen.getByTitle('Shortcuts')).toBeInTheDocument();
      expect(screen.getByTitle('Themes')).toBeInTheDocument();
      expect(screen.getByTitle('Notifications')).toBeInTheDocument();
      expect(screen.getByTitle('AI Commands')).toBeInTheDocument();
    });

    it('should default to general tab', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // General tab content should show the Font Size label
      expect(screen.getByText('Font Size')).toBeInTheDocument();
    });

    it('should respect initialTab prop', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'theme' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Theme tab should show theme mode sections
      expect(screen.getByText('dark Mode')).toBeInTheDocument();
    });

    it('should switch to shortcuts tab when clicked', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      fireEvent.click(screen.getByTitle('Shortcuts'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByPlaceholderText('Filter shortcuts...')).toBeInTheDocument();
    });

    it('should switch to notifications tab when clicked', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      fireEvent.click(screen.getByTitle('Notifications'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText('Operating System Notifications')).toBeInTheDocument();
    });

    it('should switch to AI Commands tab when clicked', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      fireEvent.click(screen.getByTitle('AI Commands'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByTestId('ai-commands-panel')).toBeInTheDocument();
    });
  });

  describe('keyboard tab navigation', () => {
    it('should navigate to next tab with Cmd+Shift+]', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // Start on general tab
      expect(screen.getByText('Font Size')).toBeInTheDocument();

      // Press Cmd+Shift+] to go to shortcuts
      fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByPlaceholderText('Filter shortcuts...')).toBeInTheDocument();
    });

    it('should navigate to previous tab with Cmd+Shift+[', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // Start on shortcuts tab
      expect(screen.getByPlaceholderText('Filter shortcuts...')).toBeInTheDocument();

      // Press Cmd+Shift+[ to go back to general
      fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText('Font Size')).toBeInTheDocument();
    });

    it('should wrap around when navigating past last tab', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'aicommands' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // Start on AI Commands tab (last tab)
      expect(screen.getByTestId('ai-commands-panel')).toBeInTheDocument();

      // Press Cmd+Shift+] to wrap to general
      fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText('Font Size')).toBeInTheDocument();
    });

    it('should wrap around when navigating before first tab', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // Start on general tab (first tab)
      expect(screen.getByText('Font Size')).toBeInTheDocument();

      // Press Cmd+Shift+[ to wrap to AI Commands
      fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByTestId('ai-commands-panel')).toBeInTheDocument();
    });
  });

  describe('close button', () => {
    it('should call onClose when close button is clicked', async () => {
      const onClose = vi.fn();
      render(<SettingsModal {...createDefaultProps({ onClose })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // Find the X close button in the header
      const closeButtons = screen.getAllByRole('button');
      const closeButton = closeButtons.find(btn => btn.querySelector('svg.w-5.h-5'));
      expect(closeButton).toBeDefined();

      fireEvent.click(closeButton!);
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('General tab - Font settings', () => {
    it('should show font loading message initially', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // Font selector should exist
      expect(screen.getByText('Interface Font')).toBeInTheDocument();
    });

    it('should call setFontFamily when font is changed', async () => {
      const setFontFamily = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setFontFamily })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Find the font select and trigger change
      const fontSelect = screen.getByRole('combobox') as HTMLSelectElement;
      fireEvent.change(fontSelect, { target: { value: 'Monaco' } });

      expect(setFontFamily).toHaveBeenCalledWith('Monaco');
    });

    it('should load fonts when font select is focused', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const fontSelect = screen.getByRole('combobox');
      fireEvent.focus(fontSelect);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect((window.maestro as any).fonts.detect).toHaveBeenCalled();
    });
  });

  describe('General tab - Font size buttons', () => {
    it('should call setFontSize with 12 when Small is clicked', async () => {
      const setFontSize = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setFontSize })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Small' }));
      expect(setFontSize).toHaveBeenCalledWith(12);
    });

    it('should call setFontSize with 14 when Medium is clicked', async () => {
      const setFontSize = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setFontSize })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Medium' }));
      expect(setFontSize).toHaveBeenCalledWith(14);
    });

    it('should call setFontSize with 16 when Large is clicked', async () => {
      const setFontSize = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setFontSize })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Large' }));
      expect(setFontSize).toHaveBeenCalledWith(16);
    });

    it('should call setFontSize with 18 when X-Large is clicked', async () => {
      const setFontSize = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setFontSize })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: 'X-Large' }));
      expect(setFontSize).toHaveBeenCalledWith(18);
    });

    it('should highlight selected font size', async () => {
      render(<SettingsModal {...createDefaultProps({ fontSize: 14 })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const mediumButton = screen.getByText('Medium');
      expect(mediumButton).toHaveClass('ring-2');
    });
  });

  describe('General tab - Terminal width buttons', () => {
    it('should call setTerminalWidth with 80', async () => {
      const setTerminalWidth = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setTerminalWidth })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: '80' }));
      expect(setTerminalWidth).toHaveBeenCalledWith(80);
    });

    it('should call setTerminalWidth with 100', async () => {
      const setTerminalWidth = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setTerminalWidth })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Find the terminal width 100 button (not font size)
      const buttons = screen.getAllByText('100');
      const terminalWidthButton = buttons[0]; // First one is terminal width
      fireEvent.click(terminalWidthButton);
      expect(setTerminalWidth).toHaveBeenCalledWith(100);
    });
  });

  describe('General tab - Log level buttons', () => {
    it('should call setLogLevel with debug', async () => {
      const setLogLevel = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setLogLevel })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Debug' }));
      expect(setLogLevel).toHaveBeenCalledWith('debug');
    });

    it('should call setLogLevel with info', async () => {
      const setLogLevel = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setLogLevel })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Info' }));
      expect(setLogLevel).toHaveBeenCalledWith('info');
    });

    it('should call setLogLevel with warn', async () => {
      const setLogLevel = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setLogLevel })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Warn' }));
      expect(setLogLevel).toHaveBeenCalledWith('warn');
    });

    it('should call setLogLevel with error', async () => {
      const setLogLevel = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setLogLevel })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Error' }));
      expect(setLogLevel).toHaveBeenCalledWith('error');
    });
  });

  describe('General tab - Max log buffer buttons', () => {
    it('should call setMaxLogBuffer with various values', async () => {
      const setMaxLogBuffer = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setMaxLogBuffer })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: '1000' }));
      expect(setMaxLogBuffer).toHaveBeenCalledWith(1000);

      fireEvent.click(screen.getByRole('button', { name: '5000' }));
      expect(setMaxLogBuffer).toHaveBeenCalledWith(5000);

      fireEvent.click(screen.getByRole('button', { name: '10000' }));
      expect(setMaxLogBuffer).toHaveBeenCalledWith(10000);

      fireEvent.click(screen.getByRole('button', { name: '25000' }));
      expect(setMaxLogBuffer).toHaveBeenCalledWith(25000);
    });
  });

  describe('General tab - Max output lines buttons', () => {
    it('should call setMaxOutputLines with various values', async () => {
      const setMaxOutputLines = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setMaxOutputLines })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: '15' }));
      expect(setMaxOutputLines).toHaveBeenCalledWith(15);

      fireEvent.click(screen.getByRole('button', { name: '25' }));
      expect(setMaxOutputLines).toHaveBeenCalledWith(25);

      fireEvent.click(screen.getByRole('button', { name: '50' }));
      expect(setMaxOutputLines).toHaveBeenCalledWith(50);

      fireEvent.click(screen.getByRole('button', { name: 'All' }));
      expect(setMaxOutputLines).toHaveBeenCalledWith(Infinity);
    });
  });

  describe('General tab - Shell selection', () => {
    it('should show shell detection button when shells not loaded', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText('Detect other available shells...')).toBeInTheDocument();
    });

    it('should load shells on interaction', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const detectButton = screen.getByText('Detect other available shells...');
      fireEvent.click(detectButton);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(window.maestro.shells.detect).toHaveBeenCalled();
    });

    it('should call setDefaultShell when shell is selected', async () => {
      const setDefaultShell = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setDefaultShell })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Trigger shell loading
      const detectButton = screen.getByText('Detect other available shells...');
      fireEvent.click(detectButton);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Click on Bash shell
      const bashButton = screen.getByText('Bash').closest('button');
      fireEvent.click(bashButton!);

      expect(setDefaultShell).toHaveBeenCalledWith('bash');
    });
  });

  describe('General tab - Input behavior toggles', () => {
    it('should call setEnterToSendAI when toggled', async () => {
      const setEnterToSendAI = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setEnterToSendAI, enterToSendAI: true })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Find the AI Interaction Mode section and click its toggle button
      const aiModeLabel = screen.getByText('AI Interaction Mode');
      const aiModeSection = aiModeLabel.closest('.p-3');
      const toggleButton = aiModeSection?.querySelector('button');
      fireEvent.click(toggleButton!);

      expect(setEnterToSendAI).toHaveBeenCalledWith(false);
    });

    it('should call setEnterToSendTerminal when toggled', async () => {
      const setEnterToSendTerminal = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setEnterToSendTerminal, enterToSendTerminal: true })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Find the Terminal Mode section and click its toggle button
      const terminalModeLabel = screen.getByText('Terminal Mode');
      const terminalModeSection = terminalModeLabel.closest('.p-3');
      const toggleButton = terminalModeSection?.querySelector('button');
      fireEvent.click(toggleButton!);

      expect(setEnterToSendTerminal).toHaveBeenCalledWith(false);
    });

    it('should display Cmd+Enter when enter-to-send is false', async () => {
      render(<SettingsModal {...createDefaultProps({ enterToSendAI: false })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText('⌘ + Enter')).toBeInTheDocument();
    });
  });

  describe('General tab - History toggle', () => {
    it('should call setDefaultSaveToHistory when checkbox is changed', async () => {
      const setDefaultSaveToHistory = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setDefaultSaveToHistory, defaultSaveToHistory: true })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const historyCheckbox = screen.getByText('Enable "History" by default for new tabs').closest('label')?.querySelector('input[type="checkbox"]');
      expect(historyCheckbox).toBeDefined();

      fireEvent.click(historyCheckbox!);
      expect(setDefaultSaveToHistory).toHaveBeenCalledWith(false);
    });
  });

  describe('General tab - GitHub CLI path', () => {
    it('should call setGhPath when path is changed', async () => {
      const setGhPath = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setGhPath })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const ghPathInput = screen.getByPlaceholderText('/opt/homebrew/bin/gh');
      fireEvent.change(ghPathInput, { target: { value: '/usr/local/bin/gh' } });

      expect(setGhPath).toHaveBeenCalledWith('/usr/local/bin/gh');
    });

    it('should show clear button when ghPath has value', async () => {
      render(<SettingsModal {...createDefaultProps({ ghPath: '/usr/local/bin/gh' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getAllByText('Clear').length).toBeGreaterThan(0);
    });

    it('should call setGhPath with empty string when clear is clicked', async () => {
      const setGhPath = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setGhPath, ghPath: '/usr/local/bin/gh' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Find the Clear button near the gh path input
      const clearButtons = screen.getAllByText('Clear');
      fireEvent.click(clearButtons[clearButtons.length - 1]); // Last clear button is for gh path

      expect(setGhPath).toHaveBeenCalledWith('');
    });
  });

  describe('Shortcuts tab', () => {
    it('should display shortcuts list', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText('New Session')).toBeInTheDocument();
      expect(screen.getByText('Close Session')).toBeInTheDocument();
      expect(screen.getByText('Toggle Mode')).toBeInTheDocument();
    });

    it('should filter shortcuts by label', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const filterInput = screen.getByPlaceholderText('Filter shortcuts...');
      fireEvent.change(filterInput, { target: { value: 'New' } });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(screen.getByText('New Session')).toBeInTheDocument();
      expect(screen.queryByText('Close Session')).not.toBeInTheDocument();
    });

    it('should show shortcut count', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText('3')).toBeInTheDocument();
    });

    it('should show filtered count when filtering', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const filterInput = screen.getByPlaceholderText('Filter shortcuts...');
      fireEvent.change(filterInput, { target: { value: 'Session' } });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(screen.getByText('2 / 3')).toBeInTheDocument();
    });

    it('should enter recording mode when shortcut button is clicked', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const shortcutButton = screen.getByText('Meta+n');
      fireEvent.click(shortcutButton);

      expect(screen.getByText('Press keys...')).toBeInTheDocument();
    });

    it('should record new shortcut on keydown', async () => {
      const setShortcuts = vi.fn();
      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', setShortcuts })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Click to enter recording mode
      const shortcutButton = screen.getByText('Meta+n');
      fireEvent.click(shortcutButton);

      // Press new key combination
      fireEvent.keyDown(shortcutButton, { key: 'k', metaKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() });

      expect(setShortcuts).toHaveBeenCalledWith({
        ...mockShortcuts,
        'new-session': { ...mockShortcuts['new-session'], keys: ['Meta', 'k'] }
      });
    });

    it('should cancel recording on Escape', async () => {
      const setShortcuts = vi.fn();
      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', setShortcuts })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Click to enter recording mode
      const shortcutButton = screen.getByText('Meta+n');
      fireEvent.click(shortcutButton);

      expect(screen.getByText('Press keys...')).toBeInTheDocument();

      // Press Escape
      fireEvent.keyDown(shortcutButton, { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() });

      // Should exit recording mode without calling setShortcuts
      expect(setShortcuts).not.toHaveBeenCalled();
      expect(screen.getByText('Meta+n')).toBeInTheDocument();
    });
  });

  describe('Theme tab', () => {
    it('should display theme mode sections', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'theme' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText('dark Mode')).toBeInTheDocument();
      expect(screen.getByText('light Mode')).toBeInTheDocument();
      expect(screen.getByText('vibe Mode')).toBeInTheDocument();
    });

    it('should display theme buttons', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'theme' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText('Dracula')).toBeInTheDocument();
      expect(screen.getByText('GitHub Light')).toBeInTheDocument();
      expect(screen.getByText('Pedurple')).toBeInTheDocument();
    });

    it('should call setActiveThemeId when theme is selected', async () => {
      const setActiveThemeId = vi.fn();
      render(<SettingsModal {...createDefaultProps({ initialTab: 'theme', setActiveThemeId })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: 'GitHub Light' }));
      expect(setActiveThemeId).toHaveBeenCalledWith('github-light');
    });

    it('should highlight active theme', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'theme', activeThemeId: 'dracula' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const draculaButton = screen.getByText('Dracula').closest('button');
      expect(draculaButton).toHaveClass('ring-2');
    });

    it('should navigate themes with Tab key', async () => {
      const setActiveThemeId = vi.fn();
      render(<SettingsModal {...createDefaultProps({ initialTab: 'theme', setActiveThemeId, activeThemeId: 'dracula' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Find the theme picker container (the div with tabIndex=0 and onKeyDown handler)
      const themePickerContainer = screen.getByText('dark Mode').closest('.space-y-6');

      // Fire Tab keydown on the theme picker container
      fireEvent.keyDown(themePickerContainer!, { key: 'Tab' });

      // Should move to next theme (github-light in this case, or next in the list)
      expect(setActiveThemeId).toHaveBeenCalled();
    });
  });

  describe('Notifications tab', () => {
    it('should display OS notifications setting', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText('Enable OS Notifications')).toBeInTheDocument();
    });

    it('should call setOsNotificationsEnabled when checkbox is changed', async () => {
      const setOsNotificationsEnabled = vi.fn();
      render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications', setOsNotificationsEnabled, osNotificationsEnabled: true })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const checkbox = screen.getByText('Enable OS Notifications').closest('label')?.querySelector('input[type="checkbox"]');
      fireEvent.click(checkbox!);

      expect(setOsNotificationsEnabled).toHaveBeenCalledWith(false);
    });

    it('should update checkbox state when prop changes (regression test for memo bug)', async () => {
      // This test ensures the component re-renders when props change
      // A previous bug had an overly restrictive memo comparator that prevented re-renders
      const { rerender } = render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications', osNotificationsEnabled: true })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Verify initial checked state
      const checkbox = screen.getByText('Enable OS Notifications').closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox.checked).toBe(true);

      // Rerender with changed prop (simulating what happens after onChange)
      rerender(<SettingsModal {...createDefaultProps({ initialTab: 'notifications', osNotificationsEnabled: false })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // The checkbox should now be unchecked - this would fail with the old memo comparator
      expect(checkbox.checked).toBe(false);
    });

    it('should test notification when button is clicked', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Test Notification' }));
      expect(window.maestro.notification.show).toHaveBeenCalledWith('Maestro', 'Test notification - notifications are working!');
    });

    it('should display audio feedback setting', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText('Enable Audio Feedback')).toBeInTheDocument();
    });

    it('should call setAudioFeedbackEnabled when checkbox is changed', async () => {
      const setAudioFeedbackEnabled = vi.fn();
      render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications', setAudioFeedbackEnabled, audioFeedbackEnabled: false })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const checkbox = screen.getByText('Enable Audio Feedback').closest('label')?.querySelector('input[type="checkbox"]');
      fireEvent.click(checkbox!);

      expect(setAudioFeedbackEnabled).toHaveBeenCalledWith(true);
    });

    it('should call setAudioFeedbackCommand when TTS command is changed', async () => {
      const setAudioFeedbackCommand = vi.fn();
      render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications', setAudioFeedbackCommand })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const ttsInput = screen.getByPlaceholderText('say');
      fireEvent.change(ttsInput, { target: { value: 'espeak' } });

      expect(setAudioFeedbackCommand).toHaveBeenCalledWith('espeak');
    });

    it('should test TTS when test button is clicked', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Test' }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(window.maestro.notification.speak).toHaveBeenCalled();
    });

    it('should display toast duration setting', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText('Toast Notification Duration')).toBeInTheDocument();
    });

    it('should call setToastDuration when duration is selected', async () => {
      const setToastDuration = vi.fn();
      render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications', setToastDuration })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: 'Off' }));
      expect(setToastDuration).toHaveBeenCalledWith(-1);

      fireEvent.click(screen.getByRole('button', { name: '5s' }));
      expect(setToastDuration).toHaveBeenCalledWith(5);

      fireEvent.click(screen.getByRole('button', { name: '10s' }));
      expect(setToastDuration).toHaveBeenCalledWith(10);

      fireEvent.click(screen.getByRole('button', { name: '20s' }));
      expect(setToastDuration).toHaveBeenCalledWith(20);

      fireEvent.click(screen.getByRole('button', { name: '30s' }));
      expect(setToastDuration).toHaveBeenCalledWith(30);

      fireEvent.click(screen.getByRole('button', { name: 'Never' }));
      expect(setToastDuration).toHaveBeenCalledWith(0);
    });
  });

  describe('AI Commands tab', () => {
    it('should render AICommandsPanel component', async () => {
      render(<SettingsModal {...createDefaultProps({ initialTab: 'aicommands' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByTestId('ai-commands-panel')).toBeInTheDocument();
    });
  });

  describe('custom fonts', () => {
    it('should add custom font when input is submitted', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const customFontInput = screen.getByPlaceholderText('Add custom font name...');
      fireEvent.change(customFontInput, { target: { value: 'My Custom Font' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(window.maestro.settings.set).toHaveBeenCalledWith('customFonts', ['My Custom Font']);
    });

    it('should add custom font on Enter key', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const customFontInput = screen.getByPlaceholderText('Add custom font name...');
      fireEvent.change(customFontInput, { target: { value: 'My Custom Font' } });
      fireEvent.keyDown(customFontInput, { key: 'Enter' });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(window.maestro.settings.set).toHaveBeenCalledWith('customFonts', ['My Custom Font']);
    });

    it('should not add empty custom font', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const customFontInput = screen.getByPlaceholderText('Add custom font name...');
      fireEvent.change(customFontInput, { target: { value: '   ' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(window.maestro.settings.set).not.toHaveBeenCalledWith('customFonts', expect.anything());
    });
  });

  describe('edge cases', () => {
    it('should handle font detection failure gracefully', async () => {
      (window.maestro as any).fonts.detect.mockRejectedValue(new Error('Font detection failed'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const fontSelect = screen.getByRole('combobox');
      fireEvent.focus(fontSelect);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should handle shell detection failure gracefully', async () => {
      vi.mocked(window.maestro.shells.detect).mockRejectedValue(new Error('Shell detection failed'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const detectButton = screen.getByText('Detect other available shells...');
      fireEvent.click(detectButton);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should handle XSS characters in settings', async () => {
      const customShortcuts: Record<string, Shortcut> = {
        'xss-test': { id: 'xss-test', label: '<script>alert("xss")</script>', keys: ['Meta', 'x'] },
      };

      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', shortcuts: customShortcuts })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Should render as text, not execute
      expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument();
    });

    it('should handle unicode in labels', async () => {
      const customShortcuts: Record<string, Shortcut> = {
        'unicode-test': { id: 'unicode-test', label: 'Hello 🌍 World', keys: ['Meta', 'u'] },
      };

      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', shortcuts: customShortcuts })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(screen.getByText(/Hello.*World/)).toBeInTheDocument();
    });
  });

  describe('layer stack integration', () => {
    it('should register layer when modal opens', async () => {
      const { useLayerStack } = await import('../../../renderer/contexts/LayerStackContext');
      const mockRegisterLayer = vi.fn(() => 'layer-123');
      vi.mocked(useLayerStack).mockReturnValue({
        registerLayer: mockRegisterLayer,
        unregisterLayer: vi.fn(),
        updateLayerHandler: vi.fn(),
        getTopLayer: vi.fn(),
        closeTopLayer: vi.fn(),
        getLayers: vi.fn(),
        hasOpenLayers: vi.fn(),
        hasOpenModal: vi.fn(),
        layerCount: 0,
      });

      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(mockRegisterLayer).toHaveBeenCalledWith(expect.objectContaining({
        type: 'modal',
        ariaLabel: 'Settings',
      }));
    });

    it('should unregister layer when modal closes', async () => {
      const { useLayerStack } = await import('../../../renderer/contexts/LayerStackContext');
      const mockUnregisterLayer = vi.fn();
      vi.mocked(useLayerStack).mockReturnValue({
        registerLayer: vi.fn(() => 'layer-123'),
        unregisterLayer: mockUnregisterLayer,
        updateLayerHandler: vi.fn(),
        getTopLayer: vi.fn(),
        closeTopLayer: vi.fn(),
        getLayers: vi.fn(),
        hasOpenLayers: vi.fn(),
        hasOpenModal: vi.fn(),
        layerCount: 0,
      });

      const { rerender } = render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      rerender(<SettingsModal {...createDefaultProps({ isOpen: false })} />);

      expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-123');
    });
  });

  describe('recording state and escape handling', () => {
    it('should cancel recording instead of closing modal when Escape is pressed during recording', async () => {
      const onClose = vi.fn();
      const { useLayerStack } = await import('../../../renderer/contexts/LayerStackContext');

      let capturedEscapeHandler: (() => void) | undefined;
      vi.mocked(useLayerStack).mockReturnValue({
        registerLayer: vi.fn((config) => {
          capturedEscapeHandler = config.onEscape;
          return 'layer-123';
        }),
        unregisterLayer: vi.fn(),
        updateLayerHandler: vi.fn((id, handler) => {
          capturedEscapeHandler = handler;
        }),
        getTopLayer: vi.fn(),
        closeTopLayer: vi.fn(),
        getLayers: vi.fn(),
        hasOpenLayers: vi.fn(),
        hasOpenModal: vi.fn(),
        layerCount: 0,
      });

      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', onClose })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Enter recording mode
      const shortcutButton = screen.getByText('Meta+n');
      fireEvent.click(shortcutButton);

      expect(screen.getByText('Press keys...')).toBeInTheDocument();

      // Call the escape handler (simulating layer stack escape)
      capturedEscapeHandler?.();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // Should exit recording mode but not close modal
      expect(screen.getByText('Meta+n')).toBeInTheDocument();
      // Modal should still be open since we didn't call onClose
    });
  });

  describe('TTS Stop button', () => {
    it('should show Stop button when TTS is playing and handle click', async () => {
      // Mock speak to return a ttsId
      vi.mocked(window.maestro.notification.speak).mockResolvedValue({ success: true, ttsId: 123 });
      vi.mocked(window.maestro.notification.stopSpeak).mockResolvedValue({ success: true });

      render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Click Test button to start TTS
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Stop button should now be visible
      expect(screen.getByText('Stop')).toBeInTheDocument();

      // Click Stop button
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(window.maestro.notification.stopSpeak).toHaveBeenCalledWith(123);
    });

    it('should handle stopSpeak error gracefully', async () => {
      vi.mocked(window.maestro.notification.speak).mockResolvedValue({ success: true, ttsId: 456 });
      vi.mocked(window.maestro.notification.stopSpeak).mockRejectedValue(new Error('Stop failed'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Click Test button to start TTS
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Click Stop button
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should handle speak error gracefully', async () => {
      vi.mocked(window.maestro.notification.speak).mockRejectedValue(new Error('Speak failed'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Click Test button to trigger speak error
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should auto-clear TTS state after timeout', async () => {
      vi.mocked(window.maestro.notification.speak).mockResolvedValue({ success: true, ttsId: 789 });

      render(<SettingsModal {...createDefaultProps({ initialTab: 'notifications' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Click Test button to start TTS
      fireEvent.click(screen.getByRole('button', { name: 'Test' }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Stop button should be visible
      expect(screen.getByText('Stop')).toBeInTheDocument();

      // Advance timer to trigger auto-clear (8000ms)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });

      // Test button should be back
      expect(screen.getByText('Test')).toBeInTheDocument();
    });
  });

  describe('Theme picker - Shift+Tab navigation', () => {
    it('should navigate to previous theme with Shift+Tab', async () => {
      const setActiveThemeId = vi.fn();
      render(<SettingsModal {...createDefaultProps({ initialTab: 'theme', setActiveThemeId, activeThemeId: 'github-light' })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Find the theme picker container
      const themePickerContainer = screen.getByText('dark Mode').closest('.space-y-6');

      // Fire Shift+Tab keydown
      fireEvent.keyDown(themePickerContainer!, { key: 'Tab', shiftKey: true });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // Should navigate to previous theme (dracula, since github-light is after dracula)
      expect(setActiveThemeId).toHaveBeenCalledWith('dracula');
    });
  });

  describe('Shortcut recording edge cases', () => {
    it('should handle Ctrl modifier key', async () => {
      const setShortcuts = vi.fn();
      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', setShortcuts })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Click to enter recording mode
      const shortcutButton = screen.getByText('Meta+n');
      fireEvent.click(shortcutButton);

      // Press Ctrl+k combination
      fireEvent.keyDown(shortcutButton, { key: 'k', ctrlKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() });

      expect(setShortcuts).toHaveBeenCalledWith(expect.objectContaining({
        'new-session': expect.objectContaining({ keys: ['Ctrl', 'k'] })
      }));
    });

    it('should handle Alt modifier key', async () => {
      const setShortcuts = vi.fn();
      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', setShortcuts })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Click to enter recording mode
      const shortcutButton = screen.getByText('Meta+n');
      fireEvent.click(shortcutButton);

      // Press Alt+k combination
      fireEvent.keyDown(shortcutButton, { key: 'k', altKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() });

      expect(setShortcuts).toHaveBeenCalledWith(expect.objectContaining({
        'new-session': expect.objectContaining({ keys: ['Alt', 'k'] })
      }));
    });

    it('should handle Shift modifier key', async () => {
      const setShortcuts = vi.fn();
      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', setShortcuts })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Click to enter recording mode
      const shortcutButton = screen.getByText('Meta+n');
      fireEvent.click(shortcutButton);

      // Press Shift+k combination
      fireEvent.keyDown(shortcutButton, { key: 'k', shiftKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() });

      expect(setShortcuts).toHaveBeenCalledWith(expect.objectContaining({
        'new-session': expect.objectContaining({ keys: ['Shift', 'k'] })
      }));
    });

    it('should ignore modifier-only key presses', async () => {
      const setShortcuts = vi.fn();
      render(<SettingsModal {...createDefaultProps({ initialTab: 'shortcuts', setShortcuts })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Click to enter recording mode
      const shortcutButton = screen.getByText('Meta+n');
      fireEvent.click(shortcutButton);

      // Press just Control key
      fireEvent.keyDown(shortcutButton, { key: 'Control', ctrlKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() });

      // Should not call setShortcuts for modifier-only key
      expect(setShortcuts).not.toHaveBeenCalled();
      // Should still be in recording mode
      expect(screen.getByText('Press keys...')).toBeInTheDocument();
    });
  });

  describe('Custom font removal', () => {
    it('should remove custom font when X is clicked', async () => {
      // Preload custom fonts
      vi.mocked(window.maestro.settings.get).mockResolvedValue(['MyCustomFont', 'AnotherFont']);

      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Trigger font loading
      const fontSelect = screen.getByRole('combobox');
      fireEvent.focus(fontSelect);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Find the remove button for MyCustomFont
      const removeButtons = screen.getAllByText('×');
      expect(removeButtons.length).toBeGreaterThan(0);

      // Click remove on first custom font
      fireEvent.click(removeButtons[0]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // Should save updated custom fonts (without MyCustomFont)
      expect(window.maestro.settings.set).toHaveBeenCalledWith('customFonts', ['AnotherFont']);
    });
  });

  describe('Terminal width 120 and 160 buttons', () => {
    it('should call setTerminalWidth with 120', async () => {
      const setTerminalWidth = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setTerminalWidth })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: '120' }));
      expect(setTerminalWidth).toHaveBeenCalledWith(120);
    });

    it('should call setTerminalWidth with 160', async () => {
      const setTerminalWidth = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setTerminalWidth })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      fireEvent.click(screen.getByRole('button', { name: '160' }));
      expect(setTerminalWidth).toHaveBeenCalledWith(160);
    });
  });

  describe('Max output lines 100 button', () => {
    it('should call setMaxOutputLines with 100', async () => {
      const setMaxOutputLines = vi.fn();
      render(<SettingsModal {...createDefaultProps({ setMaxOutputLines })} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Find the 100 button in max output lines section (not terminal width)
      const buttons100 = screen.getAllByText('100');
      // The second one is for max output lines
      fireEvent.click(buttons100[buttons100.length - 1]);
      expect(setMaxOutputLines).toHaveBeenCalledWith(100);
    });
  });

  describe('Font availability checking', () => {
    it('should check font availability using normalized names', async () => {
      (window.maestro as any).fonts.detect.mockResolvedValue(['JetBrains Mono', 'Fira Code']);

      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Trigger font loading
      const fontSelect = screen.getByRole('combobox');
      fireEvent.focus(fontSelect);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Should show fonts with availability indicators
      // JetBrains Mono is in the list, so it should be available
      const options = fontSelect.querySelectorAll('option');
      expect(options.length).toBeGreaterThan(0);
    });
  });

  describe('Shell selection with mouseEnter and focus', () => {
    it('should load shells on mouseEnter', async () => {
      render(<SettingsModal {...createDefaultProps()} />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Trigger shell loading via mouseEnter
      const detectButton = screen.getByText('Detect other available shells...');

      // Load shells first
      fireEvent.click(detectButton);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Now shells should be loaded, find a shell button
      const zshButton = screen.getByText('Zsh').closest('button');
      expect(zshButton).toBeInTheDocument();

      // Trigger mouseEnter - should not reload (already loaded)
      fireEvent.mouseEnter(zshButton!);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      // shells.detect should only have been called once
      expect(window.maestro.shells.detect).toHaveBeenCalledTimes(1);
    });
  });
});
