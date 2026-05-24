import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentCreationDialog } from '../../../renderer/components/AgentCreationDialog';
import type { AgentConfig, Theme } from '../../../renderer/types';
import type { RegisteredRepository, SymphonyIssue } from '../../../shared/symphony-types';

const mocks = vi.hoisted(() => ({
	registerLayer: vi.fn(() => 'agent-creation-layer'),
	unregisterLayer: vi.fn(),
	refreshAgent: vi.fn(),
	getModels: vi.fn(),
	homeDir: vi.fn(),
	selectFolder: vi.fn(),
	isBetaAgent: vi.fn((agentId: string) => agentId === 'factory-droid'),
}));

type AgentConfigurationState = {
	detectedAgents: AgentConfig[];
	isDetecting: boolean;
	refreshAgent: () => Promise<void>;
};

let agentConfigurationState: AgentConfigurationState;

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mocks.registerLayer,
		unregisterLayer: mocks.unregisterLayer,
	}),
}));

vi.mock('../../../renderer/hooks/agent/useAgentConfiguration', () => ({
	useAgentConfiguration: (options: { agentFilter?: (agent: AgentConfig) => boolean }) => {
		options.agentFilter?.({
			id: 'terminal',
			name: 'Terminal',
			available: true,
			capabilities: { supportsBatchMode: true },
		});
		options.agentFilter?.({
			id: 'unavailable',
			name: 'Unavailable',
			available: false,
			capabilities: { supportsBatchMode: true },
		});
		options.agentFilter?.({
			id: 'hidden',
			name: 'Hidden',
			available: true,
			hidden: true,
			capabilities: { supportsBatchMode: true },
		});
		options.agentFilter?.({
			id: 'no-batch',
			name: 'No Batch',
			available: true,
			capabilities: { supportsBatchMode: false },
		});
		options.agentFilter?.({
			id: 'claude-code',
			name: 'Claude Code',
			available: true,
			capabilities: { supportsBatchMode: true },
		});
		return agentConfigurationState;
	},
}));

vi.mock('../../../shared/agentMetadata', () => ({
	isBetaAgent: mocks.isBetaAgent,
}));

vi.mock('../../../renderer/components/shared/AgentConfigPanel', () => ({
	AgentConfigPanel: ({
		agent,
		onCustomPathChange,
		onCustomPathClear,
		onCustomArgsChange,
		onCustomArgsClear,
		onEnvVarAdd,
		onEnvVarValueChange,
		onEnvVarKeyChange,
		onEnvVarRemove,
		onConfigChange,
		onRefreshModels,
		onRefreshAgent,
		customEnvVars,
		loadingModels,
		availableModels,
	}: {
		agent: AgentConfig;
		onCustomPathChange: (value: string) => void;
		onCustomPathClear: () => void;
		onCustomArgsChange: (value: string) => void;
		onCustomArgsClear: () => void;
		onEnvVarAdd: () => void;
		onEnvVarValueChange: (key: string, value: string) => void;
		onEnvVarKeyChange: (oldKey: string, newKey: string, value: string) => void;
		onEnvVarRemove: (key: string) => void;
		onConfigChange: (key: string, value: unknown) => void;
		onRefreshModels: () => void;
		onRefreshAgent: () => void;
		customEnvVars: Record<string, string>;
		loadingModels: boolean;
		availableModels: string[];
	}) => (
		<div data-testid={`agent-config-panel-${agent.id}`}>
			<span>{loadingModels ? 'Loading models' : `Models: ${availableModels.join(',')}`}</span>
			<span>Env keys: {Object.keys(customEnvVars).join(',')}</span>
			<button type="button" onClick={() => onCustomPathChange('/custom/agent')}>
				Set custom path
			</button>
			<button type="button" onClick={onCustomPathClear}>
				Clear custom path
			</button>
			<button type="button" onClick={() => onCustomArgsChange('--fast')}>
				Set custom args
			</button>
			<button type="button" onClick={onCustomArgsClear}>
				Clear custom args
			</button>
			<button type="button" onClick={onEnvVarAdd}>
				Add env
			</button>
			<button type="button" onClick={() => onEnvVarValueChange('NEW_VAR', 'occupied')}>
				Set new env value
			</button>
			<button type="button" onClick={() => onEnvVarKeyChange('NEW_VAR', 'API_KEY', 'secret')}>
				Rename env
			</button>
			<button type="button" onClick={() => onEnvVarValueChange('API_KEY', 'updated')}>
				Update env value
			</button>
			<button type="button" onClick={onEnvVarAdd}>
				Add second env
			</button>
			<button type="button" onClick={() => onEnvVarKeyChange('NEW_VAR_1', 'SECOND_KEY', 'two')}>
				Rename second env
			</button>
			<button type="button" onClick={() => onEnvVarRemove('SECOND_KEY')}>
				Remove second env
			</button>
			<button type="button" onClick={() => onEnvVarRemove('API_KEY')}>
				Remove env
			</button>
			<button type="button" onClick={() => onConfigChange('model', 'gpt-test')}>
				Set model config
			</button>
			<button type="button" onClick={onRefreshModels}>
				Refresh models
			</button>
			<button type="button" onClick={onRefreshAgent}>
				Refresh agent
			</button>
		</div>
	),
}));

