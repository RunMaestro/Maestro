import { describe, it, expect } from 'vitest';
import type { PluginRecord } from '../../../../../shared/plugins/plugin-registry';
import {
	FIRST_PARTY_PLUGINS,
	PIANOLA_FIRST_PARTY_PLUGIN_ID,
	PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS,
} from '../../../../../shared/plugins/first-party';
import {
	buildExtensions,
	builtinExtension,
	BUILTIN_FEATURES,
	pluginExtension,
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

describe('extensionModel first-party projection (all Encore features)', () => {
	it('projects EVERY built-in feature as plugin-backed from the shared registry', () => {
		expect(BUILTIN_FEATURES.map((def) => def.flag)).toEqual([
			'usageStats',
			'symphony',
			'maestroCue',
			'directorNotes',
			'pianola',
			'coworking',
			'opencodeServer',
			'concerto',
			'groupsPlus',
		]);

		for (const def of BUILTIN_FEATURES) {
			const backing = FIRST_PARTY_PLUGINS[def.flag as keyof typeof FIRST_PARTY_PLUGINS];
			const ext = builtinExtension(def, flags({ [def.flag]: true }));
			expect(ext).toMatchObject({
				key: `builtin:${def.flag}`,
				kind: 'builtin',
				id: def.flag,
				name: backing.name,
				description: backing.description,
				category: backing.category,
				state: 'enabled',
				pluginBacked: true,
				firstParty: true,
				pluginId: backing.id,
				settingsNamespace: backing.settingsNamespace,
			});
			expect(ext.permissions).toEqual(backing.permissions);
			expect(ext.backgroundServiceId).toBe(backing.backgroundServices[0]?.id);
		}
	});

	it('projects Groups+ as a disabled-by-default plugin-backed UI extension', () => {
		const groupsPlus = BUILTIN_FEATURES.find((def) => def.flag === 'groupsPlus');
		expect(groupsPlus).toBeDefined();

		expect(builtinExtension(groupsPlus!, flags())).toMatchObject({
			key: 'builtin:groupsPlus',
			state: 'not-installed',
			name: 'Groups+',
			category: 'ui',
			pluginId: 'com.maestro.groups-plus',
			settingsNamespace: 'groupsPlus',
		});
		expect(builtinExtension(groupsPlus!, flags({ groupsPlus: true })).state).toBe('enabled');
	});

	it('surfaces the plan-table identities on the details pane fields', () => {
		const byFlag = (flag: keyof EncoreFeatureFlags) =>
			builtinExtension(BUILTIN_FEATURES.find((d) => d.flag === flag)!, flags());
		expect(byFlag('directorNotes')).toMatchObject({
			pluginId: 'com.maestro.director-notes',
			category: 'insights',
		});
		expect(byFlag('usageStats')).toMatchObject({
			pluginId: 'com.maestro.usage-stats',
			category: 'insights',
		});
		expect(byFlag('symphony')).toMatchObject({
			pluginId: 'com.maestro.symphony',
			category: 'agents',
		});
		expect(byFlag('maestroCue')).toMatchObject({
			pluginId: 'com.maestro.cue',
			category: 'automation',
		});
	});

	it('off flags project as not-installed tiles', () => {
		const extensions = buildExtensions(flags(), []);
		for (const ext of extensions) {
			expect(ext.state).toBe('not-installed');
		}
	});
});

describe('extensionModel provided plugin projection', () => {
	it('classifies OMP as first-party only when host bundle provenance is present', () => {
		const bundled = pluginExtension({ ...pluginRecord('com.maestro.omp'), installOwner: 'bundle' });
		const spoofed = pluginExtension(pluginRecord('com.maestro.omp'));
		const community = pluginExtension(pluginRecord('com.example.demo'));

		expect(bundled).toMatchObject({
			firstParty: true,
			provided: true,
			pluginId: 'com.maestro.omp',
		});
		expect(spoofed.firstParty).toBeUndefined();
		expect(spoofed.provided).toBeUndefined();
		expect(community.firstParty).toBeUndefined();
	});
});
