import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	AgentLogo,
	AgentSelectionScreen,
} from '../../renderer/components/Wizard/screens/AgentSelectionScreen';
import { WizardProvider } from '../../renderer/components/Wizard/WizardContext';
import type { AgentConfig, Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111827',
		bgSidebar: '#1f2937',
		bgActivity: '#0f172a',
		border: '#374151',
		textMain: '#f9fafb',
		textDim: '#9ca3af',
		accent: '#2563eb',
		accentDim: '#1d4ed8',
		accentText: '#2563eb',
		accentForeground: '#ffffff',
		success: '#16a34a',
		warning: '#f59e0b',
		error: '#dc2626',
		info: '#0ea5e9',
		bgAccentHover: '#1d4ed8',
	},
};

function createAgent(
	id: string,
	name: string,
	available: boolean,
	overrides: Partial<AgentConfig> = {}
): AgentConfig {
	return {
		id,
		name,
		available,
		path: available ? `/usr/local/bin/${id}` : undefined,
		binaryName: id,
		hidden: false,
		capabilities: {
			supportsModelSelection: false,
		} as NonNullable<AgentConfig['capabilities']>,
		configOptions: [],
		...overrides,
	};
}

function createDetectedAgents(): AgentConfig[] {
	return [
		createAgent('claude-code', 'Claude Code', true, { binaryName: 'claude' }),
		createAgent('codex', 'Codex', true, {
			binaryName: 'codex',
			capabilities: { supportsModelSelection: true } as NonNullable<AgentConfig['capabilities']>,
			configOptions: [
				{
					key: 'model',
					label: 'Model',
					type: 'text',
					default: 'gpt-5-mini',
					description: 'Model slug',
				},
				{
					key: 'contextWindow',
					label: 'Context Window',
					type: 'number',
					default: 100000,
					description: 'Token budget',
				},
			],
		}),
		createAgent('opencode', 'OpenCode', false, { binaryName: 'opencode' }),
		createAgent('factory-droid', 'Factory Droid', false, { binaryName: 'factory' }),
		createAgent('terminal', 'Terminal', true, { hidden: true }),
	];
}

function createOnlyClaudeAgent(): AgentConfig[] {
	return [
		createAgent('claude-code', 'Claude Code', true, { binaryName: 'claude' }),
		createAgent('codex', 'Codex', false, { binaryName: 'codex' }),
		createAgent('opencode', 'OpenCode', false, { binaryName: 'opencode' }),
		createAgent('factory-droid', 'Factory Droid', false, { binaryName: 'factory' }),
	];
}

function createUnavailableAgents(): AgentConfig[] {
	return [
		createAgent('claude-code', 'Claude Code', false, { binaryName: 'claude' }),
		createAgent('codex', 'Codex', false, { binaryName: 'codex' }),
		createAgent('opencode', 'OpenCode', false, { binaryName: 'opencode' }),
		createAgent('factory-droid', 'Factory Droid', false, { binaryName: 'factory' }),
	];
}

function createNonClaudeAvailableAgents(): AgentConfig[] {
	return [
		createAgent('claude-code', 'Claude Code', false, { binaryName: 'claude' }),
		createAgent('codex', 'Codex', true, {
			binaryName: 'codex',
			capabilities: { supportsModelSelection: true } as NonNullable<AgentConfig['capabilities']>,
		}),
		createAgent('opencode', 'OpenCode', true, { binaryName: 'opencode' }),
		createAgent('factory-droid', 'Factory Droid', false, { binaryName: 'factory' }),
	];
}

function renderScreen() {
	return render(
		<WizardProvider>
			<AgentSelectionScreen theme={theme} />
		</WizardProvider>
	);
}

