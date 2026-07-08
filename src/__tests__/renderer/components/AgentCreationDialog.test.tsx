import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { AgentCreationDialog } from '../../../renderer/components/AgentCreationDialog';
import { mockTheme } from '../../helpers/mockTheme';
import type { AgentConfig } from '../../../renderer/types';
import type { RegisteredRepository, SymphonyIssue } from '../../../shared/symphony-types';

const agentConfigState = vi.hoisted(() => ({
	isDetecting: false,
	detectedAgents: [] as AgentConfig[],
	refreshAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
}));

vi.mock('../../../renderer/hooks/agent/useAgentConfiguration', () => ({
	useAgentConfiguration: vi.fn(() => agentConfigState),
}));

vi.mock('../../../renderer/components/shared/AgentConfigPanel', () => ({
	AgentConfigPanel: (props: any) => (
		<div data-testid={`agent-config-${props.agent.id}`}>
			<input
				aria-label="Custom path"
				value={props.customPath}
				onChange={(e) => props.onCustomPathChange(e.target.value)}
			/>
			<input
				aria-label="Custom args"
				value={props.customArgs}
				onChange={(e) => props.onCustomArgsChange(e.target.value)}
			/>
			<button onClick={props.onEnvVarAdd}>Add env</button>
			<button onClick={() => props.onEnvVarKeyChange('NEW_VAR', 'API_KEY', 'fixture-value')}>
				Set env key
			</button>
			<button onClick={() => props.onEnvVarValueChange('API_KEY', 'fixture-value-2')}>
				Set env value
			</button>
			<button onClick={() => props.onConfigChange('model', 'opus')}>Set model</button>
			<label>
				Batch Mode
				<input
					type="checkbox"
					checked={props.enableMaestroP}
					onChange={(e) => props.onEnableMaestroPChange(e.target.checked)}
				/>
			</label>
			<button onClick={() => props.onMaestroPModeChange('interactive')}>TUI mode</button>
			<input
				aria-label="Maestro path"
				value={props.maestroPPath}
				onChange={(e) => props.onMaestroPPathChange(e.target.value)}
			/>
			<button onClick={props.onRefreshModels}>Refresh models</button>
			<button onClick={props.onRefreshAgent}>Refresh agent</button>
			<span>{props.detectedMaestroPPath}</span>
		</div>
	),
}));

const repo: RegisteredRepository = {
	slug: 'owner/project',
	name: 'Owner Project',
	description: 'Test repository',
	url: 'https://github.com/owner/project',
	category: 'developer-tools',
	maintainer: { name: 'Maintainer' },
	isActive: true,
	addedAt: '2026-06-18T00:00:00Z',
};

const issue: SymphonyIssue = {
	number: 42,
	title: 'Fix orchestration',
	body: 'Use these docs.',
	url: 'https://github.com/owner/project/issues/42',
	htmlUrl: 'https://github.com/owner/project/issues/42',
	author: 'octocat',
	labels: [],
	documentPaths: [
		{ name: 'plan.md', path: 'plan.md', isExternal: false },
		{ name: 'checks.md', path: 'checks.md', isExternal: false },
	],
	createdAt: '2026-06-18T00:00:00Z',
	updatedAt: '2026-06-18T00:00:00Z',
	status: 'available',
};

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		binaryName: 'claude',
		available: true,
		hidden: false,
		capabilities: {
			supportsBatchMode: true,
			supportsModelSelection: true,
		},
		configOptions: [
			{
				key: 'profile',
				label: 'Profile',
				type: 'select',
				description: 'Profile',
				default: '',
				dynamic: true,
			},
		],
		...overrides,
	} as AgentConfig;
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof AgentCreationDialog>> = {}) {
	const props = {
		theme: mockTheme,
		isOpen: true,
		onClose: vi.fn(),
		repo,
		issue,
		onCreateAgent: vi.fn().mockResolvedValue({ success: true }),
		...overrides,
	};
	render(<AgentCreationDialog {...props} />);
	return props;
}

