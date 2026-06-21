import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { EditAgentModal, NewInstanceModal } from '../../renderer/components/NewInstanceModal';
import type { AgentConfig, Session, Theme } from '../../renderer/types';
import type { SshRemoteConfig } from '../../shared/types';
import { logger } from '../../renderer/utils/logger';

const DEFAULT_AGENT_CAPABILITIES: NonNullable<AgentConfig['capabilities']> = {
	supportsResume: true,
	supportsReadOnlyMode: true,
	supportsJsonOutput: true,
	supportsSessionId: true,
	supportsImageInput: true,
	supportsImageInputOnResume: true,
	supportsSlashCommands: true,
	supportsSessionStorage: true,
	supportsCostTracking: true,
	supportsUsageStats: true,
	supportsBatchMode: true,
	requiresPromptToStart: false,
	supportsStreaming: true,
	supportsResultMessages: true,
	supportsModelSelection: true,
};

function createTheme(): Theme {
	return {
		id: 'integration-dark',
		name: 'Integration Dark',
		mode: 'dark',
		colors: {
			bgMain: '#111827',
			bgSidebar: '#1f2937',
			bgActivity: '#0f172a',
			textMain: '#f9fafb',
			textDim: '#9ca3af',
			accent: '#2563eb',
			accentDim: '#1d4ed8',
			accentForeground: '#ffffff',
			border: '#374151',
			success: '#16a34a',
			warning: '#f59e0b',
			error: '#dc2626',
			info: '#0ea5e9',
			bgAccentHover: '#1d4ed8',
		},
	};
}

function createAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		available: true,
		path: '/usr/local/bin/claude',
		binaryName: 'claude',
		hidden: false,
		capabilities: DEFAULT_AGENT_CAPABILITIES,
		configOptions: [
			{
				key: 'model',
				label: 'Model',
				type: 'text',
				default: 'claude-sonnet',
				description: 'Model slug',
			},
			{
				key: 'contextWindow',
				label: 'Context Window',
				type: 'number',
				default: 100000,
				description: 'Context window',
			},
			{
				key: 'providerPath',
				label: 'Provider Path',
				type: 'text',
				default: '/old/provider',
				description: 'Provider binary path',
			},
		],
		...overrides,
	};
}

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Editable Agent',
		toolType: 'claude-code',
		cwd: '/workspace/project',
		projectRoot: '/workspace/project',
		fullPath: '/workspace/project',
		state: 'idle',
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		aiTabs: [],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		shellLogs: [],
		executionQueue: [],
		contextUsage: 0,
		workLog: [],
		isGitRepo: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		isLive: false,
		activeTimeMs: 0,
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	} as Session;
}

