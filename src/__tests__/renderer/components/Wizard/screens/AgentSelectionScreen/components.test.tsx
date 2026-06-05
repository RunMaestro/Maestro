import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { mockTheme } from '../../../../../helpers/mockTheme';
import type { AgentConfig } from '../../../../../../renderer/types';
import {
	AgentConfigurationView,
	AgentGrid,
	AgentLocationSelect,
	AgentLogo,
	AgentSelectionFooter,
	AgentSelectionHeader,
	AgentSelectionLoading,
	SshConnectionErrorPanel,
} from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/components';
import { AGENT_TILES } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen';

vi.mock('../../../../../../renderer/components/shared/AgentConfigPanel', () => ({
	AgentConfigPanel: (props: any) => (
		<div data-testid="agent-config-panel">
			<button onClick={props.onCustomPathBlur}>blur-path</button>
			<button onClick={() => props.onEnvVarAdd()}>add-env</button>
			<button onClick={() => props.onConfigChange('model', 'gpt-5')}>change-config</button>
			<button onClick={() => props.onConfigBlur('model', 'gpt-5')}>blur-config</button>
			<button onClick={props.onRefreshModels}>refresh-models</button>
			<button onClick={props.onRefreshAgent}>refresh-agent</button>
			<span>{props.agent.name}</span>
			<span>{props.customPath}</span>
			<span>{props.customArgs}</span>
		</div>
	),
}));

function detectedAgent(id: string, available = true): AgentConfig {
	return {
		id,
		name: id,
		available,
		hidden: false,
	};
}

