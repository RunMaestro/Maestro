import { describe, expect, it } from 'vitest';
import {
	getPluginWorkspaceDestinations,
	initialPluginWorkspaceRoute,
	reducePluginWorkspaceRoute,
} from '../pluginWorkspaceNavigation';

describe('plugin workspace navigation', () => {
	const workspace = {
		ownerPluginId: 'com.example.agent',
		localId: 'agent-workspace',
		canonicalContributionId: 'com.example.agent/agent-workspace',
		title: 'Agent workspace',
		icon: 'bot',
		panelLocalId: 'agent-panel',
		order: 1,
	};
	const panel = {
		ownerPluginId: 'com.example.agent',
		localId: 'agent-panel',
		canonicalContributionId: 'com.example.agent/agent-panel',
		title: 'Agent workspace panel',
		entry: 'panel.html',
	};

	it('shows only workspaces paired to an interactive panel from the same owner', () => {
		expect(getPluginWorkspaceDestinations([workspace], [panel])).toEqual([workspace]);
		expect(getPluginWorkspaceDestinations([workspace], [])).toEqual([]);
		expect(
		getPluginWorkspaceDestinations([workspace], [{ ...panel, ownerPluginId: 'com.example.other' }])
		).toEqual([]);
	});

	it('activates a plugin workspace route without changing the native session selection', () => {
		const active = reducePluginWorkspaceRoute(initialPluginWorkspaceRoute, {
			type: 'open',
			ownerPluginId: workspace.ownerPluginId,
			workspaceLocalId: workspace.localId,
		});
		const closed = reducePluginWorkspaceRoute(active, { type: 'close' });

		expect(active).toEqual({
			ownerPluginId: 'com.example.agent',
			workspaceLocalId: 'agent-workspace',
		});
		expect(closed).toBeNull();
	});
});
