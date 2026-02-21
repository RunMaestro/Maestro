/**
 * @fileoverview Tests for AddParticipantModal component
 *
 * Tests that the modal renders fresh agent and existing session options,
 * filters terminals and already-added participants, calls the correct
 * IPC callbacks, closes on success, and shows errors on failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddParticipantModal } from '../../../renderer/components/AddParticipantModal';
import type { Theme, Session, AgentConfig, GroupChatParticipant } from '../../../renderer/types';

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-add-participant-123');
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

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/home/user/project',
		fullPath: '/home/user/project',
		projectRoot: '/home/user/project',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 12345,
		shellPid: 0,
		activeTab: 'ai',
		tabs: [],
		...overrides,
	} as Session;
}

function createMockParticipant(overrides: Partial<GroupChatParticipant> = {}): GroupChatParticipant {
	return {
		name: 'Participant 1',
		agentId: 'claude-code',
		sessionId: 'session-existing',
		addedAt: Date.now(),
		...overrides,
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

const defaultProps = () => ({
	theme: createMockTheme(),
	isOpen: true,
	groupChatId: 'group-chat-1',
	sessions: [] as Session[],
	participants: [] as GroupChatParticipant[],
	onClose: vi.fn(),
	onAddExisting: vi.fn(),
	onAddFresh: vi.fn(),
});

// =============================================================================
// TESTS
// =============================================================================

describe('AddParticipantModal', () => {
	beforeEach(() => {
		mockRegisterLayer.mockClear().mockReturnValue('layer-add-participant-123');
		mockUnregisterLayer.mockClear();
		mockUpdateLayerHandler.mockClear();

		// Default: return claude-code and codex as available agents
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			createMockAgent({ id: 'claude-code', name: 'Claude Code' }),
			createMockAgent({ id: 'codex', name: 'Codex' }),
		]);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('rendering', () => {
		it('renders with fresh agent and existing session radio options', async () => {
			const props = defaultProps();
			render(<AddParticipantModal {...props} />);

			// Both radio options should be visible
			expect(screen.getByText('Create fresh agent')).toBeInTheDocument();
			expect(screen.getByText('Use existing session')).toBeInTheDocument();
		});

		it('renders agent type dropdown in fresh mode by default', async () => {
			const props = defaultProps();
			render(<AddParticipantModal {...props} />);

			// Wait for agent detection to complete
			await waitFor(() => {
				expect(screen.getByLabelText('Select agent type')).toBeInTheDocument();
			});

			// Agent type label should be shown
			expect(screen.getByText('Agent Type')).toBeInTheDocument();
		});

		it('shows detecting spinner while loading agents', () => {
			// Make detect never resolve
			vi.mocked(window.maestro.agents.detect).mockReturnValue(new Promise(() => {}));

			const props = defaultProps();
			render(<AddParticipantModal {...props} />);

			expect(screen.getByText('Detecting agents...')).toBeInTheDocument();
		});

		it('does not render when isOpen is false', () => {
			const props = defaultProps();
			props.isOpen = false;
			const { container } = render(<AddParticipantModal {...props} />);

			expect(container.innerHTML).toBe('');
		});
	});

	describe('session filtering', () => {
		it('filters out terminal sessions from the existing session dropdown', async () => {
			const props = defaultProps();
			props.sessions = [
				createMockSession({ id: 'agent-1', name: 'My Agent', toolType: 'claude-code' }),
				createMockSession({ id: 'term-1', name: 'My Terminal', toolType: 'terminal' }),
			];

			render(<AddParticipantModal {...props} />);

			// Switch to existing mode
			fireEvent.click(screen.getByText('Use existing session'));

			await waitFor(() => {
				expect(screen.getByLabelText('Select existing session')).toBeInTheDocument();
			});

			// Agent session should be visible, terminal should not
			const select = screen.getByLabelText('Select existing session');
			const options = select.querySelectorAll('option');
			const optionTexts = Array.from(options).map((o) => o.textContent);

			expect(optionTexts.some((t) => t?.includes('My Agent'))).toBe(true);
			expect(optionTexts.some((t) => t?.includes('My Terminal'))).toBe(false);
		});

		it('filters out already-added participants from the existing session dropdown', async () => {
			const props = defaultProps();
			props.sessions = [
				createMockSession({ id: 'session-a', name: 'Agent A', toolType: 'claude-code' }),
				createMockSession({ id: 'session-b', name: 'Agent B', toolType: 'codex' }),
			];
			props.participants = [
				createMockParticipant({ sessionId: 'session-a', name: 'Agent A' }),
			];

			render(<AddParticipantModal {...props} />);

			// Switch to existing mode
			fireEvent.click(screen.getByText('Use existing session'));

			await waitFor(() => {
				expect(screen.getByLabelText('Select existing session')).toBeInTheDocument();
			});

			const select = screen.getByLabelText('Select existing session');
			const options = select.querySelectorAll('option');
			const optionTexts = Array.from(options).map((o) => o.textContent);

			// Only Agent B should be available (Agent A already added)
			expect(optionTexts.some((t) => t?.includes('Agent A'))).toBe(false);
			expect(optionTexts.some((t) => t?.includes('Agent B'))).toBe(true);
		});

		it('shows empty message when no sessions are available in existing mode', async () => {
			const props = defaultProps();
			props.sessions = [
				createMockSession({ id: 'term-1', name: 'Terminal', toolType: 'terminal' }),
			];

			render(<AddParticipantModal {...props} />);

			// Switch to existing mode
			fireEvent.click(screen.getByText('Use existing session'));

			await waitFor(() => {
				expect(
					screen.getByText(/No available sessions/)
				).toBeInTheDocument();
			});
		});
	});

	describe('fresh agent selection', () => {
		it('calls onAddFresh with agent id and name when submitting in fresh mode', async () => {
			const props = defaultProps();
			render(<AddParticipantModal {...props} />);

			// Wait for agents to load
			await waitFor(() => {
				expect(screen.getByLabelText('Select agent type')).toBeInTheDocument();
			});

			// Claude Code should be auto-selected; click Add
			const addButton = screen.getByRole('button', { name: /add/i });
			fireEvent.click(addButton);

			expect(props.onAddFresh).toHaveBeenCalledWith('claude-code', 'Claude Code');
		});

		it('allows selecting a different agent type', async () => {
			const props = defaultProps();
			render(<AddParticipantModal {...props} />);

			// Wait for agents to load
			await waitFor(() => {
				expect(screen.getByLabelText('Select agent type')).toBeInTheDocument();
			});

			// Change to codex
			const select = screen.getByLabelText('Select agent type');
			fireEvent.change(select, { target: { value: 'codex' } });

			const addButton = screen.getByRole('button', { name: /add/i });
			fireEvent.click(addButton);

			expect(props.onAddFresh).toHaveBeenCalledWith('codex', 'Codex');
		});
	});

	describe('existing session selection', () => {
		it('calls onAddExisting with session details when submitting in existing mode', async () => {
			const props = defaultProps();
			props.sessions = [
				createMockSession({
					id: 'session-1',
					name: 'My Project',
					toolType: 'claude-code',
					cwd: '/home/user/project',
				}),
			];

			render(<AddParticipantModal {...props} />);

			// Switch to existing mode
			fireEvent.click(screen.getByText('Use existing session'));

			await waitFor(() => {
				expect(screen.getByLabelText('Select existing session')).toBeInTheDocument();
			});

			// First session should be auto-selected; click Add
			const addButton = screen.getByRole('button', { name: /add/i });
			fireEvent.click(addButton);

			expect(props.onAddExisting).toHaveBeenCalledWith(
				'session-1',
				'My Project',
				'claude-code',
				'/home/user/project'
			);
		});
	});

	describe('error handling', () => {
		it('shows error message when onAddFresh throws', async () => {
			const props = defaultProps();
			props.onAddFresh = vi.fn(() => {
				throw new Error('Failed to start Claude Code. Check that it\'s properly configured and accessible.');
			});

			render(<AddParticipantModal {...props} />);

			// Wait for agents to load
			await waitFor(() => {
				expect(screen.getByLabelText('Select agent type')).toBeInTheDocument();
			});

			// Click Add
			const addButton = screen.getByRole('button', { name: /add/i });
			fireEvent.click(addButton);

			// Error should be displayed
			await waitFor(() => {
				expect(
					screen.getByText(/Failed to start Claude Code/)
				).toBeInTheDocument();
			});
		});

		it('shows generic error for non-Error throws', async () => {
			const props = defaultProps();
			props.onAddFresh = vi.fn(() => {
				throw 'something went wrong';
			});

			render(<AddParticipantModal {...props} />);

			await waitFor(() => {
				expect(screen.getByLabelText('Select agent type')).toBeInTheDocument();
			});

			const addButton = screen.getByRole('button', { name: /add/i });
			fireEvent.click(addButton);

			await waitFor(() => {
				expect(screen.getByText('Failed to add participant')).toBeInTheDocument();
			});
		});
	});

	describe('modal close', () => {
		it('calls onClose when cancel is clicked', async () => {
			const props = defaultProps();
			render(<AddParticipantModal {...props} />);

			const cancelButton = screen.getByRole('button', { name: /cancel/i });
			fireEvent.click(cancelButton);

			expect(props.onClose).toHaveBeenCalledTimes(1);
		});
	});
});