vi.mock('lucide-react', () => {
	const Icon = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="icon" className={className} style={style} />
	);
	return {
		Music: Icon,
		X: Icon,
		Loader2: Icon,
		Bot: Icon,
		Settings: Icon,
		FolderOpen: Icon,
		ChevronRight: Icon,
		RefreshCw: Icon,
	};
});

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#151515',
		bgActivity: '#202020',
		textMain: '#f5f5f5',
		textDim: '#999999',
		accent: '#3b82f6',
		accentDim: '#1d4ed8',
		accentText: '#ffffff',
		accentForeground: '#000000',
		border: '#333333',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
	},
};

const repo: RegisteredRepository = {
	slug: 'runmaestro/maestro',
	name: 'Maestro',
	description: 'AI agent orchestration',
	url: 'https://github.com/runmaestro/maestro',
	category: 'Developer Tools',
	maintainer: { name: 'Maestro' },
	isActive: true,
	addedAt: '2026-05-01T00:00:00.000Z',
};

const issue: SymphonyIssue = {
	number: 42,
	title: 'Add contribution workflow',
	body: 'Please run these documents',
	url: 'https://api.github.com/repos/runmaestro/maestro/issues/42',
	htmlUrl: 'https://github.com/runmaestro/maestro/issues/42',
	author: 'octocat',
	createdAt: '2026-05-01T00:00:00.000Z',
	updatedAt: '2026-05-02T00:00:00.000Z',
	documentPaths: [
		{ name: 'plan', path: 'docs/plan.md', isExternal: false },
		{ name: 'verify', path: 'docs/verify.md', isExternal: false },
	],
	labels: [{ name: 'good first issue', color: '00ff00' }],
	status: 'available',
};

const claudeAgent: AgentConfig = {
	id: 'claude-code',
	name: 'Claude Code',
	available: true,
	capabilities: {
		supportsBatchMode: true,
		supportsModelSelection: true,
	},
};

const betaAgent: AgentConfig = {
	id: 'factory-droid',
	name: 'Factory Droid',
	available: true,
	capabilities: {
		supportsBatchMode: true,
		supportsModelSelection: false,
	},
};

function renderDialog(props: Partial<React.ComponentProps<typeof AgentCreationDialog>> = {}) {
	return render(
		<AgentCreationDialog
			theme={theme}
			isOpen
			onClose={vi.fn()}
			repo={repo}
			issue={issue}
			onCreateAgent={vi.fn().mockResolvedValue({ success: true })}
			{...props}
		/>
	);
}