function createRemote(overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig {
	return {
		id: 'remote-1',
		name: 'Remote Dev',
		host: 'dev.example.test',
		username: 'dev',
		port: 22,
		enabled: true,
		...overrides,
	};
}

function renderWithLayerStack(ui: React.ReactElement) {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
}

function removeAllEnvVars() {
	for (let index = 0; index < 10; index++) {
		const [removeButton] = screen.queryAllByTitle('Remove variable');
		if (!removeButton) return;
		fireEvent.click(removeButton);
	}
	throw new Error('Expected environment variable remove buttons to clear within 10 clicks');
}

describe('NewInstanceModal integration', () => {
	let theme: Theme;
	let onClose: ReturnType<typeof vi.fn>;
	let onCreate: ReturnType<typeof vi.fn>;
	let onSave: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		theme = createTheme();
		onClose = vi.fn();
		onCreate = vi.fn();
		onSave = vi.fn();

		vi.clearAllMocks();
		vi.mocked(window.maestro.fs.homeDir).mockResolvedValue('/Users/integration');
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue(null);
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([createAgent()]);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
			customPath: '/custom/bin/claude',
			customArgs: '--old',
			customEnvVars: { EXISTING_FLAG: '1' },
			model: 'claude-sonnet',
			contextWindow: 100000,
			providerPath: '/old/provider',
		});
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue([]);
		vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(undefined);
		vi.mocked(window.maestro.agents.refresh).mockResolvedValue({
			agents: [createAgent()],
			debugInfo: null,
		});
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [],
		});
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			isDirectory: true,
			isFile: false,
		} as any);
		vi.mocked(window.maestro.shell.openExternal).mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: vi.fn().mockResolvedValue(undefined) },
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('creates a configured local agent from detected agent metadata and config panel state', async () => {
		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		const agentRow = await screen.findByRole('option', { name: /Claude Code/i });
		fireEvent.click(agentRow);
		await screen.findByDisplayValue('/custom/bin/claude');

		fireEvent.change(screen.getByLabelText('Agent Name'), {
			target: { value: 'Configured Agent' },
		});
		fireEvent.change(screen.getByLabelText('Working Directory'), {
			target: { value: '~/workspace/project' },
		});
		fireEvent.change(
			screen.getByPlaceholderText('Instructions appended to every message you send...'),
			{
				target: { value: 'Keep responses terse.' },
			}
		);
		fireEvent.change(screen.getByDisplayValue('--old'), {
			target: { value: '--fast' },
		});
		fireEvent.click(screen.getByText('Add Variable'));
		const envKeyInput = await screen.findByDisplayValue('NEW_VAR');
		fireEvent.change(envKeyInput, { target: { value: 'INTEGRATION_FLAG' } });
		fireEvent.blur(envKeyInput);
		const envValueInputs = screen.getAllByPlaceholderText('value');
		fireEvent.change(envValueInputs.at(-1)!, { target: { value: 'enabled' } });
		fireEvent.change(screen.getByDisplayValue('claude-sonnet'), {
			target: { value: 'claude-haiku' },
		});
		fireEvent.change(screen.getByDisplayValue('100000'), { target: { value: '200000' } });
		fireEvent.change(screen.getByDisplayValue('/old/provider'), {
			target: { value: '/new/provider' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'MAESTRO_SESSION_RESUMED' }));
		fireEvent.click(screen.getByText('Create Agent'));

		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
			'https://docs.runmaestro.ai/autorun-playbooks?theme=dracula#environment-variables'
		);
		expect(onCreate).toHaveBeenCalledWith(
			'claude-code',
			'/Users/integration/workspace/project',
			'Configured Agent',
			'Keep responses terse.',
			undefined,
			'/custom/bin/claude',
			'--fast',
			{ EXISTING_FLAG: '1', INTEGRATION_FLAG: 'enabled' },
			'claude-haiku',
			200000,
			'/new/provider',
			{ enabled: false, remoteId: null, shareHistoryToProjectDir: undefined },
			undefined,
			undefined,
			true,
			undefined,
			'dynamic'
		);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('creates a remote agent after SSH remote selection and remote path validation', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [
				{
					id: 'remote-1',
					name: 'Remote Dev',
					host: 'dev.example.test',
					username: 'dev',
					port: 22,
					enabled: true,
				},
			],
		});
		vi.mocked(window.maestro.agents.detect).mockImplementation(async (sshRemoteId?: string) => [
			createAgent({
				path: sshRemoteId ? '/usr/bin/claude' : '/usr/local/bin/claude',
			}),
		]);

		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		await screen.findByText('SSH Remote Execution');
		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'remote-1' } });
		fireEvent.change(screen.getByLabelText('Agent Name'), {
			target: { value: 'Remote Agent' },
		});
		fireEvent.change(screen.getByLabelText('Working Directory'), {
			target: { value: '/srv/project' },
		});

		await waitFor(() => {
			expect(window.maestro.agents.detect).toHaveBeenCalledWith('remote-1');
			expect(window.maestro.fs.stat).toHaveBeenCalledWith('/srv/project', 'remote-1');
			expect(screen.getByText('Directory found on dev.example.test')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByText('Create Agent'));

		expect(onCreate).toHaveBeenCalledWith(
			'claude-code',
			'/srv/project',
			'Remote Agent',
			undefined,
			undefined,
			'/custom/bin/claude',
			'--old',
			{ EXISTING_FLAG: '1' },
			'claude-sonnet',
			100000,
			'/old/provider',
			{
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/srv/project',
				syncHistory: false,
				shareHistoryToProjectDir: undefined,
			},
			undefined,
			undefined,
			true,
			undefined,
			'dynamic'
		);
	});

	it('edits an existing agent with provider, config, SSH, and clipboard workflows', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [
				{
					id: 'remote-1',
					name: 'Remote Dev',
					host: 'dev.example.test',
					username: 'dev',
					port: 22,
					enabled: true,
				},
			],
		});
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			createAgent(),
			createAgent({
				id: 'codex',
				name: 'Codex',
				path: '/usr/local/bin/codex',
				binaryName: 'codex',
			}),
		]);
		vi.mocked(window.maestro.agents.getConfig).mockImplementation(async (agentId: string) => ({
			customPath: agentId === 'codex' ? '' : '/custom/bin/claude',
			customArgs: agentId === 'codex' ? '' : '--old',
			customEnvVars: agentId === 'codex' ? {} : { EXISTING_FLAG: '1' },
			model: agentId === 'codex' ? 'codex-pro' : 'claude-sonnet',
			contextWindow: agentId === 'codex' ? 150000 : 100000,
			providerPath: '/provider/path',
		}));
		const session = createSession({
			id: 'session-abcdef',
			name: 'Editable Agent',
			nudgeMessage: 'Keep context.',
			customPath: '/custom/bin/claude',
			customArgs: '--old',
			customEnvVars: { EXISTING_FLAG: '1' },
			customModel: 'claude-sonnet',
			customContextWindow: 100000,
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/remote/project',
			},
		});

		renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={session}
				existingSessions={[session]}
			/>
		);

		await screen.findByDisplayValue('Editable Agent');
		fireEvent.click(screen.getByTitle('Click to copy: session-abcdef'));
		await waitFor(() => {
			expect(navigator.clipboard.writeText).toHaveBeenCalledWith('session-abcdef');
		});

		fireEvent.change(screen.getByLabelText('Agent Name'), {
			target: { value: 'Edited Agent' },
		});
		fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'codex' } });
		await screen.findByText(/Changing the provider will clear your session list/);
		await screen.findByDisplayValue('codex-pro');

		fireEvent.change(screen.getByPlaceholderText('codex'), {
			target: { value: '/custom/bin/codex' },
		});
		fireEvent.change(screen.getByPlaceholderText('--flag value --another-flag'), {
			target: { value: '--approval-mode full-auto' },
		});
		fireEvent.click(screen.getByText('Add Variable'));
		const envKeyInput = await screen.findByDisplayValue('NEW_VAR');
		fireEvent.change(envKeyInput, { target: { value: 'CODEX_ENV' } });
		fireEvent.blur(envKeyInput);
		fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: '1' } });
		fireEvent.change(screen.getByDisplayValue('codex-pro'), {
			target: { value: 'codex-max' },
		});
		fireEvent.change(screen.getByDisplayValue('150000'), { target: { value: '250000' } });
		fireEvent.click(screen.getByText('Save Changes'));

		expect(onSave).toHaveBeenCalledWith(
			'session-abcdef',
			'Edited Agent',
			'codex',
			'Keep context.',
			undefined,
			'/custom/bin/codex',
			'--approval-mode full-auto',
			{ CODEX_ENV: '1' },
			'codex-max',
			250000,
			{
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/remote/project',
				syncHistory: undefined,
				shareHistoryToProjectDir: undefined,
			},
			undefined,
			undefined,
			undefined
		);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('duplicates a source session with source config and requires same-directory acknowledgement', async () => {
		const originalConsoleError = console.error;
		vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
			if (typeof message === 'string' && message.includes('inside a test was not wrapped in act')) {
				return;
			}
			originalConsoleError(message, ...args);
		});
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [createRemote()],
		});
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
			customPath: '/source/bin/claude',
			customArgs: '--source',
			customEnvVars: { SOURCE_FLAG: '1' },
			model: 'source-model',
			contextWindow: 123456,
			providerPath: '/source/provider',
		});
		const source = createSession({
			id: 'source-session',
			groupId: 'group-1',
			name: 'Original Agent',
			cwd: '~',
			projectRoot: '/Users/integration',
			fullPath: '/Users/integration',
			nudgeMessage: 'Keep context.',
			customPath: '/source/bin/claude',
			customArgs: '--source',
			customEnvVars: { SOURCE_FLAG: '1' },
			customModel: 'source-model',
			customContextWindow: 123456,
			customProviderPath: '/source/provider',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/remote/project',
			},
		});

		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[source]}
				sourceSession={source}
			/>
		);

		await screen.findByDisplayValue('Original Agent (Copy)');
		await screen.findByDisplayValue('/source/bin/claude');
		await screen.findByDisplayValue('--source');
		await screen.findByDisplayValue('source-model');
		await screen.findByText('Directory found on dev.example.test');
		await screen.findByText(/This directory is already used by "Original Agent"/);
		const createButton = screen.getByRole('button', { name: 'Create Agent' });
		expect(createButton).toBeDisabled();

		fireEvent.click(screen.getByLabelText(/I understand the risk/));
		await waitFor(() => expect(createButton).not.toBeDisabled());
		fireEvent.click(createButton);

		expect(onCreate).toHaveBeenCalledWith(
			'claude-code',
			'/Users/integration',
			'Original Agent (Copy)',
			'Keep context.',
			undefined,
			'/source/bin/claude',
			'--source',
			{ SOURCE_FLAG: '1' },
			'source-model',
			123456,
			'/source/provider',
			{
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/remote/project',
				syncHistory: undefined,
				shareHistoryToProjectDir: undefined,
			},
			undefined,
			'group-1',
			true,
			undefined,
			'dynamic'
		);
	});

	it('surfaces remote path validation failures while keeping remote creation informational', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [createRemote()],
		});
		vi.mocked(window.maestro.fs.stat).mockImplementation(async (path) => {
			if (path === '/srv/file') {
				return { isDirectory: false, isFile: true } as any;
			}
			if (path === '/srv/missing') {
				return null as any;
			}
			throw new Error('remote stat failed');
		});

		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		await screen.findByText('SSH Remote Execution');
		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'remote-1' } });

		fireEvent.change(screen.getByLabelText('Working Directory'), {
			target: { value: '/srv/file' },
		});
		await screen.findByText(/Path is a file, not a directory/);

		fireEvent.change(screen.getByLabelText('Working Directory'), {
			target: { value: '/srv/missing' },
		});
		await screen.findByText(/Path not found or not accessible/);

		fireEvent.change(screen.getByLabelText('Working Directory'), {
			target: { value: '/srv/error' },
		});
		await waitFor(() => {
			expect(window.maestro.fs.stat).toHaveBeenCalledWith('/srv/error', 'remote-1');
		});
		expect(screen.getByText(/Path not found or not accessible/)).toBeInTheDocument();
	});

	it('shows an SSH connection error when remote agent detection only returns failures', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [createRemote()],
		});
		vi.mocked(window.maestro.agents.detect).mockImplementation(async (sshRemoteId?: string) =>
			sshRemoteId
				? [
						createAgent({
							available: false,
							error: 'SSH connection failed',
						} as Partial<AgentConfig>),
					]
				: [createAgent()]
		);

		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		await screen.findByText('SSH Remote Execution');
		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'remote-1' } });

		await screen.findByText('Unable to Connect');
		expect(screen.getByText('SSH connection failed')).toBeInTheDocument();
		expect(screen.getByText(/Select a different remote host/)).toBeInTheDocument();
	});

	it('handles new-agent refresh, model, env var, and config persistence error paths', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['claude-sonnet']);
		vi.mocked(window.maestro.agents.refresh).mockResolvedValueOnce({
			agents: [createAgent({ available: false })],
			debugInfo: {
				agentId: 'claude-code',
				available: false,
				path: null,
				binaryName: 'claude',
				envPath: '/bin:/usr/bin',
				homeDir: '/Users/integration',
				platform: 'darwin',
				whichCommand: 'which claude',
				error: 'not found',
			},
		});

		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		const agentRow = await screen.findByRole('option', { name: /Claude Code/i });
		fireEvent.click(agentRow);
		await screen.findByDisplayValue('/custom/bin/claude');

		fireEvent.click(screen.getByText('Clear'));

		fireEvent.click(screen.getByText('Add Variable'));
		await screen.findByDisplayValue('NEW_VAR');
		fireEvent.change(screen.getAllByPlaceholderText('value').at(-1)!, {
			target: { value: 'set' },
		});
		fireEvent.click(screen.getByText('Add Variable'));
		await screen.findByDisplayValue('NEW_VAR_1');
		removeAllEnvVars();

		vi.mocked(window.maestro.agents.setConfig).mockRejectedValueOnce(new Error('persist failed'));
		fireEvent.blur(screen.getByDisplayValue('/old/provider'));
		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to persist config for claude-code:',
				undefined,
				expect.any(Error)
			);
		});

		vi.mocked(window.maestro.agents.getModels).mockRejectedValueOnce(new Error('models failed'));
		fireEvent.click(screen.getByTitle('Refresh available models'));
		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to load models for claude-code:',
				undefined,
				expect.any(Error)
			);
		});

		fireEvent.click(screen.getByTitle('Refresh detection'));
		await screen.findByText('Debug Info: claude not found');
		expect(screen.getByText('/bin')).toBeInTheDocument();
		fireEvent.click(screen.getByText('Dismiss'));
		await waitFor(() => {
			expect(screen.queryByText('Debug Info: claude not found')).not.toBeInTheDocument();
		});
	});

	it('guards edit saves and reports remote path validation failures', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [
				createRemote(),
				createRemote({ id: 'remote-2', name: 'Remote Missing', host: 'missing.example.test' }),
				createRemote({ id: 'remote-3', name: 'Remote Error', host: 'error.example.test' }),
			],
		});
		vi.mocked(window.maestro.fs.stat).mockImplementation(async (_path, sshRemoteId) => {
			if (sshRemoteId === 'remote-1') {
				return { isDirectory: false, isFile: true } as any;
			}
			if (sshRemoteId === 'remote-2') {
				return null as any;
			}
			throw new Error('remote stat failed');
		});
		const session = createSession({
			id: 'edit-session',
			name: 'Editable Agent',
			customPath: '/custom/bin/claude',
			customArgs: '--old',
			customEnvVars: { EXISTING_FLAG: '1' },
			customModel: 'claude-sonnet',
			customContextWindow: 100000,
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
			},
		});
		const duplicate = createSession({ id: 'duplicate-session', name: 'Duplicate Agent' });

		renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={session}
				existingSessions={[session, duplicate]}
			/>
		);

		await screen.findByDisplayValue('Editable Agent');
		await screen.findByText(/Path is a file, not a directory/);

		fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'remote-2' } });
		await screen.findByText(/Path not found or not accessible/);

		fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'remote-3' } });
		await waitFor(() => {
			expect(window.maestro.fs.stat).toHaveBeenCalledWith('/workspace/project', 'remote-3');
		});

		fireEvent.change(screen.getByLabelText('Agent Name'), {
			target: { value: 'Duplicate Agent' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
		expect(onSave).not.toHaveBeenCalled();

		fireEvent.change(screen.getByLabelText('Agent Name'), { target: { value: '   ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
		expect(onSave).not.toHaveBeenCalled();

		fireEvent.change(screen.getByLabelText('Agent Name'), {
			target: { value: 'Remote Renamed' },
		});
		fireEvent.keyDown(screen.getByRole('dialog', { name: /Edit Agent:/ }), {
			key: 'Enter',
			metaKey: true,
		});

		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
		expect(onSave).toHaveBeenCalledWith(
			'edit-session',
			'Remote Renamed',
			undefined,
			undefined,
			undefined,
			'/custom/bin/claude',
			'--old',
			{ EXISTING_FLAG: '1' },
			'claude-sonnet',
			100000,
			{
				enabled: true,
				remoteId: 'remote-3',
				workingDirOverride: '/workspace/project',
				syncHistory: false,
				shareHistoryToProjectDir: undefined,
			},
			undefined,
			undefined,
			undefined
		);
	});

	it('handles edit model refresh, detection refresh, and per-session config clearing paths', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['claude-sonnet']);
		const session = createSession({
			id: 'edit-local',
			name: 'Editable Agent',
			customPath: '/custom/bin/claude',
			customArgs: '--old',
			customEnvVars: { EXISTING_FLAG: '1' },
			customModel: 'claude-sonnet',
			customContextWindow: 100000,
		});

		renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={session}
				existingSessions={[session]}
			/>
		);

		await screen.findByText('Claude Code Settings');
		fireEvent.click(screen.getByText('Clear'));
		fireEvent.click(screen.getByText('Add Variable'));
		await screen.findByDisplayValue('NEW_VAR');
		removeAllEnvVars();

		vi.mocked(window.maestro.agents.setConfig).mockRejectedValueOnce(new Error('persist failed'));
		fireEvent.blur(screen.getByDisplayValue('/old/provider'));
		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to persist config for claude-code:',
				undefined,
				expect.any(Error)
			);
		});

		vi.mocked(window.maestro.agents.getModels).mockRejectedValueOnce(new Error('models failed'));
		fireEvent.click(screen.getByTitle('Refresh available models'));
		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to refresh models:',
				undefined,
				expect.any(Error)
			);
		});

		vi.mocked(window.maestro.agents.refresh).mockRejectedValueOnce(new Error('refresh failed'));
		fireEvent.click(screen.getByTitle('Re-detect agent path'));
		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to refresh agent:',
				undefined,
				expect.any(Error)
			);
		});

		fireEvent.change(screen.getByLabelText('Agent Name'), {
			target: { value: 'Edited Local' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

		expect(onSave).toHaveBeenCalledWith(
			'edit-local',
			'Edited Local',
			undefined,
			undefined,
			undefined,
			'/custom/bin/claude',
			'--old',
			undefined,
			'',
			100000,
			{ enabled: false, remoteId: null, shareHistoryToProjectDir: undefined },
			undefined,
			undefined,
			undefined
		);
	});

	it('creates a local agent from folder picker and keyboard shortcuts', async () => {
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/picked/project');

		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		const dialog = await screen.findByRole('dialog', { name: 'Create New Agent' });
		await screen.findByRole('option', { name: /Claude Code/i });

		fireEvent.keyDown(dialog, { key: 'o', metaKey: true });

		await waitFor(() => {
			expect(window.maestro.dialog.selectFolder).toHaveBeenCalledTimes(1);
			expect(screen.getByLabelText('Working Directory')).toHaveValue('/picked/project');
		});

		fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true });
		expect(onCreate).not.toHaveBeenCalled();

		fireEvent.change(screen.getByLabelText('Agent Name'), {
			target: { value: 'Keyboard Agent' },
		});
		fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true });

		await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
		expect(onCreate).toHaveBeenCalledWith(
			'claude-code',
			'/picked/project',
			'Keyboard Agent',
			undefined,
			undefined,
			'/custom/bin/claude',
			'--old',
			{ EXISTING_FLAG: '1' },
			'claude-sonnet',
			100000,
			'/old/provider',
			{ enabled: false, remoteId: null, shareHistoryToProjectDir: undefined },
			undefined,
			undefined,
			true,
			undefined,
			'dynamic'
		);
	});

	it('logs new-agent startup failures without blocking the modal shell', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.agents.detect).mockRejectedValueOnce(new Error('detect failed'));
		vi.mocked(window.maestro.sshRemote.getConfigs).mockRejectedValueOnce(
			new Error('ssh config failed')
		);

		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to load agents:',
				undefined,
				expect.any(Error)
			);
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to load SSH remote configs:',
				undefined,
				expect.any(Error)
			);
		});
		expect(screen.getByRole('button', { name: 'MAESTRO_SESSION_RESUMED' })).toBeInTheDocument();
	});

	it('preserves a pending SSH remote when keyboard-selecting an unavailable agent with a custom path', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [createRemote()],
		});
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			createAgent({
				id: 'opencode',
				name: 'OpenCode',
				binaryName: 'opencode',
				path: null,
				available: false,
			} as Partial<AgentConfig>),
		]);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
			customPath: '',
			customArgs: '',
			customEnvVars: {},
			model: 'opencode-default',
			contextWindow: 64000,
			providerPath: '',
		});

		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		await screen.findByText('SSH Remote Execution');
		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'remote-1' } });
		await waitFor(() => expect(window.maestro.agents.detect).toHaveBeenCalledWith('remote-1'));

		const agentRow = await screen.findByRole('option', { name: /OpenCode/i });
		fireEvent.keyDown(agentRow, { key: ' ' });

		const customPathInput = await screen.findByPlaceholderText('/path/to/opencode');
		fireEvent.change(customPathInput, { target: { value: '/remote/bin/opencode' } });
		fireEvent.blur(customPathInput);
		const argsInput = screen.getByPlaceholderText('--flag value --another-flag');
		fireEvent.change(argsInput, { target: { value: '--json' } });
		fireEvent.blur(argsInput);
		fireEvent.change(screen.getByLabelText('Agent Name'), {
			target: { value: 'Remote OpenCode' },
		});
		fireEvent.change(screen.getByLabelText('Working Directory'), {
			target: { value: '/srv/opencode' },
		});

		fireEvent.keyDown(screen.getByRole('dialog', { name: 'Create New Agent' }), {
			key: 'O',
			metaKey: true,
		});
		expect(window.maestro.dialog.selectFolder).not.toHaveBeenCalled();

		fireEvent.click(screen.getByText('Create Agent'));

		expect(onCreate).toHaveBeenCalledWith(
			'opencode',
			'/srv/opencode',
			'Remote OpenCode',
			undefined,
			undefined,
			'/remote/bin/opencode',
			'--json',
			undefined,
			'opencode-default',
			64000,
			undefined,
			{
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/srv/opencode',
				syncHistory: false,
				shareHistoryToProjectDir: undefined,
			},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined
		);
	});

	it('reuses cached model lists and refreshes detection from the expanded agent panel', async () => {
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['claude-sonnet']);

		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		const agentRow = await screen.findByRole('option', { name: /Claude Code/i });
		fireEvent.click(agentRow);
		await waitFor(() => expect(window.maestro.agents.getModels).toHaveBeenCalledTimes(1));

		fireEvent.click(agentRow);
		fireEvent.click(agentRow);
		expect(window.maestro.agents.getModels).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByTitle('Re-detect agent path'));
		await waitFor(() => expect(window.maestro.agents.refresh).toHaveBeenCalledWith('claude-code'));
	});

	it('handles edit startup errors, nudge truncation, and keyboard save', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.agents.getModels).mockRejectedValueOnce(
			new Error('initial models failed')
		);
		vi.mocked(window.maestro.sshRemote.getConfigs).mockRejectedValueOnce(
			new Error('ssh remotes failed')
		);
		const session = createSession({
			id: 'edit-errors',
			name: 'Editable Agent',
			customPath: '/custom/bin/claude',
			customArgs: '--old',
			customEnvVars: { EXISTING_FLAG: '1' },
			customModel: 'claude-sonnet',
			customContextWindow: 100000,
		});

		renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={session}
				existingSessions={[session]}
			/>
		);

		await screen.findByDisplayValue('claude-sonnet');
		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to load models:',
				undefined,
				expect.any(Error)
			);
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to load SSH remotes:',
				undefined,
				expect.any(Error)
			);
		});

		const longNudge = 'x'.repeat(1005);
		fireEvent.change(
			screen.getByPlaceholderText('Instructions appended to every message you send...'),
			{
				target: { value: longNudge },
			}
		);
		fireEvent.keyDown(screen.getByRole('dialog', { name: /Edit Agent:/ }), {
			key: 'Enter',
			metaKey: true,
		});

		expect(onSave).toHaveBeenCalledWith(
			'edit-errors',
			'Editable Agent',
			undefined,
			'x'.repeat(1000),
			undefined,
			'/custom/bin/claude',
			'--old',
			{ EXISTING_FLAG: '1' },
			'claude-sonnet',
			100000,
			{ enabled: false, remoteId: null, shareHistoryToProjectDir: undefined },
			undefined,
			undefined,
			undefined
		);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('covers closed edit rendering and edit custom field branches', async () => {
		const closedSession = createSession({ id: 'closed-edit' });
		const { container } = renderWithLayerStack(
			<EditAgentModal
				isOpen={false}
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={closedSession}
				existingSessions={[closedSession]}
			/>
		);
		expect(container.firstChild).toBeNull();

		const session = createSession({
			id: 'edit-fields',
			name: 'Editable Agent',
			customPath: '/custom/bin/claude',
			customArgs: '--old',
			customEnvVars: { NEW_VAR: 'existing' },
		});

		renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={session}
				existingSessions={[session]}
			/>
		);

		await screen.findByText('Claude Code Settings');
		fireEvent.blur(screen.getByDisplayValue('/custom/bin/claude'));
		fireEvent.blur(screen.getByDisplayValue('--old'));
		fireEvent.click(screen.getByText('Add Variable'));
		await screen.findByDisplayValue('NEW_VAR_1');
	});

	it('covers closed create rendering and new-agent refresh failure logging', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		const { container, unmount } = renderWithLayerStack(
			<NewInstanceModal
				isOpen={false}
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);
		expect(container.firstChild).toBeNull();
		unmount();

		vi.mocked(window.maestro.agents.refresh).mockRejectedValueOnce(new Error('refresh failed'));
		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		await screen.findByRole('option', { name: /Claude Code/i });
		fireEvent.click(screen.getByTitle('Refresh detection'));

		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to refresh agent:',
				undefined,
				expect.any(Error)
			);
		});
	});

	it('handles edit agents without model support and SSH sessions without a project root', async () => {
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([
			createAgent({
				capabilities: {
					...DEFAULT_AGENT_CAPABILITIES,
					supportsModelSelection: false,
				},
			}),
		]);
		const localSession = createSession({ id: 'no-model-edit' });
		const { unmount } = renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={localSession}
				existingSessions={[localSession]}
			/>
		);

		await screen.findByText('Claude Code Settings');
		await waitFor(() => expect(window.maestro.agents.detect).toHaveBeenCalled());
		expect(window.maestro.agents.getModels).not.toHaveBeenCalled();
		unmount();

		vi.clearAllMocks();
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([createAgent()]);
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [createRemote()],
		});
		const noRootSession = createSession({
			id: 'no-root-edit',
			projectRoot: '',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
			},
		});

		renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={noRootSession}
				existingSessions={[noRootSession]}
			/>
		);

		await screen.findByText('SSH Remote Execution');
		await waitFor(() => expect(window.maestro.sshRemote.getConfigs).toHaveBeenCalled());
		expect(window.maestro.fs.stat).not.toHaveBeenCalled();
	});

	it('shows successful edit remote validation and refreshes models and agent metadata', async () => {
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['claude-sonnet']);
		vi.mocked(window.maestro.agents.refresh).mockResolvedValue({
			agents: [createAgent({ path: '/new/bin/claude' })],
			debugInfo: null,
		});
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [createRemote()],
		});
		const session = createSession({
			id: 'edit-remote-success',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
			},
		});

		const { unmount } = renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={session}
				existingSessions={[session]}
			/>
		);

		await screen.findByText('Directory found on dev.example.test');
		fireEvent.click(screen.getByTitle('Refresh available models'));
		await waitFor(() =>
			expect(window.maestro.agents.getModels).toHaveBeenCalledWith('claude-code', true)
		);
		unmount();

		renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({ id: 'edit-local-refresh' })}
				existingSessions={[]}
			/>
		);
		await screen.findByText('Claude Code Settings');
		fireEvent.click(screen.getByTitle('Re-detect agent path'));
		await waitFor(() => expect(window.maestro.agents.refresh).toHaveBeenCalledWith('claude-code'));
	});

	it('duplicates a source session without optional per-agent overrides', async () => {
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		const source = createSession({
			id: 'source-minimal',
			groupId: 'minimal-group',
			name: 'Minimal Agent',
			cwd: '~',
			projectRoot: '/Users/integration',
			fullPath: '/Users/integration',
		});

		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
				sourceSession={source}
			/>
		);

		await screen.findByDisplayValue('Minimal Agent (Copy)');
		fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

		expect(onCreate).toHaveBeenCalledWith(
			'claude-code',
			'/Users/integration',
			'Minimal Agent (Copy)',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ enabled: false, remoteId: null, shareHistoryToProjectDir: undefined },
			undefined,
			'minimal-group',
			true,
			undefined,
			'dynamic'
		);
	});

	it('keeps mixed SSH detection results visible for a hostless remote and coming-soon agent', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [createRemote({ host: '' })],
		});
		vi.mocked(window.maestro.agents.detect).mockImplementation(async (sshRemoteId?: string) =>
			sshRemoteId
				? [
						createAgent({
							id: 'codex',
							name: 'Codex',
							binaryName: 'codex',
							path: null,
							available: false,
							error: 'codex missing',
						} as Partial<AgentConfig>),
						createAgent(),
						createAgent({
							id: 'future-agent',
							name: 'Future Agent',
							binaryName: 'future-agent',
							path: '/usr/local/bin/future-agent',
						} as Partial<AgentConfig>),
					]
				: [
						createAgent(),
						createAgent({
							id: 'future-agent',
							name: 'Future Agent',
							binaryName: 'future-agent',
							path: '/usr/local/bin/future-agent',
						} as Partial<AgentConfig>),
					]
		);

		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		await screen.findByText('SSH Remote Execution');
		const futureAgent = await screen.findByRole('option', { name: /Future Agent/i });
		expect(futureAgent).toHaveAttribute('tabindex', '-1');
		expect(screen.getByText('Coming Soon')).toBeInTheDocument();
		fireEvent.click(futureAgent);
		fireEvent.keyDown(futureAgent, { key: 'ArrowDown' });

		fireEvent.change(screen.getByRole('combobox'), { target: { value: 'remote-1' } });

		await waitFor(() => expect(window.maestro.agents.detect).toHaveBeenCalledWith('remote-1'));
		expect(screen.queryByText('Unable to Connect')).not.toBeInTheDocument();
		expect(await screen.findByRole('option', { name: /Codex/i })).toBeInTheDocument();
		expect(
			screen.getByPlaceholderText('Enter remote path (e.g., /home/user/project)')
		).toBeInTheDocument();
		expect(
			screen.getByTitle('Folder picker unavailable for SSH remote. Enter the remote path manually.')
		).toBeDisabled();
	});

	it('uses empty defaults when refresh detection returns a provider without loaded config', async () => {
		vi.mocked(window.maestro.agents.refresh).mockResolvedValueOnce({
			agents: [
				createAgent({
					id: 'codex',
					name: 'Codex',
					binaryName: 'codex',
					path: '/usr/local/bin/codex',
				}),
			],
			debugInfo: null,
		});

		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[]}
			/>
		);

		await screen.findByRole('option', { name: /Claude Code/i });
		fireEvent.click(screen.getByTitle('Refresh detection'));
		const codexAgent = await screen.findByRole('option', { name: /Codex/i });
		fireEvent.click(codexAgent);

		await screen.findByDisplayValue('claude-sonnet');
		fireEvent.click(screen.getByText('Add Variable'));
		await screen.findByDisplayValue('NEW_VAR');
		fireEvent.blur(screen.getByDisplayValue('claude-sonnet'));

		await waitFor(() =>
			expect(window.maestro.agents.setConfig).toHaveBeenCalledWith('codex', {
				model: 'claude-sonnet',
			})
		);
	});

	it('saves edit sessions with absent model defaults after missing refresh detection results', async () => {
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		vi.mocked(window.maestro.agents.refresh).mockResolvedValueOnce({
			agents: [],
			debugInfo: null,
		});
		const session = createSession({
			id: 'edit-empty-config',
			name: 'Empty Config Agent',
		});

		renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={session}
				existingSessions={[session]}
			/>
		);

		await screen.findByText('Claude Code Settings');
		fireEvent.click(screen.getByTitle('Re-detect agent path'));
		await waitFor(() => expect(window.maestro.agents.refresh).toHaveBeenCalledWith('claude-code'));
		await waitFor(() => expect(screen.queryByText('Claude Code Settings')).not.toBeInTheDocument());

		fireEvent.change(screen.getByLabelText('Agent Name'), {
			target: { value: 'Empty Config Saved' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

		expect(onSave).toHaveBeenCalledWith(
			'edit-empty-config',
			'Empty Config Saved',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			'',
			undefined,
			{ enabled: false, remoteId: null, shareHistoryToProjectDir: undefined },
			undefined,
			undefined,
			undefined
		);
	});

	it('renders nothing for an open edit modal without a session', () => {
		const { container } = renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={null}
				existingSessions={[]}
			/>
		);

		expect(container.firstChild).toBeNull();
	});

	it('shows generic edit SSH validation labels when a remote has no host', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [createRemote({ host: '' })],
		});
		const session = createSession({
			id: 'edit-hostless-remote',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
			},
		});
		const { unmount } = renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={session}
				existingSessions={[session]}
			/>
		);

		await screen.findByText('Directory found on remote');
		unmount();

		vi.mocked(window.maestro.fs.stat).mockResolvedValue(null as any);
		renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={createSession({
					id: 'edit-hostless-remote-missing',
					sessionSshRemoteConfig: {
						enabled: true,
						remoteId: 'remote-1',
					},
				})}
				existingSessions={[]}
			/>
		);

		await screen.findByText(/Path not found or not accessible/);
	});

	it('handles create keyboard no-ops, duplicate names, and ctrl-submit', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({ success: false });
		const existing = createSession({
			id: 'existing-agent',
			name: 'Existing Agent',
			cwd: '/other/project',
			projectRoot: '/other/project',
		});

		renderWithLayerStack(
			<NewInstanceModal
				isOpen
				onClose={onClose}
				onCreate={onCreate}
				theme={theme}
				existingSessions={[existing]}
			/>
		);

		const dialog = await screen.findByRole('dialog', { name: 'Create New Agent' });
		fireEvent.keyDown(dialog, { key: 'a' });
		fireEvent.keyDown(dialog, { key: 'o', ctrlKey: true });
		await waitFor(() => expect(window.maestro.dialog.selectFolder).toHaveBeenCalledTimes(1));
		expect(screen.getByLabelText('Working Directory')).toHaveValue('');

		fireEvent.keyDown(dialog, { key: 'Escape' });
		fireEvent.change(screen.getByLabelText('Agent Name'), {
			target: { value: 'Existing Agent' },
		});
		fireEvent.change(screen.getByLabelText('Working Directory'), {
			target: { value: '/new/project' },
		});
		await screen.findByText('An agent named "Existing Agent" already exists');

		fireEvent.change(screen.getByLabelText('Agent Name'), {
			target: { value: 'Ctrl Agent' },
		});
		fireEvent.keyDown(dialog, { key: 'Enter', ctrlKey: true });

		expect(onCreate).toHaveBeenCalledWith(
			'claude-code',
			'/new/project',
			'Ctrl Agent',
			undefined,
			undefined,
			'/custom/bin/claude',
			'--old',
			{ EXISTING_FLAG: '1' },
			'claude-sonnet',
			100000,
			'/old/provider',
			{ enabled: false, remoteId: null, shareHistoryToProjectDir: undefined },
			undefined,
			undefined,
			true,
			undefined,
			'dynamic'
		);
	});

	it('handles edit no-op branches for missing agents, clipboard failure, and invalid keyboard saves', async () => {
		vi.mocked(window.maestro.agents.detect).mockResolvedValueOnce([]);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValueOnce({});
		const missingAgentSession = createSession({ id: 'missing-agent-edit' });
		const { unmount } = renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={missingAgentSession}
				existingSessions={[missingAgentSession]}
			/>
		);

		await waitFor(() => expect(window.maestro.agents.detect).toHaveBeenCalled());
		expect(screen.queryByText('Claude Code Settings')).not.toBeInTheDocument();
		unmount();

		vi.clearAllMocks();
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([createAgent()]);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
			model: 'claude-sonnet',
			contextWindow: 100000,
		});
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({ success: false });
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard blocked')) },
		});
		const session = createSession({ id: 'copy-fail-edit', name: 'Copy Fail Agent' });
		const duplicate = createSession({ id: 'duplicate-edit', name: 'Duplicate Agent' });

		renderWithLayerStack(
			<EditAgentModal
				isOpen
				onClose={onClose}
				onSave={onSave}
				theme={theme}
				session={session}
				existingSessions={[session, duplicate]}
			/>
		);

		const dialog = await screen.findByRole('dialog', { name: /Edit Agent:/ });
		await screen.findByText('Claude Code Settings');
		fireEvent.keyDown(dialog, { key: 'a' });
		fireEvent.click(screen.getByTitle('Click to copy: copy-fail-edit'));
		await waitFor(() =>
			expect(navigator.clipboard.writeText).toHaveBeenCalledWith('copy-fail-edit')
		);
		expect(screen.queryByTitle('Copied!')).not.toBeInTheDocument();

		fireEvent.blur(screen.getByDisplayValue('claude-sonnet'));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(window.maestro.agents.setConfig).not.toHaveBeenCalled();

		fireEvent.change(screen.getByLabelText('Agent Name'), {
			target: { value: 'Duplicate Agent' },
		});
		fireEvent.keyDown(dialog, { key: 'Enter', ctrlKey: true });
		fireEvent.keyDown(dialog, { key: 'Escape' });
		expect(onSave).not.toHaveBeenCalled();
	});
});
