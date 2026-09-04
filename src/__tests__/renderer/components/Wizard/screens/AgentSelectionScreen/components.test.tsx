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
import { PICKABLE_AGENT_IDS } from '../../../../../../shared/agentMetadata';
import { AGENT_LOGO_FALLBACK_TESTID } from '../../../../../../renderer/components/Wizard/screens/AgentSelectionScreen/components/AgentLogo';

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

	it('draws a real mark for every provider a user can pick', () => {
		// A provider that reaches a picker without a mark of its own renders as the
		// blank fallback ring, which reads as a bug. Assert on the fallback's own
		// marker rather than "some svg rendered": the fallback is a div today, but
		// were it ever redrawn as an svg, a presence check would start passing for
		// exactly the providers this test exists to catch.
		for (const agentId of PICKABLE_AGENT_IDS) {
			const { queryByTestId, unmount } = render(
				<AgentLogo agentId={agentId} supported detected theme={mockTheme} />
			);
			expect(
				queryByTestId(AGENT_LOGO_FALLBACK_TESTID),
				`${agentId} has no logo of its own and fell through to the fallback`
			).toBeNull();
			unmount();
		}
	});

	it('marks the fallback so the coverage test above cannot pass vacuously', () => {
		const { queryByTestId } = render(
			<AgentLogo agentId="not-a-real-provider" supported detected theme={mockTheme} />
		);

		expect(queryByTestId(AGENT_LOGO_FALLBACK_TESTID)).toBeInTheDocument();
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
				totalProviderCount={AGENT_TILES.length}
				availableProviderCount={1}
				providerLocationLabel="locally"
				showAllProviders
				tileRefs={tileRefs}
				onTileClick={onTileClick}
				onOpenConfig={onOpenConfig}
				onShowAllProvidersChange={vi.fn()}
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

		// One customize action per tile, so the strip's alphabetical order decides
		// which one belongs to Codex.
		const codexTileIndex = AGENT_TILES.findIndex((tile) => tile.id === 'codex');
		const customizeActions = screen.getAllByTitle('Customize agent settings');
		fireEvent.click(customizeActions[codexTileIndex]);
		expect(onOpenConfig).toHaveBeenCalledWith('codex');
		expect(customizeActions[codexTileIndex]).toHaveAttribute('tabindex', '0');
		fireEvent.keyDown(customizeActions[codexTileIndex], { key: 'Enter' });
		expect(onOpenConfig).toHaveBeenCalledTimes(2);
	});

	it('reports the provider count and toggles the unavailable ones', () => {
		const onShowAllProvidersChange = vi.fn();
		const tileRefs: React.MutableRefObject<(HTMLButtonElement | null)[]> = { current: [] };
		const available = [detectedAgent('claude-code'), detectedAgent('codex')];

		render(
			<AgentGrid
				theme={mockTheme}
				tiles={AGENT_TILES.slice(0, 2)}
				detectedAgents={available}
				selectedAgent="claude-code"
				focusedTileIndex={0}
				isNameFieldFocused={false}
				totalProviderCount={15}
				availableProviderCount={5}
				providerLocationLabel="locally"
				showAllProviders={false}
				tileRefs={tileRefs}
				onTileClick={vi.fn()}
				onOpenConfig={vi.fn()}
				onShowAllProvidersChange={onShowAllProvidersChange}
				setFocusedTileIndex={vi.fn()}
				setIsNameFieldFocused={vi.fn()}
			/>
		);

		expect(screen.getByText('5 providers available locally of 15 supported')).toBeInTheDocument();

		const toggle = screen.getByRole('switch', { name: 'Show all supported providers' });
		expect(toggle).toHaveAttribute('aria-checked', 'false');

		// The screen-wide keydown handler must not eat this control's own keys.
		expect(toggle.closest('[data-provider-bar-nav-exempt]')).not.toBeNull();

		fireEvent.click(toggle);
		expect(onShowAllProvidersChange).toHaveBeenCalledWith(true);
	});

	it('wraps a short tile set and only reaches for the strip when it has to', () => {
		const onColumnsChange = vi.fn();
		const tileRefs: React.MutableRefObject<(HTMLButtonElement | null)[]> = { current: [] };

		function renderGrid(tiles: typeof AGENT_TILES) {
			return (
				<AgentGrid
					theme={mockTheme}
					tiles={tiles}
					detectedAgents={tiles.map((tile) => detectedAgent(tile.id))}
					selectedAgent={null}
					focusedTileIndex={0}
					isNameFieldFocused={false}
					totalProviderCount={AGENT_TILES.length}
					availableProviderCount={tiles.length}
					providerLocationLabel="locally"
					showAllProviders
					tileRefs={tileRefs}
					onTileClick={vi.fn()}
					onOpenConfig={vi.fn()}
					onShowAllProvidersChange={vi.fn()}
					onColumnsChange={onColumnsChange}
					setFocusedTileIndex={vi.fn()}
					setIsNameFieldFocused={vi.fn()}
				/>
			);
		}

		// Five tiles fit in two rows, so there is nothing to scroll and no arrows to
		// draw. An arrow that cannot move is worse than no arrow.
		const { rerender } = render(renderGrid(AGENT_TILES.slice(0, 5)));
		expect(screen.queryByTitle('Scroll right')).toBeNull();
		// Balanced 3 + 2 rather than 4 + 1, and the count is reported upward so
		// up/down arrow movement steps by the layout that was actually drawn.
		expect(onColumnsChange).toHaveBeenLastCalledWith(3);

		// The full registry does not, so the strip and its affordances come back.
		rerender(renderGrid(AGENT_TILES));
		expect(screen.getByTitle('Scroll right')).toBeInTheDocument();
		expect(screen.getByTitle('Scroll left')).toBeInTheDocument();
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
				configuringTile={AGENT_TILES.find((tile) => tile.id === 'codex')}
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
