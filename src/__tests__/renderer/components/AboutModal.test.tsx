/**
 * @fileoverview Tests for AboutModal component
 * Tests: formatTokens helper, formatDuration helper, layer stack integration,
 * streaming stats loading, external links, child component rendering
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AboutModal } from '../../../renderer/components/AboutModal';
import type { Theme, Session, AutoRunStats } from '../../../renderer/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <span data-testid="x-icon" className={className} style={style}>×</span>
  ),
  Wand2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <span data-testid="wand-icon" className={className} style={style}>🪄</span>
  ),
  ExternalLink: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <span data-testid="external-link-icon" className={className} style={style}>↗</span>
  ),
  FileCode: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <span data-testid="file-code-icon" className={className} style={style}>📄</span>
  ),
  BarChart3: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <span data-testid="bar-chart-icon" className={className} style={style}>📊</span>
  ),
  Loader2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
    <span data-testid="loader-icon" className={className} style={style}>⏳</span>
  ),
}));

// Mock the avatar import
vi.mock('../../../renderer/assets/pedram-avatar.png', () => ({
  default: 'mock-avatar-url.png',
}));

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-about-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
  useLayerStack: () => ({
    registerLayer: mockRegisterLayer,
    unregisterLayer: mockUnregisterLayer,
    updateLayerHandler: mockUpdateLayerHandler,
  }),
}));

// Mock AchievementCard
vi.mock('../../../renderer/components/AchievementCard', () => ({
  AchievementCard: ({ theme, autoRunStats, globalStats, onEscapeWithBadgeOpen }: {
    theme: Theme;
    autoRunStats: AutoRunStats;
    globalStats: ClaudeGlobalStats | null;
    onEscapeWithBadgeOpen: (handler: (() => boolean) | null) => void;
  }) => (
    <div data-testid="achievement-card">
      AchievementCard
      <button
        data-testid="badge-open-trigger"
        onClick={() => onEscapeWithBadgeOpen(() => true)}
      >
        Open Badge
      </button>
      <button
        data-testid="badge-close-trigger"
        onClick={() => onEscapeWithBadgeOpen(null)}
      >
        Close Badge
      </button>
    </div>
  ),
}));

// Add __APP_VERSION__ global
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '1.0.0';

// Interface for global stats
interface ClaudeGlobalStats {
  totalSessions: number;
  totalMessages: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  totalSizeBytes: number;
  isComplete?: boolean;
}

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

// Create test session
const createSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-1',
  name: 'Test Session',
  toolType: 'claude-code',
  state: 'idle',
  inputMode: 'ai',
  cwd: '/test/path',
  projectRoot: '/test/path',
  aiPid: 12345,
  terminalPid: 12346,
  aiLogs: [],
  shellLogs: [],
  isGitRepo: false,
  fileTree: [],
  fileExplorerExpanded: [],
  activeTimeMs: 0,
  ...overrides,
});

// Create test autoRunStats
const createAutoRunStats = (overrides: Partial<AutoRunStats> = {}): AutoRunStats => ({
  cumulativeTimeMs: 0,
  longestRunMs: 0,
  totalRuns: 0,
  lastBadgeAcknowledged: null,
  badgeHistory: [],
  ...overrides,
});

// Create test global stats
const createGlobalStats = (overrides: Partial<ClaudeGlobalStats> = {}): ClaudeGlobalStats => ({
  totalSessions: 100,
  totalMessages: 500,
  totalInputTokens: 1000000,
  totalOutputTokens: 500000,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  totalCostUsd: 25.50,
  totalSizeBytes: 1048576,
  isComplete: true,
  ...overrides,
});

describe('AboutModal', () => {
  let theme: Theme;
  let onClose: ReturnType<typeof vi.fn>;
  let unsubscribeMock: ReturnType<typeof vi.fn>;
  let statsCallback: ((stats: ClaudeGlobalStats) => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    theme = createTheme();
    onClose = vi.fn();
    unsubscribeMock = vi.fn();
    statsCallback = null;

    // Mock onGlobalStatsUpdate to capture the callback
    vi.mocked(window.maestro.claude.onGlobalStatsUpdate).mockImplementation((callback) => {
      statsCallback = callback;
      return unsubscribeMock;
    });

    // Mock getGlobalStats
    vi.mocked(window.maestro.claude.getGlobalStats).mockResolvedValue(createGlobalStats());

    // Mock shell.openExternal
    vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);

    // Reset layer stack mocks
    mockRegisterLayer.mockClear().mockReturnValue('layer-about-123');
    mockUnregisterLayer.mockClear();
    mockUpdateLayerHandler.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    statsCallback = null;
  });

  describe('Initial render', () => {
    it('should render with dialog role and aria attributes', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-label', 'About Maestro');
    });

    it('should render the modal header with title', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      expect(screen.getByText('About Maestro')).toBeInTheDocument();
    });

    it('should render MAESTRO branding', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      expect(screen.getByText('MAESTRO')).toBeInTheDocument();
    });

    it('should render version number', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      expect(screen.getByText('v1.0.0')).toBeInTheDocument();
    });

    it('should render subtitle', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      expect(screen.getByText('Agent Orchestration Command Center')).toBeInTheDocument();
    });

    it('should render loading state initially', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      expect(screen.getByText('Loading stats...')).toBeInTheDocument();
    });
  });

  describe('Author section', () => {
    it('should render author name', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      expect(screen.getByText('Pedram Amini')).toBeInTheDocument();
    });

    it('should render author title', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      expect(screen.getByText('Founder, Hacker, Investor, Advisor')).toBeInTheDocument();
    });

    it('should render author avatar with correct alt text', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      const avatar = screen.getByAltText('Pedram Amini');
      expect(avatar).toBeInTheDocument();
    });

    it('should have GitHub profile link', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      // The component renders "GitHub" twice - author section and project link
      // Use getAllByText since there are multiple GitHub buttons
      const githubLinks = screen.getAllByText('GitHub');
      expect(githubLinks.length).toBeGreaterThanOrEqual(1);
    });

    it('should have LinkedIn profile link', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      // The component renders "LinkedIn" as the button text
      expect(screen.getByText('LinkedIn')).toBeInTheDocument();
    });
  });

  describe('External links', () => {
    it('should open GitHub profile on click', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      // The component renders "GitHub" twice - first one is the author profile link
      const githubLinks = screen.getAllByText('GitHub');
      fireEvent.click(githubLinks[0]);

      expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://github.com/pedramamini');
    });

    it('should open LinkedIn profile on click', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      // The component renders "LinkedIn" as the button text
      const linkedinLink = screen.getByText('LinkedIn');
      fireEvent.click(linkedinLink);

      expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://www.linkedin.com/in/pedramamini/');
    });

    it('should open GitHub repo on project GitHub click', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      // The component renders "GitHub" twice - second one is the project repo link
      const githubLinks = screen.getAllByText('GitHub');
      fireEvent.click(githubLinks[1]);

      expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://github.com/pedramamini/Maestro');
    });

    it('should open San Jac Saloon on Texas flag click', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      // Find the Texas flag button (it's near "Made in Austin, TX")
      const austinText = screen.getByText('Made in Austin, TX');
      // The Texas flag SVG button is a sibling
      const texasButton = austinText.parentElement?.querySelector('button');
      expect(texasButton).toBeInTheDocument();
      fireEvent.click(texasButton!);

      expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://www.sanjacsaloon.com');
    });
  });

  describe('Layer stack integration', () => {
    it('should register layer on mount', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      expect(mockRegisterLayer).toHaveBeenCalledTimes(1);
      expect(mockRegisterLayer).toHaveBeenCalledWith(expect.objectContaining({
        type: 'modal',
        blocksLowerLayers: true,
        capturesFocus: true,
        focusTrap: 'strict',
        ariaLabel: 'About Maestro',
      }));
    });

    it('should unregister layer on unmount', () => {
      const { unmount } = render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      unmount();

      expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-about-123');
    });
  });

  describe('Close functionality', () => {
    it('should call onClose when X button is clicked', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      const closeButton = screen.getByTestId('x-icon').closest('button');
      expect(closeButton).toBeInTheDocument();
      fireEvent.click(closeButton!);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should call onClose via Escape when no badge overlay is open', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      // Get the registered escape handler
      const registerCall = mockRegisterLayer.mock.calls[0][0];
      expect(registerCall.onEscape).toBeDefined();

      // Call the escape handler
      act(() => {
        registerCall.onEscape();
      });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should handle badge escape handler before modal close', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      // Simulate badge overlay opening (via mocked AchievementCard)
      const openBadgeButton = screen.getByTestId('badge-open-trigger');
      fireEvent.click(openBadgeButton);

      // Get the registered escape handler
      const registerCall = mockRegisterLayer.mock.calls[0][0];

      // Call the escape handler - should handle badge first
      act(() => {
        registerCall.onEscape();
      });

      // onClose should NOT be called because badge handler intercepted
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('Global stats loading', () => {
    it('should subscribe to global stats updates on mount', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      expect(window.maestro.claude.onGlobalStatsUpdate).toHaveBeenCalledTimes(1);
    });

    it('should call getGlobalStats on mount', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      expect(window.maestro.claude.getGlobalStats).toHaveBeenCalledTimes(1);
    });

    it('should unsubscribe from stats updates on unmount', () => {
      const { unmount } = render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      unmount();

      expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    });

    it('should display stats when received via callback', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      // Simulate receiving stats via callback
      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats({
            totalSessions: 42,
            totalMessages: 123,
            isComplete: true,
          }));
        }
      });

      // Should no longer show loading
      expect(screen.queryByText('Loading stats...')).not.toBeInTheDocument();

      // Should show stats
      expect(screen.getByText('42')).toBeInTheDocument();
      expect(screen.getByText('123')).toBeInTheDocument();
    });

    it('should show spinner when stats are not complete', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      // Simulate receiving incomplete stats
      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats({ isComplete: false }));
        }
      });

      // Should show spinner icon in the header
      expect(screen.getAllByTestId('loader-icon')).toHaveLength(1);
    });

    it('should handle stats loading error gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(window.maestro.claude.getGlobalStats).mockRejectedValue(new Error('Failed'));

      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to load global Claude stats:', expect.any(Error));
      consoleErrorSpy.mockRestore();
    });

    it('should display "No Claude sessions found" when no stats', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Setup the mock to reject BEFORE rendering
      vi.mocked(window.maestro.claude.getGlobalStats).mockRejectedValue(new Error('Failed'));

      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(screen.getByText('No Claude sessions found')).toBeInTheDocument();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('formatTokens helper (tested via display)', () => {
    it('should format millions with M suffix', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats({
            totalInputTokens: 2500000,
            totalOutputTokens: 1000000,
          }));
        }
      });

      expect(screen.getByText('2.5M')).toBeInTheDocument();
      expect(screen.getByText('1.0M')).toBeInTheDocument();
    });

    it('should format thousands with K suffix', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats({
            totalInputTokens: 5500,
            totalOutputTokens: 2000,
          }));
        }
      });

      expect(screen.getByText('5.5K')).toBeInTheDocument();
      expect(screen.getByText('2.0K')).toBeInTheDocument();
    });

    it('should format small numbers without suffix', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats({
            totalInputTokens: 599,
            totalOutputTokens: 299,
          }));
        }
      });

      // Use unique values that won't match other numbers
      expect(screen.getByText('599')).toBeInTheDocument();
      expect(screen.getByText('299')).toBeInTheDocument();
    });
  });

  describe('formatDuration helper (tested via display)', () => {
    it('should format hours and minutes', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[createSession({ activeTimeMs: 3900000 })]} // 1h 5m
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats());
        }
      });

      expect(screen.getByText('1h 5m')).toBeInTheDocument();
    });

    it('should format minutes and seconds', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[createSession({ activeTimeMs: 125000 })]} // 2m 5s
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats());
        }
      });

      expect(screen.getByText('2m 5s')).toBeInTheDocument();
    });

    it('should format only seconds for small values', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[createSession({ activeTimeMs: 45000 })]} // 45s
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats());
        }
      });

      expect(screen.getByText('45s')).toBeInTheDocument();
    });

    it('should not show Active Time when totalActiveTimeMs is 0', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[createSession({ activeTimeMs: 0 })]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats());
        }
      });

      expect(screen.queryByText('Active Time')).not.toBeInTheDocument();
    });

    it('should accumulate active time from multiple sessions', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[
            createSession({ id: 's1', activeTimeMs: 60000 }), // 1m
            createSession({ id: 's2', activeTimeMs: 60000 }), // 1m
          ]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats());
        }
      });

      expect(screen.getByText('2m 0s')).toBeInTheDocument();
    });
  });

  describe('Cache tokens display', () => {
    it('should show cache tokens when they exist', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats({
            totalCacheReadTokens: 50000,
            totalCacheCreationTokens: 25000,
          }));
        }
      });

      expect(screen.getByText('Cache Read')).toBeInTheDocument();
      expect(screen.getByText('50.0K')).toBeInTheDocument();
      expect(screen.getByText('Cache Creation')).toBeInTheDocument();
      expect(screen.getByText('25.0K')).toBeInTheDocument();
    });

    it('should hide cache tokens when they are 0', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats({
            totalCacheReadTokens: 0,
            totalCacheCreationTokens: 0,
          }));
        }
      });

      expect(screen.queryByText('Cache Read')).not.toBeInTheDocument();
      expect(screen.queryByText('Cache Creation')).not.toBeInTheDocument();
    });
  });

  describe('Total cost display', () => {
    it('should format cost with 2 decimal places', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats({
            totalCostUsd: 1234.56,
          }));
        }
      });

      expect(screen.getByText('$1,234.56')).toBeInTheDocument();
    });

    it('should show cost with pulse animation when incomplete', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats({
            totalCostUsd: 25.50,
            isComplete: false,
          }));
        }
      });

      const costElement = screen.getByText('$25.50');
      expect(costElement).toHaveClass('animate-pulse');
    });

    it('should show cost without pulse animation when complete', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats({
            totalCostUsd: 25.50,
            isComplete: true,
          }));
        }
      });

      const costElement = screen.getByText('$25.50');
      expect(costElement).not.toHaveClass('animate-pulse');
    });
  });

  describe('AchievementCard integration', () => {
    it('should render AchievementCard', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      expect(screen.getByTestId('achievement-card')).toBeInTheDocument();
    });
  });

  describe('Made in Austin section', () => {
    it('should render Made in Austin text', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      expect(screen.getByText('Made in Austin, TX')).toBeInTheDocument();
    });
  });

  describe('Theme styling', () => {
    it('should apply theme colors to modal', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      const dialog = screen.getByRole('dialog');
      const modalContent = dialog.querySelector('div > div');
      expect(modalContent).toHaveStyle({ backgroundColor: theme.colors.bgSidebar });
    });

    it('should apply theme colors to title', () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      const title = screen.getByText('MAESTRO');
      expect(title).toHaveStyle({ color: theme.colors.textMain });
    });
  });

  describe('Edge cases', () => {
    it('should handle empty sessions array', () => {
      expect(() => {
        render(
          <AboutModal
            theme={theme}
            sessions={[]}
            autoRunStats={createAutoRunStats()}
            onClose={onClose}
          />
        );
      }).not.toThrow();
    });

    it('should handle sessions with undefined activeTimeMs', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[createSession({ activeTimeMs: undefined })]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats());
        }
      });

      // Should not show Active Time with 0
      expect(screen.queryByText('Active Time')).not.toBeInTheDocument();
    });

    it('should handle very large token counts', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats({
            totalInputTokens: 999999999, // Almost 1 billion
          }));
        }
      });

      expect(screen.getByText('1000.0M')).toBeInTheDocument();
    });

    it('should handle very large cost', async () => {
      render(
        <AboutModal
          theme={theme}
          sessions={[]}
          autoRunStats={createAutoRunStats()}
          onClose={onClose}
        />
      );

      await act(async () => {
        if (statsCallback) {
          statsCallback(createGlobalStats({
            totalCostUsd: 12345678.90,
          }));
        }
      });

      expect(screen.getByText('$12,345,678.90')).toBeInTheDocument();
    });
  });
});