describe('AgentSelectionScreen integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window.maestro.sessions as any).getAll = vi.fn().mockResolvedValue([]);
		vi.mocked(window.maestro.agents.detect).mockResolvedValue(createDetectedAgents());
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({ model: 'gpt-5-mini' });
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['gpt-5', 'gpt-5-mini']);
		vi.mocked(window.maestro.agents.setCustomPath).mockResolvedValue(undefined);
		vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(undefined);
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [],
		});
		vi.mocked(window.maestro.settings.set).mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('detects local agents, preserves existing-agent guidance, and advances the wizard', async () => {
		(window.maestro.sessions as any).getAll.mockResolvedValue([{ id: 'existing-session' }]);

		renderScreen();

		await waitFor(() => {
			expect(screen.getByText('Create a Maestro Agent')).toBeInTheDocument();
		});

		expect(screen.getByText('/wizard')).toBeInTheDocument();
		expect(screen.getAllByText('Beta')).toHaveLength(3);
		expect(screen.queryByText('Soon')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);

		fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
		fireEvent.change(screen.getByLabelText('Agent name'), {
			target: { value: 'Integration Playbook' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

		await waitFor(() => {
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'wizardResumeState',
				expect.objectContaining({
					currentStep: 'directory-selection',
					selectedAgent: 'codex',
					agentName: 'Integration Playbook',
				})
			);
		});
	});

	it('threads remote location changes through detection and shows recoverable SSH failures', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [{ id: 'remote-1', name: 'Build Box', host: 'build.example.com' }],
		});
		vi.mocked(window.maestro.agents.detect).mockImplementation(async (sshRemoteId?: string) => {
			if (sshRemoteId === 'remote-1') {
				return [
					createAgent('claude-code', 'Claude Code', false, {
						error: 'ssh connect failed',
					} as Partial<AgentConfig>),
					createAgent('codex', 'Codex', false, {
						error: 'ssh connect failed',
					} as Partial<AgentConfig>),
				];
			}
			return createDetectedAgents();
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
		expect(window.maestro.agents.detect).toHaveBeenCalledWith('remote-1');

		fireEvent.change(screen.getByLabelText('Agent location'), {
			target: { value: '' },
		});

		await waitFor(() => {
			expect(screen.queryByText('Unable to Connect')).not.toBeInTheDocument();
		});
		expect(window.maestro.agents.detect).toHaveBeenCalledWith(undefined);
	});

	it('reports thrown remote detection errors with specific and fallback messages', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [
				{ id: 'remote-error', name: 'Error Box', host: 'error.example.com' },
				{ id: 'remote-unknown', name: 'Unknown Box', host: 'unknown.example.com' },
			],
		});
		vi.mocked(window.maestro.agents.detect).mockImplementation(async (sshRemoteId?: string) => {
			if (sshRemoteId === 'remote-error') {
				throw new Error('remote detector exploded');
			}
			if (sshRemoteId === 'remote-unknown') {
				throw 'non-error detector failure';
			}
			return createDetectedAgents();
		});

		renderScreen();

		const locationSelect = await screen.findByLabelText('Agent location');
		fireEvent.change(locationSelect, { target: { value: 'remote-error' } });

		await waitFor(() => {
			expect(screen.getByText('remote detector exploded')).toBeInTheDocument();
		});
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to detect agents:',
			undefined,
			expect.any(Error)
		);

		fireEvent.change(screen.getByLabelText('Agent location'), {
			target: { value: 'remote-unknown' },
		});

		await waitFor(() => {
			expect(screen.getByText('Unknown connection error')).toBeInTheDocument();
		});
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to detect agents:',
			undefined,
			'non-error detector failure'
		);
	});

	it('opens the real config panel, persists provider settings, and returns to the grid', async () => {
		renderScreen();

		await waitFor(() => {
			expect(screen.getAllByTitle('Customize agent settings')[1]).toBeInTheDocument();
		});

		fireEvent.click(screen.getAllByTitle('Customize agent settings')[1]);

		await waitFor(() => {
			expect(screen.getByText('Configure Codex')).toBeInTheDocument();
		});
		expect(window.maestro.agents.getConfig).toHaveBeenCalledWith('codex');
		expect(window.maestro.agents.getModels).toHaveBeenCalledWith('codex', false, undefined);
		expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();

		fireEvent.change(screen.getByDisplayValue('/usr/local/bin/codex'), {
			target: { value: '/opt/homebrew/bin/codex' },
		});
		fireEvent.blur(screen.getByDisplayValue('/opt/homebrew/bin/codex'));
		await waitFor(() => {
			expect(window.maestro.agents.setCustomPath).toHaveBeenCalledWith(
				'codex',
				'/opt/homebrew/bin/codex'
			);
		});

		fireEvent.click(screen.getByText('Add Variable'));
		const envKeyInput = await screen.findByDisplayValue('NEW_VAR');
		fireEvent.change(envKeyInput, { target: { value: 'INTEGRATION_FLAG' } });
		fireEvent.blur(envKeyInput);
		fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: 'enabled' } });

		fireEvent.change(screen.getByDisplayValue('gpt-5-mini'), { target: { value: 'gpt-5' } });
		fireEvent.blur(screen.getByDisplayValue('gpt-5'));
		await waitFor(() => {
			expect(window.maestro.agents.setConfig).toHaveBeenCalledWith(
				'codex',
				expect.objectContaining({ model: 'gpt-5' })
			);
		});

		fireEvent.change(screen.getByDisplayValue('100000'), { target: { value: '200000' } });
		fireEvent.blur(screen.getByDisplayValue('200000'));
		await waitFor(() => {
			expect(window.maestro.agents.setConfig).toHaveBeenCalledWith(
				'codex',
				expect.objectContaining({ contextWindow: 200000 })
			);
		});

		fireEvent.click(screen.getByTitle('Refresh available models'));
		await waitFor(() => {
			expect(window.maestro.agents.getModels).toHaveBeenCalledWith('codex', true, undefined);
		});

		fireEvent.click(screen.getByTitle('Re-detect agent path'));
		await waitFor(() => {
			expect(window.maestro.agents.detect).toHaveBeenCalledTimes(3);
		});

		fireEvent.click(screen.getByRole('button', { name: 'Done' }));

		await waitFor(() => {
			expect(screen.getByText('Create a Maestro Agent')).toBeInTheDocument();
		});
		expect(screen.queryByText('Configure Codex')).not.toBeInTheDocument();
	});

	it('handles detection and bootstrap failures without enabling progression', async () => {
		(window.maestro.sessions as any).getAll.mockRejectedValue(new Error('sessions unavailable'));
		vi.mocked(window.maestro.sshRemote.getConfigs).mockRejectedValue(
			new Error('ssh config failed')
		);
		vi.mocked(window.maestro.agents.detect).mockResolvedValue(createUnavailableAgents());

		const firstRender = renderScreen();

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Claude Code (not installed)' })).toBeDisabled();
		});
		expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
		expect(screen.queryByLabelText('Agent location')).not.toBeInTheDocument();
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to load SSH remotes:',
			undefined,
			expect.any(Error)
		);

		firstRender.unmount();
		vi.mocked(window.maestro.agents.detect).mockRejectedValueOnce(new Error('local detector died'));
		renderScreen();

		await waitFor(() => {
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'error',
				'Failed to detect agents:',
				undefined,
				expect.any(Error)
			);
		});
		expect(screen.getAllByRole('button', { name: 'Continue' }).at(-1)).toBeDisabled();
	});

	it('supports keyboard navigation and name-field shortcuts', async () => {
		vi.mocked(window.maestro.agents.detect).mockResolvedValue(createDetectedAgents());
		renderScreen();

		const codexTile = await screen.findByRole('button', { name: 'Codex' });
		const nameInput = screen.getByLabelText('Agent name');

		await waitFor(() => {
			expect(codexTile).toBeEnabled();
		});

		fireEvent.focus(nameInput);
		fireEvent.keyDown(nameInput, { key: 'Tab', shiftKey: true });
		fireEvent.keyDown(codexTile, { key: 'ArrowRight' });
		fireEvent.keyDown(codexTile, { key: 'ArrowLeft' });
		fireEvent.keyDown(codexTile, { key: 'ArrowDown' });
		fireEvent.keyDown(codexTile, { key: 'ArrowUp' });
		fireEvent.keyDown(codexTile, { key: ' ' });

		await waitFor(() => {
			expect(codexTile).toHaveAttribute('aria-pressed', 'true');
		});

		fireEvent.keyDown(codexTile, { key: 'Tab' });
		expect(nameInput).toHaveFocus();
		fireEvent.change(nameInput, { target: { value: 'Keyboard Flow' } });
		fireEvent.keyDown(nameInput, { key: 'Enter' });

		await waitFor(() => {
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'wizardResumeState',
				expect.objectContaining({
					currentStep: 'directory-selection',
					agentName: 'Keyboard Flow',
				})
			);
		});
	});

	it('focuses the first available non-Claude agent and opens customization from the keyboard', async () => {
		vi.mocked(window.maestro.agents.detect).mockResolvedValue(createNonClaudeAvailableAgents());
		const firstRender = renderScreen();

		const codexTile = await screen.findByRole('button', { name: 'Codex' });
		await waitFor(() => {
			expect(codexTile).toHaveFocus();
		});

		fireEvent.keyDown(codexTile, { key: 'Enter' });
		await waitFor(() => {
			expect(codexTile).toHaveAttribute('aria-pressed', 'true');
		});

		fireEvent.change(screen.getByLabelText('Agent name'), {
			target: { value: 'Non Claude Flow' },
		});
		fireEvent.keyDown(codexTile, { key: 'Enter' });

		await waitFor(() => {
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'wizardResumeState',
				expect.objectContaining({
					currentStep: 'directory-selection',
					selectedAgent: 'codex',
					agentName: 'Non Claude Flow',
				})
			);
		});

		firstRender.unmount();
		renderScreen();
		const customizeCodex = await screen.findAllByTitle('Customize agent settings');
		fireEvent.keyDown(customizeCodex[1], { key: 'Enter' });
		await waitFor(() => {
			expect(screen.getByText('Configure Codex')).toBeInTheDocument();
		});
	});

	it('uses remote config context for model refresh and survives model load failures', async () => {
		vi.mocked(window.maestro.sshRemote.getConfigs).mockResolvedValue({
			success: true,
			configs: [{ id: 'remote-host-only', host: 'builder.internal' }],
		});
		vi.mocked(window.maestro.agents.detect).mockResolvedValue(createDetectedAgents());
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue(null);
		vi.mocked(window.maestro.agents.getModels)
			.mockRejectedValueOnce(new Error('initial model load failed'))
			.mockRejectedValueOnce(new Error('refresh model load failed'));

		renderScreen();

		const locationSelect = await screen.findByLabelText('Agent location');
		expect(screen.getByText('builder.internal')).toBeInTheDocument();
		fireEvent.change(locationSelect, { target: { value: 'remote-host-only' } });

		await waitFor(() => {
			expect(window.maestro.agents.detect).toHaveBeenCalledWith('remote-host-only');
		});

		fireEvent.click(screen.getAllByTitle('Customize agent settings')[1]);

		await waitFor(() => {
			expect(screen.getByText('Configure Codex')).toBeInTheDocument();
		});
		await waitFor(() => {
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'error',
				'Failed to load models:',
				undefined,
				expect.any(Error)
			);
		});
		expect(window.maestro.agents.getModels).toHaveBeenCalledWith(
			'codex',
			false,
			'remote-host-only'
		);

		fireEvent.click(screen.getByTitle('Refresh available models'));
		await waitFor(() => {
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'error',
				'Failed to refresh models:',
				undefined,
				expect.any(Error)
			);
		});
		expect(window.maestro.agents.getModels).toHaveBeenCalledWith('codex', true, 'remote-host-only');

		fireEvent.click(screen.getByRole('button', { name: 'Done' }));
		await waitFor(() => {
			expect(screen.getByText('Create a Maestro Agent')).toBeInTheDocument();
		});
	});

	it('clears custom config fields and removes environment variables', async () => {
		vi.mocked(window.maestro.agents.detect).mockResolvedValue(createOnlyClaudeAgent());
		renderScreen();

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Claude Code' })).toBeInTheDocument();
		});

		fireEvent.click(screen.getAllByTitle('Customize agent settings')[0]);

		await waitFor(() => {
			expect(screen.getByText('Configure Claude Code')).toBeInTheDocument();
		});

		const pathInput = screen.getByDisplayValue('/usr/local/bin/claude-code');
		fireEvent.change(pathInput, { target: { value: '/custom/claude' } });
		fireEvent.change(pathInput, { target: { value: '   ' } });
		fireEvent.blur(pathInput);
		await waitFor(() => {
			expect(window.maestro.agents.setCustomPath).toHaveBeenCalledWith('claude-code', null);
		});

		const argsInput = screen.getByPlaceholderText('--flag value --another-flag');
		fireEvent.change(argsInput, { target: { value: '--verbose' } });
		fireEvent.change(argsInput, { target: { value: '' } });
		expect(argsInput).toHaveValue('');

		fireEvent.click(screen.getByText('Add Variable'));
		expect(await screen.findByDisplayValue('NEW_VAR')).toBeInTheDocument();
		fireEvent.change(screen.getAllByPlaceholderText('value').at(-1)!, {
			target: { value: 'enabled' },
		});
		fireEvent.click(screen.getByText('Add Variable'));
		await waitFor(() => {
			expect(screen.getByDisplayValue('NEW_VAR_1')).toBeInTheDocument();
		});

		fireEvent.click(screen.getAllByTitle('Remove variable')[0]);
		await waitFor(() => {
			expect(screen.queryByDisplayValue('NEW_VAR')).not.toBeInTheDocument();
		});
		fireEvent.click(screen.getAllByTitle('Remove variable')[0]);
		await waitFor(() => {
			expect(screen.queryByDisplayValue('NEW_VAR_1')).not.toBeInTheDocument();
		});
	});

	it('renders the logo fallback for unknown agents', () => {
		const { container } = render(
			<AgentLogo agentId="unknown-agent" supported detected brandColor={undefined} theme={theme} />
		);

		expect(container.querySelector('div[style*="border-color"]')).toBeInTheDocument();
	});
});