describe('AgentSelectionScreen components', () => {
	it('renders agent logos for known and unknown agents', () => {
		const { rerender, container } = render(
			<AgentLogo agentId="claude-code" supported detected brandColor="#111" theme={mockTheme} />
		);

		expect(container.querySelector('svg')).toBeInTheDocument();

		rerender(<AgentLogo agentId="unknown" supported={false} detected={false} theme={mockTheme} />);

		expect(container.querySelector('div')).toHaveClass('rounded-full');
	});

	it('renders tile states, beta badges, disabled unavailable agents, and customize actions', () => {
		const onTileClick = vi.fn();
		const onOpenConfig = vi.fn();
		const tileRefs: React.MutableRefObject<(HTMLButtonElement | null)[]> = { current: [] };

		render(
			<AgentGrid
				theme={mockTheme}
				tiles={AGENT_TILES}
				detectedAgents={[detectedAgent('claude-code'), detectedAgent('codex', false)]}
				selectedAgent="claude-code"
				focusedTileIndex={0}
				isNameFieldFocused={false}
				tileRefs={tileRefs}
				onTileClick={onTileClick}
				onOpenConfig={onOpenConfig}
				setFocusedTileIndex={vi.fn()}
				setIsNameFieldFocused={vi.fn()}
			/>
		);

		expect(screen.getByRole('button', { name: /claude code/i })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		expect(screen.getByRole('button', { name: /codex \(not installed\)/i })).toBeDisabled();
		expect(screen.getAllByText('Beta').length).toBeGreaterThan(0);
		expect(screen.getAllByText('Not installed').length).toBeGreaterThan(0);

		const customizeActions = screen.getAllByTitle('Customize agent settings');
		fireEvent.click(customizeActions[1]);
		expect(onOpenConfig).toHaveBeenCalledWith('codex');
		expect(customizeActions[1]).toHaveAttribute('tabindex', '0');
		fireEvent.keyDown(customizeActions[1], { key: 'Enter' });
		expect(onOpenConfig).toHaveBeenCalledTimes(2);
	});

	it('renders location select only when remotes exist and forwards selection', () => {
		const onSshRemoteChange = vi.fn();
		const { rerender } = render(
			<AgentLocationSelect
				theme={mockTheme}
				sshRemotes={[]}
				sshRemoteConfig={undefined}
				onSshRemoteChange={onSshRemoteChange}
			/>
		);

		expect(screen.queryByLabelText('Agent location')).not.toBeInTheDocument();

		rerender(
			<AgentLocationSelect
				theme={mockTheme}
				sshRemotes={[{ id: 'remote-1', name: 'Server', host: 'host' } as any]}
				sshRemoteConfig={{ enabled: true, remoteId: 'remote-1' }}
				onSshRemoteChange={onSshRemoteChange}
			/>
		);

		const select = screen.getByLabelText('Agent location');
		expect(select).toHaveValue('remote-1');
		fireEvent.change(select, { target: { value: '' } });
		expect(onSshRemoteChange).toHaveBeenCalledWith('');
	});

	it('wires header name field focus, blur, change, and location selection', () => {
		const onAgentNameChange = vi.fn();
		const onNameFocus = vi.fn();
		const onNameBlur = vi.fn();
		const onSshRemoteChange = vi.fn();

		render(
			<AgentSelectionHeader
				theme={mockTheme}
				agentName="Project"
				isNameFieldFocused
				nameInputRef={{ current: null }}
				sshRemotes={[{ id: 'remote-1', name: 'Server', host: 'host' } as any]}
				sshRemoteConfig={undefined}
				onAgentNameChange={onAgentNameChange}
				onNameFocus={onNameFocus}
				onNameBlur={onNameBlur}
				onSshRemoteChange={onSshRemoteChange}
			/>
		);

		const input = screen.getByLabelText('Agent name');
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: 'New Project' } });
		fireEvent.blur(input);
		fireEvent.change(screen.getByLabelText('Agent location'), { target: { value: 'remote-1' } });

		expect(onNameFocus).toHaveBeenCalled();
		expect(onAgentNameChange).toHaveBeenCalledWith('New Project');
		expect(onNameBlur).toHaveBeenCalled();
		expect(onSshRemoteChange).toHaveBeenCalledWith('remote-1');
	});

	it('renders footer disabled and enabled states', () => {
		const onContinue = vi.fn();
		const { rerender } = render(
			<AgentSelectionFooter theme={mockTheme} canProceed={false} onContinue={onContinue} />
		);

		expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

		rerender(<AgentSelectionFooter theme={mockTheme} canProceed onContinue={onContinue} />);
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
		expect(onContinue).toHaveBeenCalledTimes(1);
	});

	it('renders loading and SSH connection error panels', () => {
		const { rerender } = render(<AgentSelectionLoading theme={mockTheme} />);

		expect(screen.getByText('Detecting available agents...')).toBeInTheDocument();

		rerender(<SshConnectionErrorPanel theme={mockTheme} error="Connection refused" />);

		expect(screen.getByText('Unable to Connect')).toBeInTheDocument();
		expect(screen.getByText('Connection refused')).toBeInTheDocument();
	});

	it('renders config view and forwards panel callbacks', async () => {
		const onCloseConfig = vi.fn();
		const onCustomPathBlur = vi.fn();
		const onEnvVarAdd = vi.fn();
		const onConfigChange = vi.fn();
		const onConfigBlur = vi.fn();
		const onRefreshModels = vi.fn();
		const onRefreshAgent = vi.fn();

		render(
			<AgentConfigurationView
				theme={mockTheme}
				containerRef={{ current: null }}
				isTransitioning={false}
				isDetecting
				configuringAgent={detectedAgent('codex')}
				configuringTile={AGENT_TILES[1]}
				detectedConfigAgent={undefined}
				sshRemotes={[{ id: 'remote-1', name: 'Server', host: 'host' } as any]}
				sshRemoteConfig={undefined}
				onSshRemoteChange={vi.fn()}
				onCloseConfig={onCloseConfig}
				customPath="/bin/codex"
				onCustomPathChange={vi.fn()}
				onCustomPathBlur={onCustomPathBlur}
				customArgs="--debug"
				onCustomArgsChange={vi.fn()}
				onCustomArgsBlur={vi.fn()}
				customEnvVars={{}}
				onEnvVarKeyChange={vi.fn()}
				onEnvVarValueChange={vi.fn()}
				onEnvVarRemove={vi.fn()}
				onEnvVarAdd={onEnvVarAdd}
				onEnvVarsBlur={vi.fn()}
				agentConfig={{}}
				onConfigChange={onConfigChange}
				onConfigBlur={onConfigBlur}
				availableModels={[]}
				loadingModels={false}
				onRefreshModels={onRefreshModels}
				onRefreshAgent={onRefreshAgent}
				refreshingAgent={false}
			/>
		);

		expect(screen.getByText('Configure Codex')).toBeInTheDocument();
		expect(screen.getByText('Detecting agent on remote host...')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		fireEvent.click(screen.getByText('blur-path'));
		fireEvent.click(screen.getByText('add-env'));
		fireEvent.click(screen.getByText('change-config'));
		fireEvent.click(screen.getByText('blur-config'));
		fireEvent.click(screen.getByText('refresh-models'));
		fireEvent.click(screen.getByText('refresh-agent'));

		expect(onCloseConfig).toHaveBeenCalledTimes(1);
		expect(onCustomPathBlur).toHaveBeenCalledTimes(1);
		expect(onEnvVarAdd).toHaveBeenCalledTimes(1);
		expect(onConfigChange).toHaveBeenCalledWith('model', 'gpt-5');
		expect(onConfigBlur).toHaveBeenCalledWith('model', 'gpt-5');
		expect(onRefreshModels).toHaveBeenCalledTimes(1);
		expect(onRefreshAgent).toHaveBeenCalledTimes(1);
	});
});
