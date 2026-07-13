import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginWorkspaceActivityItems } from '../PluginWorkspaceActivityItems';
import type { InteractivePanelHostBinder } from '../PluginInteractivePanelFrame';
import { closePluginWorkspace } from '../pluginWorkspaceNavigation';
import { THEMES } from '../../../constants/themes';
import type { AggregatedContributions } from '../../../../shared/plugins/contributions';

const EMPTY: AggregatedContributions = {
	themes: [],
	iconPacks: [],
	prompts: [],
	settings: [],
	commandMacros: [],
	cueTriggers: [],
	commands: [],
	panels: [],
	workspaces: [],
	interactivePanels: [],
	agents: [],
	tools: [],
	keybindings: [],
	uiItems: [],
	hostViews: [],
	groupings: [],
	errorsByPlugin: {},
};

const pluginBridge = {
	contributions: vi.fn<() => Promise<AggregatedContributions>>(),
	onChanged: vi.fn(() => () => {}),
};
const binder: InteractivePanelHostBinder = { bind: vi.fn(() => vi.fn()) };

beforeEach(() => {
	window.maestro.plugins = pluginBridge as unknown as typeof window.maestro.plugins;
	pluginBridge.contributions.mockReset().mockResolvedValue(EMPTY);
	pluginBridge.onChanged.mockClear();
	closePluginWorkspace();
});

afterEach(() => cleanup());

describe('PluginWorkspaceActivityItems', () => {
	it('renders a destination only when a paired workspace and interactive panel are capability-gated in', async () => {
		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			workspaces: [
				{
					ownerPluginId: 'com.example.agent',
					localId: 'workspace',
					canonicalContributionId: 'com.example.agent/workspace',
					title: 'Agent workspace',
					icon: 'bot',
					panelLocalId: 'workspace-panel',
					order: 0,
				},
			],
			interactivePanels: [
				{
					ownerPluginId: 'com.example.agent',
					localId: 'workspace-panel',
					canonicalContributionId: 'com.example.agent/workspace-panel',
					title: 'Agent panel',
					entry: 'panel.html',
				},
			],
		});

		render(<PluginWorkspaceActivityItems theme={THEMES.dracula} binder={binder} />);

		const destination = await screen.findByRole('button', { name: 'Open Agent workspace' });
		fireEvent.click(destination);
		await waitFor(() => expect(destination).toHaveAttribute('aria-current', 'page'));
	});

	it('does not expose a route before the host binder is injected', async () => {
		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			workspaces: [
				{
					ownerPluginId: 'com.example.agent',
					localId: 'workspace',
					canonicalContributionId: 'com.example.agent/workspace',
					title: 'Agent workspace',
					icon: 'bot',
					panelLocalId: 'workspace-panel',
					order: 0,
				},
			],
		});
		const { container } = render(<PluginWorkspaceActivityItems theme={THEMES.dracula} />);

		await waitFor(() => expect(pluginBridge.contributions).toHaveBeenCalled());
		expect(container.querySelector('[data-plugin-workspace-activity-items]')).toBeNull();
	});
});
