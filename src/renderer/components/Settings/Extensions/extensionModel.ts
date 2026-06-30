/**
 * Unified "extension" model for the Extensions (Encore) marketplace.
 *
 * The Extensions view lists TWO sources behind one tiled grid:
 *  - first-party Encore features (the `encoreFeatures.*` flags), and
 *  - community plugins (from `window.maestro.plugins.list()`).
 *
 * Both are projected onto a single `UnifiedExtension` shape so the grid, the
 * category/search/only-installed filters, and the details pane treat them
 * uniformly. This module is pure (no React, no window) so it is trivially
 * testable and shared between the grid and the details pane.
 */

import type { PluginCategory } from '../../../../shared/plugins/plugin-manifest';
import {
	PIANOLA_FIRST_PARTY_PLUGIN_METADATA,
	type PianolaFirstPartyPluginMetadata,
} from '../../../../shared/pianola/first-party-plugin';
import type { PluginRecord, PluginSignatureInfo } from '../../../../shared/plugins/plugin-registry';
import { PLUGIN_CATEGORIES } from '../../../../shared/plugins/plugin-manifest';
import type { EncoreFeatureFlags } from '../../../types';

export type ExtensionKind = 'builtin' | 'plugin';

/**
 * State pill shown on a tile.
 *  - 'not-installed': a first-party feature that is turned off (enabling it is
 *    how you "install" it — built-ins are bundled but inactive until enabled).
 *  - 'installed': a plugin present on disk but disabled.
 *  - 'enabled': active (feature flag on / plugin enabled).
 */
export type ExtensionState = 'not-installed' | 'installed' | 'enabled';

/** Trust status mirrored from a plugin's signature verification. */
export type ExtensionTrust = PluginSignatureInfo['status'];

/** A first-party Encore feature surfaced as a tile. */
export interface BuiltinFeatureDef {
	flag: keyof EncoreFeatureFlags;
	name: string;
	description: string;
	category: PluginCategory;
	beta?: boolean;
	pluginBacking?: PianolaFirstPartyPluginMetadata;
}

/** One tile in the grid, regardless of source. */
export interface UnifiedExtension {
	/** Stable, source-namespaced key: `builtin:<flag>` or `plugin:<id>`. */
	key: string;
	kind: ExtensionKind;
	/** Encore flag name (builtin) or plugin id (plugin). */
	id: string;
	name: string;
	description: string;
	category: PluginCategory;
	state: ExtensionState;
	beta?: boolean;
	pluginBacked?: boolean;
	firstParty?: boolean;
	pluginId?: string;
	permissions?: PianolaFirstPartyPluginMetadata['permissions'];
	settingsNamespace?: string;
	backgroundServiceId?: string;
	// --- plugin-only ---
	tier?: number;
	trust?: ExtensionTrust;
	version?: string;
	author?: string;
	loadStatus?: PluginRecord['loadStatus'];
	record?: PluginRecord;
	// --- builtin-only ---
	flag?: keyof EncoreFeatureFlags;
}

/** The first-party Encore features the marketplace surfaces (NOT the `plugins`
 * subsystem flag itself, which is the master switch handled separately). */
export const BUILTIN_FEATURES: readonly BuiltinFeatureDef[] = [
	{
		flag: 'usageStats',
		name: 'Usage & Stats',
		description: 'Track queries, Auto Run sessions, and view the Usage Dashboard.',
		category: 'data',
	},
	{
		flag: 'symphony',
		name: 'Maestro Symphony',
		description: 'Contribute to open-source projects through curated repositories.',
		category: 'devtools',
	},
	{
		flag: 'maestroCue',
		name: 'Maestro Cue',
		description:
			'Event-driven automation — trigger agent prompts on timers, file changes, and completions.',
		category: 'automation',
		beta: true,
	},
	{
		flag: 'directorNotes',
		name: "Director's Notes",
		description: 'Unified history view and AI-generated synopsis across all sessions.',
		category: 'agents',
		beta: true,
	},
	{
		flag: 'pianola',
		name: 'Pianola',
		description: PIANOLA_FIRST_PARTY_PLUGIN_METADATA.description,
		category: PIANOLA_FIRST_PARTY_PLUGIN_METADATA.category,
		pluginBacking: PIANOLA_FIRST_PARTY_PLUGIN_METADATA,
		beta: true,
	},
];

/** Display labels for the category filter bar + tile badge. */
export const CATEGORY_LABELS: Record<PluginCategory, string> = {
	automation: 'Automation',
	agents: 'Agents',
	ui: 'UI',
	data: 'Data',
	devtools: 'Dev Tools',
	other: 'Other',
};

/** Pill text per state. */
export const STATE_LABELS: Record<ExtensionState, string> = {
	'not-installed': 'Not installed',
	installed: 'Installed',
	enabled: 'Enabled',
};

/** The category filter options: 'all' plus every known category. */
export type CategoryFilter = PluginCategory | 'all';
export const CATEGORY_FILTERS: readonly CategoryFilter[] = ['all', ...PLUGIN_CATEGORIES];

/** Project a first-party feature flag onto a tile. */
export function builtinExtension(
	def: BuiltinFeatureDef,
	flags: EncoreFeatureFlags
): UnifiedExtension {
	const on = flags[def.flag] === true;
	return {
		key: `builtin:${def.flag}`,
		kind: 'builtin',
		id: def.flag,
		name: def.name,
		description: def.description,
		category: def.category,
		state: on ? 'enabled' : 'not-installed',
		beta: def.beta,
		pluginBacked: def.pluginBacking ? true : undefined,
		firstParty: def.pluginBacking?.firstParty,
		pluginId: def.pluginBacking?.id,
		permissions: def.pluginBacking?.permissions,
		settingsNamespace: def.pluginBacking?.settings.namespace,
		backgroundServiceId: def.pluginBacking?.backgroundService.id,
		flag: def.flag,
	};
}

/** Project a discovered plugin record onto a tile. */
export function pluginExtension(record: PluginRecord): UnifiedExtension {
	const m = record.manifest;
	return {
		key: `plugin:${record.id}`,
		kind: 'plugin',
		id: record.id,
		name: m?.name ?? record.id,
		description: m?.description ?? '',
		category: m?.category ?? 'other',
		state: record.enabled ? 'enabled' : 'installed',
		tier: m?.tier,
		trust: record.signature?.status,
		version: m?.version,
		author: m?.author,
		loadStatus: record.loadStatus,
		record,
	};
}

/** Build the full, source-merged tile list (features first, then plugins). */
export function buildExtensions(
	flags: EncoreFeatureFlags,
	plugins: PluginRecord[]
): UnifiedExtension[] {
	const builtins = BUILTIN_FEATURES.map((def) => builtinExtension(def, flags));
	const pluginTiles = plugins.map(pluginExtension);
	return [...builtins, ...pluginTiles];
}

/** Apply the category + only-installed + search filters, in that order. */
export function filterExtensions(
	all: UnifiedExtension[],
	opts: { category: CategoryFilter; onlyInstalled: boolean; query: string }
): UnifiedExtension[] {
	const q = opts.query.trim().toLowerCase();
	return all.filter((ext) => {
		if (opts.category !== 'all' && ext.category !== opts.category) return false;
		if (opts.onlyInstalled && ext.state === 'not-installed') return false;
		if (q !== '') {
			const haystack =
				`${ext.name} ${ext.description} ${CATEGORY_LABELS[ext.category]}`.toLowerCase();
			if (!haystack.includes(q)) return false;
		}
		return true;
	});
}