describe('AgentCreationDialog', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		agentConfigState.isDetecting = false;
		agentConfigState.detectedAgents = [agent()];
		agentConfigState.refreshAgent.mockReset().mockResolvedValue(undefined);
		(window as any).maestro.fs.homeDir.mockResolvedValue('/Users/tester');
		(window as any).maestro.dialog.selectFolder.mockResolvedValue('/tmp/symphony');
		(window as any).maestro.agents.getMaestroPDetectedPath.mockResolvedValue(
			'/usr/local/bin/maestro-p'
		);
		(window as any).maestro.agents.getModels.mockResolvedValue(['opus', 'sonnet']);
		(window as any).maestro.agents.getConfigOptions.mockResolvedValue(['work', 'review']);
	});

	it('renders nothing when closed', () => {
		renderDialog({ isOpen: false });
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('pre-fills issue context, session name, working directory, and creates an agent', async () => {
		const props = renderDialog();

		expect(await screen.findByDisplayValue('Symphony: owner/project #42')).toBeInTheDocument();
		expect(
			await screen.findByDisplayValue('/Users/tester/Maestro-Symphony/owner-project-42')
		).toBeInTheDocument();
		expect(screen.getByText('Owner Project')).toBeInTheDocument();
		expect(screen.getByText('#42: Fix orchestration')).toBeInTheDocument();
		expect(screen.getByText('2 Auto Run documents')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));

		await waitFor(() =>
			expect(props.onCreateAgent).toHaveBeenCalledWith(
				expect.objectContaining({
					agentType: 'claude-code',
					sessionName: 'Symphony: owner/project #42',
					workingDirectory: '/Users/tester/Maestro-Symphony/owner-project-42',
					repo,
					issue,
				})
			)
		);
	});

	it('lets the user browse for a working directory', async () => {
		renderDialog();

		await screen.findByDisplayValue('/Users/tester/Maestro-Symphony/owner-project-42');
		fireEvent.click(screen.getByTitle('Browse for folder'));

		expect(await screen.findByDisplayValue('/tmp/symphony')).toBeInTheDocument();
	});

	it('expands an agent and includes custom config in the create payload', async () => {
		const props = renderDialog();

		fireEvent.click(await screen.findByRole('button', { name: /Claude Code/i }));
		fireEvent.change(screen.getByLabelText('Custom path'), { target: { value: '/bin/claude' } });
		fireEvent.change(screen.getByLabelText('Custom args'), { target: { value: '--dangerous' } });
		fireEvent.click(screen.getByText('Add env'));
		fireEvent.click(screen.getByText('Set env key'));
		fireEvent.click(screen.getByText('Set env value'));
		fireEvent.click(screen.getByText('Set model'));
		fireEvent.click(screen.getByLabelText('Batch Mode'));
		fireEvent.click(screen.getByText('TUI mode'));
		fireEvent.change(screen.getByLabelText('Maestro path'), {
			target: { value: '/opt/maestro-p' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));

		await waitFor(() =>
			expect(props.onCreateAgent).toHaveBeenCalledWith(
				expect.objectContaining({
					customPath: '/bin/claude',
					customArgs: '--dangerous',
					customEnvVars: { API_KEY: 'fixture-value-2' },
					agentConfig: { model: 'opus' },
					enableMaestroP: true,
					maestroPMode: 'interactive',
					maestroPPath: '/opt/maestro-p',
				})
			)
		);
	});

	it('loads agent models, dynamic options, and refreshes detection from the expanded panel', async () => {
		renderDialog();

		fireEvent.click(await screen.findByRole('button', { name: /Claude Code/i }));
		fireEvent.click(screen.getByText('Refresh models'));
		fireEvent.click(screen.getByText('Refresh agent'));

		await waitFor(() =>
			expect((window as any).maestro.agents.getModels).toHaveBeenCalledWith('claude-code', true)
		);
		expect((window as any).maestro.agents.getConfigOptions).toHaveBeenCalledWith(
			'claude-code',
			'profile'
		);
		expect(agentConfigState.refreshAgent).toHaveBeenCalledTimes(1);
		expect(await screen.findByText('/usr/local/bin/maestro-p')).toBeInTheDocument();
	});

	it('shows compatible-agent empty state and disables creation', () => {
		agentConfigState.detectedAgents = [];
		renderDialog();

		expect(screen.getByText('No compatible AI agents detected.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Create Agent/i })).toBeDisabled();
	});

	it('shows create failures and thrown errors without closing the dialog', async () => {
		const props = renderDialog({
			onCreateAgent: vi
				.fn()
				.mockResolvedValueOnce({ success: false, error: 'Could not create session' })
				.mockRejectedValueOnce(new Error('Exploded')),
		});

		fireEvent.click(await screen.findByRole('button', { name: /Create Agent/i }));
		expect(await screen.findByText('Could not create session')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));
		expect(await screen.findByText('Exploded')).toBeInTheDocument();
		expect(props.onClose).not.toHaveBeenCalled();
	});

	it('closes from the header and footer controls', () => {
		const props = renderDialog();

		fireEvent.click(screen.getByTitle('Close (Esc)'));
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(props.onClose).toHaveBeenCalledTimes(2);
	});
});
