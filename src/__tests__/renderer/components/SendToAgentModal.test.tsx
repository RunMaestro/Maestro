/**
 * Tests for SendToAgentModal component
 *
 * Tests the core behavior of the send-to-agent modal:
 * - Rendering with session list and search
 * - Session selection and status display
 * - Keyboard navigation
 * - Fuzzy search filtering
 * - Send button handlers
 * - Layer stack integration
 * - Accessibility
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SendToAgentModal } from '../../../renderer/components/SendToAgentModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme, Session, ToolType } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';

// Create a test theme
const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

// Create mock sessions for the allSessions prop
const createMockTargetSession = (
	id: string,
	name: string,
	toolType: ToolType = 'opencode',
	state: 'idle' | 'busy' = 'idle'
): Session => ({
	id,
	name,
	toolType,
	state,
	cwd: '/test/path',
	fullPath: '/test/path',
	projectRoot: '/test/path',
	aiLogs: [],
	shellLogs: [],
	workLog: [],
	contextUsage: 0,
	inputMode: 'ai',
	aiPid: 0,
	terminalPid: 0,
	port: 0,
	isLive: false,
	changedFiles: [],
	isGitRepo: true,
	fileTree: [],
	fileExplorerExpanded: [],
	fileExplorerScrollPos: 0,
	activeTimeMs: 0,
	executionQueue: [],
	aiTabs: [
		{
			id: 'tab-1',
			agentSessionId: null,
			name: null,
			starred: false,
			logs: [],
			inputValue: '',
			stagedImages: [],
			createdAt: Date.now(),
			state: 'idle',
		},
	],
	activeTabId: 'tab-1',
	closedTabHistory: [],
});

// Mock sessions that correspond to the agents we want available
const mockSessions: Session[] = [
	createMockTargetSession('session-opencode', 'OpenCode Session', 'opencode'),
	createMockTargetSession('session-codex', 'Codex Session', 'codex'),
	createMockTargetSession('session-busy', 'Busy Session', 'claude-code', 'busy'),
];

// Thin wrapper: pre-populates an AI tab with chat logs so Send To Agent
// has real content to forward.
const createMockSession = (overrides: Partial<Session> = {}): Session =>
	baseCreateMockSession({
		id: 'test-session-1',
		cwd: '/test/path',
		fullPath: '/test/path',
		projectRoot: '/test/path',
		isGitRepo: true,
		aiTabs: [
			{
				id: 'tab-1',
				agentSessionId: 'session-abc-123',
				name: 'Test Tab',
				starred: false,
				logs: [
					{ id: '1', timestamp: Date.now(), source: 'user', text: 'Hello' },
					{
						id: '2',
						timestamp: Date.now(),
						source: 'ai',
						text: 'Hi there! How can I help you today?',
					},
				],
				inputValue: '',
				stagedImages: [],
				createdAt: Date.now(),
				state: 'idle',
			},
		] as any,
		activeTabId: 'tab-1',
		...overrides,
	});

// Helper to render with LayerStackProvider
const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

describe('SendToAgentModal', () => {
	const mockSession = createMockSession();
	const mockOnClose = vi.fn();
	const mockOnSend = vi.fn().mockResolvedValue({ success: true });

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('rendering', () => {
		it('does not render when isOpen is false', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={false}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('renders when isOpen is true', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(screen.getByText('Send Context to Agent')).toBeInTheDocument();
		});

		it('renders target session list', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			expect(screen.getByText('OpenCode Session')).toBeInTheDocument();
			expect(screen.getByText('Codex Session')).toBeInTheDocument();
			expect(screen.getByText('Busy Session')).toBeInTheDocument();
		});

		it('excludes the source session from target options', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			expect(screen.queryByText(mockSession.name)).not.toBeInTheDocument();
		});

		it('shows Busy status for busy sessions', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			expect(screen.getByText('Busy')).toBeInTheDocument();
		});

		it('shows Idle status for idle sessions', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const idleStatuses = screen.getAllByText('Idle');
			expect(idleStatuses.length).toBeGreaterThanOrEqual(2);
		});

		it('has correct ARIA attributes', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-labelledby', 'send-to-agent-title');
			expect(dialog).toHaveAttribute('aria-describedby', 'send-to-agent-description');
		});
	});

	describe('search functionality', () => {
		it('renders search input', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			expect(screen.getByPlaceholderText('Search sessions...')).toBeInTheDocument();
		});

		it('filters sessions based on search query', async () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const searchInput = screen.getByPlaceholderText('Search sessions...');
			fireEvent.change(searchInput, { target: { value: 'open' } });

			await waitFor(() => {
				expect(screen.getByText('OpenCode Session')).toBeInTheDocument();
				expect(screen.queryByText('Codex Session')).not.toBeInTheDocument();
			});
		});

		it('shows empty state when no sessions match search', async () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const searchInput = screen.getByPlaceholderText('Search sessions...');
			fireEvent.change(searchInput, { target: { value: 'zzzzzzz' } });

			await waitFor(() => {
				expect(screen.getByText('No matching sessions found')).toBeInTheDocument();
			});
		});
	});

	describe('session selection', () => {
		it('selects session when clicked', async () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const openCodeButton = screen.getByText('OpenCode Session').closest('button');
			fireEvent.click(openCodeButton!);

			// Send button should now be enabled
			const sendButton = screen.getByRole('button', { name: /send to session/i });
			expect(sendButton).not.toBeDisabled();
		});

		it('marks selected session as selected', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const openCodeButton = screen.getByText('OpenCode Session').closest('button')!;
			fireEvent.click(openCodeButton);

			expect(openCodeButton).toHaveAttribute('aria-selected', 'true');
		});
	});

	describe('button handlers', () => {
		it('calls onClose when Cancel is clicked', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});

		it('calls onClose when X button is clicked', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const closeButton = screen.getByLabelText('Close dialog');
			fireEvent.click(closeButton);
			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});

		it('Send button is disabled when no agent selected', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const sendButton = screen.getByRole('button', { name: /send to session/i });
			expect(sendButton).toBeDisabled();
		});

		it('calls onSend and onClose when Send is clicked with session selected', async () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const openCodeButton = screen.getByText('OpenCode Session').closest('button');
			fireEvent.click(openCodeButton!);

			// Click Send
			const sendButton = screen.getByRole('button', { name: /send to session/i });
			fireEvent.click(sendButton);

			await waitFor(() => {
				expect(mockOnSend).toHaveBeenCalledTimes(1);
				expect(mockOnSend).toHaveBeenCalledWith('session-opencode', {
					groomContext: true,
					targetSessionId: 'session-opencode',
				});
				expect(mockOnClose).toHaveBeenCalledTimes(1);
			});
		});
	});

	describe('options', () => {
		it('renders clean context checkbox (checked by default)', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const groomCheckbox = screen.getByRole('checkbox', { name: /clean context/i });
			expect(groomCheckbox).toBeChecked();
		});

		it('passes correct options to onSend when clean context is unchecked', async () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const groomCheckbox = screen.getByRole('checkbox', { name: /clean context/i });
			fireEvent.click(groomCheckbox);

			const openCodeButton = screen.getByText('OpenCode Session').closest('button');
			fireEvent.click(openCodeButton!);

			const sendButton = screen.getByRole('button', { name: /send to session/i });
			fireEvent.click(sendButton);

			await waitFor(() => {
				expect(mockOnSend).toHaveBeenCalledWith('session-opencode', {
					groomContext: false,
					targetSessionId: 'session-opencode',
				});
			});
		});
	});

	describe('token estimation', () => {
		it('displays source token estimate', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			// The test tab has ~45 characters worth of text, so ~11 tokens
			expect(screen.getByText(/Source:/)).toBeInTheDocument();
			// There should be at least one token display (source tokens)
			const tokenElements = screen.getAllByText(/tokens/i);
			expect(tokenElements.length).toBeGreaterThan(0);
		});
	});

	describe('keyboard navigation', () => {
		it('focuses search input on mount', async () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			await waitFor(() => {
				expect(document.activeElement).toBe(screen.getByPlaceholderText('Search sessions...'));
			});
		});

		it('navigates with arrow keys in grid', async () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const dialog = screen.getByRole('dialog');

			// Press ArrowDown to move to next row
			fireEvent.keyDown(dialog, { key: 'ArrowDown' });

			// Press ArrowUp to move up
			fireEvent.keyDown(dialog, { key: 'ArrowUp' });

			// No errors should occur during navigation
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('selects session with number keys', async () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const dialog = screen.getByRole('dialog');

			fireEvent.keyDown(dialog, { key: '1' });

			await waitFor(() => {
				const sendButton = screen.getByRole('button', { name: /send to session/i });
				expect(sendButton).not.toBeDisabled();
			});
		});

		it('confirms selection with Enter key', async () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const dialog = screen.getByRole('dialog');

			fireEvent.keyDown(dialog, { key: '1' });

			// Then press Enter to confirm
			fireEvent.keyDown(dialog, { key: 'Enter' });

			await waitFor(() => {
				expect(mockOnSend).toHaveBeenCalled();
			});
		});

		it('selects highlighted session with Space key', async () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			const dialog = screen.getByRole('dialog');

			// Wait for state to update after navigation
			await waitFor(() => {
				const options = screen.getAllByRole('option');
				expect(options.length).toBeGreaterThan(1);
			});

			// Press Space to select
			fireEvent.keyDown(dialog, { key: ' ' });

			await waitFor(() => {
				const sendButton = screen.getByRole('button', { name: /send to session/i });
				expect(sendButton).not.toBeDisabled();
			});
		});
	});

	describe('layer stack integration', () => {
		it('registers and unregisters without errors', () => {
			const { unmount } = renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(() => unmount()).not.toThrow();
		});
	});

	describe('busy agent status', () => {
		it('shows Busy status for agents with busy sessions', () => {
			const busySessions: Session[] = [
				createMockSession({ id: 'busy-session', toolType: 'opencode', state: 'busy' }),
			];

			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={busySessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			expect(screen.getByText('Busy')).toBeInTheDocument();
		});
	});

	describe('accessibility', () => {
		it('has tabIndex on dialog for focus', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			expect(screen.getByRole('dialog')).toHaveAttribute('tabIndex', '-1');
		});

		it('has semantic elements for agents and action buttons', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={mockSessions}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			// Should have action buttons (Cancel, Send, Close)
			const buttons = screen.getAllByRole('button');
			expect(buttons.length).toBeGreaterThanOrEqual(3);

			// Session options should be rendered as options in a listbox
			const options = screen.getAllByRole('option');
			expect(options.length).toBe(3); // 3 sessions (mockSessions)
		});
	});
});
