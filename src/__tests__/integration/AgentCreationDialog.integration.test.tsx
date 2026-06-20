import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentCreationDialog } from '../../renderer/components/AgentCreationDialog';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { AgentConfig, Theme } from '../../renderer/types';
import type { RegisteredRepository, SymphonyIssue } from '../../shared/symphony-types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
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
	path: '/usr/local/bin/claude',
	binaryName: 'claude',
	capabilities: {
		supportsBatchMode: true,
		supportsModelSelection: true,
	},
	configOptions: [
		{
			key: 'model',
			label: 'Model',
			type: 'text',
			default: 'sonnet',
			description: 'Model slug',
		},
		{
			key: 'contextWindow',
			label: 'Context Window',
			type: 'number',
			default: 100000,
			description: 'Maximum context window',
		},
		{
			key: 'summaries',
			label: 'Summaries',
			type: 'checkbox',
			default: false,
			description: 'Enable summaries',
		},
		{
			key: 'approvalMode',
			label: 'Approval Mode',
			type: 'select',
			default: 'ask',
			options: ['ask', 'full-auto'],
			description: 'Tool approval mode',
		},
	],
};

const betaAgent: AgentConfig = {
	id: 'factory-droid',
	name: 'Factory Droid',
	available: true,
	path: '/opt/factory-droid',
	binaryName: 'factory-droid',
	capabilities: {
		supportsBatchMode: true,
		supportsModelSelection: false,
	},
};

const incompatibleAgents: AgentConfig[] = [
	{
		id: 'terminal',
		name: 'Terminal',
		available: true,
		hidden: false,
		capabilities: { supportsBatchMode: true },
	},
	{
		id: 'hidden-agent',
		name: 'Hidden Agent',
		available: true,
		hidden: true,
		capabilities: { supportsBatchMode: true },
	},
	{
		id: 'unavailable-agent',
		name: 'Unavailable Agent',
		available: false,
		capabilities: { supportsBatchMode: true },
	},
	{
		id: 'interactive-only',
		name: 'Interactive Only',
		available: true,
		capabilities: { supportsBatchMode: false },
	},
];

function renderDialog(props: Partial<React.ComponentProps<typeof AgentCreationDialog>> = {}) {
	const mergedProps: React.ComponentProps<typeof AgentCreationDialog> = {
		theme,
		isOpen: true,
		onClose: vi.fn(),
		repo,
		issue,
		onCreateAgent: vi.fn().mockResolvedValue({ success: true }),
		...props,
	};

	const result = render(
		<LayerStackProvider>
			<AgentCreationDialog {...mergedProps} />
		</LayerStackProvider>
	);

	return { ...result, props: mergedProps };
}

