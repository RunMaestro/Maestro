import { describe, it, expect } from 'vitest';
import type { PluginRecord } from '../../../../../shared/plugins/plugin-registry';
import {
	PIANOLA_FIRST_PARTY_PLUGIN_ID,
	PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS,
} from '../../../../../shared/pianola/first-party-plugin';
import {
	buildExtensions,
	builtinExtension,
	BUILTIN_FEATURES,
} from '../../../../../renderer/components/Settings/Extensions/extensionModel';
import type { EncoreFeatureFlags } from '../../../../../renderer/types';

function flags(overrides: Partial<EncoreFeatureFlags> = {}): EncoreFeatureFlags {
	return {
		directorNotes: false,
		usageStats: false,
		symphony: false,
		maestroCue: false,
		pianola: false,
		plugins: false,
		...overrides,
	};
}

function pluginRecord(id: string): PluginRecord {
	return {
		id,
		source: `/plugins/${id}`,
		folderName: id,
		enabled: false,
		loadStatus: 'ok',
		errors: [],
		manifest: {
			id,
			name: 'Demo Plugin',
			version: '1.0.0',
			tier: 1,
			maestro: { minHostApi: '1.0.0' },
			entry: 'main.js',
			category: 'automation',
		},
	};
}

describe('extensionModel Pianola first-party plugin backing', () => {
	it('projects Pianola as a built-in Encore feature with first-party plugin metadata', () => {
		const pianolaDef = BUILTIN_FEATURES.find((def) => def.flag === 'pianola');
		expect(pianolaDef).toBeDefined();

		const ext = builtinExtension(pianolaDef!, flags({ pianola: true }));
		expect(ext).toMatchObject({
			key: 'builtin:pianola',
			kind: 'builtin',
			id: 'pianola',
			state: 'enabled',
			category: 'agents',
			pluginBacked: true,
			pluginId: PIANOLA_FIRST_PARTY_PLUGIN_ID,
			firstParty: true,
			settingsNamespace: 'pianola',
			backgroundServiceId: 'pianola.supervisor',
		});
		expect(ext.permissions).toEqual(PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS);
	});

	it('keeps Pianola first-party and plugin-backed when merged with installed plugins', () => {
		const extensions = buildExtensions(flags({ pianola: false }), [
			pluginRecord('com.example.demo'),
		]);
		const pianola = extensions.find((ext) => ext.id === 'pianola');
		const plugin = extensions.find((ext) => ext.id === 'com.example.demo');

		expect(pianola).toMatchObject({
			kind: 'builtin',
			state: 'not-installed',
			pluginBacked: true,
			pluginId: PIANOLA_FIRST_PARTY_PLUGIN_ID,
		});
		expect(plugin?.kind).toBe('plugin');
		expect(plugin?.pluginBacked).toBeUndefined();
	});
});
