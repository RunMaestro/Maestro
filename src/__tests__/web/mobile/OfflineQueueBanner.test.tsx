/**
 * Tests for OfflineQueueBanner component
 *
 * @file src/web/mobile/OfflineQueueBanner.tsx
 *
 * Tests the offline queue banner that displays queued commands
 * and provides options to view, clear, or retry them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { OfflineQueueBanner } from '../../../web/mobile/OfflineQueueBanner';
import type { QueuedCommand, QueueStatus } from '../../../web/hooks/useOfflineQueue';

// Mock colors object for reuse
const mockColors = {
  bgMain: '#0b0b0d',
  bgSidebar: '#111113',
  bgActivity: '#1c1c1f',
  border: '#27272a',
  textMain: '#e4e4e7',
  textDim: '#a1a1aa',
  accent: '#6366f1',
  accentDim: 'rgba(99, 102, 241, 0.2)',
  accentText: '#a5b4fc',
  success: '#22c55e',
  warning: '#eab308',
  error: '#ef4444',
};

// Mock the ThemeProvider hooks - must include both useThemeColors and useTheme
vi.mock('../../../web/components/ThemeProvider', () => ({
  useThemeColors: () => mockColors,
  useTheme: () => ({
    theme: {
      id: 'dracula',
      name: 'Dracula',
      mode: 'dark',
      colors: mockColors,
    },
    isLight: false,
    isDark: true,
    isVibe: false,
    isDevicePreference: false,
  }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Track haptic calls
const mockTriggerHaptic = vi.fn();

vi.mock('../../../web/mobile/constants', () => ({
  triggerHaptic: (...args: unknown[]) => mockTriggerHaptic(...args),
  HAPTIC_PATTERNS: {
    tap: [10],
    send: [20, 50, 20],
    interrupt: [50, 25, 50],
    success: [10, 50, 10],
    error: [50, 50, 50],
  },
}));

describe('OfflineQueueBanner', () => {
  // Default props
  const defaultProps = {
    queue: [] as QueuedCommand[],
    status: 'idle' as QueueStatus,
    onClearQueue: vi.fn(),
    onProcessQueue: vi.fn(),
    onRemoveCommand: vi.fn(),
    isOffline: false,
    isConnected: true,
  };

  // Helper to create a queued command
  const createQueuedCommand = (overrides: Partial<QueuedCommand> = {}): QueuedCommand => ({
    id: 'cmd-1',
    command: 'test command',
    sessionId: 'session-1',
    inputMode: 'ai',
    timestamp: Date.now() - 60000, // 1 minute ago
    attempts: 0,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================
  // PURE FUNCTION TESTS: truncateCommand
  // ============================================================

  describe('truncateCommand (tested via component)', () => {
    it('does not truncate short commands', () => {
      const queue = [createQueuedCommand({ command: 'short cmd' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      // Expand to see command list
      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText('short cmd')).toBeInTheDocument();
    });

    it('truncates commands longer than 40 characters', () => {
      const longCommand = 'this is a very long command that should be truncated';
      const queue = [createQueuedCommand({ command: longCommand })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      // Expand to see command list
      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      // Should truncate to 40 chars total: slice(0, 39) + '…' (unicode ellipsis)
      // Uses shared truncateCommand function
      expect(screen.getByText(longCommand.slice(0, 39) + '…')).toBeInTheDocument();
    });

    it('handles command exactly at truncation boundary', () => {
      const exactCommand = 'a'.repeat(40); // Exactly 40 chars
      const queue = [createQueuedCommand({ command: exactCommand })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      // Expand to see command list
      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText(exactCommand)).toBeInTheDocument();
    });

    it('handles command one char over truncation boundary', () => {
      const overBoundary = 'b'.repeat(41); // 41 chars
      const queue = [createQueuedCommand({ command: overBoundary })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      // Expand to see command list
      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      // Should truncate: 39 b's + '…' (unicode ellipsis) = 40 total
      expect(screen.getByText('b'.repeat(39) + '…')).toBeInTheDocument();
    });

    it('handles empty command', () => {
      const queue = [createQueuedCommand({ command: '' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      // Empty string renders as empty
      const commandElement = document.querySelector('[style*="monospace"]');
      expect(commandElement).toBeInTheDocument();
    });

    it('handles command with special characters', () => {
      const specialCommand = 'echo "hello <world>" && rm -rf';
      const queue = [createQueuedCommand({ command: specialCommand })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText(specialCommand)).toBeInTheDocument();
    });

    it('handles unicode in command', () => {
      const unicodeCommand = '你好世界 🚀 npm run 测试';
      const queue = [createQueuedCommand({ command: unicodeCommand })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText(unicodeCommand)).toBeInTheDocument();
    });
  });

  // ============================================================
  // PURE FUNCTION TESTS: formatRelativeTime
  // ============================================================

  describe('formatRelativeTime (tested via component)', () => {
    it('shows "just now" for recent timestamps', () => {
      const queue = [createQueuedCommand({ timestamp: Date.now() - 1000 })]; // 1 second ago
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText(/just now/i)).toBeInTheDocument();
    });

    it('shows "just now" for timestamps less than 60 seconds ago', () => {
      const queue = [createQueuedCommand({ timestamp: Date.now() - 59000 })]; // 59 seconds ago
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText(/just now/i)).toBeInTheDocument();
    });

    it('shows minutes ago for timestamps 1-59 minutes ago', () => {
      const queue = [createQueuedCommand({ timestamp: Date.now() - 120000 })]; // 2 minutes ago
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText(/2m ago/)).toBeInTheDocument();
    });

    it('shows "1m ago" at exactly 60 seconds', () => {
      const queue = [createQueuedCommand({ timestamp: Date.now() - 60000 })]; // 1 minute ago
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText(/1m ago/)).toBeInTheDocument();
    });

    it('shows hours ago for timestamps 1+ hours ago', () => {
      const queue = [createQueuedCommand({ timestamp: Date.now() - 3600000 })]; // 1 hour ago
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText(/1h ago/)).toBeInTheDocument();
    });

    it('shows "2h ago" for 2 hour old timestamp', () => {
      const queue = [createQueuedCommand({ timestamp: Date.now() - 7200000 })]; // 2 hours ago
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText(/2h ago/)).toBeInTheDocument();
    });

    it('handles very old timestamps', () => {
      const queue = [createQueuedCommand({ timestamp: Date.now() - 86400000 })]; // 24 hours ago
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      // 24 hours = 1 day, so formatRelativeTime returns "1d ago"
      expect(screen.getByText(/1d ago/)).toBeInTheDocument();
    });
  });

  // ============================================================
  // RENDER CONDITIONS
  // ============================================================

  describe('render conditions', () => {
    it('returns null when queue is empty', () => {
      const { container } = render(<OfflineQueueBanner {...defaultProps} queue={[]} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders when queue has one command', () => {
      const queue = [createQueuedCommand()];
      const { container } = render(<OfflineQueueBanner {...defaultProps} queue={queue} />);
      expect(container.firstChild).not.toBeNull();
    });

    it('renders when queue has multiple commands', () => {
      const queue = [
        createQueuedCommand({ id: 'cmd-1' }),
        createQueuedCommand({ id: 'cmd-2' }),
        createQueuedCommand({ id: 'cmd-3' }),
      ];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);
      expect(screen.getByText('3 commands queued')).toBeInTheDocument();
    });
  });

  // ============================================================
  // HEADER DISPLAY
  // ============================================================

  describe('header display', () => {
    it('shows singular "command" when queue has one item', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);
      expect(screen.getByText('1 command queued')).toBeInTheDocument();
    });

    it('shows plural "commands" when queue has multiple items', () => {
      const queue = [
        createQueuedCommand({ id: 'cmd-1' }),
        createQueuedCommand({ id: 'cmd-2' }),
      ];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);
      expect(screen.getByText('2 commands queued')).toBeInTheDocument();
    });

    it('displays queue icon as SVG', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const svg = document.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    it('uses accent color for icon when connected', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} isOffline={false} />);

      const svg = document.querySelector('svg');
      expect(svg).toHaveAttribute('stroke', '#6366f1'); // accent color
    });

    it('uses warning color for icon when offline', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} isOffline={true} />);

      const svg = document.querySelector('svg');
      expect(svg).toHaveAttribute('stroke', '#eab308'); // warning color
    });
  });

  // ============================================================
  // PROCESSING STATE
  // ============================================================

  describe('processing state indicator', () => {
    it('shows "Sending..." badge when processing', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} status="processing" />);
      expect(screen.getByText('Sending...')).toBeInTheDocument();
    });

    it('does not show "Sending..." badge when idle', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} status="idle" />);
      expect(screen.queryByText('Sending...')).not.toBeInTheDocument();
    });

    it('does not show "Sending..." badge when paused', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} status="paused" />);
      expect(screen.queryByText('Sending...')).not.toBeInTheDocument();
    });
  });

  // ============================================================
  // STATUS MESSAGES
  // ============================================================

  describe('status messages', () => {
    it('shows offline message when offline', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} isOffline={true} />);
      expect(screen.getByText('Commands will be sent when you reconnect.')).toBeInTheDocument();
    });

    it('shows processing message when processing', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} status="processing" isOffline={false} />);
      expect(screen.getByText('Sending queued commands...')).toBeInTheDocument();
    });

    it('shows ready message when idle and online', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} status="idle" isOffline={false} />);
      expect(screen.getByText('Commands ready to send.')).toBeInTheDocument();
    });

    it('shows ready message when paused and online', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} status="paused" isOffline={false} />);
      expect(screen.getByText('Commands ready to send.')).toBeInTheDocument();
    });

    it('prioritizes offline message over processing message', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} status="processing" isOffline={true} />);
      expect(screen.getByText('Commands will be sent when you reconnect.')).toBeInTheDocument();
    });
  });

  // ============================================================
  // EXPAND/COLLAPSE TOGGLE
  // ============================================================

  describe('expand/collapse toggle', () => {
    it('starts collapsed (queue list not visible)', () => {
      const queue = [createQueuedCommand({ command: 'npm test' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      // The queue list should not be visible initially
      expect(screen.queryByText('npm test')).not.toBeInTheDocument();
    });

    it('expands when toggle button is clicked', () => {
      const queue = [createQueuedCommand({ command: 'npm test' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText('npm test')).toBeInTheDocument();
    });

    it('collapses when toggle button is clicked again', () => {
      const queue = [createQueuedCommand({ command: 'npm test' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton); // Expand
      expect(screen.getByText('npm test')).toBeInTheDocument();

      fireEvent.click(toggleButton); // Collapse
      expect(screen.queryByText('npm test')).not.toBeInTheDocument();
    });

    it('triggers haptic feedback on toggle', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(mockTriggerHaptic).toHaveBeenCalledWith([10]); // tap pattern
    });

    it('rotates chevron icon when expanded', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      // Find the chevron SVG (second SVG in the button)
      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      const chevronSvg = toggleButton.querySelectorAll('svg')[1];

      // Initially not rotated
      expect(chevronSvg.style.transform).toBe('rotate(0deg)');

      fireEvent.click(toggleButton);

      // Should be rotated 180deg when expanded
      expect(chevronSvg.style.transform).toBe('rotate(180deg)');
    });
  });

  // ============================================================
  // RETRY BUTTON
  // ============================================================

  describe('retry button', () => {
    it('shows "Send Now" button when canRetry is true', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} isOffline={false} isConnected={true} status="idle" />);
      expect(screen.getByText('Send Now')).toBeInTheDocument();
    });

    it('hides retry button when offline', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} isOffline={true} isConnected={true} status="idle" />);
      expect(screen.queryByText('Send Now')).not.toBeInTheDocument();
    });

    it('hides retry button when not connected', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} isOffline={false} isConnected={false} status="idle" />);
      expect(screen.queryByText('Send Now')).not.toBeInTheDocument();
    });

    it('hides retry button when processing', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} isOffline={false} isConnected={true} status="processing" />);
      expect(screen.queryByText('Send Now')).not.toBeInTheDocument();
    });

    it('calls onProcessQueue when clicked', () => {
      const onProcessQueue = vi.fn();
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} onProcessQueue={onProcessQueue} />);

      fireEvent.click(screen.getByText('Send Now'));
      expect(onProcessQueue).toHaveBeenCalledTimes(1);
    });

    it('triggers haptic feedback when clicked', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      fireEvent.click(screen.getByText('Send Now'));
      expect(mockTriggerHaptic).toHaveBeenCalledWith([10]); // tap pattern
    });

    it('does not call onProcessQueue when canRetry is false', () => {
      const onProcessQueue = vi.fn();
      const queue = [createQueuedCommand()];

      // Button won't render when canRetry is false, so we test that it doesn't appear
      render(<OfflineQueueBanner {...defaultProps} queue={queue} onProcessQueue={onProcessQueue} isOffline={true} />);

      expect(screen.queryByText('Send Now')).not.toBeInTheDocument();
      expect(onProcessQueue).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // CLEAR BUTTON
  // ============================================================

  describe('clear button', () => {
    it('shows "Clear" button', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);
      expect(screen.getByText('Clear')).toBeInTheDocument();
    });

    it('calls onClearQueue when clicked', () => {
      const onClearQueue = vi.fn();
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} onClearQueue={onClearQueue} />);

      fireEvent.click(screen.getByText('Clear'));
      expect(onClearQueue).toHaveBeenCalledTimes(1);
    });

    it('triggers haptic feedback when clicked', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      fireEvent.click(screen.getByText('Clear'));
      expect(mockTriggerHaptic).toHaveBeenCalledWith([10]); // tap pattern
    });

    it('is disabled when processing', () => {
      const onClearQueue = vi.fn();
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} onClearQueue={onClearQueue} status="processing" />);

      const clearButton = screen.getByText('Clear');
      expect(clearButton).toBeDisabled();
    });

    it('does not call onClearQueue when disabled', () => {
      const onClearQueue = vi.fn();
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} onClearQueue={onClearQueue} status="processing" />);

      const clearButton = screen.getByText('Clear');
      fireEvent.click(clearButton);
      expect(onClearQueue).not.toHaveBeenCalled();
    });

    it('has reduced opacity when disabled', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} status="processing" />);

      const clearButton = screen.getByText('Clear');
      expect(clearButton.style.opacity).toBe('0.5');
    });
  });

  // ============================================================
  // QUEUE ITEM DISPLAY
  // ============================================================

  describe('queue item display', () => {
    it('displays command text in monospace font', () => {
      const queue = [createQueuedCommand({ command: 'npm run build' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      const commandElement = screen.getByText('npm run build');
      expect(commandElement.style.fontFamily).toBe('monospace');
    });

    it('displays timestamp for each command', () => {
      const queue = [createQueuedCommand({ timestamp: Date.now() - 300000 })]; // 5 minutes ago
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText(/5m ago/)).toBeInTheDocument();
    });

    it('displays attempt count when attempts > 0', () => {
      const queue = [createQueuedCommand({ attempts: 2 })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText(/2 attempts/)).toBeInTheDocument();
    });

    it('uses singular "attempt" when attempts is 1', () => {
      const queue = [createQueuedCommand({ attempts: 1 })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      // Text should be "1 attempt" not "1 attempts"
      expect(screen.getByText(/1 attempt(?!s)/)).toBeInTheDocument();
    });

    it('does not show attempt count when attempts is 0', () => {
      const queue = [createQueuedCommand({ attempts: 0 })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.queryByText(/attempt/)).not.toBeInTheDocument();
    });

    it('displays lastError when present', () => {
      const queue = [createQueuedCommand({ lastError: 'Connection refused' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText(/Connection refused/)).toBeInTheDocument();
    });

    it('styles lastError in error color', () => {
      const queue = [createQueuedCommand({ lastError: 'Network error' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      const errorSpan = screen.getByText(/Network error/);
      expect(errorSpan.style.color).toBe('rgb(239, 68, 68)'); // #ef4444
    });

    it('displays multiple commands in list', () => {
      const queue = [
        createQueuedCommand({ id: 'cmd-1', command: 'npm install' }),
        createQueuedCommand({ id: 'cmd-2', command: 'npm build' }),
        createQueuedCommand({ id: 'cmd-3', command: 'npm test' }),
      ];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText('npm install')).toBeInTheDocument();
      expect(screen.getByText('npm build')).toBeInTheDocument();
      expect(screen.getByText('npm test')).toBeInTheDocument();
    });
  });

  // ============================================================
  // MODE BADGE
  // ============================================================

  describe('mode badge', () => {
    it('shows "AI" badge for AI mode commands', () => {
      const queue = [createQueuedCommand({ inputMode: 'ai' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText('AI')).toBeInTheDocument();
    });

    it('shows "CLI" badge for terminal mode commands', () => {
      const queue = [createQueuedCommand({ inputMode: 'terminal' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText('CLI')).toBeInTheDocument();
    });

    it('displays correct badge for mixed mode queue', () => {
      const queue = [
        createQueuedCommand({ id: 'cmd-1', inputMode: 'ai' }),
        createQueuedCommand({ id: 'cmd-2', inputMode: 'terminal' }),
      ];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText('AI')).toBeInTheDocument();
      expect(screen.getByText('CLI')).toBeInTheDocument();
    });
  });

  // ============================================================
  // REMOVE COMMAND BUTTON
  // ============================================================

  describe('remove command button', () => {
    it('renders remove button for each command', () => {
      const queue = [
        createQueuedCommand({ id: 'cmd-1' }),
        createQueuedCommand({ id: 'cmd-2' }),
      ];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      const removeButtons = screen.getAllByRole('button', { name: /Remove command/i });
      expect(removeButtons).toHaveLength(2);
    });

    it('calls onRemoveCommand with command id when clicked', () => {
      const onRemoveCommand = vi.fn();
      const queue = [createQueuedCommand({ id: 'test-cmd-123' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} onRemoveCommand={onRemoveCommand} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      const removeButton = screen.getByRole('button', { name: /Remove command/i });
      fireEvent.click(removeButton);

      expect(onRemoveCommand).toHaveBeenCalledWith('test-cmd-123');
    });

    it('triggers haptic feedback when clicked', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);
      mockTriggerHaptic.mockClear();

      const removeButton = screen.getByRole('button', { name: /Remove command/i });
      fireEvent.click(removeButton);

      expect(mockTriggerHaptic).toHaveBeenCalledWith([10]); // tap pattern
    });

    it('is disabled when processing', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} status="processing" />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      const removeButton = screen.getByRole('button', { name: /Remove command/i });
      expect(removeButton).toBeDisabled();
    });

    it('has reduced opacity when processing', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} status="processing" />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      const removeButton = screen.getByRole('button', { name: /Remove command/i });
      expect(removeButton.style.opacity).toBe('0.5');
    });

    it('has aria-label for accessibility', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByRole('button', { name: 'Remove command' })).toBeInTheDocument();
    });
  });

  // ============================================================
  // STYLING
  // ============================================================

  describe('styling', () => {
    it('uses warning colors when offline', () => {
      const queue = [createQueuedCommand()];
      const { container } = render(<OfflineQueueBanner {...defaultProps} queue={queue} isOffline={true} />);

      const banner = container.firstChild as HTMLElement;
      // Background color is rendered as rgba from the hex + opacity
      expect(banner.style.backgroundColor).toMatch(/234.*179.*8/); // warning color RGB values
    });

    it('uses accent colors when connected', () => {
      const queue = [createQueuedCommand()];
      const { container } = render(<OfflineQueueBanner {...defaultProps} queue={queue} isOffline={false} />);

      const banner = container.firstChild as HTMLElement;
      // Background color is rendered as rgba from the hex + opacity
      expect(banner.style.backgroundColor).toMatch(/99.*102.*241/); // accent color RGB values
    });

    it('has proper container styling', () => {
      const queue = [createQueuedCommand()];
      const { container } = render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const banner = container.firstChild as HTMLElement;
      expect(banner.style.margin).toBe('8px 16px');
      expect(banner.style.padding).toBe('12px');
      expect(banner.style.borderRadius).toBe('12px');
    });

    it('expanded list has max height and overflow', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      // Find the scrollable list container (has overflowY auto)
      const listContainer = document.querySelector('[style*="overflow-y: auto"]');
      expect(listContainer).toBeInTheDocument();
      if (listContainer) {
        expect((listContainer as HTMLElement).style.maxHeight).toBe('200px');
      }
    });
  });

  // ============================================================
  // EDGE CASES
  // ============================================================

  describe('edge cases', () => {
    it('handles XSS-like content safely', () => {
      const queue = [createQueuedCommand({ command: '<script>alert("xss")</script>' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      // Should render as text, not execute
      expect(screen.getByText(/<script>alert/)).toBeInTheDocument();
    });

    it('handles very long error messages', () => {
      const longError = 'Error: ' + 'a'.repeat(200);
      const queue = [createQueuedCommand({ lastError: longError })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByText(new RegExp(longError.substring(0, 50)))).toBeInTheDocument();
    });

    it('handles rapid expand/collapse toggles', () => {
      const queue = [createQueuedCommand({ command: 'test cmd' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });

      // Rapid toggles
      for (let i = 0; i < 10; i++) {
        fireEvent.click(toggleButton);
      }

      // Should end up collapsed (even number of clicks)
      expect(screen.queryByText('test cmd')).not.toBeInTheDocument();
    });

    it('handles large queue counts', () => {
      const queue = Array.from({ length: 100 }, (_, i) =>
        createQueuedCommand({ id: `cmd-${i}`, command: `command ${i}` })
      );
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      expect(screen.getByText('100 commands queued')).toBeInTheDocument();
    });

    it('handles commands with newlines', () => {
      const queue = [createQueuedCommand({ command: 'line1\nline2\nline3' })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      // Should display without breaking layout
      const commandElement = document.querySelector('[style*="monospace"]');
      expect(commandElement).toBeInTheDocument();
    });

    it('handles undefined optional fields gracefully', () => {
      const queue = [{
        id: 'cmd-1',
        command: 'test',
        sessionId: 'session-1',
        inputMode: 'ai' as const,
        timestamp: Date.now(),
        attempts: 0,
        // lastError is undefined
      }];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      // Should render without errors
      expect(screen.getByText('test')).toBeInTheDocument();
    });

    it('handles future timestamps', () => {
      const queue = [createQueuedCommand({ timestamp: Date.now() + 60000 })]; // 1 minute in future
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      // Should show "just now" for negative time difference
      expect(screen.getByText(/just now/i)).toBeInTheDocument();
    });

    it('handles zero timestamp', () => {
      const queue = [createQueuedCommand({ timestamp: 0 })];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      // Should show date format for epoch timestamp (> 7 days ago)
      // formatRelativeTime shows a date format like "Jan 1" or "1 Jan" (locale-dependent)
      // Just verify it's not showing "ago" since it should be a date
      expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
    });
  });

  // ============================================================
  // INTEGRATION SCENARIOS
  // ============================================================

  describe('integration scenarios', () => {
    it('complete offline queue workflow', () => {
      const onClearQueue = vi.fn();
      const onProcessQueue = vi.fn();
      const onRemoveCommand = vi.fn();

      const queue = [
        createQueuedCommand({ id: 'cmd-1', command: 'npm install', inputMode: 'terminal', attempts: 2, lastError: 'timeout' }),
        createQueuedCommand({ id: 'cmd-2', command: 'help me with testing', inputMode: 'ai' }),
      ];

      // Start offline
      const { rerender } = render(
        <OfflineQueueBanner
          {...defaultProps}
          queue={queue}
          isOffline={true}
          isConnected={false}
          onClearQueue={onClearQueue}
          onProcessQueue={onProcessQueue}
          onRemoveCommand={onRemoveCommand}
        />
      );

      // Should show offline message
      expect(screen.getByText('Commands will be sent when you reconnect.')).toBeInTheDocument();
      expect(screen.queryByText('Send Now')).not.toBeInTheDocument();

      // Expand queue
      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      // Should see both commands
      expect(screen.getByText('npm install')).toBeInTheDocument();
      expect(screen.getByText(/help me with testing/)).toBeInTheDocument();
      expect(screen.getByText(/2 attempts/)).toBeInTheDocument();
      expect(screen.getByText(/timeout/)).toBeInTheDocument();

      // Go online
      rerender(
        <OfflineQueueBanner
          {...defaultProps}
          queue={queue}
          isOffline={false}
          isConnected={true}
          onClearQueue={onClearQueue}
          onProcessQueue={onProcessQueue}
          onRemoveCommand={onRemoveCommand}
        />
      );

      // Should show ready message and retry button
      expect(screen.getByText('Commands ready to send.')).toBeInTheDocument();
      expect(screen.getByText('Send Now')).toBeInTheDocument();

      // Retry queue
      fireEvent.click(screen.getByText('Send Now'));
      expect(onProcessQueue).toHaveBeenCalled();

      // Remove one command
      const removeButtons = screen.getAllByRole('button', { name: /Remove command/i });
      fireEvent.click(removeButtons[0]);
      expect(onRemoveCommand).toHaveBeenCalledWith('cmd-1');

      // Clear queue
      fireEvent.click(screen.getByText('Clear'));
      expect(onClearQueue).toHaveBeenCalled();
    });

    it('processing state workflow', () => {
      const queue = [createQueuedCommand()];

      const { rerender } = render(
        <OfflineQueueBanner {...defaultProps} queue={queue} status="idle" />
      );

      expect(screen.getByText('Send Now')).toBeInTheDocument();
      expect(screen.queryByText('Sending...')).not.toBeInTheDocument();

      // Start processing
      rerender(<OfflineQueueBanner {...defaultProps} queue={queue} status="processing" />);

      // Should show processing indicator and hide retry
      expect(screen.getByText('Sending...')).toBeInTheDocument();
      expect(screen.queryByText('Send Now')).not.toBeInTheDocument();
      expect(screen.getByText('Sending queued commands...')).toBeInTheDocument();
      expect(screen.getByText('Clear')).toBeDisabled();
    });

    it('handles state transitions correctly', () => {
      const queue = [createQueuedCommand()];

      const { rerender } = render(
        <OfflineQueueBanner {...defaultProps} queue={queue} status="idle" isOffline={false} isConnected={true} />
      );

      // idle -> paused
      rerender(<OfflineQueueBanner {...defaultProps} queue={queue} status="paused" isOffline={false} isConnected={true} />);
      expect(screen.getByText('Commands ready to send.')).toBeInTheDocument();

      // paused -> processing
      rerender(<OfflineQueueBanner {...defaultProps} queue={queue} status="processing" isOffline={false} isConnected={true} />);
      expect(screen.getByText('Sending queued commands...')).toBeInTheDocument();

      // processing -> idle (with connection lost)
      rerender(<OfflineQueueBanner {...defaultProps} queue={queue} status="idle" isOffline={true} isConnected={false} />);
      expect(screen.getByText('Commands will be sent when you reconnect.')).toBeInTheDocument();
    });
  });

  // ============================================================
  // ACCESSIBILITY
  // ============================================================

  describe('accessibility', () => {
    it('buttons are keyboard accessible', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      // Button is accessible via role
      expect(toggleButton.tagName).toBe('BUTTON');
    });

    it('remove buttons have descriptive aria-label', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} />);

      const toggleButton = screen.getByRole('button', { name: /command.* queued/i });
      fireEvent.click(toggleButton);

      expect(screen.getByRole('button', { name: 'Remove command' })).toBeInTheDocument();
    });

    it('processing badge communicates status', () => {
      const queue = [createQueuedCommand()];
      render(<OfflineQueueBanner {...defaultProps} queue={queue} status="processing" />);

      expect(screen.getByText('Sending...')).toBeInTheDocument();
    });
  });

  // ============================================================
  // DEFAULT EXPORT
  // ============================================================

  describe('default export', () => {
    it('exports OfflineQueueBanner as default', async () => {
      const module = await import('../../../web/mobile/OfflineQueueBanner');
      expect(module.default).toBe(module.OfflineQueueBanner);
    });
  });
});
