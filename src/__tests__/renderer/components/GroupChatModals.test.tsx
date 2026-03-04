/**
 * @fileoverview Tests for GroupChatModal component (create and edit modes)
 *
 * Regression test for: MAESTRO_SESSION_RESUMED env var display in group chat moderator customization
 * This test ensures that when users customize the moderator agent in group chat modals,
 * they see the built-in MAESTRO_SESSION_RESUMED environment variable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GroupChatModal } from '../../../renderer/components/GroupChatModal';
import type { Theme, GroupChat, AgentConfig } from '../../../renderer/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	Folder: ({ className }: { className?: string }) => (
		<span data-testid="folder-icon" className={className}>
			📁
		</span>
	),
	X: ({ className }: { className?: string }) => (
		<span data-testid="x-icon" className={className}>
			×
		</span>
	),
	RefreshCw: ({ className }: { className?: string }) => (
		<span data-testid="refresh-icon" className={className}>
			🔄
		</span>
	),
	Check: ({ className }: { className?: string }) => (
		<span data-testid="check-icon" className={className}>
			✓
		</span>
	),
	Plus: ({ className }: { className?: string }) => (
		<span data-testid="plus-icon" className={className}>
			+
		</span>
	),
	Trash2: ({ className }: { className?: string }) => (
		<span data-testid="trash-icon" className={className}>
			🗑
		</span>
	),
	HelpCircle: ({ className }: { className?: string }) => (
		<span data-testid="help-circle-icon" className={className}>
			?
		</span>
	),
	ChevronDown: ({ className }: { className?: string }) => (
		<span data-testid="chevron-down-icon" className={className}>
			▼
		</span>
	),
	Settings: ({ className }: { className?: string }) => (
		<span data-testid="settings-icon" className={className}>
			⚙
		</span>
	),
	ArrowLeft: ({ className }: { className?: string }) => (
		<span data-testid="arrow-left-icon" className={className}>
			←
		</span>
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

describe('GroupChatModal', () => {
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

	describe('create mode', () => {
		it('should display MAESTRO_SESSION_RESUMED in moderator configuration panel', async () => {
			const onCreate = vi.fn();
			const onClose = vi.fn();

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
				/>
			);

			// Wait for agent detection and verify dropdown is rendered
			await waitFor(() => {
				expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
			});

			// Verify Claude Code is selected in dropdown
			const dropdown = screen.getByRole('combobox', { name: /select moderator/i });
			expect(dropdown).toHaveValue('claude-code');

			// Click the Customize button to expand config panel
			const customizeButton = screen.getByRole('button', { name: /customize/i });
			fireEvent.click(customizeButton);

			// Wait for config panel to appear and verify MAESTRO_SESSION_RESUMED is displayed
			await waitFor(() => {
				expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
			});

			// Also verify the value hint is shown
			expect(screen.getByText('1 (when resuming)')).toBeInTheDocument();
		});

		it('should show all available agents in dropdown', async () => {
			// Setup multiple agents
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createMockAgent({ id: 'claude-code', name: 'Claude Code' }),
				createMockAgent({ id: 'codex', name: 'Codex' }),
				createMockAgent({ id: 'opencode', name: 'OpenCode' }),
				createMockAgent({ id: 'factory-droid', name: 'Factory Droid' }),
			]);

			const onCreate = vi.fn();
			const onClose = vi.fn();

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
				/>
			);

			// Wait for dropdown to be rendered
			await waitFor(() => {
				expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
			});

			// Verify all agents appear as options
			expect(screen.getByRole('option', { name: /Claude Code/i })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /Codex.*Beta/i })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /OpenCode.*Beta/i })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /Factory Droid.*Beta/i })).toBeInTheDocument();
		});
	});

	describe('edit mode', () => {
		it('should display MAESTRO_SESSION_RESUMED in moderator configuration panel', async () => {
			const onSave = vi.fn();
			const onClose = vi.fn();
			const groupChat = createMockGroupChat();

			render(
				<GroupChatModal
					mode="edit"
					theme={createMockTheme()}
					isOpen={true}
					groupChat={groupChat}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			// Wait for dropdown to be rendered
			await waitFor(() => {
				expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
			});

			// Verify Claude Code is pre-selected
			const dropdown = screen.getByRole('combobox', { name: /select moderator/i });
			expect(dropdown).toHaveValue('claude-code');

			// Click the Customize button to expand config panel
			const customizeButton = screen.getByRole('button', { name: /customize/i });
			fireEvent.click(customizeButton);

			// Wait for config panel to appear and verify MAESTRO_SESSION_RESUMED is displayed
			await waitFor(() => {
				expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
			});

			// Also verify the value hint is shown
			expect(screen.getByText('1 (when resuming)')).toBeInTheDocument();
		});

		it('should show warning when changing moderator agent', async () => {
			// Setup multiple agents
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				createMockAgent({ id: 'claude-code', name: 'Claude Code' }),
				createMockAgent({ id: 'codex', name: 'Codex' }),
			]);

			const onSave = vi.fn();
			const onClose = vi.fn();
			const groupChat = createMockGroupChat({ moderatorAgentId: 'claude-code' });

			render(
				<GroupChatModal
					mode="edit"
					theme={createMockTheme()}
					isOpen={true}
					groupChat={groupChat}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			// Wait for dropdown
			await waitFor(() => {
				expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
			});

			// Change to different agent
			const dropdown = screen.getByRole('combobox', { name: /select moderator/i });
			fireEvent.change(dropdown, { target: { value: 'codex' } });

			// Verify warning message appears
			await waitFor(() => {
				expect(screen.getByText(/changing the moderator agent/i)).toBeInTheDocument();
			});
		});
	});
});
