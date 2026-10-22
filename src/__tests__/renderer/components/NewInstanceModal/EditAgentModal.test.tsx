import { requestProviderTranslation } from '../../../../renderer/services/providerTranslation';
vi.mock('../../../../renderer/services/providerTranslation', () => ({
	requestProviderTranslation: vi.fn(),
}));
/**
 * @fileoverview Tests for EditAgentModal component
 * Tests: rendering, form population, validation, save handling,
 * provider switching, SSH config, keyboard shortcuts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { EditAgentModal } from '../../../../renderer/components/NewInstanceModal/EditAgentModal';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { Theme, Session, AgentConfig } from '../../../../renderer/types';

// lucide-react icons are mocked globally in src/__tests__/setup.ts using a Proxy

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-edit-agent-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
		getTopLayer: () => undefined,
		closeTopLayer: vi.fn().mockResolvedValue(true),
		getLayers: () => [],
		hasOpenLayers: () => false,
		hasOpenModal: () => false,
	}),
}));

const createTheme = (): Theme =>
	({
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
			accentDim: '#5a1f8f',
			accentForeground: '#ffffff',
			border: '#333355',
			success: '#22c55e',
			warning: '#f59e0b',
			error: '#ef4444',
			info: '#3b82f6',
			bgAccentHover: '#9333ea',
		},
	}) as Theme;

const createSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-123',
		name: 'My Agent',
		toolType: 'claude-code',
		projectRoot: '/home/user/project',
		cwd: '/home/user/project',
		nudgeMessage: 'Be concise',
		status: 'ready',
		tabs: [],
		activeTabId: null,
		customPath: '/custom/claude',
		customArgs: '--verbose',
		customEnvVars: { API_KEY: 'test-key' },
		customModel: 'claude-sonnet',
		customContextWindow: 100000,
		...overrides,
	}) as Session;

describe('EditAgentModal', () => {
	let theme: Theme;
	let onClose: ReturnType<typeof vi.fn>;
	let onSave: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		// Clear the call log too, or "not called" assertions see earlier tests' plans.
		vi.mocked(requestProviderTranslation)
			.mockClear()
			.mockResolvedValue({
				success: true,
				plan: {
					id: 'plan',
					status: 'ready',
					tabs: [],
					counts: { records: 0, artifacts: 0, bytes: 0 },
					verification: 'unverified',
					limitations: [
						{
							code: 'unverified-native-resume',
							message: 'Native resume remains unverified',
							severity: 'warning',
						},
					],
				} as any,
			});
		theme = createTheme();
		onClose = vi.fn();
		onSave = vi.fn();

		mockRegisterLayer.mockClear().mockReturnValue('layer-edit-agent-123');
		mockUnregisterLayer.mockClear();
		mockUpdateLayerHandler.mockClear();

		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			{
				id: 'claude-code',
				name: 'Claude Code',
				available: true,
				path: '/usr/local/bin/claude',
				binaryName: 'claude',
				hidden: false,
			} as AgentConfig,
		]);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
			model: 'claude-sonnet',
			contextWindow: 200000,
		});
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['claude-sonnet', 'claude-opus']);
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [],
		});
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			isDirectory: true,
			isFile: false,
			size: 0,
			mtimeMs: 0,
		});
	});

	it('should render null when isOpen is false', () => {
		const { container } = render(
			<EditAgentModal
				isOpen={false}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);

		expect(container.innerHTML).toBe('');
	});

	it('should render null when session is null', () => {
		const { container } = render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={null}
				existingSessions={[]}
			/>
		);

		expect(container.innerHTML).toBe('');
	});

	it('should populate form fields from session on open', async () => {
		const session = createSession({ name: 'Test Agent', nudgeMessage: 'Be helpful' });

		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={session}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			const nameInput = screen.getByDisplayValue('Test Agent');
			expect(nameInput).toBeInTheDocument();
		});
	});

	it('should show session name in modal title', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ name: 'My Special Agent' })}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getAllByText(/Edit Agent: My Special Agent/).length).toBeGreaterThanOrEqual(1);
		});
	});

	it('should show the working directory as an editable field', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ projectRoot: '/home/user/my-project' })}
				existingSessions={[]}
			/>
		);

		const input = await screen.findByDisplayValue('/home/user/my-project');
		expect(input).not.toBeDisabled();
		expect(screen.queryByText(/Directory cannot be changed/)).not.toBeInTheDocument();
	});

	it('should pass a changed working directory to onSave', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ projectRoot: '/home/user/project' })}
				existingSessions={[]}
			/>
		);

		const input = await screen.findByDisplayValue('/home/user/project');
		fireEvent.change(input, { target: { value: '/home/user/moved-project' } });

		// Save waits for the directory to be confirmed on disk.
		await waitFor(() => {
			expect(window.maestro.fs.stat).toHaveBeenCalledWith('/home/user/moved-project', undefined);
		});
		await waitFor(() => {
			expect(screen.getByText('Save Changes').closest('button')).not.toBeDisabled();
		});
		fireEvent.click(screen.getByText('Save Changes'));

		expect(onSave).toHaveBeenCalledTimes(1);
		const args = onSave.mock.calls[0];
		// `workingDirectory` is at index 20; reset, transport and Board flags follow it.
		// Keep the established positional callback contract.
		expect(args[20]).toBe('/home/user/moved-project');
	});

	it('should refuse a local working directory that does not exist', async () => {
		vi.mocked(window.maestro.fs.stat).mockResolvedValue(null);

		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ projectRoot: '/home/user/project' })}
				existingSessions={[]}
			/>
		);

		const input = await screen.findByDisplayValue('/home/user/project');
		fireEvent.change(input, { target: { value: '/home/user/projectt' } });

		expect(await screen.findByText('Path not found or not accessible')).toBeInTheDocument();
		fireEvent.click(screen.getByText('Save Changes'));
		expect(onSave).not.toHaveBeenCalled();
	});

	it('should fill the working directory from the folder picker', async () => {
		const selectFolder = vi.fn().mockResolvedValue('/picked/folder');
		(window.maestro as any).dialog = { ...(window.maestro as any).dialog, selectFolder };

		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ projectRoot: '/home/user/project' })}
				existingSessions={[]}
			/>
		);

		await screen.findByDisplayValue('/home/user/project');
		fireEvent.click(screen.getByLabelText('Browse folders'));

		expect(await screen.findByDisplayValue('/picked/folder')).toBeInTheDocument();
		expect(selectFolder).toHaveBeenCalled();
	});

	it('should refuse a relative local working directory', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ projectRoot: '/home/user/project' })}
				existingSessions={[]}
			/>
		);

		const input = await screen.findByDisplayValue('/home/user/project');
		fireEvent.change(input, { target: { value: 'relative/project' } });

		expect(screen.getByText('Enter an absolute path')).toBeInTheDocument();
		fireEvent.click(screen.getByText('Save Changes'));
		expect(onSave).not.toHaveBeenCalled();
	});

	it('should not treat a trailing slash as a changed working directory', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ projectRoot: '/home/user/project' })}
				existingSessions={[]}
			/>
		);

		const input = await screen.findByDisplayValue('/home/user/project');
		fireEvent.change(input, { target: { value: '/home/user/project/' } });
		fireEvent.click(screen.getByText('Save Changes'));

		expect(onSave).toHaveBeenCalled();
		const args = onSave.mock.calls[0];
		// `workingDirectory` is at index 20; reset, transport and Board flags follow it.
		// Keep the established positional callback contract.
		expect(args[20]).toBeUndefined(); // workingDirectory unchanged
	});

	it('should refuse a new SSH working directory the remote reports is not a directory', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [
				{
					id: 'remote-1',
					name: 'Dev Server',
					host: 'dev.example.com',
					port: 22,
					username: 'devuser',
					privateKeyPath: '/path/to/key',
					enabled: true,
				},
			],
		});
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			isDirectory: false,
			isFile: true,
			size: 0,
			mtimeMs: 0,
		});

		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({
					projectRoot: '/home/devuser/my-project',
					cwd: '/home/devuser/my-project',
					sessionSshRemoteConfig: {
						enabled: true,
						remoteId: 'remote-1',
						workingDirOverride: '/home/devuser/my-project',
					},
				})}
				existingSessions={[]}
			/>
		);

		const input = await screen.findByDisplayValue('/home/devuser/my-project');
		fireEvent.change(input, { target: { value: '/home/devuser/notes.txt' } });

		await waitFor(() => {
			// The status line appends the remote host, so match the message as a prefix.
			expect(screen.getByText(/^Path is a file, not a directory/)).toBeInTheDocument();
		});
		fireEvent.click(screen.getByText('Save Changes'));
		expect(onSave).not.toHaveBeenCalled();
	});

	it('should lock the working directory while the agent is busy', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ projectRoot: '/home/user/project', state: 'busy' })}
				existingSessions={[]}
			/>
		);

		expect(await screen.findByDisplayValue('/home/user/project')).toBeDisabled();
		expect(
			screen.getByText('Stop the agent before changing its working directory.')
		).toBeInTheDocument();
	});

	it('should show copy session ID button with truncated ID', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ id: 'abcdefgh-1234-5678' })}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByText('abcdefgh')).toBeInTheDocument();
		});
	});

	it('should render provider dropdown with supported agents', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			const providerSelect = screen.getByRole('button', { name: 'Agent Provider' });
			expect(providerSelect).toHaveTextContent('Claude Code');
		});
	});

	it('should show provider change notice when provider is changed', async () => {
		const session = createSession({ toolType: 'claude-code' });
		const { rerender } = render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={session}
				existingSessions={[]}
			/>
		);

		const providerSelect = screen.getByRole('button', { name: 'Agent Provider' });

		// Change provider
		fireEvent.click(providerSelect);
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		rerender(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={{ ...session, providerTranslationTabInventory: [] }}
				existingSessions={[]}
			/>
		);
		expect(providerSelect).toHaveTextContent('Codex');

		// A plain switch is the default: nothing is converted.
		await waitFor(() => {
			expect(
				screen.getByText(
					/Tabs, transcripts, drafts, queue and file previews are kept\. Each tab starts a new Codex conversation; switching back to Claude Code resumes/
				)
			).toBeInTheDocument();
		});
		expect(requestProviderTranslation).not.toHaveBeenCalled();
		fireEvent.click(screen.getByLabelText('Convert memory and session history'));
		await waitFor(() => {
			expect(
				screen.getByText(/Tabs, transcripts, drafts, queue and file previews are preserved/)
			).toBeInTheDocument();
		});
		// The old copy promised the opposite. Tabs are preserved now, so the notice
		// must never tell the user their tabs will be cleared.
		expect(screen.queryByText(/clear your session list/)).not.toBeInTheDocument();
	});

	it('marks only destinations with memory and history carry from the original provider', () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);
		const hint = screen.getByText(/Some providers support the ability to transfer sessions/);
		expect(hint).toHaveTextContent(
			'Some providers support the ability to transfer sessions, memories, subagents, etc between them. They are denoted as Carry Over in the list.'
		);
		const hintBadge = within(hint).getByText('Carry Over');
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		const destination = screen.getByRole('option', { name: 'Codex Carry Over' });
		expect(within(destination).getByText('Carry Over').className).toBe(hintBadge.className);
		expect(within(destination).getByText('Carry Over').getAttribute('style')).toBe(
			hintBadge.getAttribute('style')
		);
		expect(screen.getByRole('option', { name: 'Claude Code' })).toBeInTheDocument();
		expect(screen.getByRole('option', { name: 'OpenCode' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('option', { name: 'OpenCode' }));
		// Selection is not a completed switch: compatibility still uses the original Claude source.
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		expect(screen.getByRole('option', { name: 'Codex Carry Over' })).toBeInTheDocument();
	});

	it('marks the reverse Claude destination for a Codex agent', () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ toolType: 'codex' })}
				existingSessions={[]}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		expect(screen.getByRole('option', { name: 'Claude Code Carry Over' })).toBeInTheDocument();
		expect(screen.getByRole('option', { name: 'Codex' })).toBeInTheDocument();
	});

	it('shows no carry badge when the source provider has no conversion adapter', () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ toolType: 'opencode' })}
				existingSessions={[]}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		expect(screen.queryByRole('option', { name: /Carry Over/ })).not.toBeInTheDocument();
		expect(
			screen.getByText(/Some providers support the ability to transfer sessions/)
		).toBeInTheDocument();
	});

	it('clears the reading indicator and saves plainly if preflight rejects', async () => {
		vi.mocked(requestProviderTranslation).mockRejectedValueOnce(new Error('Cannot read history'));
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		fireEvent.click(screen.getByLabelText('Convert memory and session history'));
		expect(screen.getByRole('status')).toHaveTextContent('Reading memory and session history...');
		expect(await screen.findByRole('alert')).toHaveTextContent('Cannot read history');
		expect(screen.queryByText('Reading memory and session history...')).not.toBeInTheDocument();
		// A failed conversion never blocks saving: the notice says the save is a plain switch.
		expect(
			screen.getByText(
				'The conversion cannot run, so saving switches providers without converting.'
			)
		).toBeInTheDocument();
		fireEvent.click(screen.getByText('Save Changes'));
		await waitFor(() => expect(onSave).toHaveBeenCalled());
		expect(onSave.mock.calls[0].slice(23, 27)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it('shows translation activity and locks the provider picker until save completes', async () => {
		let finishSave!: () => void;
		onSave.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishSave = resolve;
				})
		);
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);
		const picker = screen.getByRole('button', { name: 'Agent Provider' });
		fireEvent.click(picker);
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		fireEvent.click(screen.getByLabelText('Convert memory and session history'));
		await screen.findByText('Native resume remains unverified');
		fireEvent.click(screen.getByText('Save Changes'));
		expect(screen.getByRole('status')).toHaveTextContent(
			'Translating memory and session history...'
		);
		expect(picker).toBeDisabled();
		finishSave();
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(screen.queryByText('Translating memory and session history...')).not.toBeInTheDocument();
	});

	it('advances deferred activity from waiting to translation using the live operation state', async () => {
		const previousSessions = useSessionStore.getState().sessions;
		const session = createSession();
		vi.mocked(requestProviderTranslation).mockResolvedValue({
			success: true,
			plan: {
				id: 'plan',
				status: 'deferred',
				tabs: [],
				counts: { records: 0, artifacts: 0, bytes: 0 },
				limitations: [
					{ code: 'unverified-native-resume', message: 'Review conversion', severity: 'warning' },
				],
			} as any,
		});
		let finishSave!: () => void;
		onSave.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishSave = resolve;
				})
		);
		try {
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);
			fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
			fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
			fireEvent.click(screen.getByLabelText('Convert memory and session history'));
			await screen.findByText('Review conversion');
			fireEvent.click(screen.getByText('Save Changes'));
			expect(screen.getByRole('status')).toHaveTextContent(
				'Waiting for the current turn to finish...'
			);
			act(() =>
				useSessionStore.setState({
					sessions: [
						{
							...session,
							providerMigration: {
								operationId: 'plan',
								destination: 'codex',
								state: 'staging',
								verification: 'unverified',
							},
						},
					],
				})
			);
			expect(screen.getByRole('status')).toHaveTextContent(
				'Translating memory and session history...'
			);
			finishSave();
			await waitFor(() => expect(onClose).toHaveBeenCalled());
		} finally {
			act(() => useSessionStore.setState({ sessions: previousSessions }));
		}
	});

	it('shows conversion limitations as a notice and saves with them accepted', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		fireEvent.click(screen.getByLabelText('Convert memory and session history'));
		expect(await screen.findByText('Native resume remains unverified')).toBeInTheDocument();
		expect(
			screen.queryByLabelText('Accept the listed conversion limitations')
		).not.toBeInTheDocument();
		const save = screen.getByText('Save Changes').closest('button')!;
		expect(save).not.toBeDisabled();
		fireEvent.click(save);
		await waitFor(() => expect(onSave).toHaveBeenCalled());
		const args = onSave.mock.calls[0];
		// acceptTranslationLimitations, resources, plan id, convert flag
		expect(args.slice(23, 27)).toEqual([true, [], 'plan', true]);
	});

	it('switches provider without converting by default', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		expect(screen.getByLabelText('Convert memory and session history')).not.toBeChecked();
		const save = screen.getByText('Save Changes').closest('button')!;
		await waitFor(() => expect(save).not.toBeDisabled());
		fireEvent.click(save);
		await waitFor(() => expect(onSave).toHaveBeenCalled());
		expect(requestProviderTranslation).not.toHaveBeenCalled();
		const args = onSave.mock.calls[0];
		expect(args[2]).toBe('codex');
		// No conversion arguments: the save does a plain switch.
		expect(args.slice(23, 27)).toEqual([undefined, undefined, undefined, undefined]);
	});

	it('offers no conversion for a provider pair without an adapter, and still saves', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		fireEvent.click(screen.getByRole('option', { name: 'OpenCode' }));
		expect(screen.queryByLabelText('Convert memory and session history')).not.toBeInTheDocument();
		const save = screen.getByText('Save Changes').closest('button')!;
		await waitFor(() => expect(save).not.toBeDisabled());
		fireEvent.click(save);
		await waitFor(() => expect(onSave).toHaveBeenCalled());
		expect(onSave.mock.calls[0][2]).toBe('opencode');
		expect(requestProviderTranslation).not.toHaveBeenCalled();
	});

	it('saves a plain switch when an opted-in conversion is blocked', async () => {
		vi.mocked(requestProviderTranslation).mockResolvedValue({
			success: true,
			plan: {
				id: 'plan',
				status: 'blocked',
				tabs: [],
				counts: { records: 0, artifacts: 0, bytes: 0 },
				limitations: [
					{ code: 'unsupported-version', message: 'Codex is too old', severity: 'block' },
				],
			} as any,
		});
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		fireEvent.click(screen.getByLabelText('Convert memory and session history'));
		expect(await screen.findByText('Codex is too old')).toBeInTheDocument();
		const save = screen.getByText('Save Changes').closest('button')!;
		expect(save).not.toBeDisabled();
		expect(screen.getByText(/The conversion cannot run/)).toBeInTheDocument();
		fireEvent.click(save);
		await waitFor(() => expect(onSave).toHaveBeenCalled());
		const args = onSave.mock.calls[0];
		expect(args[2]).toBe('codex');
		expect(args.slice(23, 27)).toEqual([undefined, undefined, undefined, undefined]);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
	});

	it('seeds the form with what the incoming provider parked, so a switch back keeps it', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({
					providerOverrides: {
						codex: { customPath: '/opt/codex', customArgs: '--search' },
					},
				})}
				existingSessions={[]}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		const save = screen.getByText('Save Changes').closest('button')!;
		await waitFor(() => expect(save).not.toBeDisabled());
		fireEvent.click(save);
		await waitFor(() => expect(onSave).toHaveBeenCalled());
		const args = onSave.mock.calls[0];
		// Codex's parked binary and arguments, not Claude's live ones or blanks.
		expect(args[5]).toBe('/opt/codex');
		expect(args[6]).toBe('--search');
		expect(args[7]).toBeUndefined();
	});

	// Effort is per-session (like model), but the panel used to render it straight
	// from the agent-level config: an agent whose customEffort was 'max' displayed
	// the agent-level 'high' while every new tab still spawned at max.
	describe('effort (per-session)', () => {
		const agentWithEffort = {
			id: 'claude-code',
			name: 'Claude Code',
			available: true,
			path: '/usr/local/bin/claude',
			binaryName: 'claude',
			hidden: false,
			configOptions: [
				{ key: 'model', type: 'text', label: 'Model', default: '' },
				{
					key: 'effort',
					type: 'select',
					label: 'Effort',
					options: ['', 'low', 'high', 'max'],
					default: '',
				},
				{ key: 'yoloMode', type: 'checkbox', label: 'YOLO Mode', default: false },
			],
		} as unknown as AgentConfig;

		beforeEach(() => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([agentWithEffort]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				model: 'claude-sonnet',
				contextWindow: 200000,
				effort: 'high',
				yoloMode: false,
			});
			vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(true);
		});

		it("shows the agent's own effort override, not the agent-level default", async () => {
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession({ customEffort: 'max' })}
					existingSessions={[]}
				/>
			);

			// 'max' (session override), not 'high' (agent-level config)
			expect(await screen.findByDisplayValue('max')).toBeInTheDocument();

			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave).toHaveBeenCalledWith(
				expect.any(String),
				expect.any(String),
				undefined,
				expect.anything(),
				undefined,
				'/custom/claude',
				'--verbose',
				{ API_KEY: 'test-key' },
				'claude-sonnet',
				'max', // effort round-trips as a per-session override
				100000,
				expect.anything(),
				undefined,
				undefined,
				undefined,
				true,
				true,
				undefined, // additionalDirectories
				undefined, // contextWindowSource: the window was not touched, so no
				// provenance is recorded and P1 precedence stands (finding AD1)
				undefined, // customEnvVarsDisabled (nothing switched off)
				undefined, // workingDirectory unchanged
				false, // codexAutoResetOnExhaustion: off by default
				'exec', // codexTransport: Standard by default
				undefined,
				undefined,
				undefined,
				undefined,
				false // boardWorker (defaults off, checkbox untouched)
			);
		});

		it('saves an edited effort onto the session instead of the shared agent config', async () => {
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession({ customEffort: 'max' })}
					existingSessions={[]}
				/>
			);

			const effortSelect = await screen.findByDisplayValue('max');
			fireEvent.change(effortSelect, { target: { value: 'low' } });
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave.mock.calls[0][9]).toBe('low');
			// Effort belongs to the session; it must not be written into the
			// agent-level config, which only seeds newly created agents.
			expect(window.maestro.agents.setConfig).not.toHaveBeenCalled();
		});

		it('preserves the agent-level model/effort defaults when an agent-level option is edited', async () => {
			// agents:setConfig replaces the whole object, so a blur-save that rebuilt
			// the config from the panel state used to erase the agent-level defaults.
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession({ customEffort: 'max', customModel: 'claude-opus' })}
					existingSessions={[]}
				/>
			);

			const yolo = await screen.findByLabelText('Enabled');
			fireEvent.click(yolo);

			expect(window.maestro.agents.setConfig).toHaveBeenCalledWith('claude-code', {
				model: 'claude-sonnet', // agent-level default preserved, not the session's opus
				contextWindow: 200000,
				effort: 'high', // agent-level default preserved, not the session's max
				yoloMode: true,
			});
		});
	});

	it('should call onSave with correct parameters when save button is clicked', async () => {
		const session = createSession({
			id: 'test-id',
			name: 'Original Name',
			nudgeMessage: 'Be helpful',
		});

		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={session}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByDisplayValue('Original Name')).toBeInTheDocument();
		});

		// Click Save Changes
		fireEvent.click(screen.getByText('Save Changes'));

		expect(onSave).toHaveBeenCalledWith(
			'test-id',
			'Original Name',
			undefined, // toolType not changed
			'Be helpful',
			undefined, // newSessionMessage
			'/custom/claude',
			'--verbose',
			{ API_KEY: 'test-key' },
			expect.anything(), // model
			expect.anything(), // effort
			expect.anything(), // contextWindow
			expect.objectContaining({ enabled: false }), // SSH disabled
			undefined, // enableMaestroP
			undefined, // maestroPPath
			undefined, // maestroPMode
			true, // retryOnAvailabilityErrors
			true, // retryOnTokenExhaustion
			undefined, // additionalDirectories
			undefined, // contextWindowSource: the window was not touched, so no
			// provenance is recorded and P1 precedence stands (finding AD1)
			undefined, // customEnvVarsDisabled (nothing switched off)
			undefined, // workingDirectory unchanged
			false, // codexAutoResetOnExhaustion: off by default
			'exec', // codexTransport: Standard by default
			undefined,
			undefined,
			undefined,
			undefined,
			false // boardWorker (defaults off, checkbox untouched)
		);
		expect(onClose).toHaveBeenCalled();
	});

	it('should trigger save on Cmd+Enter when form is valid', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByDisplayValue('My Agent')).toBeInTheDocument();
		});

		fireEvent.keyDown(window, { key: 'Enter', metaKey: true });

		expect(onSave).toHaveBeenCalled();
	});

	it('should trigger save on Cmd+S when form is valid', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByDisplayValue('My Agent')).toBeInTheDocument();
		});

		fireEvent.keyDown(window, { key: 's', metaKey: true });

		expect(onSave).toHaveBeenCalled();
	});

	it('should not trigger save on Cmd+Enter when name is empty', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ name: '' })}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		fireEvent.keyDown(window, { key: 'Enter', metaKey: true });

		expect(onSave).not.toHaveBeenCalled();
	});

	it('should show Save Changes and Cancel buttons', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByText('Save Changes')).toBeInTheDocument();
			expect(screen.getByText('Cancel')).toBeInTheDocument();
		});
	});

	it('should call onClose when Cancel is clicked', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByText('Cancel')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByText('Cancel'));
		expect(onClose).toHaveBeenCalled();
	});

	it('should show close button with correct aria-label', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByLabelText('Close modal')).toBeInTheDocument();
		});
	});

	it('should show NudgeMessageField with session nudge message', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ nudgeMessage: 'Test nudge' })}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			const textarea = screen.getByPlaceholderText(
				'Instructions appended to every message you send...'
			);
			expect(textarea).toHaveValue('Test nudge');
		});
	});

	it('should show NewSessionMessageField with session new session message', async () => {
		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ newSessionMessage: 'Init instructions' })}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			const textarea = screen.getByPlaceholderText(
				'Instructions sent with the first message of every new session...'
			);
			expect(textarea).toHaveValue('Init instructions');
		});
	});

	it('should set workingDirOverride from projectRoot when saving SSH session without explicit override (regression: SSH terminal cwd)', async () => {
		// Regression test: when an SSH session has no explicit workingDirOverride
		// (e.g., created before the fix), saving it should populate workingDirOverride
		// from session.projectRoot so SSH terminals cd to the correct remote directory.
		const sshSession = createSession({
			projectRoot: '/home/devuser/my-project',
			cwd: '/home/devuser/my-project',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				// No workingDirOverride - this is the regression scenario
			},
		});

		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [
				{
					id: 'remote-1',
					name: 'Dev Server',
					host: 'dev.example.com',
					port: 22,
					username: 'devuser',
					privateKeyPath: '/path/to/key',
					enabled: true,
				},
			],
		});

		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={sshSession}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByDisplayValue('My Agent')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByText('Save Changes'));

		// workingDirOverride should be populated from projectRoot
		expect(onSave).toHaveBeenCalledWith(
			expect.any(String), // sessionId
			expect.any(String), // name
			undefined, // toolType not changed
			'Be concise', // nudgeMessage
			undefined, // newSessionMessage
			'/custom/claude', // customPath
			'--verbose', // customArgs
			{ API_KEY: 'test-key' }, // customEnvVars
			'claude-sonnet', // model
			'', // effort (no session override, none in agent config)
			100000, // contextWindow
			expect.objectContaining({
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/home/devuser/my-project',
			}),
			undefined, // enableMaestroP
			undefined, // maestroPPath
			undefined, // maestroPMode
			true, // retryOnAvailabilityErrors
			true, // retryOnTokenExhaustion
			undefined, // additionalDirectories
			undefined, // contextWindowSource: the window was not touched, so no
			// provenance is recorded and P1 precedence stands (finding AD1)
			undefined, // customEnvVarsDisabled (nothing switched off)
			undefined, // workingDirectory unchanged
			false, // codexAutoResetOnExhaustion: off by default
			'exec', // codexTransport: Standard by default
			undefined,
			undefined,
			undefined,
			undefined,
			false // boardWorker (defaults off, checkbox untouched)
		);
	});

	it('should preserve explicit workingDirOverride when saving SSH session (regression: SSH terminal cwd)', async () => {
		// When a session already has an explicit workingDirOverride, saving should keep it
		// (not overwrite it with projectRoot).
		const sshSession = createSession({
			projectRoot: '/home/devuser/project',
			cwd: '/home/devuser/project',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/explicit/remote/path',
			},
		});

		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [
				{
					id: 'remote-1',
					name: 'Dev Server',
					host: 'dev.example.com',
					port: 22,
					username: 'devuser',
					privateKeyPath: '/path/to/key',
					enabled: true,
				},
			],
		});

		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={sshSession}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(screen.getByDisplayValue('My Agent')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByText('Save Changes'));

		// Explicit workingDirOverride should be preserved, not replaced by projectRoot
		expect(onSave).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			undefined,
			'Be concise', // nudgeMessage
			undefined, // newSessionMessage
			'/custom/claude', // customPath
			'--verbose', // customArgs
			{ API_KEY: 'test-key' }, // customEnvVars
			'claude-sonnet', // model
			'', // effort (no session override, none in agent config)
			100000, // contextWindow
			expect.objectContaining({
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/explicit/remote/path',
			}),
			undefined, // enableMaestroP
			undefined, // maestroPPath
			undefined, // maestroPMode
			true, // retryOnAvailabilityErrors
			true, // retryOnTokenExhaustion
			undefined, // additionalDirectories
			undefined, // contextWindowSource: the window was not touched, so no
			// provenance is recorded and P1 precedence stands (finding AD1)
			undefined, // customEnvVarsDisabled (nothing switched off)
			undefined, // workingDirectory unchanged
			false, // codexAutoResetOnExhaustion: off by default
			'exec', // codexTransport: Standard by default
			undefined,
			undefined,
			undefined,
			undefined,
			false // boardWorker (defaults off, checkbox untouched)
		);
	});

	it('should preserve shareHistoryToProjectDir when toggling the SSH dropdown (regression: remote-controlled flag was silently dropped)', async () => {
		// Regression test: the SSH dropdown's onChange used to rebuild the config
		// with only enabled/remoteId/syncHistory, silently dropping
		// shareHistoryToProjectDir (the "This agent is remote-controlled" toggle).
		// Switching from a remote to Local Execution would wipe the flag on save.
		const sshSession = createSession({
			projectRoot: '/home/devuser/project',
			cwd: '/home/devuser/project',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/home/devuser/project',
				shareHistoryToProjectDir: true,
			},
		});

		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [
				{
					id: 'remote-1',
					name: 'Dev Server',
					host: 'dev.example.com',
					port: 22,
					username: 'devuser',
					privateKeyPath: '/path/to/key',
					enabled: true,
				},
			],
		});

		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={sshSession}
				existingSessions={[]}
			/>
		);

		// Wait for the SSH dropdown to render with the remote selected
		const dropdown = (await screen.findByDisplayValue(/Dev Server/)) as HTMLSelectElement;

		// Switch the dropdown to Local Execution - this is the action that used
		// to wipe shareHistoryToProjectDir.
		fireEvent.change(dropdown, { target: { value: 'local' } });

		fireEvent.click(screen.getByText('Save Changes'));

		// shareHistoryToProjectDir must survive the dropdown toggle.
		expect(onSave).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			undefined,
			'Be concise',
			undefined,
			'/custom/claude',
			'--verbose',
			{ API_KEY: 'test-key' },
			'claude-sonnet',
			'', // effort
			100000,
			expect.objectContaining({
				enabled: false,
				remoteId: null,
				shareHistoryToProjectDir: true,
			}),
			undefined, // enableMaestroP
			undefined, // maestroPPath
			undefined, // maestroPMode
			true, // retryOnAvailabilityErrors
			true, // retryOnTokenExhaustion
			undefined, // additionalDirectories
			undefined, // contextWindowSource: the window was not touched, so no
			// provenance is recorded and P1 precedence stands (finding AD1)
			undefined, // customEnvVarsDisabled (nothing switched off)
			undefined, // workingDirectory unchanged
			false, // codexAutoResetOnExhaustion: off by default
			'exec', // codexTransport: Standard by default
			undefined,
			undefined,
			undefined,
			undefined,
			false // boardWorker (defaults off, checkbox untouched)
		);
	});

	it('should render SSH remote selector when remotes exist', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [
				{
					id: 'remote-1',
					name: 'Dev Server',
					host: 'dev.example.com',
					user: 'admin',
					port: 22,
				},
			],
		});

		render(
			<EditAgentModal
				isOpen={true}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);

		// SSH selector should appear after SSH configs load
		await waitFor(() => {
			expect(screen.getByText('SSH Remote Execution')).toBeInTheDocument();
		});
	});

	// Finding AD1: provenance for `customContextWindow`.
	describe('context window provenance (finding AD1)', () => {
		const agentWithWindow = {
			id: 'claude-code',
			name: 'Claude Code',
			available: true,
			path: '/usr/local/bin/claude',
			binaryName: 'claude',
			hidden: false,
			configOptions: [
				{ key: 'model', type: 'text', label: 'Model', default: '' },
				{
					key: 'contextWindow',
					type: 'number',
					label: 'Context Window Size',
					default: 200000,
				},
			],
		} as unknown as AgentConfig;

		beforeEach(() => {
			// Seeded store entries must not leak between cases: the note reads the
			// live store, so a leftover session would silently satisfy another test.
			useSessionStore.setState({ sessions: [] } as never);
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([agentWithWindow]);
			vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
				model: 'claude-sonnet',
				contextWindow: 200000,
			});
		});

		// #1370: the stored number stays visible in this control while the gauge,
		// the Context Timeline and compaction all divide by the provider's window
		// instead. The control looks like it configures something; it does not.
		describe('override note (#1370)', () => {
			const withUsage = (
				overrides: Partial<Session>,
				usageStats?: Record<string, unknown>
			): Session =>
				createSession({
					...overrides,
					activeTabId: 'tab-1',
					aiTabs: [{ id: 'tab-1', usageStats }],
				} as Partial<Session>);

			const note = () => screen.queryByTestId('config-option-note-contextWindow');

			it('explains the override when a provider window outranks a materialized value', async () => {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={withUsage(
							{ customContextWindow: 200000 },
							{
								contextWindow: 1_000_000,
								contextWindowResolved: true,
							}
						)}
						existingSessions={[]}
					/>
				);

				await screen.findByDisplayValue('200000');
				// Names the window actually in use, so the number in the field is not
				// the only figure on screen.
				expect(note()).toHaveTextContent('1.0M');
				expect(note()).toHaveTextContent(/edit this field/i);
			});

			it('stays silent when the stored window is user-edited', async () => {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={withUsage(
							{ customContextWindow: 120000, contextWindowSource: 'user-edited' },
							{ contextWindow: 1_000_000, contextWindowResolved: true }
						)}
						existingSessions={[]}
					/>
				);

				await screen.findByDisplayValue('120000');
				// The value is winning, so there is nothing to explain.
				expect(note()).not.toBeInTheDocument();
			});

			it('stays silent when the reported window carries no authority flag', async () => {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={withUsage({ customContextWindow: 200000 }, { contextWindow: 1_000_000 })}
						existingSessions={[]}
					/>
				);

				await screen.findByDisplayValue('200000');
				// An unflagged report may be a parser-injected static fallback, so the
				// stored value is still the one in use.
				expect(note()).not.toBeInTheDocument();
			});

			it('stays silent when nothing is stored to override', async () => {
				const { customContextWindow: _drop, ...withoutWindow } = createSession() as Record<
					string,
					unknown
				>;
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={
							{
								...withoutWindow,
								activeTabId: 'tab-1',
								aiTabs: [
									{
										id: 'tab-1',
										usageStats: { contextWindow: 1_000_000, contextWindowResolved: true },
									},
								],
							} as unknown as Session
						}
						existingSessions={[]}
					/>
				);

				await screen.findByDisplayValue('200000');
				expect(note()).not.toBeInTheDocument();
			});

			it('follows the live store when usage lands while the modal is open', async () => {
				// The `session` prop is a snapshot from when the modal opened, so a
				// turn completing mid-edit would leave the note missing or naming a
				// stale winner (review of #1371). Snapshot has no usage; the store
				// entry does.
				const snapshot = withUsage({ customContextWindow: 200000 }, undefined);
				useSessionStore.setState({
					sessions: [
						withUsage(
							{ customContextWindow: 200000 },
							{
								contextWindow: 1_000_000,
								contextWindowResolved: true,
							}
						),
					],
				} as never);

				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={snapshot}
						existingSessions={[]}
					/>
				);

				await screen.findByDisplayValue('200000');
				expect(note()).toHaveTextContent('1.0M');
			});

			it('stays silent while a provider switch is pending', async () => {
				// Mid-switch the panel already shows the NEW provider's config, so a
				// note describing the OLD provider's window would caption the wrong
				// control (review of #1371).
				//
				// codex MUST be in the detect mock: without it `agent` resolves to null
				// after the switch and the whole config panel unmounts, so the note
				// would be absent for a reason that has nothing to do with the guard.
				vi.mocked(window.maestro.agents.detect).mockResolvedValue([
					agentWithWindow,
					{ ...agentWithWindow, id: 'codex', name: 'Codex' } as unknown as AgentConfig,
				]);
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={withUsage(
							{ customContextWindow: 200000 },
							{
								contextWindow: 1_000_000,
								contextWindowResolved: true,
							}
						)}
						existingSessions={[]}
					/>
				);

				// Note is present before the switch...
				await screen.findByDisplayValue('200000');
				expect(note()).toBeInTheDocument();

				// ...and gone once a different provider is selected.
				fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
				fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
				// The control itself is still on screen - the note is gone, not the panel.
				await waitFor(() => expect(note()).not.toBeInTheDocument());
				expect(screen.getByDisplayValue('200000')).toBeInTheDocument();
			});

			it('credits the model marker rather than the provider when it is what won', async () => {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={withUsage(
							{ customContextWindow: 200000, customModel: 'opus[1m]' },
							{
								contextWindow: 500000,
								contextWindowResolved: true,
							}
						)}
						existingSessions={[]}
					/>
				);

				await screen.findByDisplayValue('200000');
				expect(note()).toHaveTextContent(/selected model/i);
				expect(note()).toHaveTextContent('1.0M');
			});
		});

		// Finding AD1. This modal is HOW the agent-level default gets materialized
		// into a per-session override (finding P1): with no stored value the panel
		// seeds from `globalConfig.contextWindow`, and pressing Save writes that
		// number to the session. If that write were recorded as 'user-edited' it
		// would outrank the provider's own report and reinstate the exact bug P1
		// removed - so the seed comparison, not the presence of a value, is what
		// decides provenance.
		it('does not mark an untouched seeded context window as user-edited', async () => {
			const { customContextWindow: _drop, ...withoutWindow } = createSession() as Record<
				string,
				unknown
			>;

			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={withoutWindow as unknown as Session}
					existingSessions={[]}
				/>
			);

			// Seeded from the agent-level config because the session has none.
			expect(await screen.findByDisplayValue('200000')).toBeInTheDocument();

			fireEvent.click(screen.getByText('Save Changes'));

			const args = onSave.mock.calls[0];
			// The value still materializes onto the session, exactly as before...
			expect(args[10]).toBe(200000);
			// ...but carries no provenance, so P1's precedence still applies to it.
			expect(args[18]).toBeUndefined();
		});

		it('clears provenance when the user clears the context window', async () => {
			// Review of PR #1362 (CodeRabbit). Clearing the control makes the value
			// undefined, which differs from the numeric seed and so used to be
			// recorded as a deliberate edit. Provenance must die with the value it
			// describes, or the NEXT window set inherits precedence nobody asked for.
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession({ contextWindowSource: 'user-edited' })}
					existingSessions={[]}
				/>
			);

			const input = await screen.findByDisplayValue('100000');
			fireEvent.change(input, { target: { value: '' } });

			fireEvent.click(screen.getByText('Save Changes'));

			const args = onSave.mock.calls[0];
			expect(args[10]).toBeUndefined();
			expect(args[18]).toBeUndefined();
		});

		it('marks a context window the user actually changed as user-edited', async () => {
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession()}
					existingSessions={[]}
				/>
			);

			const input = await screen.findByDisplayValue('100000');
			fireEvent.change(input, { target: { value: '120000' } });

			fireEvent.click(screen.getByText('Save Changes'));

			const args = onSave.mock.calls[0];
			expect(args[10]).toBe(120000);
			expect(args[18]).toBe('user-edited');
		});
	});

	// The toggle is the ONLY way a user opts into unattended spending of a
	// finite, non-refundable grant, so both directions are pinned: an agent that
	// asked for it must come back with it on, and Save must carry the new value
	// out. A regression in either direction is silent - the checkbox still
	// renders, it just stops meaning anything.
	describe('Codex automatic usage resets', () => {
		const codexAgent = {
			id: 'codex',
			name: 'Codex',
			available: true,
			path: '/usr/local/bin/codex',
			binaryName: 'codex',
			hidden: false,
		} as AgentConfig;

		const codexSession = (overrides: Partial<Session> = {}) =>
			createSession({
				id: 'codex-1',
				toolType: 'codex',
				customPath: undefined,
				customModel: undefined,
				customEnvVars: undefined,
				...overrides,
			});

		function renderCodex(session: Session) {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([codexAgent]);
			return render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);
		}

		const toggle = () =>
			screen.getByLabelText(
				'Automatically redeem a reset credit when usage limits are hit'
			) as HTMLInputElement;

		it('renders the toggle off for a Codex agent that never opted in', async () => {
			renderCodex(codexSession());

			await waitFor(() => expect(toggle()).toBeInTheDocument());
			expect(toggle().checked).toBe(false);
		});

		it('reflects an agent that already opted in', async () => {
			renderCodex(codexSession({ codexAutoResetOnExhaustion: true }));

			await waitFor(() => expect(toggle().checked).toBe(true));
		});

		it('carries the opt-in out through Save', async () => {
			renderCodex(codexSession());

			await waitFor(() => expect(toggle()).toBeInTheDocument());
			fireEvent.click(toggle());
			fireEvent.click(screen.getByText('Save Changes'));

			const args = onSave.mock.calls[0];
			expect(args[21]).toBe(true);
		});

		it('carries an opt-OUT out through Save', async () => {
			// Turning it back off has to reach the session too: leaving the old
			// `true` in place would keep spending credits after the user stopped it.
			renderCodex(codexSession({ codexAutoResetOnExhaustion: true }));

			await waitFor(() => expect(toggle().checked).toBe(true));
			fireEvent.click(toggle());
			fireEvent.click(screen.getByText('Save Changes'));

			const args = onSave.mock.calls[0];
			expect(args[21]).toBe(false);
		});

		it('is absent for a provider with no reset credits', async () => {
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={createSession()}
					existingSessions={[]}
				/>
			);

			await waitFor(() => expect(screen.getByDisplayValue('My Agent')).toBeInTheDocument());
			expect(screen.queryByTestId('codex-auto-reset-option')).not.toBeInTheDocument();
		});

		// The transport rides the same Codex-only slot. Load and Save are both
		// pinned: a Save that dropped the value would silently put an opted-in
		// agent back on codex exec.
		describe('Codex transport', () => {
			const appServerButton = () => screen.getByText('codex app-server').closest('button');

			it('loads Standard for an agent that never opted in, and saves exec', async () => {
				renderCodex(codexSession());

				await waitFor(() => expect(screen.getByText('Codex Transport')).toBeInTheDocument());
				expect(appServerButton()?.className).not.toContain('ring-2');
				fireEvent.click(screen.getByText('Save Changes'));

				const args = onSave.mock.calls[0];
				expect(args[22]).toBe('exec');
			});

			it('reflects a stored app-server choice', async () => {
				renderCodex(codexSession({ codexTransport: 'app-server' }));

				await waitFor(() => expect(appServerButton()?.className).toContain('ring-2'));
			});

			it('carries a new app-server choice out through Save', async () => {
				renderCodex(codexSession());

				await waitFor(() => expect(screen.getByText('Codex Transport')).toBeInTheDocument());
				fireEvent.click(appServerButton()!);
				fireEvent.click(screen.getByText('Save Changes'));

				const args = onSave.mock.calls[0];
				expect(args[22]).toBe('app-server');
			});

			it('is absent for a non-Codex agent', async () => {
				render(
					<EditAgentModal
						isOpen={true}
						onClose={onClose}
						onSave={onSave}
						theme={theme}
						session={createSession()}
						existingSessions={[]}
					/>
				);

				await waitFor(() => expect(screen.getByDisplayValue('My Agent')).toBeInTheDocument());
				expect(screen.queryByTestId('codex-transport-option')).not.toBeInTheDocument();
			});
		});
	});

	// The export section saves its own changes into its own store. Nothing of
	// it may ride along with Save: Save writes the Session object, and that
	// object lands in a file the CLI reads.
	describe('chain of thought export section', () => {
		/** A name unlike anything else in the dialog, so a leak of the folder is found by it. */
		const LOG_FOLDER = '/audit/turn-log-7f3c91d2';
		const TOGGLE_LABEL = 'Keep an audit log for this agent';
		const UNSUPPORTED_NOTE = /This provider does not expose its reasoning\./;
		const INTERACTIVE_NOTE =
			/Reasoning may be missing while this agent runs through the interactive/;

		type Choice = { enabled: boolean; folder: string | null };
		const statusOf = (choice: Choice) => ({ ...choice, turnsToday: 0, unencrypted: false });

		/** A fake `window.maestro.cotExport` that keeps what it is told, as the store does. */
		function installCotExport(initial: Choice = { enabled: false, folder: null }) {
			let stored = initial;
			const api = {
				get: vi.fn(),
				set: vi.fn(async (_agentId: string, choice: Choice) => {
					stored = choice;
					return { ok: true, status: statusOf(stored) };
				}),
				status: vi.fn(async () => statusOf(stored)),
				validateFolder: vi.fn(async (_agentId: string, folder: string) => ({
					ok: true,
					resolved: folder,
				})),
				verify: vi.fn(async () => []),
			};
			(window.maestro as any).cotExport = api;
			return api;
		}

		const renderModal = (session: Session = createSession()) =>
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);

		/** The form, once the agent and its config have loaded: what Save reads. */
		const formReady = () =>
			waitFor(() => {
				expect(screen.getByDisplayValue('My Agent')).toBeInTheDocument();
				expect(screen.queryAllByText('Claude Code Settings').length).toBeGreaterThan(0);
			});

		/** The section, once its first status has arrived and its controls are free. */
		const sectionReady = () =>
			waitFor(() => expect(screen.getByText('Choose Folder')).not.toBeDisabled());

		let originalDialog: unknown;

		beforeEach(() => {
			originalDialog = (window.maestro as any).dialog;
		});

		afterEach(() => {
			delete (window.maestro as any).cotExport;
			(window.maestro as any).dialog = originalDialog;
		});

		it('is absent where the API is not exposed', async () => {
			renderModal();

			await formReady();
			expect(screen.queryByText('Audit Log')).not.toBeInTheDocument();
		});

		it('mounts directly after Agent Resilience, for the agent being edited', async () => {
			const api = installCotExport();
			renderModal(createSession({ id: 'agent-under-edit' }));

			const section = await screen.findByTestId('cot-export-section');
			expect(section.previousElementSibling).toHaveTextContent('Agent Resilience');
			expect(api.status).toHaveBeenCalledWith('agent-under-edit');
		});

		it('keeps every export change out of Save', async () => {
			// What Save hands over with the feature absent...
			const without = renderModal();
			await formReady();
			fireEvent.click(screen.getByText('Save Changes'));
			const baseline = onSave.mock.calls[0];
			expect(baseline).toBeDefined();
			without.unmount();
			onSave.mockClear();

			// ...is what it hands over after a folder was chosen and export turned on.
			const api = installCotExport();
			const selectFolder = vi.fn().mockResolvedValue(LOG_FOLDER);
			(window.maestro as any).dialog = { ...(window.maestro as any).dialog, selectFolder };
			renderModal();
			await formReady();
			await sectionReady();

			fireEvent.click(screen.getByText('Choose Folder'));
			await waitFor(() =>
				expect(screen.getByTestId('cot-export-folder')).toHaveTextContent(LOG_FOLDER)
			);
			fireEvent.click(screen.getByLabelText(TOGGLE_LABEL));
			await waitFor(() =>
				expect(screen.getByRole('switch', { name: TOGGLE_LABEL })).toHaveAttribute(
					'aria-checked',
					'true'
				)
			);

			// The section saved both changes itself, the moment they were made.
			expect(api.set).toHaveBeenNthCalledWith(1, 'session-123', {
				enabled: false,
				folder: LOG_FOLDER,
			});
			expect(api.set).toHaveBeenNthCalledWith(2, 'session-123', {
				enabled: true,
				folder: LOG_FOLDER,
			});
			expect(onSave).not.toHaveBeenCalled();

			fireEvent.click(screen.getByText('Save Changes'));

			const saved = onSave.mock.calls[0];
			expect(saved).toEqual(baseline);
			expect(JSON.stringify(saved)).not.toMatch(
				/cot[-_ ]?export|chain of thought|turn-log-7f3c91d2/i
			);
		});

		it('notes a provider that does not expose its reasoning', async () => {
			installCotExport();
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				{
					id: 'claude-code',
					name: 'Claude Code',
					available: true,
					path: '/usr/local/bin/claude',
					binaryName: 'claude',
					hidden: false,
					capabilities: { supportsThinkingDisplay: false },
				} as unknown as AgentConfig,
			]);
			renderModal();

			expect(await screen.findByText(UNSUPPORTED_NOTE)).toBeInTheDocument();
		});

		it('shows no reasoning note for a provider that exposes it', async () => {
			installCotExport();
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				{
					id: 'claude-code',
					name: 'Claude Code',
					available: true,
					path: '/usr/local/bin/claude',
					binaryName: 'claude',
					hidden: false,
					capabilities: { supportsThinkingDisplay: true },
				} as unknown as AgentConfig,
			]);
			renderModal();
			await sectionReady();

			expect(screen.queryByText(UNSUPPORTED_NOTE)).not.toBeInTheDocument();
		});

		it.each([
			['interactive', { enableMaestroP: true, maestroPMode: 'interactive' }],
			// Dynamic starts every turn on the TUI and leaves it only near a limit.
			['dynamic', { enableMaestroP: true, maestroPMode: 'dynamic' }],
		] as const)(
			'notes that reasoning may be missing on the %s token source',
			async (_mode, source) => {
				installCotExport();
				renderModal(createSession(source));

				expect(await screen.findByText(INTERACTIVE_NOTE)).toBeInTheDocument();
			}
		);

		it('shows no token source note for an agent on the API', async () => {
			installCotExport();
			renderModal(createSession({ enableMaestroP: false }));
			await sectionReady();

			expect(screen.queryByText(INTERACTIVE_NOTE)).not.toBeInTheDocument();
		});

		it('shows no token source note for another provider', async () => {
			installCotExport();
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				{
					id: 'codex',
					name: 'Codex',
					available: true,
					path: '/usr/local/bin/codex',
					binaryName: 'codex',
					hidden: false,
				} as AgentConfig,
			]);
			renderModal(
				createSession({ toolType: 'codex', enableMaestroP: true, maestroPMode: 'interactive' })
			);
			await sectionReady();

			expect(screen.queryByText(INTERACTIVE_NOTE)).not.toBeInTheDocument();
		});
	});
});
