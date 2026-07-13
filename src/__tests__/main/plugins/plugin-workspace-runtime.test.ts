import { describe, expect, it } from 'vitest';
import {
	PluginWorkspaceRuntime,
	WorkspaceRuntimeError,
} from '../../../main/plugins/plugin-workspace-runtime';
import { PluginWorkspaceRegistry } from '../../../main/plugins/plugin-workspace-registry';
import {
	parseWorkspaceFoundation,
	type CanonicalWorkspaceFoundation,
} from '../../../shared/plugins/workspace-foundation';

const PLUGIN_ID = 'com.example.workspace';
const LOCAL_ID = 'primary';
const PANEL_ID = 'panel';

function foundation(ownerPluginId = PLUGIN_ID): CanonicalWorkspaceFoundation {
	const parsed = parseWorkspaceFoundation(
		{
			workspaces: [
				{
					localId: LOCAL_ID,
					title: 'Primary',
					icon: 'sparkles',
					interactivePanelLocalId: PANEL_ID,
				},
			],
			interactivePanels: [
				{
					localId: PANEL_ID,
					title: 'Panel',
					entry: 'panel.html',
					workspaceLocalId: LOCAL_ID,
				},
			],
		},
		[{ capability: 'ui:workspace' }, { capability: 'ui:interactivePanel' }],
		ownerPluginId
	);
	if (!parsed.ok) throw new Error(parsed.errors.join(', '));
	return parsed.value;
}

function setup() {
	let enabled = true;
	const registry = new PluginWorkspaceRegistry({
		tokenSource: () => 't000000000000000000000',
		isOwnerEnabled: () => enabled,
		instanceNonce: 'workspaceruntime',
	});
	const runtime = new PluginWorkspaceRuntime(registry);
	const active = (generation = 1n, trusted = true) =>
		runtime.reconcile([
			{
				context: {
					ownerPluginId: PLUGIN_ID,
					generation,
					trusted,
					enabled,
					grants: ['ui:workspace', 'ui:interactivePanel'],
				},
				foundation: foundation(),
			},
		]);
	return { registry, runtime, active, disable: () => (enabled = false) };
}

describe('PluginWorkspaceRuntime', () => {
	it('acquires only a declared local workspace from the active owner context', () => {
		const { runtime, active } = setup();
		active();

		expect(runtime.acquire(PLUGIN_ID, LOCAL_ID)).toBeDefined();
		expect(() => runtime.acquire(PLUGIN_ID, 'not-declared')).toThrow(WorkspaceRuntimeError);
	});

	it('revokes an acquired capability after a generation rotation', () => {
		const { registry, runtime, active } = setup();
		active(1n);
		const capability = runtime.acquire(PLUGIN_ID, LOCAL_ID);
		active(2n);

		expect(() => registry.getExternalSessions(capability)).toThrow('capability_unavailable');
		expect(runtime.acquire(PLUGIN_ID, LOCAL_ID)).toBeDefined();
	});

	it('rejects stale, disabled, untrusted, and wrong-owner acquisition', () => {
		const { runtime, active, disable } = setup();
		active(2n);
		expect(() => runtime.acquire(PLUGIN_ID, LOCAL_ID, 1n)).toThrow('capability_unavailable');

		disable();
		expect(() => runtime.acquire(PLUGIN_ID, LOCAL_ID)).toThrow('capability_unavailable');
		active(3n, false);
		expect(() => runtime.acquire(PLUGIN_ID, LOCAL_ID)).toThrow('capability_unavailable');
		expect(() => runtime.acquire('com.example.other', LOCAL_ID)).toThrow('capability_unavailable');
	});

	it('revokes every registered workspace during runtime teardown', () => {
		const { registry, runtime, active } = setup();
		active();
		const capability = runtime.acquire(PLUGIN_ID, LOCAL_ID);

		runtime.teardown(PLUGIN_ID);
		expect(() => registry.getExternalSessions(capability)).toThrow('capability_unavailable');
		expect(() => runtime.acquire(PLUGIN_ID, LOCAL_ID)).toThrow('capability_unavailable');
	});
});
