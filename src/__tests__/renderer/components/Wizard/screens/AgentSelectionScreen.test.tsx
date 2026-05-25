import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AgentLogo,
	AgentSelectionScreen,
} from '../../../../../renderer/components/Wizard/screens/AgentSelectionScreen';
import { WizardProvider, useWizard } from '../../../../../renderer/components/Wizard/WizardContext';
import type { AgentConfig, Theme } from '../../../../../renderer/types';

vi.mock('lucide-react', () => ({
	Check: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="check-icon" className={className} style={style} />
	),
	X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="x-icon" className={className} style={style} />
	),
	Settings: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="settings-icon" className={className} style={style} />
	),
	ArrowLeft: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="arrow-left-icon" className={className} style={style} />
	),
	AlertTriangle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="alert-triangle-icon" className={className} style={style} />
	),
	Info: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="info-icon" className={className} style={style} />
	),
	Wand2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="wand-icon" className={className} style={style} />
	),
}));

vi.mock('../../../../../renderer/components/shared/AgentConfigPanel', () => ({
	AgentConfigPanel: (props: any) => (
		<div data-testid="agent-config-panel">
			<div data-testid="config-agent-name">{props.agent.name}</div>
			<div data-testid="custom-path">{props.customPath}</div>
			<div data-testid="custom-args">{props.customArgs}</div>
			<div data-testid="env-var-count">{Object.keys(props.customEnvVars).length}</div>
			<div data-testid="model-count">{props.availableModels.length}</div>
			<div data-testid="loading-models">{String(props.loadingModels)}</div>
			<div data-testid="refreshing-agent">{String(props.refreshingAgent)}</div>
			<button onClick={() => props.onCustomPathChange('/opt/codex')}>Set Custom Path</button>
			<button onClick={() => props.onCustomPathBlur()}>Blur Custom Path</button>
			<button onClick={() => props.onCustomPathClear()}>Clear Custom Path</button>
			<button onClick={() => props.onCustomArgsChange('--verbose')}>Set Custom Args</button>
			<button onClick={() => props.onCustomArgsClear()}>Clear Custom Args</button>
			<button onClick={() => props.onEnvVarAdd()}>Add Env Var</button>
			<button onClick={() => props.onEnvVarValueChange('NEW_VAR', 'enabled')}>
				Set Default Env Value
			</button>
			<button onClick={() => props.onEnvVarKeyChange('NEW_VAR', 'API_KEY', '')}>
				Rename Env Var
			</button>
			<button onClick={() => props.onEnvVarValueChange('API_KEY', 'secret')}>Set Env Value</button>
			<button onClick={() => props.onEnvVarRemove('API_KEY')}>Remove Env Var</button>
			<button onClick={() => props.onConfigChange('model', 'gpt-5')}>Set Model Config</button>
			<button onClick={() => props.onConfigBlur('model', 'gpt-5')}>Blur Model Config</button>
			<button onClick={() => props.onRefreshModels()}>Refresh Models</button>
			<button onClick={() => props.onRefreshAgent()}>Refresh Agent</button>
		</div>
	),
}));

const mockTheme: Theme = {
	id: 'custom',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		bgActivity: '#202020',
		border: '#303030',
		textMain: '#f8f8f8',
		textDim: '#a0a0a0',
		accent: '#4f8cff',
		accentDim: '#4f8cff33',
		accentText: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#3fb950',
		warning: '#d29922',
		error: '#f85149',
	},
};

const agent = (
	id: string,
	name: string,
	available: boolean,
	overrides: Partial<AgentConfig> = {}
): AgentConfig => ({
	id,
	name,
	command: id,
	args: [],
	available,
	path: available ? `/usr/local/bin/${id}` : undefined,
	hidden: false,
	capabilities: {},
	...overrides,
});

const defaultAgents: AgentConfig[] = [
	agent('claude-code', 'Claude Code', true),
	agent('codex', 'Codex', true, { capabilities: { supportsModelSelection: true } as any }),
	agent('opencode', 'OpenCode', false),
	agent('factory-droid', 'Factory Droid', false),
	agent('terminal', 'Terminal', true, { hidden: true }),
];

const mockMaestro = {
	agents: {
		detect: vi.fn(),
		getConfig: vi.fn(),
		getModels: vi.fn(),
		setCustomPath: vi.fn(),
		setConfig: vi.fn(),
	},
	sshRemote: {
		getConfigs: vi.fn(),
	},
	sessions: {
		getAll: vi.fn(),
	},
	settings: {
		get: vi.fn(),
		set: vi.fn(),
	},
};

