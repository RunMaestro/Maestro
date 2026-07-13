import { describe, expect, it } from 'vitest';
import { PluginPanelDescriptorRegistry } from '../../main/plugins/plugin-panel-descriptor-registry';

const ownerPluginId = 'com.example.plugin';
const panelLocalId = 'main-panel';
const bridge = Object.freeze({
	requestSchemas: Object.freeze({ ping: { canonicalJsonSchema: { type: 'object' } } }),
	eventSchemas: Object.freeze({}),
	resultSchemas: Object.freeze({ ping: { canonicalJsonSchema: { type: 'object' } } }),
	errorSchemas: Object.freeze({ ping: { canonicalJsonSchema: { type: 'object' } } }),
});

function record(overrides: Record<string, unknown> = {}) {
	return {
		id: ownerPluginId,
		loadStatus: 'ok',
		enabled: true,
		signature: { status: 'trusted' },
		manifest: {
			id: ownerPluginId,
			workspaceFoundation: {
				ownerPluginId,
				panel: { localId: panelLocalId, bridge },
			},
		},
		...overrides,
	} as never;
}

function projection(panelId = panelLocalId) {
	return { ownerPluginId, panel: { localId: panelId }, generation: 2n } as never;
}

describe('PluginPanelDescriptorRegistry', () => {
	it('exposes only the immutable bridge for a current trusted canonical panel', () => {
		const registry = new PluginPanelDescriptorRegistry();
		registry.sync([record()]);

		const descriptor = registry.get(projection());
		expect(descriptor).toBe(bridge);
		expect(Object.isFrozen(descriptor)).toBe(true);
	});

	it('rejects duplicate or invalid declarations and clears stale or removed panels', () => {
		const registry = new PluginPanelDescriptorRegistry();
		expect(() => registry.sync([record(), record()])).toThrow('DuplicatePluginPanelDescriptor');
		expect(() =>
			registry.sync([
				record({
					manifest: {
						id: ownerPluginId,
						workspaceFoundation: {
							ownerPluginId,
							panel: { localId: panelLocalId, bridge: {} },
						},
					},
				}),
			])
		).toThrow('InvalidPluginPanelDescriptor');

		registry.sync([record()]);
		expect(registry.get(projection('replacement-panel'))).toBeNull();
		registry.sync([]);
		expect(registry.get(projection())).toBeNull();
	});
});
