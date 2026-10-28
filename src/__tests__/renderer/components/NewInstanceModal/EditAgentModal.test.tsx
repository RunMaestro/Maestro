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
import { __resetRememberedModalTabsForTests } from '../../../../renderer/components/ui/ModalTabStrip';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { LocalModelEndpoint } from '../../../../shared/local-models/endpoints';
import { RUN_ON_MIN_CONTEXT_TOKENS } from '../../../../shared/local-models/run-on';
import type { HarnessTierOptions } from '../../../../shared/local-models/tier-options';
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

/**
 * The 27th `onSave` argument of a form whose Peers tab was never touched: a
 * session with no peers saves every source of the roster as absent.
 */
const NO_PEER_GRANTS = {
	peerAgents: undefined,
	groupPeerAccess: undefined,
	worktreePeerAccess: undefined,
};

/**
 * Positions in `onSave`'s argument list that tests read by slot. Named here so
 * an argument appended later does not shift what a test thought was "last".
 */
const SAVE_ARG = {
	workingDirectory: 20,
	codexAutoResetOnExhaustion: 21,
	codexTransport: 22,
	gatewayUrl: 23,
	runOn: 24,
	tierTargets: 25,
	peerGrants: 26,
} as const;

/** Show one tab of the form. Only the active tab's fields are rendered. */
const openTab = (name: string) =>
	fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }));

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
		// The form remembers its last tab per app session; start every case on General.
		__resetRememberedModalTabsForTests();
		useModalStore.getState().closeModal('editAgent');
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
		// Anchored on the slot, not on distance from the end: arguments keep
		// being appended after it.
		expect(args[SAVE_ARG.workingDirectory]).toBe('/home/user/moved-project');
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
		// Anchored on the slot, not on distance from the end: arguments keep
		// being appended after it.
		expect(args[SAVE_ARG.workingDirectory]).toBeUndefined(); // workingDirectory unchanged
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
		openTab('Provider');

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
		openTab('Provider');

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
					/Tabs, transcripts, drafts, queue and file previews are kept\. Each tab that follows the agent starts a new Codex conversation; switching back to Claude Code resumes/
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
		openTab('Provider');
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
		openTab('Provider');
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
		openTab('Provider');
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		expect(screen.queryByRole('option', { name: /Carry Over/ })).not.toBeInTheDocument();
		expect(
			screen.getByText(/Some providers support the ability to transfer sessions/)
		).toBeInTheDocument();
	});

	it('reviews and applies only the requested pending tab without saving agent defaults', async () => {
		const session = createSession({ toolType: 'codex' });
		useModalStore.getState().openModal('editAgent', {
			session,
			initialTab: 'provider',
			translationReview: { tabId: 'pending-tab', provider: 'codex' },
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
		await waitFor(() =>
			expect(requestProviderTranslation).toHaveBeenCalledWith(
				expect.objectContaining({ action: 'plan', tabId: 'pending-tab', destination: 'codex' })
			)
		);
		fireEvent.click(await screen.findByLabelText('Allow experimental carry-over'));
		expect(screen.getByRole('button', { name: 'Agent Provider' })).toBeDisabled();
		vi.mocked(requestProviderTranslation).mockResolvedValue({ success: true });
		fireEvent.click(screen.getByRole('button', { name: /Save/ }));
		await waitFor(() =>
			expect(requestProviderTranslation).toHaveBeenLastCalledWith(
				expect.objectContaining({
					action: 'apply',
					tabId: 'pending-tab',
					destination: 'codex',
					acceptLimitations: true,
				}),
				{ waitForDeferred: true }
			)
		);
		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});
	it('summarizes sessions and messages without exposing individual conversation IDs', async () => {
		const report = await vi.mocked(requestProviderTranslation).getMockImplementation()!({} as any);
		vi.mocked(requestProviderTranslation).mockResolvedValue({
			...report,
			plan: {
				...report.plan!,
				tabs: [
					{
						tabId: 'compacted',
						sourceSessionId: 'native',
						records: 4492,
						activeRecords: 312,
						archivedRecords: 4180,
						newRecords: 0,
					},
					{ tabId: 'legacy', sourceSessionId: 'older', records: 12, newRecords: 0 },
				],
				deferredTabs: [{ id: 'closed-tab', agentSessionId: 'closed-native' }],
				counts: { records: 4504, messages: 800, artifacts: 2, bytes: 0 },
			},
		});
		render(
			<EditAgentModal
				isOpen={true}
				onClose={vi.fn()}
				onSave={vi.fn()}
				theme={theme}
				session={createSession()}
				existingSessions={[]}
			/>
		);
		openTab('Provider');
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		fireEvent.click(screen.getByLabelText('Convert memory and session history'));
		await screen.findByText('Messages');
		expect(screen.getByText('800')).toBeInTheDocument();
		expect(screen.getByText('Sessions')).toBeInTheDocument();
		expect(screen.getByText('2')).toBeInTheDocument();
		expect(screen.getByText('On next use')).toBeInTheDocument();
		expect(screen.getByText('1')).toBeInTheDocument();
		expect(screen.queryByText(/Conversation 1:/)).not.toBeInTheDocument();
		expect(screen.queryByText('closed-tab')).not.toBeInTheDocument();
		expect(screen.queryByLabelText(/Selected user resource/)).not.toBeInTheDocument();
		expect(screen.queryByText('Add resource')).not.toBeInTheDocument();
		expect(screen.queryByText('Review selection')).not.toBeInTheDocument();
	});

	it('omits conversion metadata and enables Save after experimental carry-over acceptance', async () => {
		const report = await vi.mocked(requestProviderTranslation).getMockImplementation()!({} as any);
		const warning = {
			code: 'context-capacity',
			severity: 'warning' as const,
			message: 'Large conversation; source transcript preserved.',
		};
		vi.mocked(requestProviderTranslation).mockResolvedValue({
			...report,
			plan: {
				...report.plan!,
				limitations: [
					{ ...warning, tabId: 'one' },
					{ ...warning, tabId: 'two' },
					{
						code: 'native-project-memory-unavailable',
						severity: 'warning',
						message: 'Generated Codex account memory is excluded from project migration.',
					},
					{
						code: 'untested-version',
						severity: 'warning',
						message: 'codex 0.164.0 is untested; tested versions: 0.162.1, 0.163.0.',
					},
					{
						code: 'untested-version',
						severity: 'warning',
						message: 'claude-code 2.1.310 is untested; tested versions: 2.1.296, 2.1.302.',
					},
					{
						code: 'unverified-native-resume',
						severity: 'warning',
						message: 'Native resume and round-trip continuity have not been verified.',
					},
				],
			},
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
		openTab('Provider');
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		fireEvent.click(screen.getByLabelText('Convert memory and session history'));
		const accept = await screen.findByLabelText('Allow experimental carry-over');
		expect(screen.queryByText(warning.message)).not.toBeInTheDocument();
		expect(screen.queryByText(/Generated Codex account memory/)).not.toBeInTheDocument();
		expect(screen.queryByText(/codex 0.164.0 is untested/)).not.toBeInTheDocument();
		expect(screen.queryByText(/claude-code 2.1.310 is untested/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Native resume and round-trip continuity/)).not.toBeInTheDocument();
		expect(screen.getByTestId('edit-agent-tab-body')).not.toContainElement(accept);
		expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
		fireEvent.click(accept);
		expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
		fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
		await waitFor(() => expect(onSave).toHaveBeenCalled());
		expect(onSave.mock.calls[0][27]).toBe(true);
		expect(onSave.mock.calls[0][28]).toEqual([]);
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
		openTab('Provider');
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
		expect(onSave.mock.calls[0].slice(27)).toEqual([]);
	});

	it('requires per-switch consent to install project resources and forwards it with the reviewed plan', async () => {
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
		openTab('Provider');
		const picker = screen.getByRole('button', { name: 'Agent Provider' });
		fireEvent.click(picker);
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		fireEvent.click(screen.getByLabelText('Convert memory and session history'));
		await screen.findByLabelText('Allow experimental carry-over');
		const checkbox = screen.getByLabelText(
			'Also install skills and subagents into the project (git-excluded)'
		);
		expect(checkbox).not.toBeChecked();
		expect(requestProviderTranslation).toHaveBeenLastCalledWith(
			expect.objectContaining({ action: 'plan', projectResourcesIntoRepo: false })
		);
		fireEvent.click(checkbox);
		await waitFor(() =>
			expect(requestProviderTranslation).toHaveBeenLastCalledWith(
				expect.objectContaining({ action: 'plan', projectResourcesIntoRepo: true })
			)
		);
		fireEvent.click(screen.getByLabelText('Allow experimental carry-over'));
		fireEvent.click(screen.getByText('Save Changes'));
		await waitFor(() => expect(onSave).toHaveBeenCalled());
		expect(onSave.mock.calls[0][30]).toBe(true);
		fireEvent.click(picker);
		fireEvent.click(screen.getByRole('option', { name: 'Claude Code' }));
		fireEvent.click(picker);
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		fireEvent.click(screen.getByLabelText('Convert memory and session history'));
		expect(
			screen.getByLabelText('Also install skills and subagents into the project (git-excluded)')
		).not.toBeChecked();
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
		openTab('Provider');
		const picker = screen.getByRole('button', { name: 'Agent Provider' });
		fireEvent.click(picker);
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		fireEvent.click(screen.getByLabelText('Convert memory and session history'));
		await screen.findByLabelText('Allow experimental carry-over');
		fireEvent.click(screen.getByLabelText('Allow experimental carry-over'));
		fireEvent.click(screen.getByText('Save Changes'));
		expect(screen.getByRole('status')).toHaveTextContent(
			'Translating memory and session history...'
		);
		openTab('Provider');
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
			openTab('Provider');
			fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
			fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
			fireEvent.click(screen.getByLabelText('Convert memory and session history'));
			await screen.findByLabelText('Allow experimental carry-over');
			fireEvent.click(screen.getByLabelText('Allow experimental carry-over'));
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
			openTab('Provider');
			expect(screen.getByRole('status')).toHaveTextContent(
				'Translating memory and session history...'
			);
			finishSave();
			await waitFor(() => expect(onClose).toHaveBeenCalled());
		} finally {
			act(() => useSessionStore.setState({ sessions: previousSessions }));
		}
	});

	it.each([false, true])(
		'omits informational notes and keeps acceptance beside Save while warnings=%s',
		async (withWarning) => {
			const report = await vi.mocked(requestProviderTranslation).getMockImplementation()!(
				{} as any
			);
			vi.mocked(requestProviderTranslation).mockResolvedValue({
				...report,
				plan: {
					...report.plan!,
					limitations: [
						...(withWarning ? report.plan!.limitations : []),
						{
							code: 'native-cwd-drift',
							severity: 'info',
							message: 'Original directories stay archived',
						},
					],
				},
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
			openTab('Provider');
			fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
			fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
			fireEvent.click(screen.getByLabelText('Convert memory and session history'));
			await screen.findByText('Ready to switch providers.');
			expect(screen.queryByText('Notes')).not.toBeInTheDocument();
			expect(screen.queryByText('Original directories stay archived')).not.toBeInTheDocument();
			openTab('General');
			const accept = screen.queryByLabelText('Allow experimental carry-over');
			if (withWarning) {
				expect(accept).toBeInTheDocument();
				expect(screen.getByText('Save Changes').closest('button')).toBeDisabled();
				fireEvent.click(accept!);
			} else expect(accept).not.toBeInTheDocument();
			expect(screen.getByText('Save Changes').closest('button')).not.toBeDisabled();
			fireEvent.click(screen.getByText('Save Changes'));
			await waitFor(() => expect(onSave).toHaveBeenCalled());
			expect(onSave.mock.calls[0][27]).toBe(withWarning);
		}
	);

	it('requires experimental carry-over acceptance before converting', async () => {
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
		openTab('Provider');
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		fireEvent.click(screen.getByLabelText('Convert memory and session history'));
		const accept = await screen.findByLabelText('Allow experimental carry-over');
		expect(screen.queryByText('Native resume remains unverified')).not.toBeInTheDocument();
		const save = screen.getByText('Save Changes').closest('button')!;
		expect(save).toBeDisabled();
		fireEvent.click(accept);
		expect(save).not.toBeDisabled();
		fireEvent.click(save);
		await waitFor(() => expect(onSave).toHaveBeenCalled());
		const args = onSave.mock.calls[0];
		// Acceptance, resources, plan id, project resources, conversion opt-in.
		expect(args.slice(27)).toEqual([true, [], 'plan', false, true]);
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
		openTab('Provider');
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
		expect(args.slice(27)).toEqual([]);
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
		openTab('Provider');
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
		openTab('Provider');
		fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
		fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
		fireEvent.click(screen.getByLabelText('Convert memory and session history'));
		expect(await screen.findByText('Codex is too old')).toBeInTheDocument();
		const save = screen.getByText('Save Changes').closest('button')!;
		expect(save).not.toBeDisabled();
		expect(screen.getByText(/The conversion cannot run/)).toBeInTheDocument();
		expect(screen.getAllByText('Saving switches without converting.').length).toBeGreaterThan(0);
		fireEvent.click(save);
		await waitFor(() => expect(onSave).toHaveBeenCalled());
		const args = onSave.mock.calls[0];
		expect(args[2]).toBe('codex');
		expect(args.slice(27)).toEqual([]);
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
		openTab('Provider');
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
			openTab('Provider');

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
				undefined, // gatewayUrl: no Local Models gateway set
				undefined, // runOn: the provider's own model
				undefined, // tierTargets: every tier follows its harness default
				NO_PEER_GRANTS // peerGrants: nothing granted unless set on the Peers tab
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
			openTab('Provider');

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
			openTab('Provider');

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
			undefined, // gatewayUrl: no Local Models gateway set
			undefined, // runOn: the provider's own model
			undefined, // tierTargets: every tier follows its harness default
			NO_PEER_GRANTS // peerGrants: nothing granted unless set on the Peers tab
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
			undefined, // gatewayUrl: no Local Models gateway set
			undefined, // runOn: the provider's own model
			undefined, // tierTargets: every tier follows its harness default
			NO_PEER_GRANTS // peerGrants: nothing granted unless set on the Peers tab
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
			undefined, // gatewayUrl: no Local Models gateway set
			undefined, // runOn: the provider's own model
			undefined, // tierTargets: every tier follows its harness default
			NO_PEER_GRANTS // peerGrants: nothing granted unless set on the Peers tab
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
		openTab('SSH');

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
			undefined, // gatewayUrl: no Local Models gateway set
			undefined, // runOn: the provider's own model
			undefined, // tierTargets: every tier follows its harness default
			NO_PEER_GRANTS // peerGrants: nothing granted unless set on the Peers tab
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
		openTab('SSH');

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
				openTab('Provider');

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
				openTab('Provider');

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
				openTab('Provider');

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
				openTab('Provider');

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
				openTab('Provider');

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
				openTab('Provider');

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
				openTab('Provider');

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
			openTab('Provider');

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
			openTab('Provider');

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
			openTab('Provider');

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
			const result = render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);
			openTab('Provider');
			return result;
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
			expect(args[SAVE_ARG.codexAutoResetOnExhaustion]).toBe(true);
		});

		it('carries an opt-OUT out through Save', async () => {
			// Turning it back off has to reach the session too: leaving the old
			// `true` in place would keep spending credits after the user stopped it.
			renderCodex(codexSession({ codexAutoResetOnExhaustion: true }));

			await waitFor(() => expect(toggle().checked).toBe(true));
			fireEvent.click(toggle());
			fireEvent.click(screen.getByText('Save Changes'));

			const args = onSave.mock.calls[0];
			expect(args[SAVE_ARG.codexAutoResetOnExhaustion]).toBe(false);
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

			openTab('Provider');
			await waitFor(() => expect(screen.getByText('Claude Code Settings')).toBeInTheDocument());
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
				expect(args[SAVE_ARG.codexTransport]).toBe('exec');
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
				expect(args[SAVE_ARG.codexTransport]).toBe('app-server');
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

				openTab('Provider');
				await waitFor(() => expect(screen.getByText('Claude Code Settings')).toBeInTheDocument());
				expect(screen.queryByTestId('codex-transport-option')).not.toBeInTheDocument();
			});
		});
	});

	// The Audit Log tab saves its own changes into its own store. Nothing of
	// it may ride along with Save: Save writes the Session object, and that
	// object lands in a file the CLI reads.
	describe('Audit Log tab', () => {
		/** A name unlike anything else in the dialog, so a leak of the folder is found by it. */
		const LOG_FOLDER = '/audit/turn-log-7f3c91d2';
		const TOGGLE_LABEL = 'Keep an audit log for this agent';
		const AUDIT_LOG_TAB = 'Audit Log';
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

		/** The dialog as it opens, on General. */
		const renderDialog = (session: Session = createSession()) =>
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

		/** The dialog, on the Audit Log tab. The API must be installed first. */
		const renderModal = (session: Session = createSession()) => {
			const result = renderDialog(session);
			openTab(AUDIT_LOG_TAB);
			return result;
		};

		/**
		 * The form, once the agent and its config have loaded: what Save reads.
		 * The config is on Provider and the name on General, so each is checked
		 * on its own tab before going to `endOn`.
		 */
		const formReady = async (endOn?: string) => {
			openTab('Provider');
			await waitFor(() =>
				expect(screen.queryAllByText('Claude Code Settings').length).toBeGreaterThan(0)
			);
			openTab('General');
			expect(screen.getByDisplayValue('My Agent')).toBeInTheDocument();
			if (endOn) openTab(endOn);
		};

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
			renderDialog();

			await formReady();
			expect(screen.queryByRole('tab', { name: AUDIT_LOG_TAB })).not.toBeInTheDocument();
			expect(screen.queryByText(AUDIT_LOG_TAB)).not.toBeInTheDocument();
		});

		it('is the last tab, and holds the section for the agent being edited', async () => {
			const api = installCotExport();
			renderModal(createSession({ id: 'agent-under-edit' }));

			expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
				'General',
				'Provider',
				'Models',
				'Peers',
				'SSH',
				AUDIT_LOG_TAB,
			]);
			const panel = screen.getByRole('tabpanel');
			expect(panel).toHaveAttribute('id', 'edit-agent-tabpanel-auditLog');
			expect(panel).toContainElement(await screen.findByTestId('cot-export-section'));
			expect(api.status).toHaveBeenCalledWith('agent-under-edit');
		});

		it('includes Audit Log when cycling visible tabs with Cmd brackets', () => {
			installCotExport();
			renderDialog();
			fireEvent.keyDown(screen.getByDisplayValue('My Agent'), { key: '[', metaKey: true });
			expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'edit-agent-tabpanel-auditLog');
			fireEvent.keyDown(screen.getByRole('tabpanel'), { key: ']', metaKey: true });
			expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'edit-agent-tabpanel-general');
		});

		it('leaves the Provider tab without the section', async () => {
			installCotExport();
			renderDialog();

			await formReady();
			openTab('Provider');
			expect(screen.getByText('Agent Resilience')).toBeInTheDocument();
			expect(screen.queryByTestId('cot-export-section')).not.toBeInTheDocument();
		});

		it('reopens on Audit Log when it was the last tab used', () => {
			installCotExport();
			const first = renderModal();
			first.unmount();

			renderDialog();
			expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'edit-agent-tabpanel-auditLog');
		});

		it('falls back to General when the last tab used was Audit Log and it is gone', () => {
			installCotExport();
			const first = renderModal();
			first.unmount();
			delete (window.maestro as any).cotExport;

			renderDialog();
			expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'edit-agent-tabpanel-general');
		});

		it('keeps every export change out of Save', async () => {
			// What Save hands over with the feature absent...
			const without = renderDialog();
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
			await formReady(AUDIT_LOG_TAB);
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
				/cot[-_ ]?export|chain of thought|audit ?log|turn-log-7f3c91d2/i
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

	describe('Local Models gateway', () => {
		function renderWith(session: Session) {
			const result = render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);
			openTab('Models');
			return result;
		}

		const field = () =>
			screen.getByTestId('edit-agent-gateway').querySelector('input') as HTMLInputElement;

		it("shows the agent's stored gateway and saves it unchanged", async () => {
			renderWith(createSession({ gatewayUrl: 'http://127.0.0.1:8787' }));

			await waitFor(() => expect(field().value).toBe('http://127.0.0.1:8787'));
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave.mock.calls[0][SAVE_ARG.gatewayUrl]).toBe('http://127.0.0.1:8787');
		});

		it('saves a typed gateway in its normalized form', async () => {
			renderWith(createSession());

			await waitFor(() => expect(field()).toBeInTheDocument());
			fireEvent.change(field(), { target: { value: ' http://localhost:4000/anthropic/ ' } });
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave.mock.calls[0][SAVE_ARG.gatewayUrl]).toBe('http://localhost:4000/anthropic');
		});

		it('clears the gateway when the field is emptied', async () => {
			renderWith(createSession({ gatewayUrl: 'http://127.0.0.1:8787' }));

			await waitFor(() => expect(field().value).toBe('http://127.0.0.1:8787'));
			fireEvent.change(field(), { target: { value: '' } });
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave).toHaveBeenCalledTimes(1);
			expect(onSave.mock.calls[0][SAVE_ARG.gatewayUrl]).toBeUndefined();
		});

		it('refuses to save a value that is not a URL, and says why', async () => {
			renderWith(createSession());

			await waitFor(() => expect(field()).toBeInTheDocument());
			fireEvent.change(field(), { target: { value: 'nope' } });
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
			expect(screen.getByTestId('edit-agent-gateway-url-status')).toHaveTextContent('not a URL');
		});

		it("says the gateway is not applied when the agent's own variable sets the base URL", async () => {
			renderWith(
				createSession({
					gatewayUrl: 'http://127.0.0.1:8787',
					customEnvVars: { ANTHROPIC_BASE_URL: 'https://mine.example.com' },
				})
			);

			await waitFor(() =>
				expect(screen.getByTestId('edit-agent-gateway-url-status')).toHaveTextContent(
					'Not applied: ANTHROPIC_BASE_URL'
				)
			);
		});

		it('disables the field for Copilot CLI with the reason', async () => {
			vi.mocked(window.maestro.agents.detect).mockResolvedValue([
				{
					id: 'copilot-cli',
					name: 'Copilot CLI',
					available: true,
					path: '/usr/local/bin/copilot',
					binaryName: 'copilot',
					hidden: false,
				} as AgentConfig,
			]);
			renderWith(
				createSession({
					toolType: 'copilot-cli',
					customPath: undefined,
					customModel: undefined,
					customEnvVars: undefined,
				})
			);

			await waitFor(() => expect(field()).toBeDisabled());
			expect(screen.getByTestId('edit-agent-gateway-url-status')).toHaveTextContent(
				'ignores base-URL variables'
			);
		});
	});

	describe('tabbed form', () => {
		const renderModal = (session: Session = createSession(), existingSessions: Session[] = []) =>
			render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={existingSessions}
				/>
			);

		const selectedTab = () =>
			screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true');

		it('renders the five tabs in order, opens on General, and is a resizable frame', () => {
			const { container } = renderModal();

			expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
				'General',
				'Provider',
				'Models',
				'Peers',
				'SSH',
			]);
			expect(selectedTab()).toHaveTextContent('General');
			expect(
				container.ownerDocument.querySelector('[data-modal-resize-key="edit-agent"]')
			).not.toBe(null);
		});

		it('renders only the active panel', () => {
			renderModal();

			expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
			expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'edit-agent-tabpanel-general');
			openTab('SSH');
			expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
			expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'edit-agent-tabpanel-ssh');
		});

		it('reopens on the last tab used', () => {
			const first = renderModal();
			openTab('Models');
			first.unmount();

			renderModal();
			expect(selectedTab()).toHaveTextContent('Models');
		});

		it('keeps the environment variables on the Provider tab', async () => {
			renderModal();

			openTab('Provider');
			await waitFor(() => expect(screen.getByText('Claude Code Settings')).toBeInTheDocument());
			expect(screen.getAllByDisplayValue('API_KEY')).toHaveLength(1);
			expect(screen.getByDisplayValue('API_KEY')).toBeInTheDocument();
			expect(screen.getByDisplayValue('test-key')).toBeInTheDocument();
		});

		it('keeps a Provider environment edit through a tab switch and out through Save', async () => {
			renderModal();
			openTab('Provider');

			fireEvent.change(screen.getByDisplayValue('test-key'), { target: { value: 'new-key' } });
			openTab('General');
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave.mock.calls[0][7]).toEqual({ API_KEY: 'new-key' });
		});

		it('dots the General tab and sends Cmd+Enter there from SSH when the name is taken', async () => {
			renderModal(createSession(), [createSession({ id: 'other', name: 'My Agent' })]);

			await waitFor(() =>
				expect(screen.getByTestId('edit-agent-tab-general-error')).toBeInTheDocument()
			);
			openTab('SSH');
			fireEvent.keyDown(window, { key: 'Enter', metaKey: true });

			expect(onSave).not.toHaveBeenCalled();
			expect(selectedTab()).toHaveTextContent('General');
			expect(screen.getByText('An agent named "My Agent" already exists')).toBeInTheDocument();
		});

		it('sends Cmd+Enter from SSH to General with the empty name shown as an error', async () => {
			renderModal();
			const name = await screen.findByDisplayValue('My Agent');
			fireEvent.change(name, { target: { value: '' } });
			// Clearing the name to retype it is not an error yet.
			expect(screen.queryByText('Enter a name for the agent')).not.toBeInTheDocument();
			expect(screen.queryByTestId('edit-agent-tab-general-error')).not.toBeInTheDocument();
			openTab('SSH');

			fireEvent.keyDown(window, { key: 'Enter', metaKey: true });

			expect(onSave).not.toHaveBeenCalled();
			expect(selectedTab()).toHaveTextContent('General');
			expect(screen.getByText('Enter a name for the agent')).toBeInTheDocument();
			expect(screen.getByTestId('edit-agent-tab-general-error')).toBeInTheDocument();

			fireEvent.change(document.getElementById('edit-agent-name-input') as HTMLInputElement, {
				target: { value: 'Renamed' },
			});
			expect(screen.queryByText('Enter a name for the agent')).not.toBeInTheDocument();
			expect(screen.queryByTestId('edit-agent-tab-general-error')).not.toBeInTheDocument();
		});

		// `openAgentSettings(session, { tab: 'peers' })`: the Delegation Graph's link.
		it('opens on the tab its opener asked for', async () => {
			const session = createSession();
			useModalStore.getState().openModal('editAgent', { session, initialTab: 'peers' });

			renderModal(session);
			await screen.findByRole('tab', { name: /^Peers/ });

			expect(selectedTab()).toHaveTextContent('Peers');
		});

		it('sends Cmd+Enter from Peers to General when the name is empty', async () => {
			renderModal();
			const name = await screen.findByDisplayValue('My Agent');
			fireEvent.change(name, { target: { value: '' } });
			openTab('Peers');

			fireEvent.keyDown(window, { key: 'Enter', metaKey: true });

			expect(onSave).not.toHaveBeenCalled();
			expect(selectedTab()).toHaveTextContent('General');
		});

		it('lands on Models when Save refuses the gateway', async () => {
			renderModal();
			openTab('Models');
			const gateway = screen
				.getByTestId('edit-agent-gateway')
				.querySelector('input') as HTMLInputElement;
			fireEvent.change(gateway, { target: { value: 'not a url' } });
			openTab('General');

			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave).not.toHaveBeenCalled();
			expect(selectedTab()).toHaveTextContent('Models');
			expect(screen.getByTestId('edit-agent-tab-models-error')).toBeInTheDocument();
		});

		it.each([
			{ metaKey: true, shiftKey: false },
			{ ctrlKey: true, shiftKey: false },
			{ metaKey: true, shiftKey: true },
		])('cycles the tabs from inside the dialog with %j', (modifiers) => {
			renderModal();

			const name = screen.getByDisplayValue('My Agent');
			name.focus();
			expect(fireEvent.keyDown(name, { key: ']', ...modifiers })).toBe(false);
			expect(selectedTab()).toHaveTextContent('Provider');
			fireEvent.keyDown(screen.getByRole('tab', { name: 'Provider' }), {
				key: '[',
				...modifiers,
			});
			fireEvent.keyDown(screen.getByDisplayValue('My Agent'), {
				key: '[',
				...modifiers,
			});
			expect(selectedTab()).toHaveTextContent('SSH');
			fireEvent.keyDown(selectedTab()!, { key: ']', ...modifiers });
			expect(selectedTab()).toHaveTextContent('General');
		});

		it('steps through every visible tab with Cmd+] and Cmd+[ without saving', () => {
			renderModal();
			const tabs = screen.getAllByRole('tab');
			for (const tab of [...tabs.slice(1), tabs[0]]) {
				fireEvent.keyDown(screen.getByRole('tabpanel'), { key: ']', metaKey: true });
				expect(tab).toHaveAttribute('aria-selected', 'true');
			}
			for (const tab of [...tabs].reverse()) {
				fireEvent.keyDown(screen.getByRole('tabpanel'), { key: '[', metaKey: true });
				expect(tab).toHaveAttribute('aria-selected', 'true');
			}
			expect(onSave).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
		});

		it('shows the Runs on chip on General and Agent Resilience on Provider', async () => {
			renderModal();
			expect(screen.getByTestId('edit-agent-runs-on')).toHaveTextContent('Local');

			openTab('Provider');
			expect(screen.getByText('Agent Resilience')).toBeInTheDocument();
		});

		describe('Peers tab', () => {
			afterEach(() => {
				useSessionStore.setState({ sessions: [], groups: [] } as never);
			});

			it('draws the Peer Agents section from the live fleet and saves the three grants', () => {
				const session = createSession({
					groupId: 'g-backend',
					peerAgents: [
						{ sessionId: 'peer-infra', read: true, write: false, description: 'Owns the infra' },
					],
					groupPeerAccess: { read: true, write: false },
				});
				// The fleet and the group name come from the store, not from the
				// `session` and `existingSessions` props.
				useSessionStore.setState({
					sessions: [
						session,
						createSession({ id: 'peer-infra', name: 'Infra', groupId: 'g-backend' }),
						createSession({ id: 'peer-docs', name: 'Docs', groupId: 'g-backend' }),
					],
					groups: [{ id: 'g-backend', name: 'Backend', emoji: '🛠', collapsed: false }],
				} as never);

				renderModal(session);
				openTab('Peers');

				// The section, seeded from the agent's stored grants.
				expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'edit-agent-tabpanel-peers');
				expect(screen.getByText('Peer Agents')).toBeInTheDocument();
				expect(screen.getByText('2 other agents in Backend')).toBeInTheDocument();
				expect(screen.getByRole('checkbox', { name: /Peers in my group/ })).toBeChecked();
				expect(screen.getByRole('checkbox', { name: /Worktree family/ })).not.toBeChecked();
				expect(screen.getByDisplayValue('Owns the infra')).toBeInTheDocument();

				// The agent being edited is not offered as its own peer.
				const picker = screen.getByRole('button', { name: 'Peer agent' });
				expect(picker).toHaveTextContent('Infra');
				fireEvent.click(picker);
				expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
					'Select an agent...',
					'Docs',
					'Infra',
				]);
				fireEvent.click(picker);

				// Edit all three sources: delegate on the row, group off, worktree on.
				fireEvent.click(screen.getByRole('switch', { name: 'Delegate to this peer' }));
				fireEvent.click(screen.getByRole('checkbox', { name: /Peers in my group/ }));
				fireEvent.click(screen.getByRole('checkbox', { name: /Worktree family/ }));
				fireEvent.click(screen.getByText('Save Changes'));

				expect(onSave).toHaveBeenCalledTimes(1);
				const grants = onSave.mock.calls[0][SAVE_ARG.peerGrants];
				expect(grants).toEqual({
					peerAgents: [
						{ sessionId: 'peer-infra', read: true, write: true, description: 'Owns the infra' },
					],
					groupPeerAccess: undefined,
					worktreePeerAccess: { read: true, write: false },
				});
				// Off is absent, never a pair of false bits.
				expect(grants.groupPeerAccess).toBeUndefined();
			});
		});
	});

	describe('Maestro token proxy mode', () => {
		const PROXY_PORT = 48123;
		const proxyUrl = `http://127.0.0.1:${PROXY_PORT}/anthropic`;
		const proxy = () => window.maestro.localModels.proxy;

		const reportWithPort = (port: number | null) => ({
			status: { port, running: port !== null, agentIds: [], lastError: null, gatewayUrls: null },
			agents: [],
			usage: null,
			recentCompressions: [],
		});

		function renderOnModels(session: Session) {
			// The mode write reads and writes the live store entry, as the table does.
			useSessionStore.setState({ sessions: [session] } as never);
			const result = render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);
			openTab('Models');
			return result;
		}

		const modeSelect = () => screen.getByTestId('edit-agent-proxy-mode') as HTMLSelectElement;
		const gatewayInput = () =>
			screen.getByTestId('edit-agent-gateway').querySelector('input') as HTMLInputElement;

		beforeEach(() => {
			vi.mocked(proxy().report).mockReset().mockResolvedValue(reportWithPort(null));
			vi.mocked(proxy().ensurePort).mockReset().mockResolvedValue(PROXY_PORT);
			vi.mocked(window.maestro.sessions.setMany)
				.mockReset()
				.mockResolvedValue(undefined as never);
		});

		afterEach(() => {
			useSessionStore.setState({ sessions: [] } as never);
		});

		it('sits on the Models tab beside the gateway and reads Off with no proxy', async () => {
			renderOnModels(createSession());

			await waitFor(() => expect(modeSelect()).not.toBeDisabled());
			expect(modeSelect()).toHaveValue('off');
			expect(screen.getByTestId('edit-agent-gateway')).toBeInTheDocument();
		});

		it('reads the stored mode when the gateway is the proxy', async () => {
			vi.mocked(proxy().report).mockResolvedValue(reportWithPort(PROXY_PORT));
			renderOnModels(createSession({ gatewayUrl: proxyUrl, tokenProxyMode: 'compress' }));

			await waitFor(() => expect(modeSelect()).toHaveValue('compress'));
			expect(screen.getByTestId('edit-agent-proxy-mode-note')).toBeInTheDocument();
		});

		it('applies a choice at once, and the gateway draft follows so Save keeps it', async () => {
			renderOnModels(createSession());
			await waitFor(() => expect(modeSelect()).not.toBeDisabled());
			vi.mocked(proxy().report).mockResolvedValue(reportWithPort(PROXY_PORT));

			fireEvent.change(modeSelect(), { target: { value: 'passthrough' } });

			await waitFor(() =>
				expect(useSessionStore.getState().sessions[0]).toMatchObject({
					gatewayUrl: proxyUrl,
					tokenProxyMode: 'passthrough',
				})
			);
			expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
			await waitFor(() => expect(gatewayInput()).toHaveValue(proxyUrl));
			await waitFor(() => expect(modeSelect()).toHaveValue('passthrough'));

			fireEvent.click(screen.getByText('Save Changes'));
			expect(onSave.mock.calls[0][SAVE_ARG.gatewayUrl]).toBe(proxyUrl);
		});

		it('reads Off once a different gateway is typed over the proxy', async () => {
			vi.mocked(proxy().report).mockResolvedValue(reportWithPort(PROXY_PORT));
			renderOnModels(createSession({ gatewayUrl: proxyUrl, tokenProxyMode: 'compress' }));
			await waitFor(() => expect(modeSelect()).toHaveValue('compress'));

			fireEvent.change(gatewayInput(), { target: { value: 'http://localhost:4000' } });

			expect(modeSelect()).toHaveValue('off');
		});

		it('waits for a pending provider change, and says why', async () => {
			renderOnModels(createSession());
			openTab('Provider');
			fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
			fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
			openTab('Models');

			expect(modeSelect()).toBeDisabled();
			expect(screen.getByTestId('edit-agent-proxy-mode-blocked')).toHaveTextContent(
				'Save the provider change first'
			);
		});

		it('is refused for an agent on an SSH remote, before the click', async () => {
			vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
				success: true,
				configs: [{ id: 'remote-1', name: 'Dev Box', host: 'dev', port: 22 }],
			} as never);
			renderOnModels(
				createSession({ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } })
			);

			await waitFor(() =>
				expect(screen.getByTestId('edit-agent-proxy-mode-blocked')).toHaveTextContent('Dev Box')
			);
			expect(modeSelect()).toBeDisabled();
		});
	});
	describe('Background requests', () => {
		const PROXY_PORT = 48123;
		const proxyUrl = `http://127.0.0.1:${PROXY_PORT}/anthropic`;
		const proxy = () => window.maestro.localModels.proxy;
		const OLLAMA: LocalModelEndpoint = {
			id: 'ep-ollama',
			name: 'Ollama',
			kind: 'ollama',
			baseUrl: 'http://127.0.0.1:11434',
			enabled: true,
		};
		const QWEN = { type: 'source' as const, endpointId: OLLAMA.id, model: 'qwen3:4b' };
		let savedEndpoints: LocalModelEndpoint[];

		const reportWithPort = (port: number | null) => ({
			status: { port, running: port !== null, agentIds: [], lastError: null, gatewayUrls: null },
			agents: [],
			usage: null,
			recentCompressions: [],
		});

		function renderOnModels(session: Session) {
			// The picker writes to, and is drawn from, the live store entry.
			useSessionStore.setState({ sessions: [session] } as never);
			const result = render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);
			openTab('Models');
			return result;
		}

		const picker = () =>
			screen.getByTestId('edit-agent-background-requests-select') as HTMLSelectElement;
		const queryPicker = () => screen.queryByTestId('edit-agent-background-requests-select');
		const modeSelect = () => screen.getByTestId('edit-agent-proxy-mode') as HTMLSelectElement;
		const stored = () => useSessionStore.getState().sessions[0];
		const listed = () =>
			waitFor(() =>
				expect(
					Array.from(picker().options).some((option) => option.value === 'ep-ollama:qwen3:4b')
				).toBe(true)
			);

		beforeEach(() => {
			savedEndpoints = useSettingsStore.getState().localModelEndpoints;
			useSettingsStore.setState({ localModelEndpoints: [OLLAMA] });
			vi.mocked(proxy().report).mockReset().mockResolvedValue(reportWithPort(PROXY_PORT));
			vi.mocked(proxy().ensurePort).mockReset().mockResolvedValue(PROXY_PORT);
			vi.mocked(window.maestro.sessions.setMany)
				.mockReset()
				.mockResolvedValue(undefined as never);
			vi.mocked(window.maestro.localModels.endpoints.listModels).mockImplementation(
				async (endpoint) =>
					typeof endpoint === 'string'
						? { ok: true, models: [] }
						: { ok: true, models: [{ id: 'qwen3:4b' }] }
			);
		});

		afterEach(() => {
			useSessionStore.setState({ sessions: [] } as never);
			useSettingsStore.setState({ localModelEndpoints: savedEndpoints });
			vi.mocked(proxy().report).mockResolvedValue(reportWithPort(null));
			vi.mocked(window.maestro.localModels.endpoints.listModels).mockResolvedValue({
				ok: true,
				models: [],
			});
		});

		it('is not offered while the agent is off the proxy', async () => {
			renderOnModels(createSession());

			await waitFor(() => expect(modeSelect()).not.toBeDisabled());
			expect(modeSelect()).toHaveValue('off');
			expect(queryPicker()).not.toBeInTheDocument();
		});

		it('is not offered to a provider the proxy cannot route for', async () => {
			renderOnModels(createSession({ toolType: 'codex', gatewayUrl: proxyUrl }));

			await waitFor(() => expect(modeSelect()).toHaveValue('passthrough'));
			expect(queryPicker()).not.toBeInTheDocument();
		});

		it('is offered to a Claude Code agent on the proxy, reading Off with the reason it exists', async () => {
			renderOnModels(createSession({ gatewayUrl: proxyUrl, tokenProxyMode: 'passthrough' }));

			await waitFor(() => expect(queryPicker()).toBeInTheDocument());
			expect(picker()).toHaveValue('none');
			expect(screen.getByTestId('edit-agent-background-requests')).toHaveTextContent(
				'side requests'
			);
		});

		it('applies a choice at once: the agent holds the target before Save', async () => {
			renderOnModels(createSession({ gatewayUrl: proxyUrl, tokenProxyMode: 'passthrough' }));
			await waitFor(() => expect(queryPicker()).toBeInTheDocument());
			await listed();

			fireEvent.change(picker(), { target: { value: 'ep-ollama:qwen3:4b' } });

			await waitFor(() => expect(stored().backgroundRequests).toEqual({ target: QWEN }));
			expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
				[expect.objectContaining({ backgroundRequests: { target: QWEN } })],
				[]
			);
			await waitFor(() => expect(picker()).toHaveValue('ep-ollama:qwen3:4b'));
			expect(onSave).not.toHaveBeenCalled();
		});

		it('shows the stored target, and turning the proxy off takes it away', async () => {
			renderOnModels(
				createSession({
					gatewayUrl: proxyUrl,
					tokenProxyMode: 'passthrough',
					backgroundRequests: { target: QWEN },
				})
			);
			await waitFor(() => expect(queryPicker()).toBeInTheDocument());
			await listed();
			expect(picker()).toHaveValue('ep-ollama:qwen3:4b');

			fireEvent.change(modeSelect(), { target: { value: 'off' } });

			await waitFor(() => expect(stored().backgroundRequests).toBeUndefined());
			await waitFor(() => expect(queryPicker()).not.toBeInTheDocument());
		});

		it('says so when the stored target cannot be read', async () => {
			renderOnModels(
				createSession({
					gatewayUrl: proxyUrl,
					tokenProxyMode: 'passthrough',
					backgroundRequests: { target: { type: 'source' } } as never,
				})
			);

			await waitFor(() =>
				expect(screen.getByTestId('edit-agent-background-requests-error')).toHaveTextContent(
					'The stored Background requests target cannot be used'
				)
			);
			expect(picker()).toHaveValue('none');
		});
	});

	describe('System One switch', () => {
		const toggle = () => screen.getByRole('switch', { name: /use System One$/ });

		beforeEach(() => {
			vi.mocked(window.maestro.sessions.setMany)
				.mockReset()
				.mockResolvedValue(undefined as never);
		});

		afterEach(() => {
			useSessionStore.setState({ sessions: [] } as never);
		});

		function renderOnModels(session: Session) {
			// The switch reads and writes the live store entry, as the proxy mode does.
			useSessionStore.setState({ sessions: [session] } as never);
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
			openTab('Models');
		}

		it('sits on the Models tab, on for an agent that was never switched off', () => {
			renderOnModels(createSession());

			expect(screen.getByTestId('edit-agent-system-one')).toBeInTheDocument();
			expect(toggle()).toHaveAttribute('aria-checked', 'true');
		});

		it('applies at once and flushes to main, without Save', async () => {
			renderOnModels(createSession());

			fireEvent.click(toggle());

			await waitFor(() =>
				expect(useSessionStore.getState().sessions[0].systemOneOptOut).toBe(true)
			);
			expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
				[expect.objectContaining({ systemOneOptOut: true })],
				[]
			);
			await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'false'));
			expect(onSave).not.toHaveBeenCalled();
		});

		it('reads off for an agent that is switched off', () => {
			renderOnModels(createSession({ systemOneOptOut: true }));

			expect(toggle()).toHaveAttribute('aria-checked', 'false');
		});
	});

	describe('Tiers', () => {
		const OLLAMA: LocalModelEndpoint = {
			id: 'ep-ollama',
			name: 'Ollama',
			kind: 'ollama',
			baseUrl: 'http://127.0.0.1:11434',
			enabled: true,
		};
		const LOCAL = { type: 'source' as const, endpointId: OLLAMA.id, model: 'qwen3:latest' };
		const row = (harness: 'claude-code' | 'codex'): HarnessTierOptions => ({
			harness,
			name: harness === 'codex' ? 'Codex' : 'Claude Code',
			installed: true,
			catalog:
				harness === 'codex'
					? [{ id: 'gpt-6-luna' }]
					: [{ id: 'haiku' }, { id: 'sonnet' }, { id: 'opus' }],
			runOn: { supported: true },
			sources: [{ endpointId: OLLAMA.id, name: 'Ollama', models: ['qwen3:latest'] }],
			problems: [],
		});
		let savedEndpoints: LocalModelEndpoint[];

		const tierOptions = () => vi.mocked(window.maestro.localModels.tiers.options);
		const picker = (tier: string) =>
			screen.getByTestId(`edit-agent-tier-targets-${tier}`) as HTMLSelectElement;
		const layer = (tier: string) =>
			screen.getByTestId(`edit-agent-tier-targets-${tier}-source`).textContent;

		beforeEach(() => {
			savedEndpoints = useSettingsStore.getState().localModelEndpoints;
			useSettingsStore.setState({ localModelEndpoints: [OLLAMA] });
			tierOptions().mockImplementation(async (request) => [
				row(request?.harness === 'codex' ? 'codex' : 'claude-code'),
			]);
		});

		afterEach(() => {
			useSettingsStore.setState({ localModelEndpoints: savedEndpoints });
			tierOptions().mockReset().mockResolvedValue([]);
		});

		async function renderOnModels(session: Session) {
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
			openTab('Models');
			await waitFor(() => screen.getByTestId('edit-agent-tier-targets-low'));
		}

		it('sits on the Models tab between Run on and the gateway', async () => {
			await renderOnModels(createSession());

			const runOn = screen.getByTestId('edit-agent-run-on');
			const tiers = screen.getByTestId('edit-agent-tiers');
			const gateway = screen.getByTestId('edit-agent-gateway');
			expect(runOn.compareDocumentPosition(tiers) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			expect(
				tiers.compareDocumentPosition(gateway) & Node.DOCUMENT_POSITION_FOLLOWING
			).toBeTruthy();
		});

		it('reads Harness default for an agent with no tier, and saves none', async () => {
			await renderOnModels(createSession());

			expect(picker('low').value).toBe('default');
			expect(picker('low').selectedOptions[0].textContent).toBe('Harness default (haiku)');
			expect(layer('low')).toBe('Built-in');
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave.mock.calls[0][SAVE_ARG.tierTargets]).toBeUndefined();
		});

		it("shows the agent's stored tiers and saves them unchanged", async () => {
			const tierTargets = {
				low: LOCAL,
				high: { type: 'provider-model' as const, model: 'sonnet' },
			};
			await renderOnModels(createSession({ tierTargets }));

			expect(picker('low').value).toBe('ep-ollama:qwen3:latest');
			expect(layer('low')).toBe('Agent');
			expect(picker('high').value).toBe('provider:sonnet');
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave.mock.calls[0][SAVE_ARG.tierTargets]).toEqual(tierTargets);
		});

		it('saves a tier that was set and drops one put back on Harness default', async () => {
			await renderOnModels(createSession({ tierTargets: { high: LOCAL } }));

			fireEvent.change(picker('low'), { target: { value: 'provider:haiku' } });
			fireEvent.change(picker('high'), { target: { value: 'default' } });
			expect(layer('low')).toBe('Agent');
			expect(layer('high')).toBe('Built-in');
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave.mock.calls[0][SAVE_ARG.tierTargets]).toEqual({
				low: { type: 'provider-model', model: 'haiku' },
			});
		});

		it('reads the built-in table as not applying once Run on is a source', async () => {
			await renderOnModels(createSession({ runOn: { ...LOCAL, contextTokens: 65_536 } }));

			expect(layer('low')).toBe('Not mapped');
			expect(screen.getByTestId('edit-agent-tier-targets-low-note')).toHaveTextContent(
				'runs on a Local Models source'
			);
		});

		it('refuses to save a stored tier a launch would refuse, and names the tier', async () => {
			await renderOnModels(createSession({ tierTargets: { high: { type: 'source' } } as never }));

			expect(screen.getByTestId('edit-agent-tier-targets-high-problem')).toBeInTheDocument();
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave).not.toHaveBeenCalled();
			expect(screen.getByTestId('edit-agent-tier-targets-error')).toHaveTextContent(/^high: /);

			// Picking a target again clears the refusal and saves.
			fireEvent.change(picker('high'), { target: { value: 'provider:opus' } });
			expect(screen.queryByTestId('edit-agent-tier-targets-error')).not.toBeInTheDocument();
			fireEvent.click(screen.getByText('Save Changes'));
			expect(onSave.mock.calls[0][SAVE_ARG.tierTargets]).toEqual({
				high: { type: 'provider-model', model: 'opus' },
			});
		});

		it('starts the tiers over on a provider switch: a tier names a model', async () => {
			await renderOnModels(createSession({ tierTargets: { low: LOCAL } }));

			openTab('Provider');
			fireEvent.click(screen.getByRole('button', { name: 'Agent Provider' }));
			fireEvent.click(screen.getByRole('option', { name: 'Codex Carry Over' }));
			fireEvent.click(screen.getByLabelText('Convert memory and session history'));
			await screen.findByLabelText('Allow experimental carry-over');
			fireEvent.click(screen.getByLabelText('Allow experimental carry-over'));
			openTab('Models');
			await waitFor(() =>
				expect(picker('low').selectedOptions[0].textContent).toBe('Harness default (gpt-6-luna)')
			);
			expect(picker('low').value).toBe('default');
			fireEvent.click(screen.getByText('Save Changes'));

			await waitFor(() => expect(onSave).toHaveBeenCalled());
			expect(onSave.mock.calls[0][SAVE_ARG.tierTargets]).toBeUndefined();
		});
	});

	describe('Run on', () => {
		const OLLAMA: LocalModelEndpoint = {
			id: 'ep-ollama',
			name: 'Ollama',
			kind: 'ollama',
			baseUrl: 'http://127.0.0.1:11434',
			enabled: true,
		};
		const QWEN = {
			type: 'source' as const,
			endpointId: OLLAMA.id,
			model: 'qwen3:latest',
			contextTokens: 65_536,
		};
		let savedEndpoints: LocalModelEndpoint[];

		beforeEach(() => {
			savedEndpoints = useSettingsStore.getState().localModelEndpoints;
			useSettingsStore.setState({ localModelEndpoints: [OLLAMA] });
			// The Maestro model server lists nothing; Ollama lists one model.
			vi.mocked(window.maestro.localModels.endpoints.listModels).mockImplementation(
				async (endpoint) =>
					typeof endpoint === 'string'
						? { ok: true, models: [] }
						: { ok: true, models: [{ id: 'qwen3:latest' }] }
			);
		});

		afterEach(() => {
			useSettingsStore.setState({ localModelEndpoints: savedEndpoints });
			vi.mocked(window.maestro.localModels.endpoints.listModels).mockResolvedValue({
				ok: true,
				models: [],
			});
		});

		function renderOnModels(session: Session) {
			const result = render(
				<EditAgentModal
					isOpen={true}
					onClose={onClose}
					onSave={onSave}
					theme={theme}
					session={session}
					existingSessions={[]}
				/>
			);
			openTab('Models');
			return result;
		}

		const picker = () => screen.getByTestId('edit-agent-run-on-field-select') as HTMLSelectElement;
		const contextInput = () =>
			screen
				.getByTestId('edit-agent-run-on-field-context')
				.querySelector('input') as HTMLInputElement;
		const listed = () =>
			waitFor(() =>
				expect(
					Array.from(picker().options).some((option) => option.value === 'ep-ollama:qwen3:latest')
				).toBe(true)
			);

		it('reads Provider for an agent with no target, and saves none', async () => {
			renderOnModels(createSession());

			expect(picker().value).toBe('provider');
			expect(screen.queryByTestId('edit-agent-run-on-field-context')).not.toBeInTheDocument();
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave.mock.calls[0][SAVE_ARG.runOn]).toBeUndefined();
		});

		it("shows the agent's stored target and saves it unchanged", async () => {
			renderOnModels(createSession({ runOn: QWEN }));

			await waitFor(() => expect(picker().value).toBe('ep-ollama:qwen3:latest'));
			expect(contextInput().value).toBe('65536');
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave.mock.calls[0][SAVE_ARG.runOn]).toEqual(QWEN);
		});

		it('saves a model picked from a source, at the smallest agent context', async () => {
			renderOnModels(createSession());

			await listed();
			fireEvent.change(picker(), { target: { value: 'ep-ollama:qwen3:latest' } });
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave.mock.calls[0][SAVE_ARG.runOn]).toEqual({
				type: 'source',
				endpointId: OLLAMA.id,
				model: 'qwen3:latest',
				contextTokens: RUN_ON_MIN_CONTEXT_TOKENS,
			});
		});

		it('clears the target when Provider is chosen', async () => {
			renderOnModels(createSession({ runOn: QWEN }));

			await waitFor(() => expect(picker().value).toBe('ep-ollama:qwen3:latest'));
			fireEvent.change(picker(), { target: { value: 'provider' } });
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave).toHaveBeenCalledTimes(1);
			expect(onSave.mock.calls[0][SAVE_ARG.runOn]).toBeUndefined();
		});

		it('saves a context size typed into the field', async () => {
			renderOnModels(createSession({ runOn: QWEN }));

			await waitFor(() => expect(contextInput().value).toBe('65536'));
			fireEvent.change(contextInput(), { target: { value: '131072' } });
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave.mock.calls[0][SAVE_ARG.runOn]).toEqual({ ...QWEN, contextTokens: 131_072 });
		});

		it('refuses a context under the agent minimum, on the Models tab, without saving', async () => {
			renderOnModels(createSession({ runOn: QWEN }));

			await waitFor(() => expect(contextInput().value).toBe('65536'));
			fireEvent.change(contextInput(), { target: { value: '8192' } });
			openTab('General');
			fireEvent.click(screen.getByText('Save Changes'));

			expect(onSave).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
			expect(screen.getByTestId('edit-agent-run-on-field-status')).toHaveTextContent(
				`at least ${RUN_ON_MIN_CONTEXT_TOKENS} tokens`
			);
			expect(screen.getByTestId('edit-agent-tab-models-error')).toBeInTheDocument();
		});

		it('shows a stored target that cannot be read as Provider, with the reason', async () => {
			renderOnModels(createSession({ runOn: { type: 'source', endpointId: OLLAMA.id } as never }));

			expect(picker().value).toBe('provider');
			expect(screen.getByTestId('edit-agent-run-on-field-status')).toHaveTextContent(
				'The stored Run on target cannot be used'
			);
		});

		it('disables both gateway controls while a source is chosen, and says why', async () => {
			renderOnModels(createSession({ runOn: QWEN, gatewayUrl: 'http://127.0.0.1:8787' }));

			await waitFor(() => expect(picker().value).toBe('ep-ollama:qwen3:latest'));
			const gateway = screen
				.getByTestId('edit-agent-gateway')
				.querySelector('input') as HTMLInputElement;
			expect(gateway).toBeDisabled();
			// The stored URL is kept: it applies again when Run on is Provider.
			expect(gateway.value).toBe('http://127.0.0.1:8787');
			expect(screen.getByTestId('edit-agent-gateway-url-status')).toHaveTextContent(
				'Not applied while Run on is a source'
			);
			expect(screen.getByTestId('edit-agent-proxy-mode')).toBeDisabled();

			fireEvent.change(picker(), { target: { value: 'provider' } });
			expect(gateway).not.toBeDisabled();
		});

		it('tests the target shown with the form as it stands, and shows the reply', async () => {
			vi.mocked(window.maestro.localModels.runOn.test).mockResolvedValueOnce({
				ok: true,
				model: 'qwen3:latest',
				label: 'qwen3:latest on Ollama',
				reply: 'ready',
				durationMs: 4200,
				contextTokens: 65_536,
			});
			renderOnModels(createSession({ runOn: QWEN }));

			await waitFor(() => expect(picker().value).toBe('ep-ollama:qwen3:latest'));
			fireEvent.click(screen.getByTestId('edit-agent-run-on-field-test'));

			await waitFor(() =>
				expect(screen.getByTestId('edit-agent-run-on-field-test-result')).toHaveTextContent(
					'qwen3:latest on Ollama answered in 4.2 s: ready'
				)
			);
			expect(window.maestro.localModels.runOn.test).toHaveBeenCalledWith({
				agentId: 'session-123',
				target: QWEN,
				subject: {
					toolType: 'claude-code',
					cwd: '/home/user/project',
					customPath: '/custom/claude',
					customArgs: '--verbose',
					customEnvVars: { API_KEY: 'test-key' },
					sshRemoteConfig: { enabled: false, remoteId: null },
				},
			});
			// Testing saves nothing.
			expect(onSave).not.toHaveBeenCalled();
		});

		it('shows why a test failed', async () => {
			vi.mocked(window.maestro.localModels.runOn.test).mockResolvedValueOnce({
				ok: false,
				code: 'run-on-model-not-served',
				message: 'The source "Ollama" does not serve "qwen3:latest".',
			});
			renderOnModels(createSession({ runOn: QWEN }));

			await waitFor(() => expect(picker().value).toBe('ep-ollama:qwen3:latest'));
			fireEvent.click(screen.getByTestId('edit-agent-run-on-field-test'));

			const result = await screen.findByTestId('edit-agent-run-on-field-test-result');
			expect(result).toHaveAttribute('data-ok', 'false');
			expect(result).toHaveTextContent('does not serve "qwen3:latest"');
		});
	});
});