const renderScreen = () =>
	render(
		<WizardProvider>
			<AgentSelectionScreen theme={mockTheme} />
		</WizardProvider>
	);

function InitialRemoteScreen({
	config,
}: {
	config: { enabled: boolean; remoteId: string | null; workingDirOverride?: string };
}) {
	const { setSessionSshRemoteConfig } = useWizard();
	const [ready, setReady] = React.useState(false);

	React.useEffect(() => {
		setSessionSshRemoteConfig(config);
		setReady(true);
	}, [config, setSessionSshRemoteConfig]);

	return ready ? <AgentSelectionScreen theme={mockTheme} /> : null;
}

const renderScreenWithInitialRemote = (config: {
	enabled: boolean;
	remoteId: string | null;
	workingDirOverride?: string;
}) =>
	render(
		<WizardProvider>
			<InitialRemoteScreen config={config} />
		</WizardProvider>
	);

function InitialSelectedAgentScreen({ agentId }: { agentId: string }) {
	const { setSelectedAgent } = useWizard();
	const [ready, setReady] = React.useState(false);

	React.useEffect(() => {
		setSelectedAgent(agentId as any);
		setReady(true);
	}, [agentId, setSelectedAgent]);

	return ready ? <AgentSelectionScreen theme={mockTheme} /> : null;
}

const renderScreenWithInitialSelectedAgent = (agentId: string) =>
	render(
		<WizardProvider>
			<InitialSelectedAgentScreen agentId={agentId} />
		</WizardProvider>
	);

const deferred = <T,>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