describe('AgentCreationDialog', () => {
	const originalMaestro = window.maestro;

	beforeEach(() => {
		vi.clearAllMocks();
		agentConfigurationState = {
			detectedAgents: [claudeAgent, betaAgent],
			isDetecting: false,
			refreshAgent: mocks.refreshAgent,
		};
		mocks.homeDir.mockResolvedValue('/Users/tester');
		mocks.selectFolder.mockResolvedValue('/chosen/workdir');
		mocks.getModels.mockResolvedValue(['sonnet', 'opus']);
		mocks.refreshAgent.mockResolvedValue(undefined);
		window.maestro = {
			...window.maestro,
			fs: { ...window.maestro?.fs, homeDir: mocks.homeDir },
			dialog: { ...window.maestro?.dialog, selectFolder: mocks.selectFolder },
			agents: { ...window.maestro?.agents, getModels: mocks.getModels },
		};
	});

	afterEach(() => {
		cleanup();
		window.maestro = originalMaestro;
	});

	it('returns null when closed and registers the modal layer when open', async () => {
		const { rerender } = renderDialog({ isOpen: false });
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		expect(mocks.registerLayer).not.toHaveBeenCalled();

		rerender(
			<AgentCreationDialog
				theme={theme}
				isOpen
				onClose={vi.fn()}
				repo={repo}
				issue={issue}
				onCreateAgent={vi.fn()}
			/>
		);

		expect(
			await screen.findByRole('dialog', { name: 'Create Symphony Agent' })
		).toBeInTheDocument();
		expect(mocks.registerLayer).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'modal',
				ariaLabel: 'Create Agent for Symphony Contribution',
				blocksLowerLayers: true,
			})
		);
	});

	it('renders loading and no-compatible-agent states', async () => {
		agentConfigurationState = {
			detectedAgents: [],
			isDetecting: true,
			refreshAgent: mocks.refreshAgent,
		};
		const { rerender } = renderDialog();
		expect(document.querySelector('.animate-spin')).toBeInTheDocument();

		agentConfigurationState = {
			detectedAgents: [],
			isDetecting: false,
			refreshAgent: mocks.refreshAgent,
		};
		rerender(
			<AgentCreationDialog
				theme={theme}
				isOpen
				onClose={vi.fn()}
				repo={repo}
				issue={issue}
				onCreateAgent={vi.fn()}
			/>
		);

		expect(screen.getByText('No compatible AI agents detected.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Create Agent/i })).toBeDisabled();
		expect(
			await screen.findByDisplayValue('/Users/tester/Maestro-Symphony/runmaestro-maestro-42')
		).toBeInTheDocument();
	});

	it('prefills defaults, browses folders, expands agent config, and creates an agent', async () => {
		const onCreateAgent = vi.fn().mockResolvedValue({ success: true });
		renderDialog({ onCreateAgent });

		expect(screen.getByText('Maestro')).toBeInTheDocument();
		expect(screen.getByText('#42: Add contribution workflow')).toBeInTheDocument();
		expect(screen.getByText('2 Auto Run documents')).toBeInTheDocument();
		expect(await screen.findByDisplayValue('Symphony: runmaestro/maestro #42')).toBeInTheDocument();
		expect(
			screen.getByDisplayValue('/Users/tester/Maestro-Symphony/runmaestro-maestro-42')
		).toBeInTheDocument();

		fireEvent.click(screen.getByText('Claude Code'));
		expect(mocks.getModels).toHaveBeenCalledWith('claude-code', false);
		expect(screen.getByTestId('agent-config-panel-claude-code')).toBeInTheDocument();
		await screen.findByText('Models: sonnet,opus');
		fireEvent.click(screen.getByText('Claude Code'));
		expect(mocks.getModels).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByText('Claude Code'));

		fireEvent.click(screen.getByRole('button', { name: 'Set custom path' }));
		fireEvent.click(screen.getByRole('button', { name: 'Set custom args' }));
		fireEvent.click(screen.getByRole('button', { name: 'Add env' }));
		fireEvent.click(screen.getByRole('button', { name: 'Rename env' }));
		fireEvent.click(screen.getByRole('button', { name: 'Update env value' }));
		fireEvent.click(screen.getByRole('button', { name: 'Set model config' }));

		fireEvent.change(screen.getByDisplayValue('Symphony: runmaestro/maestro #42'), {
			target: { value: 'Custom Symphony Agent' },
		});
		fireEvent.click(screen.getByTitle('Browse for folder'));
		await waitFor(() => {
			expect(mocks.selectFolder).toHaveBeenCalledOnce();
		});
		expect(screen.getByDisplayValue('/chosen/workdir')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));
		await waitFor(() => {
			expect(onCreateAgent).toHaveBeenCalledWith(
				expect.objectContaining({
					agentType: 'claude-code',
					sessionName: 'Custom Symphony Agent',
					workingDirectory: '/chosen/workdir',
					repo,
					issue,
					customPath: '/custom/agent',
					customArgs: '--fast',
					customEnvVars: { API_KEY: 'updated' },
					agentConfig: { model: 'gpt-test' },
				})
			);
		});
	});

	it('handles singular document copy, beta selection, folder cancel, and fallback create errors', async () => {
		const oneDocIssue = {
			...issue,
			documentPaths: [{ name: 'plan', path: 'docs/plan.md', isExternal: false }],
		};
		mocks.selectFolder.mockResolvedValueOnce(null);
		const onCreateAgent = vi.fn().mockResolvedValue({ success: false });
		renderDialog({ issue: oneDocIssue, onCreateAgent });

		expect(await screen.findByText('1 Auto Run document')).toBeInTheDocument();
		expect(
			await screen.findByDisplayValue('/Users/tester/Maestro-Symphony/runmaestro-maestro-42')
		).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Browse for folder'));
		await waitFor(() => {
			expect(mocks.selectFolder).toHaveBeenCalledOnce();
		});
		expect(
			screen.getByDisplayValue('/Users/tester/Maestro-Symphony/runmaestro-maestro-42')
		).toBeInTheDocument();

		fireEvent.click(screen.getByText('Factory Droid'));
		expect(screen.getByTestId('agent-config-panel-factory-droid')).toBeInTheDocument();
		expect(mocks.getModels).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));
		await waitFor(() => {
			expect(screen.getByText('Failed to create agent session')).toBeInTheDocument();
		});
		expect(onCreateAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentType: 'factory-droid',
			})
		);
	});

	it('clears optional custom config and handles non-Error creation throws', async () => {
		const onCreateAgent = vi.fn().mockRejectedValue('not an error object');
		renderDialog({ onCreateAgent });

		await screen.findByDisplayValue('Symphony: runmaestro/maestro #42');
		fireEvent.click(screen.getByText('Claude Code'));

		fireEvent.click(screen.getByRole('button', { name: 'Set custom path' }));
		fireEvent.click(screen.getByRole('button', { name: 'Clear custom path' }));
		fireEvent.click(screen.getByRole('button', { name: 'Set custom args' }));
		fireEvent.click(screen.getByRole('button', { name: 'Clear custom args' }));
		fireEvent.click(screen.getByRole('button', { name: 'Add env' }));
		fireEvent.click(screen.getByRole('button', { name: 'Rename env' }));
		fireEvent.click(screen.getByRole('button', { name: 'Add second env' }));
		fireEvent.click(screen.getByRole('button', { name: 'Rename second env' }));
		fireEvent.click(screen.getByRole('button', { name: 'Remove second env' }));
		fireEvent.click(screen.getByRole('button', { name: 'Remove env' }));

		fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));
		await waitFor(() => {
			expect(screen.getByText('Failed to create agent')).toBeInTheDocument();
		});
		expect(onCreateAgent).toHaveBeenCalledWith(
			expect.not.objectContaining({
				customPath: expect.anything(),
				customArgs: expect.anything(),
				customEnvVars: expect.anything(),
			})
		);
	});

	it('handles home directory fallback, beta labels, refresh actions, and creation errors', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.homeDir.mockRejectedValue(new Error('home unavailable'));
		mocks.refreshAgent.mockRejectedValueOnce(new Error('refresh failed'));
		mocks.getModels.mockRejectedValueOnce(new Error('models failed'));
		const onCreateAgent = vi.fn().mockResolvedValue({ success: false, error: 'Creation failed' });
		renderDialog({ onCreateAgent });

		expect(
			await screen.findByDisplayValue('~/Maestro-Symphony/runmaestro-maestro-42')
		).toBeInTheDocument();
		expect(screen.getByText('Beta')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Claude Code'));
		await waitFor(() => {
			expect(consoleError).toHaveBeenCalledWith(
				'Failed to load models for',
				'claude-code',
				expect.any(Error)
			);
		});

		fireEvent.click(screen.getAllByTitle('Refresh detection')[0]);
		await waitFor(() => {
			expect(consoleError).toHaveBeenCalledWith('Failed to refresh agent:', expect.any(Error));
		});

		fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));
		await waitFor(() => {
			expect(screen.getByText('Creation failed')).toBeInTheDocument();
		});

		consoleError.mockRestore();
	});

	it('shows thrown creation errors and closes through cancel and header actions', async () => {
		const onClose = vi.fn();
		const onCreateAgent = vi.fn().mockRejectedValue(new Error('Thrown failure'));
		renderDialog({ onClose, onCreateAgent });

		await screen.findByDisplayValue('Symphony: runmaestro/maestro #42');
		fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));
		await waitFor(() => {
			expect(screen.getByText('Thrown failure')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onClose).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByTitle('Close (Esc)'));
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('closes through the layer stack escape handler', async () => {
		const onClose = vi.fn();
		const { unmount } = renderDialog({ onClose });

		await screen.findByRole('dialog', { name: 'Create Symphony Agent' });

		const layerConfig = mocks.registerLayer.mock.calls[0][0];
		layerConfig.onEscape();

		expect(onClose).toHaveBeenCalledOnce();

		unmount();
		expect(mocks.unregisterLayer).toHaveBeenCalledWith('agent-creation-layer');
	});

	it('selects agents from keyboard activation while ignoring child key events', async () => {
		renderDialog();

		await screen.findByDisplayValue('Symphony: runmaestro/maestro #42');
		const claudeRow = screen.getByText('Claude Code').closest('[role="button"]')!;
		const factoryRow = screen.getByText('Factory Droid').closest('[role="button"]')!;

		fireEvent.keyDown(screen.getByText('Factory Droid'), { key: 'Enter' });
		expect(screen.queryByTestId('agent-config-panel-factory-droid')).not.toBeInTheDocument();

		fireEvent.keyDown(factoryRow, { key: 'Enter' });
		expect(screen.getByTestId('agent-config-panel-factory-droid')).toBeInTheDocument();

		fireEvent.keyDown(claudeRow, { key: ' ' });
		expect(mocks.getModels).toHaveBeenCalledWith('claude-code', false);
		expect(screen.getByTestId('agent-config-panel-claude-code')).toBeInTheDocument();
		await screen.findByText('Models: sonnet,opus');
	});

	it('does not select an agent for non-activation row key presses', async () => {
		renderDialog();

		await screen.findByDisplayValue('Symphony: runmaestro/maestro #42');
		const factoryRow = screen.getByText('Factory Droid').closest('[role="button"]')!;

		fireEvent.keyDown(factoryRow, { key: 'ArrowDown' });

		expect(screen.queryByTestId('agent-config-panel-factory-droid')).not.toBeInTheDocument();
	});

	it('refreshes models from the expanded config panel and uses typed working directory', async () => {
		const onCreateAgent = vi.fn().mockResolvedValue({ success: true });
		mocks.getModels.mockResolvedValueOnce(null).mockResolvedValueOnce(['forced-model']);
		renderDialog({ onCreateAgent });

		await screen.findByDisplayValue('Symphony: runmaestro/maestro #42');
		fireEvent.click(screen.getByText('Claude Code'));

		await screen.findByText('Models:');
		fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
		await screen.findByText('Models: forced-model');
		expect(mocks.getModels).toHaveBeenLastCalledWith('claude-code', true);

		fireEvent.click(screen.getByRole('button', { name: 'Refresh agent' }));
		await waitFor(() => {
			expect(mocks.refreshAgent).toHaveBeenCalledOnce();
		});

		fireEvent.change(
			screen.getByDisplayValue('/Users/tester/Maestro-Symphony/runmaestro-maestro-42'),
			{
				target: { value: '/typed/workdir' },
			}
		);
		fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));

		await waitFor(() => {
			expect(onCreateAgent).toHaveBeenCalledWith(
				expect.objectContaining({
					workingDirectory: '/typed/workdir',
				})
			);
		});
	});

	it('generates unique env keys and removes the final env var from create payloads', async () => {
		const onCreateAgent = vi.fn().mockResolvedValue({ success: true });
		renderDialog({ onCreateAgent });

		await screen.findByDisplayValue('Symphony: runmaestro/maestro #42');
		fireEvent.click(screen.getByText('Claude Code'));
		await screen.findByText('Models: sonnet,opus');

		fireEvent.click(screen.getByRole('button', { name: 'Add env' }));
		await screen.findByText('Env keys: NEW_VAR');
		fireEvent.click(screen.getByRole('button', { name: 'Set new env value' }));
		fireEvent.click(screen.getByRole('button', { name: 'Add second env' }));
		await screen.findByText('Env keys: NEW_VAR,NEW_VAR_1');
		fireEvent.click(screen.getByRole('button', { name: 'Rename env' }));
		await screen.findByText('Env keys: NEW_VAR_1,API_KEY');
		fireEvent.click(screen.getByRole('button', { name: 'Rename second env' }));
		await screen.findByText('Env keys: API_KEY,SECOND_KEY');
		fireEvent.click(screen.getByRole('button', { name: 'Remove second env' }));
		await screen.findByText('Env keys: API_KEY');
		fireEvent.click(screen.getByRole('button', { name: 'Remove env' }));
		await screen.findByText('Env keys:');

		fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));

		await waitFor(() => {
			expect(onCreateAgent).toHaveBeenCalledWith(
				expect.not.objectContaining({
					customEnvVars: expect.anything(),
				})
			);
		});
	});

	it('keeps the create guard from submitting without a trimmed session name', async () => {
		const onCreateAgent = vi.fn().mockResolvedValue({ success: true });
		renderDialog({ onCreateAgent });

		const sessionNameInput = await screen.findByDisplayValue('Symphony: runmaestro/maestro #42');
		fireEvent.change(sessionNameInput, { target: { value: '   ' } });

		const createButton = screen.getByRole('button', { name: /Create Agent/i });
		expect(createButton).toBeDisabled();

		createButton.removeAttribute('disabled');
		(createButton as HTMLButtonElement).disabled = false;
		fireEvent.click(createButton);

		expect(onCreateAgent).not.toHaveBeenCalled();
	});
});
