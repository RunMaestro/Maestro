/**
 * @fileoverview Tests for GroupChatModal component (create and edit modes)
 *
 * Regression test for: MAESTRO_SESSION_RESUMED env var display in group chat moderator customization
 * This test ensures that when users customize the moderator agent in group chat modals,
 * they see the built-in MAESTRO_SESSION_RESUMED environment variable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { GroupChatModal } from '../../../renderer/components/GroupChatModal';
import type { GroupChat, AgentConfig, ModeratorConfig } from '../../../renderer/types';

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

	describe('Grok moderator discovery and serialization', () => {
		beforeEach(() => {
			vi.useFakeTimers();
			const agents = [
				createMockAgent({
					id: 'grok',
					name: 'Grok CLI',
					binaryName: 'grok',
					capabilities: { supportsModelSelection: true } as AgentConfig['capabilities'],
					configOptions: [
						{ key: 'model', type: 'text', description: '', label: 'Model', default: 'model-id' },
						{
							key: 'reasoningEffort',
							type: 'text',
							description: '',
							label: 'Effort',
							default: 'effort-id',
						},
					],
				}),
				createMockAgent({ id: 'codex', name: 'Codex' }),
			];
			setupDefaultMocks(agents);
			vi.mocked(window.maestro.agents.detect).mockImplementation(async () => [...agents]);
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue({
				status: 'unavailable',
				options: [],
			} as never);
			vi.mocked(window.maestro.agents.getConfigOptions).mockResolvedValue({
				status: 'unavailable',
				options: [],
			} as never);
		});

		afterEach(() => {
			vi.clearAllTimers();
			vi.useRealTimers();
			vi.mocked(window.maestro.agents.getConfigOptions).mockReset();
			vi.restoreAllMocks();
		});

		async function openGrokEditor(config: ModeratorConfig = {}, expand = true) {
			const onSave = vi.fn();
			const groupChat = createMockGroupChat({
				moderatorAgentId: 'grok',
				moderatorConfig: { customModel: 'saved-model', ...config },
			});
			const ui = (chat = groupChat, isOpen = true) => (
				<GroupChatModal
					mode="edit"
					theme={createMockTheme()}
					isOpen={isOpen}
					groupChat={chat}
					onClose={vi.fn()}
					onSave={onSave}
				/>
			);
			const view = render(ui());
			await act(async () => {});
			if (expand) {
				fireEvent.click(screen.getByRole('button', { name: /customize/i }));
				await act(async () => {});
				await act(async () => {
					await vi.advanceTimersByTimeAsync(300);
				});
			}
			return { onSave, groupChat, ui, ...view };
		}

		it.each([undefined, {}, { GROK_HOME: '   ' }])(
			'preserves raw environment %j and the saved model across rename-only save and reopen',
			async (customEnvVars) => {
				vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
					customEnvVars: { GROK_HOME: '/provider/account' },
				});
				const { onSave, groupChat, ui, rerender } = await openGrokEditor({ customEnvVars }, false);
				fireEvent.change(screen.getByPlaceholderText(/Auth Feature Implementation/i), {
					target: { value: 'Renamed chat' },
				});
				fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
				const saved = onSave.mock.calls[0][3];
				expect(saved).toMatchObject({ customModel: 'saved-model' });
				expect(saved.customEnvVars).toEqual(customEnvVars);
				rerender(ui(groupChat, false));
				rerender(ui({ ...groupChat, moderatorConfig: saved }));
				await act(async () => {});
				fireEvent.click(screen.getByRole('button', { name: /customize/i }));
				await act(async () => {});
				await act(async () => {
					await vi.advanceTimersByTimeAsync(300);
				});
				expect(
					screen.getByText(/unavailable until the moderator workspace is known/i)
				).toBeInTheDocument();
				expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith(
					expect.objectContaining({
						providerId: 'grok',
						context: expect.objectContaining({ cwd: undefined }),
					})
				);
				fireEvent.change(screen.getByPlaceholderText('--flag value --another-flag'), {
					target: { value: '--synthetic' },
				});
				fireEvent.blur(screen.getByPlaceholderText('--flag value --another-flag'));
				fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
				expect(onSave.mock.calls[1][3]).toMatchObject({
					customModel: 'saved-model',
					customArgs: '--synthetic',
				});
				expect(onSave.mock.calls[1][3].customEnvVars).toEqual(customEnvVars);
			}
		);

		it.each(['remove', 'rename', 'blank', 'disable'] as const)(
			'keeps %s account edits identical in SSH discovery and the saved launch configuration',
			async (edit) => {
				const sshRemoteConfig = {
					enabled: true,
					remoteId: 'remote-a',
					workingDirOverride: '/remote/project',
				};
				const { onSave } = await openGrokEditor({
					customPath: '/remote/bin/grok',
					customEnvVars: { GROK_HOME: '/accounts/a' },
					sshRemoteConfig,
				});
				if (edit === 'remove') fireEvent.click(screen.getByTitle('Remove variable'));
				if (edit === 'rename') {
					const key = screen.getByDisplayValue('GROK_HOME');
					fireEvent.change(key, { target: { value: 'GROK_AUTH_PATH' } });
					fireEvent.blur(key);
				}
				if (edit === 'blank')
					fireEvent.change(screen.getByDisplayValue('/accounts/a'), { target: { value: '   ' } });
				if (edit === 'disable') fireEvent.click(screen.getByTitle(/^Disable GROK_HOME/));
				fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
				const expected =
					edit === 'rename'
						? { GROK_AUTH_PATH: '/accounts/a' }
						: edit === 'blank'
							? { GROK_HOME: '   ' }
							: {};
				const saved = onSave.mock.calls[0][3];
				expect(saved.customEnvVars).toEqual(expected);
				expect(saved.customEnvVarsDisabled).toEqual(
					edit === 'disable' ? { GROK_HOME: '/accounts/a' } : undefined
				);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(300);
				});
				const request = expect.objectContaining({
					providerId: 'grok',
					context: expect.objectContaining({
						kind: 'draft',
						cwd: '/remote/project',
						customPath: saved.customPath,
						customEnvVars: expected,
						sessionSshRemoteConfig: sshRemoteConfig,
					}),
				});
				expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith(request);
				expect(window.maestro.agents.getConfigOptions).toHaveBeenLastCalledWith(
					request,
					'reasoningEffort'
				);
			}
		);

		it('keeps typed model and effort through deferred provider settings and redetection', async () => {
			let finishConfig!: (value: Record<string, unknown>) => void;
			vi.mocked(window.maestro.agents.getConfig).mockReturnValue(
				new Promise((resolve) => {
					finishConfig = resolve;
				})
			);
			const { onSave } = await openGrokEditor();
			const model = screen.getByPlaceholderText('model-id');
			const effort = screen.getByPlaceholderText('effort-id');
			fireEvent.change(model, { target: { value: 'manual-model' } });
			fireEvent.change(effort, { target: { value: 'manual-effort' } });
			await act(async () => {
				finishConfig({ model: 'provider-model', reasoningEffort: 'provider-effort' });
			});
			vi.mocked(window.maestro.agents.getConfig).mockClear();
			fireEvent.click(screen.getByTitle('Re-detect agent path'));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(300);
			});
			expect(window.maestro.agents.getConfig).toHaveBeenCalledWith('grok');
			expect(model).toHaveValue('manual-model');
			expect(effort).toHaveValue('manual-effort');
			fireEvent.blur(effort);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(150);
			});
			expect(window.maestro.agents.setConfig).toHaveBeenLastCalledWith(
				'grok',
				expect.objectContaining({
					model: 'manual-model',
					reasoningEffort: 'manual-effort',
				})
			);
			fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
			expect(onSave.mock.calls[0][3].customModel).toBe('manual-model');
		});

		it.each(['path', 'account', 'ssh', 'unresolved-ssh', 'provider', 'reopen'] as const)(
			'discards late catalog results after a %s change',
			async (change) => {
				let finishModels!: (value: { status: 'discovered'; options: string[] }) => void;
				vi.mocked(window.maestro.agents.getModels).mockReturnValue(
					new Promise<{ status: 'discovered'; options: string[] }>((resolve) => {
						finishModels = resolve;
					}) as never
				);
				const { groupChat, ui, rerender } = await openGrokEditor({
					customEnvVars: { GROK_HOME: '/accounts/a' },
					sshRemoteConfig: {
						enabled: true,
						remoteId: 'remote-a',
						workingDirOverride: '/remote/project',
					},
				});
				expect(window.maestro.agents.getModels).toHaveBeenCalled();
				vi.mocked(window.maestro.agents.getModels).mockResolvedValue({
					status: 'unavailable',
					options: [],
				} as never);
				if (change === 'path')
					fireEvent.change(screen.getByPlaceholderText('grok'), {
						target: { value: '/remote/bin/other-grok' },
					});
				if (change === 'account')
					fireEvent.change(screen.getByDisplayValue('/accounts/a'), {
						target: { value: '/accounts/b' },
					});
				if (change === 'ssh' || change === 'unresolved-ssh')
					rerender(
						ui({
							...groupChat,
							moderatorConfig: {
								...groupChat.moderatorConfig,
								sshRemoteConfig: {
									enabled: true,
									remoteId: change === 'ssh' ? 'remote-b' : '',
									workingDirOverride: '/other/project',
								},
							},
						})
					);
				if (change === 'provider')
					fireEvent.change(screen.getByRole('combobox', { name: /select moderator/i }), {
						target: { value: 'codex' },
					});
				if (change === 'reopen') {
					rerender(ui(groupChat, false));
					rerender(ui());
					await act(async () => {});
					fireEvent.click(screen.getByRole('button', { name: /customize/i }));
				}
				await act(async () => {});
				await act(async () => {
					await vi.advanceTimersByTimeAsync(300);
				});
				await act(async () => {
					finishModels({ status: 'discovered', options: ['stale-account-model'] });
				});
				expect(screen.queryByText(/1 model available/i)).not.toBeInTheDocument();
				if (change !== 'provider')
					expect(screen.getByPlaceholderText('model-id')).toHaveValue('saved-model');
				if (change === 'ssh' || change === 'unresolved-ssh')
					expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith(
						expect.objectContaining({
							context: expect.objectContaining({
								cwd: '/other/project',
								sessionSshRemoteConfig: expect.objectContaining({
									remoteId: change === 'ssh' ? 'remote-b' : '',
								}),
							}),
						})
					);
			}
		);
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

	describe('moderator capability', () => {
		// Literal text, so the case also compiles against a revision that has no
		// shared refusal helper.
		const REASON = 'Agent does not support group chat moderation.';

		function grokAgent() {
			return createMockAgent({
				id: 'grok',
				name: 'Grok CLI',
				capabilities: { supportsModelSelection: false, supportsGroupChatModeration: false },
			} as Partial<AgentConfig>);
		}

		async function renderCreate(onCreate = vi.fn()) {
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
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);
			return onCreate;
		}

		it('lists a detected Grok agent but does not let it be selected, and says why', async () => {
			setupDefaultMocks([
				createMockAgent({
					id: 'claude-code',
					name: 'Claude Code',
					capabilities: { supportsModelSelection: false, supportsGroupChatModeration: true },
				} as Partial<AgentConfig>),
				grokAgent(),
			]);
			const onCreate = await renderCreate();

			const grok = screen.getByRole('option', { name: /Grok CLI/i }) as HTMLOptionElement;
			expect(grok).toBeDisabled();
			expect(grok).toHaveTextContent(/cannot moderate/i);
			expect(grok).toHaveAttribute('title', REASON);
			expect(screen.getByTestId('moderator-unavailable-reason')).toHaveTextContent(
				`Grok CLI is not available as moderator: ${REASON}`
			);

			// Picking it anyway (a disabled option can still be forced through a
			// change event) never reaches onCreate with Grok as moderator.
			const dropdown = screen.getByRole('combobox', { name: /select moderator/i });
			fireEvent.change(dropdown, { target: { value: 'grok' } });
			fireEvent.change(screen.getByPlaceholderText(/Auth Feature Implementation/i), {
				target: { value: 'Grok Chat' },
			});
			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
			for (const call of onCreate.mock.calls) expect(call[1]).not.toBe('grok');
		});

		it('never defaults to Grok, and leaves nothing to create when Grok is the only provider', async () => {
			setupDefaultMocks([grokAgent()]);
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
					expect(screen.getByTestId('moderator-unavailable-reason')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);
			expect(screen.queryByRole('option', { name: /Grok CLI/i, selected: true })).toBeNull();
			fireEvent.change(screen.getByPlaceholderText(/Auth Feature Implementation/i), {
				target: { value: 'Grok Only' },
			});
			const create = screen.getByRole('button', { name: /^create$/i });
			expect(create).toBeDisabled();
			fireEvent.click(create);
			expect(onCreate).not.toHaveBeenCalled();
		});

		it('keeps Claude Code and Codex selectable beside a Grok agent', async () => {
			setupDefaultMocks([
				createMockAgent({
					id: 'claude-code',
					name: 'Claude Code',
					capabilities: { supportsModelSelection: false, supportsGroupChatModeration: true },
				} as Partial<AgentConfig>),
				createMockAgent({
					id: 'codex',
					name: 'Codex',
					capabilities: { supportsModelSelection: false, supportsGroupChatModeration: true },
				} as Partial<AgentConfig>),
				grokAgent(),
			]);
			const onCreate = await renderCreate();

			const dropdown = screen.getByRole('combobox', { name: /select moderator/i });
			// The default moderator is a provider that can moderate.
			expect(['claude-code', 'codex']).toContain((dropdown as HTMLSelectElement).value);
			expect(screen.getByRole('option', { name: /^Claude Code$/i })).not.toBeDisabled();
			expect(screen.getByRole('option', { name: /^Codex$/i })).not.toBeDisabled();
			expect(screen.getByRole('option', { name: /Grok CLI/i })).toBeDisabled();

			for (const id of ['claude-code', 'codex']) {
				fireEvent.change(dropdown, { target: { value: id } });
				expect(dropdown).toHaveValue(id);
			}
			fireEvent.change(screen.getByPlaceholderText(/Auth Feature Implementation/i), {
				target: { value: 'Codex Chat' },
			});
			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
			expect(onCreate).toHaveBeenCalledWith('Codex Chat', 'codex', undefined, true);
		});
	});
});