beforeEach(() => {
	(window as any).maestro = mockMaestro;
	mockMaestro.agents.detect.mockResolvedValue(defaultAgents);
	mockMaestro.agents.getConfig.mockResolvedValue({ model: 'claude-3-5-sonnet' });
	mockMaestro.agents.getModels.mockResolvedValue(['gpt-5', 'gpt-5-mini']);
	mockMaestro.agents.setCustomPath.mockResolvedValue(undefined);
	mockMaestro.agents.setConfig.mockResolvedValue(undefined);
	mockMaestro.sshRemote.getConfigs.mockResolvedValue({ success: true, configs: [] });
	mockMaestro.sessions.getAll.mockResolvedValue([]);
	mockMaestro.settings.get.mockResolvedValue(undefined);
	mockMaestro.settings.set.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe('AgentLogo', () => {
	it('renders a fallback mark for unknown agent ids', () => {
		const { container } = render(
			<AgentLogo
				agentId="unknown-agent"
				supported
				detected
				brandColor="#ff00ff"
				theme={mockTheme}
			/>
		);

		expect(container.querySelector('div.w-12.h-12')).toBeInTheDocument();
	});

	it('uses theme accent fallback for detected supported logos and dims unavailable logos', () => {
		const { container: supportedContainer } = render(
			<AgentLogo agentId="claude-code" supported detected theme={mockTheme} />
		);
		const supportedPath = supportedContainer.querySelector('path');
		expect(supportedPath).toHaveAttribute('fill', mockTheme.colors.accent);

		const { container: unavailableContainer } = render(
			<AgentLogo agentId="claude-code" supported detected={false} theme={mockTheme} />
		);
		const unavailablePath = unavailableContainer.querySelector('path');
		expect(unavailablePath).toHaveAttribute('fill', mockTheme.colors.textDim);
	});
});

describe('AgentSelectionScreen', () => {
	it('shows unavailable, beta, and coming-soon states and selects the focused available agent', async () => {
		mockMaestro.agents.detect.mockResolvedValue([
			agent('claude-code', 'Claude Code', false),
			agent('codex', 'Codex', true),
			agent('opencode', 'OpenCode', true),
			agent('factory-droid', 'Factory Droid', false),
		]);
		mockMaestro.sessions.getAll.mockResolvedValue([{ id: 'existing-session' }]);

		renderScreen();

		await waitFor(() => {
			expect(screen.getByText('Create a Maestro Agent')).toBeInTheDocument();
		});

		expect(screen.getByRole('button', { name: 'Claude Code (not installed)' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Gemini CLI (coming soon)' })).toBeDisabled();
		expect(screen.getAllByText('Beta')).toHaveLength(2);
		expect(screen.getAllByText('Soon')).toHaveLength(2);
		expect(screen.getByText('/wizard')).toBeInTheDocument();

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Codex' })).toHaveFocus();
		});

		const container = screen.getByText('Create a Maestro Agent').closest('div[tabindex]');
		fireEvent.keyDown(container!, { key: ' ' });

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Codex' })).toHaveAttribute('aria-pressed', 'true');
		});

		fireEvent.change(screen.getByLabelText('Agent name'), {
			target: { value: 'Migration Plan' },
		});

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
		});
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		await waitFor(() => {
			expect(mockMaestro.settings.set).toHaveBeenCalledWith(
				'wizardResumeState',
				expect.objectContaining({
					currentStep: 'directory-selection',
					selectedAgent: 'codex',
					agentName: 'Migration Plan',
				})
			);
		});
	});

	it('passes SSH remote selection to agent detection and shows remote connection failures', async () => {
		mockMaestro.sshRemote.getConfigs.mockResolvedValue({
			success: true,
			configs: [{ id: 'remote-1', name: 'Build Box', host: 'build.example.com' }],
		});
		mockMaestro.agents.detect.mockImplementation(async (sshRemoteId?: string) => {
			if (sshRemoteId === 'remote-1') {
				return [
					agent('claude-code', 'Claude Code', false, { error: 'ssh connect failed' } as any),
					agent('codex', 'Codex', false, { error: 'ssh connect failed' } as any),
				];
			}
			return defaultAgents;
		});

		renderScreen();

		await waitFor(() => {
			expect(screen.getByLabelText('Agent location')).toBeInTheDocument();
		});

		fireEvent.change(screen.getByLabelText('Agent location'), {
			target: { value: 'remote-1' },
		});

		await waitFor(() => {
			expect(screen.getByText('Unable to Connect')).toBeInTheDocument();
		});
		expect(screen.getByText('ssh connect failed')).toBeInTheDocument();
		expect(mockMaestro.agents.detect).toHaveBeenCalledWith('remote-1');

		fireEvent.change(screen.getByLabelText('Agent location'), {
			target: { value: '' },
		});

		await waitFor(() => {
			expect(screen.queryByText('Unable to Connect')).not.toBeInTheDocument();
		});
		expect(mockMaestro.agents.detect).toHaveBeenCalledWith(undefined);
	});

	it('reports rejected SSH detection and SSH remote loading errors', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		mockMaestro.sshRemote.getConfigs.mockRejectedValueOnce(new Error('config read failed'));
		mockMaestro.sessions.getAll.mockRejectedValueOnce(new Error('sessions read failed'));

		const { unmount } = renderScreen();

		await waitFor(() => {
			expect(screen.getByText('Create a Maestro Agent')).toBeInTheDocument();
		});
		expect(consoleError).toHaveBeenCalledWith('Failed to load SSH remotes:', expect.any(Error));
		expect(consoleError).toHaveBeenCalledWith(
			'Failed to check existing agents:',
			expect.any(Error)
		);

		unmount();
		vi.clearAllMocks();

		mockMaestro.sshRemote.getConfigs.mockResolvedValue({
			success: true,
			configs: [{ id: 'remote-1', name: 'Build Box', host: 'build.example.com' }],
		});
		mockMaestro.agents.detect.mockImplementation(async (sshRemoteId?: string) => {
			if (sshRemoteId === 'remote-1') {
				throw new Error('ssh auth denied');
			}
			return defaultAgents;
		});

		renderScreen();

		await waitFor(() => {
			expect(screen.getByLabelText('Agent location')).toBeInTheDocument();
		});

		fireEvent.change(screen.getByLabelText('Agent location'), {
			target: { value: 'remote-1' },
		});

		await waitFor(() => {
			expect(screen.getByText('Unable to Connect')).toBeInTheDocument();
		});
		expect(screen.getByText('ssh auth denied')).toBeInTheDocument();
		expect(consoleError).toHaveBeenCalledWith('Failed to detect agents:', expect.any(Error));
	});

	it('ignores async detection, remote, and session results after unmount', async () => {
		const detect = deferred<AgentConfig[]>();
		const configs = deferred<{ success: boolean; configs: any[] }>();
		const sessions = deferred<any[]>();
		mockMaestro.agents.detect.mockReturnValue(detect.promise);
		mockMaestro.sshRemote.getConfigs.mockReturnValue(configs.promise);
		mockMaestro.sessions.getAll.mockReturnValue(sessions.promise);

		const { unmount } = renderScreen();
		unmount();

		detect.resolve(defaultAgents);
		configs.resolve({ success: true, configs: [{ id: 'remote-1', name: 'Remote' }] });
		sessions.resolve([{ id: 'session-1' }]);
		await Promise.resolve();

		expect(mockMaestro.agents.detect).toHaveBeenCalled();
		expect(mockMaestro.sshRemote.getConfigs).toHaveBeenCalled();
		expect(mockMaestro.sessions.getAll).toHaveBeenCalled();
	});

	it('ignores rejected detection after unmount', async () => {
		const detect = deferred<AgentConfig[]>();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		mockMaestro.agents.detect.mockReturnValue(detect.promise);

		const { unmount } = renderScreen();
		unmount();

		detect.reject(new Error('late failure'));
		await Promise.resolve();

		expect(consoleError).toHaveBeenCalledWith('Failed to detect agents:', expect.any(Error));
		expect(screen.queryByText(/Failed to detect available agents/)).not.toBeInTheDocument();
	});

	it('reports local detection failures without a remote connection banner', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		mockMaestro.agents.detect.mockRejectedValue(new Error('local detector failed'));

		renderScreen();

		expect(
			await screen.findByText('Failed to detect available agents. Please try again.')
		).toBeInTheDocument();
		expect(screen.queryByText(/Unable to connect to remote host/)).not.toBeInTheDocument();
		expect(consoleError).toHaveBeenCalledWith('Failed to detect agents:', expect.any(Error));
	});

	it('continues when SSH remote loading returns an unsuccessful result', async () => {
		mockMaestro.sshRemote.getConfigs.mockResolvedValue({ success: false });

		renderScreen();

		await waitFor(() => {
			expect(screen.getByText('Create a Maestro Agent')).toBeInTheDocument();
		});
		expect(mockMaestro.sshRemote.getConfigs).toHaveBeenCalled();
	});

	it('keeps mixed remote detection results on the grid without a connection-failure banner', async () => {
		mockMaestro.sshRemote.getConfigs.mockResolvedValue({
			success: true,
			configs: [{ id: 'remote-1', name: 'Build Box', host: 'build.example.com' }],
		});
		mockMaestro.agents.detect.mockImplementation(async (sshRemoteId?: string) => {
			if (sshRemoteId === 'remote-1') {
				return [
					agent('claude-code', 'Claude Code', false, { error: 'claude missing remotely' } as any),
					agent('codex', 'Codex', true, {
						capabilities: { supportsModelSelection: true } as any,
					}),
				];
			}
			return defaultAgents;
		});

		renderScreen();

		await waitFor(() => {
			expect(screen.getByLabelText('Agent location')).toBeInTheDocument();
		});

		fireEvent.change(screen.getByLabelText('Agent location'), {
			target: { value: 'remote-1' },
		});

		await waitFor(() => {
			expect(mockMaestro.agents.detect).toHaveBeenCalledWith('remote-1');
		});
		expect(screen.queryByText('Unable to Connect')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Codex' })).toBeEnabled();
	});

	it('loads and refreshes model lists against the selected remote while using empty config defaults', async () => {
		mockMaestro.sshRemote.getConfigs.mockResolvedValue({
			success: true,
			configs: [{ id: 'remote-1', name: 'Build Box', host: 'build.example.com' }],
		});
		mockMaestro.agents.getConfig.mockResolvedValueOnce(null);

		renderScreen();

		await waitFor(() => {
			expect(screen.getByLabelText('Agent location')).toBeInTheDocument();
		});
		fireEvent.change(screen.getByLabelText('Agent location'), {
			target: { value: 'remote-1' },
		});

		await waitFor(() => {
			expect(mockMaestro.agents.detect).toHaveBeenCalledWith('remote-1');
		});
		fireEvent.click(screen.getAllByTitle('Customize agent settings')[1]);

		await waitFor(() => {
			expect(screen.getByText('Configure Codex')).toBeInTheDocument();
		});
		expect(screen.getByTestId('model-count')).toHaveTextContent('2');
		expect(mockMaestro.agents.getConfig).toHaveBeenCalledWith('codex');
		expect(mockMaestro.agents.getModels).toHaveBeenCalledWith('codex', false, 'remote-1');

		fireEvent.click(screen.getByText('Blur Custom Path'));
		await waitFor(() => {
			expect(mockMaestro.agents.setCustomPath).toHaveBeenCalledWith('codex', null);
		});

		fireEvent.click(screen.getByText('Refresh Models'));

		await waitFor(() => {
			expect(mockMaestro.agents.getModels).toHaveBeenCalledWith('codex', true, 'remote-1');
		});
	});

	it('opens a placeholder config panel for supported tiles missing from detection results', async () => {
		mockMaestro.agents.detect.mockResolvedValue([agent('claude-code', 'Claude Code', true)]);

		renderScreen();

		await waitFor(() => {
			expect(screen.getAllByTitle('Customize agent settings')[1]).toBeInTheDocument();
		});
		fireEvent.click(screen.getAllByTitle('Customize agent settings')[1]);

		await waitFor(() => {
			expect(screen.getByText('Configure Codex')).toBeInTheDocument();
		});
		expect(screen.getByTestId('config-agent-name')).toHaveTextContent('Codex');
		expect(mockMaestro.agents.getModels).not.toHaveBeenCalled();
	});

	it('initializes enabled remote config without a selected remote id from wizard state', async () => {
		mockMaestro.sshRemote.getConfigs.mockResolvedValue({
			success: true,
			configs: [{ id: 'remote-1', name: 'Build Box', host: 'build.example.com' }],
		});

		renderScreenWithInitialRemote({ enabled: true, remoteId: null });

		await waitFor(() => {
			expect(screen.getByLabelText('Agent location')).toHaveValue('');
		});
		expect(mockMaestro.agents.detect).toHaveBeenCalledWith(undefined);

		fireEvent.click(screen.getAllByTitle('Customize agent settings')[1]);

		await waitFor(() => {
			expect(screen.getByText('Configure Codex')).toBeInTheDocument();
		});
		expect(screen.getByLabelText('Agent location')).toHaveValue('');
		expect(mockMaestro.agents.getModels).toHaveBeenCalledWith('codex', false, undefined);

		fireEvent.click(screen.getByText('Refresh Models'));

		await waitFor(() => {
			expect(mockMaestro.agents.getModels).toHaveBeenCalledWith('codex', true, undefined);
		});
	});

	it('uses a generic connection message for non-Error remote detection failures', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		mockMaestro.sshRemote.getConfigs.mockResolvedValue({
			success: true,
			configs: [{ id: 'remote-1', name: 'Build Box', host: 'build.example.com' }],
		});
		mockMaestro.agents.detect.mockImplementation(async (sshRemoteId?: string) => {
			if (sshRemoteId === 'remote-1') {
				throw 'offline';
			}
			return defaultAgents;
		});

		renderScreen();

		await waitFor(() => {
			expect(screen.getByLabelText('Agent location')).toBeInTheDocument();
		});
		fireEvent.change(screen.getByLabelText('Agent location'), {
			target: { value: 'remote-1' },
		});

		await waitFor(() => {
			expect(screen.getByText('Unable to Connect')).toBeInTheDocument();
		});
		expect(screen.getByText('Unknown connection error')).toBeInTheDocument();
		expect(consoleError).toHaveBeenCalledWith('Failed to detect agents:', 'offline');
	});

	it('focuses the name field for a single available agent and clears focus styling on blur', async () => {
		mockMaestro.agents.detect.mockResolvedValue([
			agent('claude-code', 'Claude Code', true),
			agent('codex', 'Codex', false),
			agent('opencode', 'OpenCode', false),
			agent('factory-droid', 'Factory Droid', false),
		]);

		renderScreen();

		const nameInput = await screen.findByLabelText('Agent name');
		await waitFor(() => {
			expect(nameInput).toHaveFocus();
		});

		fireEvent.blur(nameInput);

		await waitFor(() => {
			expect(nameInput).toHaveStyle({ boxShadow: 'none' });
		});
	});

	it('ignores unrelated keys while the name field is focused', async () => {
		mockMaestro.agents.detect.mockResolvedValue([
			agent('claude-code', 'Claude Code', true),
			agent('codex', 'Codex', false),
			agent('opencode', 'OpenCode', false),
			agent('factory-droid', 'Factory Droid', false),
		]);

		renderScreen();

		const nameInput = await screen.findByLabelText('Agent name');
		await waitFor(() => {
			expect(nameInput).toHaveFocus();
		});

		fireEvent.keyDown(nameInput, { key: 'Escape' });

		expect(mockMaestro.settings.set).not.toHaveBeenCalledWith(
			'wizardResumeState',
			expect.objectContaining({ currentStep: 'directory-selection' })
		);
		expect(nameInput).toHaveFocus();
	});

	it('falls back to the first tile when restored selected agent is not in the grid', async () => {
		mockMaestro.agents.detect.mockResolvedValue([
			agent('claude-code', 'Claude Code', true),
			agent('codex', 'Codex', true, { capabilities: { supportsModelSelection: true } as any }),
			agent('opencode', 'OpenCode', true),
			agent('factory-droid', 'Factory Droid', true),
		]);

		renderScreenWithInitialSelectedAgent('missing-agent');

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveFocus();
		});
	});

	it('selects an available tile by mouse click and leaves unavailable tiles disabled', async () => {
		renderScreen();

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Codex' })).toBeInTheDocument();
		});

		fireEvent.click(screen.getByRole('button', { name: 'Codex' }));

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Codex' })).toHaveAttribute('aria-pressed', 'true');
		});

		expect(screen.getByRole('button', { name: 'OpenCode (not installed)' })).toBeDisabled();
	});

	it('supports grid keyboard navigation and name-field Enter continue', async () => {
		mockMaestro.agents.detect.mockResolvedValue([
			agent('claude-code', 'Claude Code', true),
			agent('codex', 'Codex', true, { capabilities: { supportsModelSelection: true } as any }),
			agent('opencode', 'OpenCode', true),
			agent('factory-droid', 'Factory Droid', true),
		]);

		renderScreen();

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveFocus();
		});

		const container = screen.getByText('Create a Maestro Agent').closest('div[tabindex]')!;
		fireEvent.keyDown(container, { key: 'ArrowDown' });
		expect(screen.getByRole('button', { name: 'Factory Droid' })).toHaveFocus();

		fireEvent.keyDown(container, { key: 'ArrowUp' });
		expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveFocus();

		fireEvent.keyDown(container, { key: 'ArrowRight' });
		expect(screen.getByRole('button', { name: 'Codex' })).toHaveFocus();

		fireEvent.keyDown(container, { key: 'ArrowLeft' });
		expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveFocus();

		fireEvent.keyDown(container, { key: 'Tab' });
		expect(screen.getByLabelText('Agent name')).toHaveFocus();

		fireEvent.keyDown(container, { key: 'Tab', shiftKey: true });
		fireEvent.change(screen.getByLabelText('Agent name'), {
			target: { value: 'Keyboard Agent' },
		});
		fireEvent.focus(screen.getByLabelText('Agent name'));
		fireEvent.keyDown(screen.getByLabelText('Agent name'), { key: 'Enter' });

		await waitFor(() => {
			expect(mockMaestro.settings.set).toHaveBeenCalledWith(
				'wizardResumeState',
				expect.objectContaining({
					currentStep: 'directory-selection',
					agentName: 'Keyboard Agent',
				})
			);
		});
	});

	it('keeps grid keyboard focus at edges and selects the focused tile with Space', async () => {
		mockMaestro.agents.detect.mockResolvedValue([
			agent('claude-code', 'Claude Code', true),
			agent('codex', 'Codex', true, { capabilities: { supportsModelSelection: true } as any }),
			agent('opencode', 'OpenCode', true),
			agent('factory-droid', 'Factory Droid', true),
		]);

		renderScreen();

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveFocus();
		});

		const container = screen.getByText('Create a Maestro Agent').closest('div[tabindex]')!;
		fireEvent.keyDown(container, { key: 'ArrowUp' });
		expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveFocus();

		fireEvent.keyDown(container, { key: 'ArrowLeft' });
		expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveFocus();

		fireEvent.keyDown(container, { key: 'ArrowRight' });
		expect(screen.getByRole('button', { name: 'Codex' })).toHaveFocus();

		fireEvent.keyDown(container, { key: 'ArrowRight' });
		expect(screen.getByRole('button', { name: 'OpenCode' })).toHaveFocus();

		fireEvent.keyDown(container, { key: 'ArrowRight' });
		expect(screen.getByRole('button', { name: 'OpenCode' })).toHaveFocus();

		fireEvent.keyDown(container, { key: ' ' });
		expect(screen.getByRole('button', { name: 'OpenCode' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);

		fireEvent.keyDown(container, { key: 'ArrowLeft' });
		fireEvent.keyDown(container, { key: 'ArrowLeft' });
		expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveFocus();

		fireEvent.keyDown(container, { key: 'ArrowDown' });
		expect(screen.getByRole('button', { name: 'Factory Droid' })).toHaveFocus();

		fireEvent.keyDown(container, { key: 'ArrowDown' });
		expect(screen.getByRole('button', { name: 'Factory Droid' })).toHaveFocus();

		fireEvent.keyDown(container, { key: 'ArrowRight' });
		fireEvent.keyDown(container, { key: ' ' });
		expect(screen.getByRole('button', { name: /Gemini CLI/ })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'OpenCode' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);

		fireEvent.keyDown(container, { key: 'Tab', shiftKey: true });
		expect(screen.getByLabelText('Agent name')).not.toHaveFocus();
	});

	it('selects the focused tile with Enter and proceeds when the wizard is already valid', async () => {
		mockMaestro.agents.detect.mockResolvedValue([
			agent('claude-code', 'Claude Code', true),
			agent('codex', 'Codex', true, { capabilities: { supportsModelSelection: true } as any }),
			agent('opencode', 'OpenCode', true),
			agent('factory-droid', 'Factory Droid', true),
		]);

		renderScreen();

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveFocus();
		});

		fireEvent.change(screen.getByLabelText('Agent name'), {
			target: { value: 'Tile Agent' },
		});

		const container = screen.getByText('Create a Maestro Agent').closest('div[tabindex]')!;
		fireEvent.keyDown(container, { key: 'ArrowRight' });
		fireEvent.keyDown(container, { key: 'Enter' });

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Codex' })).toHaveAttribute('aria-pressed', 'true');
			expect(mockMaestro.settings.set).toHaveBeenCalledWith(
				'wizardResumeState',
				expect.objectContaining({
					currentStep: 'directory-selection',
					selectedAgent: 'codex',
					agentName: 'Tile Agent',
				})
			);
		});
	});

	it('opens the config panel, saves custom settings, refreshes detection, and returns to grid', async () => {
		renderScreen();

		await waitFor(() => {
			expect(screen.getByText('Create a Maestro Agent')).toBeInTheDocument();
		});

		fireEvent.click(screen.getAllByTitle('Customize agent settings')[1]);

		await waitFor(() => {
			expect(screen.getByText('Configure Codex')).toBeInTheDocument();
		});
		expect(mockMaestro.agents.getConfig).toHaveBeenCalledWith('codex');
		expect(mockMaestro.agents.getModels).toHaveBeenCalledWith('codex', false, undefined);
		expect(screen.getByTestId('model-count')).toHaveTextContent('2');

		fireEvent.click(screen.getByText('Set Custom Path'));
		await waitFor(() => expect(screen.getByTestId('custom-path')).toHaveTextContent('/opt/codex'));
		fireEvent.click(screen.getByText('Blur Custom Path'));
		await waitFor(() => {
			expect(mockMaestro.agents.setCustomPath).toHaveBeenCalledWith('codex', '/opt/codex');
		});

		fireEvent.click(screen.getByText('Clear Custom Path'));
		await waitFor(() => {
			expect(mockMaestro.agents.setCustomPath).toHaveBeenCalledWith('codex', null);
		});

		fireEvent.click(screen.getByText('Set Custom Args'));
		await waitFor(() => {
			expect(screen.getByTestId('custom-args')).toHaveTextContent('--verbose');
		});
		fireEvent.click(screen.getByText('Clear Custom Args'));
		await waitFor(() => {
			expect(screen.getByTestId('custom-args')).toBeEmptyDOMElement();
		});

		fireEvent.click(screen.getByText('Add Env Var'));
		await waitFor(() => expect(screen.getByTestId('env-var-count')).toHaveTextContent('1'));
		fireEvent.click(screen.getByText('Rename Env Var'));
		fireEvent.click(screen.getByText('Set Env Value'));
		fireEvent.click(screen.getByText('Remove Env Var'));
		await waitFor(() => expect(screen.getByTestId('env-var-count')).toHaveTextContent('0'));

		fireEvent.click(screen.getByText('Set Model Config'));
		fireEvent.click(screen.getByText('Blur Model Config'));
		await waitFor(() => {
			expect(mockMaestro.agents.setConfig).toHaveBeenCalledWith('codex', { model: 'gpt-5' });
		});

		fireEvent.click(screen.getByText('Refresh Models'));
		await waitFor(() => {
			expect(mockMaestro.agents.getModels).toHaveBeenCalledWith('codex', true, undefined);
		});

		const detectCallCountBeforeRefresh = mockMaestro.agents.detect.mock.calls.length;
		fireEvent.click(screen.getByText('Refresh Agent'));
		await waitFor(() => {
			expect(mockMaestro.agents.detect.mock.calls.length).toBeGreaterThan(
				detectCallCountBeforeRefresh
			);
		});

		fireEvent.click(screen.getByText('Done'));

		await waitFor(() => {
			expect(screen.getByText('Create a Maestro Agent')).toBeInTheDocument();
		});
		expect(screen.queryByTestId('agent-config-panel')).not.toBeInTheDocument();
	});

	it('opens config from the customize keyboard shortcut, toggles remote location, and returns on Done', async () => {
		mockMaestro.sshRemote.getConfigs.mockResolvedValue({
			success: true,
			configs: [{ id: 'remote-1', host: 'builder.example.com' }],
		});

		renderScreen();

		await waitFor(() => {
			expect(screen.getAllByTitle('Customize agent settings')[1]).toBeInTheDocument();
		});

		fireEvent.keyDown(screen.getAllByTitle('Customize agent settings')[1], { key: 'Enter' });

		await waitFor(() => {
			expect(screen.getByText('Configure Codex')).toBeInTheDocument();
		});
		expect(screen.getByRole('option', { name: 'builder.example.com' })).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText('Agent location'), {
			target: { value: 'remote-1' },
		});

		await waitFor(() => {
			expect(mockMaestro.agents.detect).toHaveBeenCalledWith('remote-1');
		});
		await waitFor(() => {
			expect(screen.getByLabelText('Agent location')).toHaveValue('remote-1');
		});

		fireEvent.change(screen.getByLabelText('Agent location'), {
			target: { value: '' },
		});

		await waitFor(() => {
			expect(screen.getByLabelText('Agent location')).toHaveValue('');
		});

		fireEvent.change(screen.getByLabelText('Agent location'), {
			target: { value: 'remote-1' },
		});

		await waitFor(() => {
			expect(screen.getByText('Done')).toBeInTheDocument();
		});
		fireEvent.click(screen.getByText('Done'));

		await waitFor(() => {
			expect(screen.getByText('Create a Maestro Agent')).toBeInTheDocument();
		});
	});

	it('ignores unrelated customize key presses and opens config with Space', async () => {
		renderScreen();

		await waitFor(() => {
			expect(screen.getAllByTitle('Customize agent settings')[1]).toBeInTheDocument();
		});

		const codexCustomize = screen.getAllByTitle('Customize agent settings')[1];
		fireEvent.keyDown(codexCustomize, { key: 'Escape' });
		expect(screen.queryByTestId('agent-config-panel')).not.toBeInTheDocument();
		expect(mockMaestro.agents.getConfig).not.toHaveBeenCalled();

		fireEvent.keyDown(codexCustomize, { key: ' ' });

		await waitFor(() => {
			expect(screen.getByText('Configure Codex')).toBeInTheDocument();
		});
		expect(mockMaestro.agents.getConfig).toHaveBeenCalledWith('codex');
	});

	it('handles model load failures, model refresh failures, and duplicate env var names', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		mockMaestro.agents.getModels.mockRejectedValueOnce(new Error('initial models down'));

		renderScreen();

		await waitFor(() => {
			expect(screen.getAllByTitle('Customize agent settings')[1]).toBeInTheDocument();
		});

		fireEvent.click(screen.getAllByTitle('Customize agent settings')[1]);

		await waitFor(() => {
			expect(screen.getByText('Configure Codex')).toBeInTheDocument();
		});
		expect(consoleError).toHaveBeenCalledWith('Failed to load models:', expect.any(Error));
		expect(screen.getByTestId('model-count')).toHaveTextContent('0');

		fireEvent.click(screen.getByText('Add Env Var'));
		await waitFor(() => {
			expect(screen.getByTestId('env-var-count')).toHaveTextContent('1');
		});
		fireEvent.click(screen.getByText('Set Default Env Value'));
		fireEvent.click(screen.getByText('Add Env Var'));
		await waitFor(() => {
			expect(screen.getByTestId('env-var-count')).toHaveTextContent('2');
		});

		mockMaestro.agents.getModels.mockRejectedValueOnce(new Error('refresh models down'));
		fireEvent.click(screen.getByText('Refresh Models'));

		await waitFor(() => {
			expect(consoleError).toHaveBeenCalledWith('Failed to refresh models:', expect.any(Error));
		});
	});
});