describe('AgentCreationDialog integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([claudeAgent, betaAgent]);
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['sonnet', 'opus']);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue(null);
		vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(true);
		vi.mocked(window.maestro.agents.refresh).mockResolvedValue(undefined);
		vi.mocked(window.maestro.fs.homeDir).mockResolvedValue('/Users/integration');
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue('/chosen/workdir');
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('renders nothing while closed', () => {
		renderDialog({ isOpen: false });

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('detects compatible agents, configures the real agent panel, browses a folder, and creates the Symphony agent', async () => {
		const onCreateAgent = vi.fn().mockResolvedValue({ success: true });
		renderDialog({ onCreateAgent });

		expect(await screen.findByText('Maestro')).toBeInTheDocument();
		expect(screen.getByText('#42: Add contribution workflow')).toBeInTheDocument();
		expect(screen.getByText('2 Auto Run documents')).toBeInTheDocument();
		expect(await screen.findByDisplayValue('Symphony: runmaestro/maestro #42')).toBeInTheDocument();
		expect(
			screen.getByDisplayValue('/Users/integration/Maestro-Symphony/runmaestro-maestro-42')
		).toBeInTheDocument();
		expect(screen.getByText('Claude Code')).toBeInTheDocument();
		expect(screen.getByText('Factory Droid')).toBeInTheDocument();
		expect(screen.getByText('Beta')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Claude Code'));
		await waitFor(() =>
			expect(window.maestro.agents.getModels).toHaveBeenCalledWith('claude-code', false)
		);
		expect(await screen.findByText('2 models available')).toBeInTheDocument();
		fireEvent.click(screen.getByText('Claude Code'));
		fireEvent.click(screen.getByText('Claude Code'));
		expect(window.maestro.agents.getModels).toHaveBeenCalledTimes(1);

		fireEvent.change(screen.getByDisplayValue('/usr/local/bin/claude'), {
			target: { value: '/custom/bin/claude' },
		});
		fireEvent.change(screen.getByPlaceholderText('--flag value --another-flag'), {
			target: { value: '--fast --json' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Add Variable' }));
		const envKeyInput = await screen.findByDisplayValue('NEW_VAR');
		fireEvent.change(envKeyInput, { target: { value: 'API_KEY' } });
		fireEvent.blur(envKeyInput);
		fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'secret' } });

		const modelInput = screen.getByDisplayValue('sonnet');
		fireEvent.change(modelInput, { target: { value: 'opus' } });
		fireEvent.blur(modelInput);
		await screen.findByDisplayValue('opus');
		fireEvent.change(screen.getByDisplayValue('100000'), { target: { value: '200000' } });
		fireEvent.click(screen.getByLabelText('Enabled'));
		fireEvent.change(screen.getByDisplayValue('ask'), { target: { value: 'full-auto' } });

		fireEvent.change(screen.getByDisplayValue('Symphony: runmaestro/maestro #42'), {
			target: { value: 'Custom Symphony Agent' },
		});
		fireEvent.click(screen.getByTitle('Re-detect agent path'));
		await waitFor(() => expect(window.maestro.agents.detect).toHaveBeenCalledTimes(2));
		fireEvent.change(
			screen.getByDisplayValue('/Users/integration/Maestro-Symphony/runmaestro-maestro-42'),
			{ target: { value: '/typed/workdir' } }
		);
		expect(screen.getByDisplayValue('/typed/workdir')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Browse for folder'));
		await waitFor(() => expect(window.maestro.dialog.selectFolder).toHaveBeenCalledOnce());
		expect(screen.getByDisplayValue('/chosen/workdir')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));

		await waitFor(() =>
			expect(onCreateAgent).toHaveBeenCalledWith({
				agentType: 'claude-code',
				sessionName: 'Custom Symphony Agent',
				workingDirectory: '/chosen/workdir',
				repo,
				issue,
				customPath: '/custom/bin/claude',
				customArgs: '--fast --json',
				customEnvVars: { API_KEY: 'secret' },
				agentConfig: {
					contextWindow: 200000,
					summaries: true,
					approvalMode: 'full-auto',
				},
				enableMaestroP: true,
				maestroPMode: 'dynamic',
				maestroPPath: undefined,
			})
		);
	});

	it('renders loading, no-agent, home-directory fallback, folder-cancel, and creation-error states', async () => {
		let resolveDetection: (agents: AgentConfig[]) => void = () => {};
		vi.mocked(window.maestro.agents.detect).mockReturnValue(
			new Promise<AgentConfig[]>((resolve) => {
				resolveDetection = resolve;
			})
		);
		const loading = renderDialog();
		expect(document.querySelector('.animate-spin')).toBeInTheDocument();
		resolveDetection(incompatibleAgents);
		expect(await screen.findByText('No compatible AI agents detected.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Create Agent/i })).toBeDisabled();

		loading.unmount();
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([betaAgent]);
		vi.mocked(window.maestro.fs.homeDir).mockRejectedValue(new Error('home unavailable'));
		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValue(null);
		const onCreateAgent = vi.fn().mockResolvedValue({ success: false });
		renderDialog({
			issue: {
				...issue,
				documentPaths: [{ name: 'plan', path: 'docs/plan.md', isExternal: false }],
			},
			onCreateAgent,
		});

		expect(await screen.findByText('1 Auto Run document')).toBeInTheDocument();
		expect(
			await screen.findByDisplayValue('~/Maestro-Symphony/runmaestro-maestro-42')
		).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Browse for folder'));
		await waitFor(() => expect(window.maestro.dialog.selectFolder).toHaveBeenCalledOnce());
		expect(
			screen.getByDisplayValue('~/Maestro-Symphony/runmaestro-maestro-42')
		).toBeInTheDocument();

		fireEvent.click(screen.getByText('Factory Droid'));
		expect(screen.getByDisplayValue('/opt/factory-droid')).toBeInTheDocument();
		expect(window.maestro.agents.getModels).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));
		expect(await screen.findByText('Failed to create agent session')).toBeInTheDocument();

		vi.mocked(window.maestro.agents.detect).mockResolvedValue([claudeAgent]);
	});

	it('surfaces refresh/model/create failures and closes through cancel, header, and Escape', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.agents.getModels).mockRejectedValueOnce(new Error('models failed'));
		vi.mocked(window.maestro.agents.detect)
			.mockResolvedValueOnce([claudeAgent])
			.mockRejectedValueOnce(new Error('refresh failed'));
		const onClose = vi.fn();
		const onCreateAgent = vi.fn().mockRejectedValue(new Error('Thrown failure'));
		renderDialog({ onClose, onCreateAgent });

		await screen.findByDisplayValue('Symphony: runmaestro/maestro #42');
		fireEvent.click(screen.getByText('Claude Code'));
		await waitFor(() =>
			expect(window.maestro.agents.getModels).toHaveBeenCalledWith('claude-code', false)
		);

		fireEvent.click(screen.getAllByTitle('Refresh detection')[0]);
		await waitFor(() => expect(window.maestro.agents.detect).toHaveBeenCalledTimes(2));

		fireEvent.click(screen.getByRole('button', { name: /Create Agent/i }));
		expect(await screen.findByText('Thrown failure')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		fireEvent.click(screen.getByTitle('Close (Esc)'));
		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(3));
	});

	it('supports keyboard row activation, model refresh, env cleanup, and the trimmed-name create guard', async () => {
		const onCreateAgent = vi.fn().mockResolvedValue({ success: true });
		vi.mocked(window.maestro.agents.getModels)
			.mockResolvedValueOnce(null as unknown as string[])
			.mockResolvedValueOnce(['forced-model']);
		renderDialog({ onCreateAgent });

		const sessionNameInput = await screen.findByDisplayValue('Symphony: runmaestro/maestro #42');
		const factoryRow = screen.getByText('Factory Droid').closest('[role="button"]')!;
		const claudeRow = screen.getByText('Claude Code').closest('[role="button"]')!;

		fireEvent.keyDown(screen.getByText('Factory Droid'), { key: 'Enter' });
		expect(screen.queryByDisplayValue('/opt/factory-droid')).not.toBeInTheDocument();

		fireEvent.keyDown(factoryRow, { key: 'Enter' });
		expect(screen.getByDisplayValue('/opt/factory-droid')).toBeInTheDocument();

		fireEvent.keyDown(claudeRow, { key: ' ' });
		await waitFor(() =>
			expect(window.maestro.agents.getModels).toHaveBeenCalledWith('claude-code', false)
		);
		fireEvent.click(screen.getByTitle('Refresh available models'));
		expect(await screen.findByText('1 model available')).toBeInTheDocument();
		expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith('claude-code', true);

		fireEvent.click(screen.getByRole('button', { name: 'Add Variable' }));
		const firstKey = await screen.findByDisplayValue('NEW_VAR');
		fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'occupied' } });
		fireEvent.click(screen.getByRole('button', { name: 'Add Variable' }));
		expect(await screen.findByDisplayValue('NEW_VAR_1')).toBeInTheDocument();
		fireEvent.click(screen.getAllByTitle('Remove variable')[1]);
		fireEvent.click(screen.getAllByTitle('Remove variable')[0]);
		expect(firstKey).not.toBeInTheDocument();

		fireEvent.change(sessionNameInput, { target: { value: '   ' } });
		expect(screen.getByRole('button', { name: /Create Agent/i })).toBeDisabled();
		expect(onCreateAgent).not.toHaveBeenCalled();
	});
});
