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
	BUILTIN_DEPENDENCIES,
	isDependencyMet,
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
			'board',
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

describe('feature dependencies (Board requires Maestro Cue)', () => {
	const boardDef = BUILTIN_FEATURES.find((d) => d.flag === 'board');

	it('declares board -> maestroCue as the first dependent flag', () => {
		expect(BUILTIN_DEPENDENCIES.board).toBe('maestroCue');
	});

	it('projects dependsOn onto the board tile and leaves independent tiles undefined', () => {
		expect(boardDef).toBeDefined();
		const boardTile = builtinExtension(boardDef!, flags({ board: true }));
		expect(boardTile.dependsOn).toBe('maestroCue');

		const cueDef = BUILTIN_FEATURES.find((d) => d.flag === 'maestroCue')!;
		const cueTile = builtinExtension(cueDef, flags());
		expect(cueTile.dependsOn).toBeUndefined();
	});

	it('isDependencyMet is false when Cue is off and true when Cue is on', () => {
		const boardTile = builtinExtension(boardDef!, flags({ board: true }));
		expect(isDependencyMet(boardTile, flags({ maestroCue: false }))).toBe(false);
		expect(isDependencyMet(boardTile, flags({ maestroCue: true }))).toBe(true);
	});

	it('isDependencyMet is always true for a feature with no dependency', () => {
		const cueDef = BUILTIN_FEATURES.find((d) => d.flag === 'maestroCue')!;
		const cueTile = builtinExtension(cueDef, flags());
		expect(isDependencyMet(cueTile, flags())).toBe(true);
	});
});
