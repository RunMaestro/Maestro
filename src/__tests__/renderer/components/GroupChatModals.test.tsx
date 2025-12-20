/**
 * @fileoverview Tests for NewGroupChatModal and EditGroupChatModal components
 *
 * Regression test for: MAESTRO_SESSION_RESUMED env var display in group chat moderator customization
 * This test ensures that when users customize the moderator agent in group chat modals,
 * they see the built-in MAESTRO_SESSION_RESUMED environment variable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NewGroupChatModal } from '../../../renderer/components/NewGroupChatModal';
import { EditGroupChatModal } from '../../../renderer/components/EditGroupChatModal';
import type { Theme, GroupChat, AgentConfig } from '../../../renderer/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Folder: ({ className }: { className?: string }) => (
    <span data-testid="folder-icon" className={className}>📁</span>
  ),
  X: ({ className }: { className?: string }) => (
    <span data-testid="x-icon" className={className}>×</span>
  ),
  RefreshCw: ({ className }: { className?: string }) => (
    <span data-testid="refresh-icon" className={className}>🔄</span>
  ),
  Check: ({ className }: { className?: string }) => (
    <span data-testid="check-icon" className={className}>✓</span>
  ),
  Plus: ({ className }: { className?: string }) => (
    <span data-testid="plus-icon" className={className}>+</span>
  ),
  Trash2: ({ className }: { className?: string }) => (
    <span data-testid="trash-icon" className={className}>🗑</span>
  ),
  HelpCircle: ({ className }: { className?: string }) => (
    <span data-testid="help-circle-icon" className={className}>?</span>
  ),
  ChevronDown: ({ className }: { className?: string }) => (
    <span data-testid="chevron-down-icon" className={className}>▼</span>
  ),
  Settings: ({ className }: { className?: string }) => (
    <span data-testid="settings-icon" className={className}>⚙</span>
  ),
  ArrowLeft: ({ className }: { className?: string }) => (
    <span data-testid="arrow-left-icon" className={className}>←</span>
  ),
}));

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-group-chat-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
  useLayerStack: () => ({
    registerLayer: mockRegisterLayer,
    unregisterLayer: mockUnregisterLayer,
    updateLayerHandler: mockUpdateLayerHandler,
  }),
}));

// =============================================================================
// TEST HELPERS
// =============================================================================

function createMockTheme(): Theme {
  return {
    id: 'test-theme',
    name: 'Test Theme',
    colors: {
      bgMain: '#1a1a1a',
      bgSidebar: '#252525',
      bgActivity: '#333333',
      textMain: '#ffffff',
      textDim: '#888888',
      accent: '#6366f1',
      border: '#333333',
      success: '#22c55e',
      error: '#ef4444',
      warning: '#f59e0b',
      contextFree: '#22c55e',
      contextMedium: '#f59e0b',
      contextHigh: '#ef4444',
    },
  };
}

function createMockAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    available: true,
    path: '/usr/local/bin/claude',
    binaryName: 'claude',
    hidden: false,
    capabilities: {
      supportsModelSelection: false,
    },
    ...overrides,
  } as AgentConfig;
}

function createMockGroupChat(overrides: Partial<GroupChat> = {}): GroupChat {
  return {
    id: 'group-chat-1',
    name: 'Test Group Chat',
    moderatorAgentId: 'claude-code',
    createdAt: Date.now(),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Group Chat Modals', () => {
  beforeEach(() => {
    mockRegisterLayer.mockClear().mockReturnValue('layer-group-chat-123');
    mockUnregisterLayer.mockClear();
    mockUpdateLayerHandler.mockClear();

    // Setup default mock implementations
    vi.mocked(window.maestro.agents.detect).mockResolvedValue([
      createMockAgent({ id: 'claude-code', name: 'Claude Code' }),
    ]);
    vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
    vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(undefined);
    vi.mocked(window.maestro.agents.getModels).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('NewGroupChatModal', () => {
    it('should display MAESTRO_SESSION_RESUMED in moderator configuration panel', async () => {
      const onCreate = vi.fn();
      const onClose = vi.fn();

      render(
        <NewGroupChatModal
          theme={createMockTheme()}
          isOpen={true}
          onClose={onClose}
          onCreate={onCreate}
        />
      );

      // Wait for agent detection
      await waitFor(() => {
        expect(screen.getByText('Claude Code')).toBeInTheDocument();
      });

      // Select the agent first
      const agentButton = screen.getByText('Claude Code').closest('button');
      expect(agentButton).not.toBeNull();
      fireEvent.click(agentButton!);

      // Click the Customize button to open config panel
      const customizeButton = screen.getByText('Customize');
      fireEvent.click(customizeButton);

      // Wait for config panel to appear and verify MAESTRO_SESSION_RESUMED is displayed
      await waitFor(() => {
        expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
      });

      // Also verify the value hint is shown
      expect(screen.getByText('1 (when resuming)')).toBeInTheDocument();
    });
  });

  describe('EditGroupChatModal', () => {
    it('should display MAESTRO_SESSION_RESUMED in moderator configuration panel', async () => {
      const onSave = vi.fn();
      const onClose = vi.fn();
      const groupChat = createMockGroupChat();

      render(
        <EditGroupChatModal
          theme={createMockTheme()}
          isOpen={true}
          groupChat={groupChat}
          onClose={onClose}
          onSave={onSave}
        />
      );

      // Wait for agent detection
      await waitFor(() => {
        expect(screen.getByText('Claude Code')).toBeInTheDocument();
      });

      // Click the Customize button to open config panel
      const customizeButton = screen.getByText('Customize');
      fireEvent.click(customizeButton);

      // Wait for config panel to appear and verify MAESTRO_SESSION_RESUMED is displayed
      await waitFor(() => {
        expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
      });

      // Also verify the value hint is shown
      expect(screen.getByText('1 (when resuming)')).toBeInTheDocument();
    });
  });
});
