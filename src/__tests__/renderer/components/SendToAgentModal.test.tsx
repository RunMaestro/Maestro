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

// Create a mock session
const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'test-session-1',
	name: 'Test Session',
	toolType: 'claude-code' as ToolType,
	state: 'idle',
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
	],
	activeTabId: 'tab-1',
	closedTabHistory: [],
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

	const renderModal = (overrides: Partial<React.ComponentProps<typeof SendToAgentModal>> = {}) => {
		return renderWithLayerStack(
			<SendToAgentModal
				theme={testTheme}
				isOpen={true}
				sourceSession={mockSession}
				sourceTabId="tab-1"
				allSessions={mockSessions}
				onClose={mockOnClose}
				onSend={mockOnSend}
				{...overrides}
			/>
		);
	};

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

		it('renders session list with target sessions', () => {
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

			expect(screen.getByRole('option', { name: /OpenCode Session/ })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /Codex Session/ })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /Busy Session/ })).toBeInTheDocument();
			expect(screen.queryByRole('option', { name: /Test Session/ })).not.toBeInTheDocument();
		});

		it('excludes the source session from the target list', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={[mockSession, ...mockSessions]}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			expect(screen.queryByRole('option', { name: /Test Session/ })).not.toBeInTheDocument();
			expect(screen.getAllByRole('option')).toHaveLength(3);
		});

		it('excludes terminal sessions from the target list', () => {
			const terminalSession = createMockTargetSession(
				'terminal-session',
				'Terminal Session',
				'terminal'
			);

			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={[...mockSessions, terminalSession]}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			expect(screen.queryByText('Terminal Session')).not.toBeInTheDocument();
			expect(screen.getAllByRole('option')).toHaveLength(3);
		});

		it('shows Idle status for available idle sessions', () => {
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

			fireEvent.click(screen.getByRole('option', { name: /OpenCode Session/ }));

			const sendButton = screen.getByRole('button', { name: /send to session/i });
			expect(sendButton).not.toBeDisabled();
		});

		it('does not offer the source session as a target', () => {
			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={[mockSession, ...mockSessions]}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			expect(screen.queryByRole('option', { name: /Test Session/ })).not.toBeInTheDocument();
		});

		it('does not offer terminal-only sessions as targets', () => {
			const terminalSession = createMockTargetSession(
				'terminal-session',
				'Terminal Session',
				'terminal'
			);

			renderWithLayerStack(
				<SendToAgentModal
					theme={testTheme}
					isOpen={true}
					sourceSession={mockSession}
					sourceTabId="tab-1"
					allSessions={[terminalSession]}
					onClose={mockOnClose}
					onSend={mockOnSend}
				/>
			);

			expect(screen.getByText('No other sessions available')).toBeInTheDocument();
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

		it('Send button is disabled when no session selected', () => {
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

			fireEvent.click(screen.getByRole('option', { name: /OpenCode Session/ }));

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

		it('does not expose a create new session option', () => {
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

			expect(
				screen.queryByRole('checkbox', { name: /create new session/i })
			).not.toBeInTheDocument();
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

			fireEvent.click(screen.getByRole('option', { name: /OpenCode Session/ }));

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

	describe('session-based behavior', () => {
		it('does not render when closed', () => {
			renderModal({ isOpen: false });

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('excludes source and terminal sessions while using fallback session names', () => {
			const sourceSession = createMockSession({
				id: 'source-session',
				name: 'Source Session',
			});
			const terminalSession = createMockTargetSession(
				'terminal-session',
				'Terminal Session',
				'terminal'
			);
			const projectNameSession = {
				...createMockTargetSession('project-session', '', 'codex'),
				name: '',
				projectRoot: '/workspace/fallback-app',
			};
			const unnamedSession = {
				...createMockTargetSession('unnamed-session', '', 'opencode'),
				name: '',
				projectRoot: '/',
			};

			renderModal({
				sourceSession,
				allSessions: [sourceSession, terminalSession, projectNameSession, unnamedSession],
			});

			expect(screen.queryByText('Source Session')).not.toBeInTheDocument();
			expect(screen.queryByText('Terminal Session')).not.toBeInTheDocument();
			expect(screen.getByText('fallback-app')).toBeInTheDocument();
			expect(screen.getByText('Unnamed Session')).toBeInTheDocument();
		});

		it('filters sessions by search query and shows the no-match state', () => {
			const sessions = [
				{
					...createMockTargetSession('docs-session', 'Docs Session', 'codex'),
					projectRoot: '/workspace/docs-app',
				},
				{
					...createMockTargetSession('api-session', 'API Session', 'opencode'),
					projectRoot: '/workspace/api',
				},
			];

			renderModal({ allSessions: sessions });

			fireEvent.change(screen.getByLabelText('Search sessions'), {
				target: { value: 'session' },
			});
			expect(screen.getAllByRole('option')).toHaveLength(2);

			fireEvent.change(screen.getByLabelText('Search sessions'), {
				target: { value: 'docs-app' },
			});

			expect(screen.getByRole('option', { name: /Docs Session/ })).toBeInTheDocument();
			expect(screen.queryByRole('option', { name: /API Session/ })).not.toBeInTheDocument();

			fireEvent.change(screen.getByLabelText('Search sessions'), {
				target: { value: 'no-match' },
			});

			expect(screen.getByText('No matching sessions found')).toBeInTheDocument();
		});

		it('shows the empty state when no target sessions are available', () => {
			renderModal({
				allSessions: [
					mockSession,
					createMockTargetSession('terminal-session', 'Terminal Session', 'terminal'),
				],
			});

			expect(screen.getByText('No other sessions available')).toBeInTheDocument();
		});

		it('shows Unknown and zero tokens when the source tab cannot be found', () => {
			renderModal({
				sourceSession: createMockSession({ aiTabs: [] }),
				sourceTabId: 'missing-tab',
			});

			expect(screen.getByText(/Source: Unknown/)).toBeInTheDocument();
			expect(screen.getByText('~0 tokens')).toBeInTheDocument();
		});

		it('falls back to the agent session prefix for unnamed source tabs', () => {
			renderModal({
				sourceSession: createMockSession({
					aiTabs: [
						{
							...mockSession.aiTabs[0],
							id: 'codex-tab',
							name: null,
							agentSessionId: 'codex-session-123',
						},
					],
				}),
				sourceTabId: 'codex-tab',
			});

			expect(screen.getByText(/Source: CODEX/)).toBeInTheDocument();
		});

		it('falls back to New Tab and ignores log entries without text', () => {
			renderModal({
				sourceSession: createMockSession({
					aiTabs: [
						{
							...mockSession.aiTabs[0],
							id: 'new-tab',
							name: null,
							agentSessionId: null,
							logs: [
								{
									id: 'empty-log',
									timestamp: Date.now(),
									source: 'ai',
									text: undefined as unknown as string,
								},
							],
						},
					],
				}),
				sourceTabId: 'new-tab',
			});

			expect(screen.getByText(/Source: New Tab/)).toBeInTheDocument();
			expect(screen.getByText('~0 tokens')).toBeInTheDocument();
		});

		it('omits numeric quick-select hints after the ninth session', () => {
			const sessions = Array.from({ length: 10 }, (_, index) =>
				createMockTargetSession(`session-${index + 1}`, `Agent ${index + 1}`, 'codex')
			);

			renderModal({ allSessions: sessions });

			expect(
				screen.getByRole('option', { name: 'Agent 9, Idle, press 9 to select' })
			).toBeInTheDocument();
			expect(screen.getByRole('option', { name: 'Agent 10, Idle' })).toBeInTheDocument();
		});

		it('sends the selected session with the default clean-context option', async () => {
			renderModal();

			fireEvent.click(screen.getByRole('option', { name: /OpenCode Session/ }));
			expect(screen.getByText('Target: OpenCode Session')).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: /Send to Session/i }));

			await waitFor(() => {
				expect(mockOnSend).toHaveBeenCalledWith('session-opencode', {
					groomContext: true,
					targetSessionId: 'session-opencode',
				});
			});
			expect(mockOnClose).toHaveBeenCalled();
		});

		it('sends without cleaning context when the option is disabled', async () => {
			renderModal();

			fireEvent.click(screen.getByRole('option', { name: /Codex Session/ }));
			fireEvent.click(screen.getByLabelText(/Clean context/));

			expect(screen.queryByText('After cleaning:')).not.toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: /Send to Session/i }));

			await waitFor(() => {
				expect(mockOnSend).toHaveBeenCalledWith('session-codex', {
					groomContext: false,
					targetSessionId: 'session-codex',
				});
			});
		});

		it('keeps the modal open and reports send failures', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockOnSend.mockRejectedValueOnce(new Error('send failed'));
			renderModal();

			fireEvent.click(screen.getByRole('option', { name: /OpenCode Session/ }));
			fireEvent.click(screen.getByRole('button', { name: /Send to Session/i }));

			await waitFor(() => {
				expect(consoleError).toHaveBeenCalledWith('Send to session failed:', expect.any(Error));
			});
			expect(mockOnClose).not.toHaveBeenCalled();
		});

		it('shows sending state while the transfer is in progress', async () => {
			let resolveSend: ((value: { success: boolean }) => void) | undefined;
			const pendingSend = vi.fn(
				() =>
					new Promise<{ success: boolean }>((resolve) => {
						resolveSend = resolve;
					})
			);
			renderModal({ onSend: pendingSend });

			fireEvent.click(screen.getByRole('option', { name: /OpenCode Session/ }));
			fireEvent.click(screen.getByRole('button', { name: /Send to Session/i }));

			expect(await screen.findByText('Sending...')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Sending/i })).toBeDisabled();

			resolveSend?.({ success: true });

			await waitFor(() => {
				expect(mockOnClose).toHaveBeenCalled();
			});
		});

		it('disables sending when the selected target disappears', () => {
			const props: React.ComponentProps<typeof SendToAgentModal> = {
				theme: testTheme,
				isOpen: true,
				sourceSession: mockSession,
				sourceTabId: 'tab-1',
				allSessions: mockSessions,
				onClose: mockOnClose,
				onSend: mockOnSend,
			};

			const { rerender } = renderWithLayerStack(<SendToAgentModal {...props} />);

			fireEvent.click(screen.getByRole('option', { name: /OpenCode Session/ }));
			expect(screen.getByText('Target: OpenCode Session')).toBeInTheDocument();

			rerender(
				<LayerStackProvider>
					<SendToAgentModal {...props} allSessions={[]} />
				</LayerStackProvider>
			);

			expect(screen.queryByText('Target: OpenCode Session')).not.toBeInTheDocument();
			expect(screen.getByRole('button', { name: /Send to Session/i })).toBeDisabled();
		});

		it('closes through the layer stack Escape handler', async () => {
			renderModal();

			fireEvent.keyDown(window, { key: 'Escape' });

			await waitFor(() => {
				expect(mockOnClose).toHaveBeenCalled();
			});
		});

		it('selects the highlighted session on first Enter and sends it on the next Enter', async () => {
			renderModal();
			const dialog = screen.getByRole('dialog');

			fireEvent.keyDown(dialog, { key: 'Enter' });

			expect(screen.getByRole('option', { name: /OpenCode Session/ })).toHaveAttribute(
				'aria-selected',
				'true'
			);
			expect(mockOnSend).not.toHaveBeenCalled();

			fireEvent.keyDown(dialog, { key: 'Enter' });

			await waitFor(() => {
				expect(mockOnSend).toHaveBeenCalledWith('session-opencode', {
					groomContext: true,
					targetSessionId: 'session-opencode',
				});
			});
		});

		it('keeps arrow navigation bounded at the last session', async () => {
			renderModal();
			const dialog = screen.getByRole('dialog');

			fireEvent.keyDown(dialog, { key: 'ArrowDown' });
			fireEvent.keyDown(dialog, { key: 'ArrowDown' });
			fireEvent.keyDown(dialog, { key: 'ArrowDown' });
			fireEvent.keyDown(dialog, { key: ' ' });

			await waitFor(() => {
				expect(screen.getByRole('option', { name: /Busy Session/ })).toHaveAttribute(
					'aria-selected',
					'true'
				);
			});
		});

		it('ignores unrelated keys and Enter when no session is highlighted', () => {
			renderModal({ allSessions: [] });
			const dialog = screen.getByRole('dialog');

			fireEvent.keyDown(dialog, { key: 'Tab' });
			fireEvent.keyDown(dialog, { key: 'Enter' });

			expect(mockOnSend).not.toHaveBeenCalled();
			expect(mockOnClose).not.toHaveBeenCalled();
			expect(screen.getByRole('button', { name: /Send to Session/i })).toBeDisabled();
		});

		it('supports arrow navigation and numeric quick selection', async () => {
			renderModal();
			const dialog = screen.getByRole('dialog');

			fireEvent.keyDown(dialog, { key: 'ArrowUp' });
			fireEvent.keyDown(dialog, { key: 'ArrowDown' });
			fireEvent.keyDown(dialog, { key: 'ArrowUp' });
			fireEvent.keyDown(dialog, { key: 'ArrowDown' });
			fireEvent.keyDown(dialog, { key: 'ArrowDown' });
			fireEvent.keyDown(dialog, { key: '9' });
			expect(mockOnSend).not.toHaveBeenCalled();

			fireEvent.keyDown(dialog, { key: ' ' });

			await waitFor(() => {
				expect(screen.getByRole('option', { name: /Busy Session/ })).toHaveAttribute(
					'aria-selected',
					'true'
				);
			});

			fireEvent.keyDown(dialog, { key: '2' });

			await waitFor(() => {
				expect(screen.getByRole('option', { name: /Codex Session/ })).toHaveAttribute(
					'aria-selected',
					'true'
				);
			});
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

			// Unsupported horizontal navigation should be ignored without errors.
			fireEvent.keyDown(dialog, { key: 'ArrowRight' });

			fireEvent.keyDown(dialog, { key: 'ArrowDown' });

			fireEvent.keyDown(dialog, { key: 'ArrowLeft' });

			fireEvent.keyDown(dialog, { key: 'ArrowUp' });

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

			fireEvent.keyDown(dialog, { key: '2' });

			await waitFor(() => {
				expect(screen.getByRole('option', { name: /Codex Session/ })).toHaveAttribute(
					'aria-selected',
					'true'
				);
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

			fireEvent.keyDown(dialog, { key: '2' });

			fireEvent.keyDown(dialog, { key: 'Enter' });

			await waitFor(() => {
				expect(mockOnSend).toHaveBeenCalledWith('session-codex', {
					groomContext: true,
					targetSessionId: 'session-codex',
				});
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

			fireEvent.keyDown(dialog, { key: 'ArrowDown' });

			fireEvent.keyDown(dialog, { key: ' ' });

			await waitFor(() => {
				expect(screen.getByRole('option', { name: /Codex Session/ })).toHaveAttribute(
					'aria-selected',
					'true'
				);
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

	describe('busy session status', () => {
		it('shows Busy status for busy sessions', () => {
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

		it('has semantic elements for sessions and action buttons', () => {
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
