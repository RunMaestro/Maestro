/**
 * @fileoverview Tests for GroupChatModal component (create and edit modes)
 *
 * Regression test for: MAESTRO_SESSION_RESUMED env var display in group chat moderator customization
 * This test ensures that when users customize the moderator agent in group chat modals,
 * they see the built-in MAESTRO_SESSION_RESUMED environment variable (on the Environment tab).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GroupChatModal } from '../../../renderer/components/GroupChatModal';
import { __resetRememberedModalTabsForTests } from '../../../renderer/components/ui/ModalTabStrip';
import type { GroupChat, AgentConfig } from '../../../renderer/types';

import { createMockTheme } from '../../helpers/mockTheme';

// Mock lucide-react icons
vi.mock('lucide-react', async (importOriginal) => ({
	...(await importOriginal()),
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
	AlertTriangle: ({ className }: { className?: string }) => (
		<span data-testid="alert-triangle-icon" className={className}>
			⚠️
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

/** Show one tab of the form. Only the active tab's fields are rendered. */
const openTab = (name: string) =>
	fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }));

const selectedTab = () => screen.getByRole('tab', { selected: true });

// =============================================================================
// TESTS
// =============================================================================

describe('GroupChatModal', () => {
	/**
	 * Setup fresh mocks before each test.
	 * Uses mockResolvedValue for agent IPC methods (detect, getConfig, setConfig, getModels).
	 * Called in beforeEach; individual tests only need to call this again if they
	 * need different agents than the default single claude-code agent.
	 */
	function setupDefaultMocks(agents?: AgentConfig[]) {
		const defaultAgents = agents ?? [createMockAgent({ id: 'claude-code', name: 'Claude Code' })];
		vi.mocked(window.maestro.agents.detect).mockResolvedValue(defaultAgents);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(undefined);
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue([]);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mockRegisterLayer.mockClear().mockReturnValue('layer-group-chat-123');
		mockUnregisterLayer.mockClear();
		mockUpdateLayerHandler.mockClear();
		setupDefaultMocks();
		// The moderator form remembers its last tab; start every case on General.
		__resetRememberedModalTabsForTests();
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
			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// Verify Claude Code is selected in dropdown
			const dropdown = screen.getByRole('combobox', { name: /select moderator/i });
			expect(dropdown).toHaveValue('claude-code');

			// The moderator's env vars, built-ins included, live on the Environment tab
			openTab('Environment');

			// Verify MAESTRO_SESSION_RESUMED is displayed
			await waitFor(() => {
				expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
			});

			// Also verify the value hint is shown
			expect(screen.getByText('1 (when resuming)')).toBeInTheDocument();
		});

		it('should show all available agents in dropdown', async () => {
			// Setup multiple agents
			setupDefaultMocks([
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
			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// Verify all agents appear as options
			expect(screen.getByRole('option', { name: /Claude Code/i })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /OpenCode.*Beta/i })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /Factory Droid.*Beta/i })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /^Codex$/i })).toBeInTheDocument();
		});

		it('should list moderator options alphabetically', async () => {
			// Detection order is arbitrary; the dropdown is not. It matches the
			// New Agent modal and the wizard tile strip so the user reads one
			// predictable list everywhere.
			setupDefaultMocks([
				createMockAgent({ id: 'opencode', name: 'OpenCode' }),
				createMockAgent({ id: 'codex', name: 'Codex' }),
				createMockAgent({ id: 'antigravity', name: 'Antigravity CLI' }),
				createMockAgent({ id: 'claude-code', name: 'Claude Code' }),
			]);

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={vi.fn()}
					onCreate={vi.fn()}
				/>
			);

			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			const values = screen
				.getAllByRole('option')
				.map((option) => (option as HTMLOptionElement).value);
			expect(values).toEqual(['antigravity', 'claude-code', 'codex', 'opencode']);
		});

		it('should default to the preferred provider rather than the first listed', async () => {
			// Antigravity CLI heads the alphabetical dropdown, but Codex outranks
			// it in AGENT_AUTOSELECT_ORDER. Defaulting to whatever sorts first is
			// what this guards against.
			setupDefaultMocks([
				createMockAgent({ id: 'antigravity', name: 'Antigravity CLI' }),
				createMockAgent({ id: 'opencode', name: 'OpenCode' }),
				createMockAgent({ id: 'codex', name: 'Codex' }),
			]);

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={vi.fn()}
					onCreate={vi.fn()}
				/>
			);

			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toHaveValue('codex');
				},
				{ timeout: 3000 }
			);
		});

		it('should fall back to the first listed provider when none is preferred', async () => {
			// Neither is in AGENT_AUTOSELECT_ORDER, so the alphabetical order
			// decides and the user still gets an installed, usable moderator.
			setupDefaultMocks([
				createMockAgent({ id: 'qwen3-coder', name: 'Qwen3 Coder' }),
				createMockAgent({ id: 'grok', name: 'Grok CLI' }),
			]);

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={vi.fn()}
					onCreate={vi.fn()}
				/>
			);

			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toHaveValue('grok');
				},
				{ timeout: 3000 }
			);
		});

		it('should not label Group Chat itself as Beta', async () => {
			// Group Chat graduated out of Beta. The per-provider "(Beta)" suffix in
			// the moderator dropdown is a different thing and stays; what must not
			// come back is a feature-level badge on the modal header.
			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={vi.fn()}
					onCreate={vi.fn()}
				/>
			);

			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			expect(screen.queryByText(/^Beta$/)).not.toBeInTheDocument();
		});

		it('should keep the standard header title and close control in create mode', async () => {
			// The create header used to be a bespoke `customHeader` carrying the
			// Beta badge. Dropping it hands the header back to <Modal>, which owns
			// the title and the graphical exit - both must survive the swap.
			const onClose = vi.fn();

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={onClose}
					onCreate={vi.fn()}
				/>
			);

			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			expect(screen.getByRole('heading', { name: 'New Group Chat' })).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: /close modal/i }));
			expect(onClose).toHaveBeenCalled();
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
			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// Verify Claude Code is pre-selected
			const dropdown = screen.getByRole('combobox', { name: /select moderator/i });
			expect(dropdown).toHaveValue('claude-code');

			// The moderator's env vars, built-ins included, live on the Environment tab
			openTab('Environment');

			// Verify MAESTRO_SESSION_RESUMED is displayed
			await waitFor(() => {
				expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
			});

			// Also verify the value hint is shown
			expect(screen.getByText('1 (when resuming)')).toBeInTheDocument();
		});

		it('should show warning when changing moderator agent', async () => {
			// Setup multiple agents
			setupDefaultMocks([
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
			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// Change to different agent
			const dropdown = screen.getByRole('combobox', { name: /select moderator/i });
			fireEvent.change(dropdown, { target: { value: 'codex' } });

			// Verify warning message appears
			await waitFor(() => {
				expect(screen.getByText(/changing the moderator agent/i)).toBeInTheDocument();
			});
		});
	});

	describe('agent availability', () => {
		function availabilityToggle() {
			return screen.getByRole('switch', { name: /only work with agents that are free/i });
		}

		it('creates with the idle requirement on and no warning showing', async () => {
			const onCreate = vi.fn();

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={vi.fn()}
					onCreate={onCreate}
				/>
			);

			await waitFor(
				() => {
					expect(availabilityToggle()).toHaveAttribute('aria-checked', 'true');
				},
				{ timeout: 3000 }
			);
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();

			fireEvent.change(screen.getByPlaceholderText(/Auth Feature Implementation/i), {
				target: { value: 'Busy Guard Chat' },
			});
			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			expect(onCreate).toHaveBeenCalledWith('Busy Guard Chat', 'claude-code', undefined, true);
		});

		it('warns when the user turns the idle requirement off, and saves the opt-out', async () => {
			const onCreate = vi.fn();

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={vi.fn()}
					onCreate={onCreate}
				/>
			);

			await waitFor(
				() => {
					expect(availabilityToggle()).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			fireEvent.click(availabilityToggle());

			expect(availabilityToggle()).toHaveAttribute('aria-checked', 'false');
			expect(screen.getByRole('alert')).toHaveTextContent(/agents will be interrupted/i);

			fireEvent.change(screen.getByPlaceholderText(/Auth Feature Implementation/i), {
				target: { value: 'Override Chat' },
			});
			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			expect(onCreate).toHaveBeenCalledWith('Override Chat', 'claude-code', undefined, false);
		});

		it('reflects a chat that opted out, and counts a change back as an edit', async () => {
			const onSave = vi.fn();
			const groupChat = createMockGroupChat({ requireIdleParticipants: false });

			render(
				<GroupChatModal
					mode="edit"
					theme={createMockTheme()}
					isOpen={true}
					groupChat={groupChat}
					onClose={vi.fn()}
					onSave={onSave}
				/>
			);

			await waitFor(
				() => {
					expect(availabilityToggle()).toHaveAttribute('aria-checked', 'false');
				},
				{ timeout: 3000 }
			);

			// Save is disabled until something changes; flipping the toggle IS a change.
			expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
			fireEvent.click(availabilityToggle());
			fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

			expect(onSave).toHaveBeenCalledWith(
				'group-chat-1',
				'Test Group Chat',
				'claude-code',
				undefined,
				true
			);
		});

		it('treats a chat saved before this setting existed as requiring idle agents', async () => {
			const groupChat = createMockGroupChat();
			delete (groupChat as { requireIdleParticipants?: boolean }).requireIdleParticipants;

			render(
				<GroupChatModal
					mode="edit"
					theme={createMockTheme()}
					isOpen={true}
					groupChat={groupChat}
					onClose={vi.fn()}
					onSave={vi.fn()}
				/>
			);

			await waitFor(
				() => {
					expect(availabilityToggle()).toHaveAttribute('aria-checked', 'true');
				},
				{ timeout: 3000 }
			);
		});
	});

	describe('tabbed form', () => {
		function renderCreate(onCreate = vi.fn()) {
			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={vi.fn()}
					onCreate={onCreate}
				/>
			);
			return onCreate;
		}

		function renderEdit(groupChat = createMockGroupChat(), onSave = vi.fn()) {
			const view = render(
				<GroupChatModal
					mode="edit"
					theme={createMockTheme()}
					isOpen={true}
					groupChat={groupChat}
					onClose={vi.fn()}
					onSave={onSave}
				/>
			);
			return { onSave, view };
		}

		async function waitForModerator() {
			await waitFor(
				() =>
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toHaveValue(
						'claude-code'
					),
				{ timeout: 3000 }
			);
		}

		it('renders the four moderator tabs in order, opens on General, and is a resizable frame', async () => {
			renderCreate();
			await waitForModerator();

			expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
				'General',
				'Provider',
				'Environment',
				'SSH',
			]);
			expect(selectedTab()).toHaveTextContent('General');
			expect(
				document.querySelector('[data-modal-resize-key="group-chat-settings"]')
			).not.toBeNull();
		});

		it('renders only the active panel and has no Customize expander', async () => {
			renderCreate();
			await waitForModerator();

			expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
			expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'group-chat-tabpanel-general');
			expect(screen.queryByRole('button', { name: /customize/i })).not.toBeInTheDocument();

			openTab('SSH');
			expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
			expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'group-chat-tabpanel-ssh');
		});

		it('loads the provider config when the Provider tab opens, without its env vars', async () => {
			renderCreate();
			await waitForModerator();
			expect(window.maestro.agents.getConfig).not.toHaveBeenCalled();

			openTab('Provider');

			await waitFor(() => expect(screen.getByText('Claude Code Settings')).toBeInTheDocument());
			expect(window.maestro.agents.getConfig).toHaveBeenCalledWith('claude-code');
			expect(screen.queryByText('MAESTRO_SESSION_RESUMED')).not.toBeInTheDocument();
		});

		it('reopens an edit on the last tab used', async () => {
			const { view } = renderEdit();
			await waitForModerator();
			openTab('SSH');
			view.unmount();

			renderEdit();
			expect(selectedTab()).toHaveTextContent('SSH');
		});

		it('cycles the tabs with Cmd+Shift+] and Cmd+Shift+[', async () => {
			renderCreate();
			await waitForModerator();

			fireEvent.keyDown(window, { key: ']', metaKey: true, shiftKey: true });
			expect(selectedTab()).toHaveTextContent('Provider');
			fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
			fireEvent.keyDown(window, { key: '[', metaKey: true, shiftKey: true });
			expect(selectedTab()).toHaveTextContent('SSH');
		});

		it('sends Cmd+Enter with an empty name from SSH to General, with the error and its dot', async () => {
			const onCreate = renderCreate();
			await waitForModerator();
			expect(screen.queryByTestId('group-chat-tab-general-error')).not.toBeInTheDocument();
			openTab('SSH');

			fireEvent.keyDown(window, { key: 'Enter', metaKey: true });

			expect(onCreate).not.toHaveBeenCalled();
			expect(selectedTab()).toHaveTextContent('General');
			expect(screen.getByText('Enter a name for the group chat')).toBeInTheDocument();
			expect(screen.getByTestId('group-chat-tab-general-error')).toBeInTheDocument();

			fireEvent.change(screen.getByPlaceholderText(/Auth Feature Implementation/i), {
				target: { value: 'Named' },
			});
			expect(screen.queryByTestId('group-chat-tab-general-error')).not.toBeInTheDocument();
		});

		it('creates once on Cmd+Enter from the name field', async () => {
			const onCreate = renderCreate();
			await waitForModerator();
			const name = screen.getByPlaceholderText(/Auth Feature Implementation/i);
			fireEvent.change(name, { target: { value: 'Keyboard Chat' } });

			fireEvent.keyDown(name, { key: 'Enter', metaKey: true });

			expect(onCreate).toHaveBeenCalledTimes(1);
			expect(onCreate).toHaveBeenCalledWith('Keyboard Chat', 'claude-code', undefined, true);
		});

		it('does nothing on Cmd+Enter in an edit with no changes', async () => {
			const { onSave } = renderEdit();
			await waitForModerator();
			openTab('SSH');

			fireEvent.keyDown(window, { key: 'Enter', metaKey: true });

			expect(onSave).not.toHaveBeenCalled();
			expect(selectedTab()).toHaveTextContent('SSH');
		});

		it('saves an Environment edit, parked rows kept apart', async () => {
			const { onSave } = renderEdit(
				createMockGroupChat({
					moderatorConfig: {
						customEnvVars: { API_KEY: 'old' },
						customEnvVarsDisabled: { PARKED: 'kept' },
					},
				})
			);
			await waitForModerator();
			openTab('Environment');

			fireEvent.change(screen.getByDisplayValue('old'), { target: { value: 'new' } });
			openTab('General');
			fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

			expect(onSave).toHaveBeenCalledWith(
				'group-chat-1',
				'Test Group Chat',
				'claude-code',
				expect.objectContaining({
					customEnvVars: { API_KEY: 'new' },
					customEnvVarsDisabled: { PARKED: 'kept' },
				}),
				true
			);
		});

		it('carries the SSH remote chosen on the SSH tab into the moderator config', async () => {
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [
					{
						id: 'remote-1',
						name: 'Build Box',
						host: 'build.example.com',
						port: 22,
						username: 'dev',
						privateKeyPath: '',
						enabled: true,
					},
				],
			} as Awaited<ReturnType<typeof window.maestro.sshRemote.getConfigs>>);
			const onCreate = renderCreate();
			await waitForModerator();

			openTab('SSH');
			const remote = await screen.findByRole('option', { name: /Build Box/ });
			fireEvent.change(remote.closest('select') as HTMLSelectElement, {
				target: { value: 'remote-1' },
			});
			openTab('General');
			fireEvent.change(screen.getByPlaceholderText(/Auth Feature Implementation/i), {
				target: { value: 'Remote Chat' },
			});
			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			expect(onCreate).toHaveBeenCalledWith(
				'Remote Chat',
				'claude-code',
				expect.objectContaining({
					sshRemoteConfig: expect.objectContaining({ enabled: true, remoteId: 'remote-1' }),
				}),
				true
			);
		});
	});
});
