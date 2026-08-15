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
	pluginExtension,
	sortExtensions,
	BUILTIN_FEATURES,
	EXTENSION_SORT_VALUES,
	SORT_OPTIONS,
	type UnifiedExtension,
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
			'aCappella',
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

	it('projects A Cappella as a beta, disabled-by-default plugin-backed UI extension', () => {
		const aCappella = BUILTIN_FEATURES.find((def) => def.flag === 'aCappella');
		expect(aCappella).toBeDefined();
		expect(aCappella!.beta).toBe(true);

		expect(builtinExtension(aCappella!, flags())).toMatchObject({
			key: 'builtin:aCappella',
			state: 'not-installed',
			name: 'A Cappella',
			category: 'ui',
			pluginId: 'com.maestro.acappella',
			settingsNamespace: 'aCappella',
		});
		expect(builtinExtension(aCappella!, flags({ aCappella: true })).state).toBe('enabled');

		// Enabling voice must not imply a running background service: nothing
		// listens until the user explicitly starts a session.
		expect(builtinExtension(aCappella!, flags()).backgroundServiceId).toBeUndefined();
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

describe('extensionModel plugin beta projection', () => {
	it('projects a manifest beta: true onto the tile as beta === true', () => {
		const record = pluginRecord('com.example.beta');
		record.manifest = { ...record.manifest!, beta: true };
		expect(pluginExtension(record).beta).toBe(true);
	});

	it('projects a manifest without beta as beta === undefined', () => {
		const ext = pluginExtension(pluginRecord('com.example.stable'));
		expect(ext.beta).toBeUndefined();
	});

	it('leaves built-in beta-list projection unchanged', () => {
		const cueDef = BUILTIN_FEATURES.find((def) => def.flag === 'maestroCue');
		expect(cueDef).toBeDefined();
		// maestroCue is on the builtin beta list, so its tile stays beta: true.
		expect(builtinExtension(cueDef!, flags()).beta).toBe(true);
		const usageDef = BUILTIN_FEATURES.find((def) => def.flag === 'usageStats');
		expect(usageDef).toBeDefined();
		// usageStats is not on the beta list, so its tile stays non-beta.
		expect(builtinExtension(usageDef!, flags()).beta).toBe(false);
	});
});

describe('extensionModel release dates', () => {
	it('gives every first-party feature a well-formed calendar day', () => {
		for (const def of BUILTIN_FEATURES) {
			const ext = builtinExtension(def, flags());
			expect(ext.releaseDate, `${def.flag} has no releaseDate`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(Number.isNaN(Date.parse(`${ext.releaseDate}T00:00:00Z`))).toBe(false);
		}
	});

	it('carries a plugin manifest releaseDate onto its tile, and leaves it off when absent', () => {
		const dated = pluginRecord('com.example.dated');
		dated.manifest = { ...dated.manifest!, releaseDate: '2026-07-10' };
		expect(pluginExtension(dated).releaseDate).toBe('2026-07-10');
		expect(pluginExtension(pluginRecord('com.example.undated')).releaseDate).toBeUndefined();
	});
});

describe('sortExtensions', () => {
	function tile(name: string, releaseDate?: string): UnifiedExtension {
		return {
			key: `plugin:${name}`,
			kind: 'plugin',
			id: name,
			name,
			description: '',
			category: 'other',
			state: 'installed',
			...(releaseDate ? { releaseDate } : {}),
		};
	}

	const list = [
		tile('Zeta', '2026-01-01'),
		tile('alpha', '2025-06-01'),
		tile('Undated'),
		tile('Mid', '2026-07-04'),
	];

	it('sorts A-Z case-insensitively', () => {
		expect(sortExtensions(list, 'name').map((e) => e.name)).toEqual([
			'alpha',
			'Mid',
			'Undated',
			'Zeta',
		]);
	});

	it('sorts newest first and parks undated tiles at the end', () => {
		expect(sortExtensions(list, 'newest').map((e) => e.name)).toEqual([
			'Mid',
			'Zeta',
			'alpha',
			'Undated',
		]);
	});

	it('breaks ties on the same day by name, in both modes', () => {
		const sameDay = [tile('Beta', '2026-02-02'), tile('Alpha', '2026-02-02')];
		expect(sortExtensions(sameDay, 'newest').map((e) => e.name)).toEqual(['Alpha', 'Beta']);
		expect(sortExtensions(sameDay, 'name').map((e) => e.name)).toEqual(['Alpha', 'Beta']);
	});

	it('does not mutate the input list', () => {
		const original = [...list];
		sortExtensions(list, 'newest');
		expect(list).toEqual(original);
	});

	it('keeps the sort-option values and the persisted-choice list in step', () => {
		expect(EXTENSION_SORT_VALUES).toEqual(SORT_OPTIONS.map((o) => o.value));
	});
});
