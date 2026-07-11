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
	FIRST_PARTY_PLUGIN_DEFINITIONS,
	type FirstPartyEncoreFlag,
	type FirstPartyPluginDefinition,
} from '../../../../shared/plugins/first-party';
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

/** A first-party Encore feature surfaced as a tile. Every built-in is
 * plugin-backed: its identity/category/permissions come from the shared
 * first-party registry (src/shared/plugins/first-party.ts). */
export interface BuiltinFeatureDef {
	flag: keyof EncoreFeatureFlags;
	beta?: boolean;
	pluginBacking: FirstPartyPluginDefinition;
}

// The registry's flag union must stay a subset of the renderer's
// EncoreFeatureFlags (shared code cannot import renderer types directly).
type _FirstPartyFlagsAreEncoreFlags = FirstPartyEncoreFlag extends keyof EncoreFeatureFlags
	? true
	: never;
const _firstPartyFlagsAssignable: _FirstPartyFlagsAreEncoreFlags = true;
void _firstPartyFlagsAssignable;

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
	permissions?: FirstPartyPluginDefinition['permissions'];
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
	/** Another Encore flag that must be ON before this feature can be enabled
	 * (see {@link BUILTIN_DEPENDENCIES}). Undefined for independent features. */
	dependsOn?: keyof EncoreFeatureFlags;
}

/**
 * First-party feature dependencies: a feature that cannot be enabled unless
 * another Encore flag is on. Board is the first such dependent flag - it rides
 * the Maestro Cue engine tick, so it requires `maestroCue`. The main-process
 * dispatcher enforces the same dual-gate at runtime; this map is the
 * renderer-side mirror that disables the tile's enable toggle until the
 * dependency is satisfied. Keep it a single source of truth: new dependent
 * features add one entry here.
 */
export const BUILTIN_DEPENDENCIES: Partial<
	Record<keyof EncoreFeatureFlags, keyof EncoreFeatureFlags>
> = {
	board: 'maestroCue',
};

/** Whether a builtin's dependency (if any) is satisfied by the current flags.
 * Plugins and features with no dependency are always considered met. */
export function isDependencyMet(ext: UnifiedExtension, flags: EncoreFeatureFlags): boolean {
	if (!ext.dependsOn) return true;
	return flags[ext.dependsOn] === true;
}

/** The first-party Encore features the marketplace surfaces (NOT the `plugins`
 * subsystem flag itself, which is the master switch handled separately).
 * Projected from the shared first-party plugin registry; `beta` is a
 * marketplace-presentation concern, so it stays here. */
export const BUILTIN_FEATURES: readonly BuiltinFeatureDef[] = FIRST_PARTY_PLUGIN_DEFINITIONS.map(
	(def) => ({
		flag: def.encoreFlag,
		beta:
			def.encoreFlag === 'maestroCue' ||
			def.encoreFlag === 'directorNotes' ||
			def.encoreFlag === 'pianola' ||
			def.encoreFlag === 'coworking' ||
			def.encoreFlag === 'opencodeServer' ||
			def.encoreFlag === 'concerto' ||
			def.encoreFlag === 'board' ||
			def.encoreFlag === 'groupsPlus',
		pluginBacking: def,
	})
);

/** Display labels for the category filter bar + tile badge. */
export const CATEGORY_LABELS: Record<PluginCategory, string> = {
	automation: 'Automation',
	agents: 'Agents',
	insights: 'Insights',
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
	const backing = def.pluginBacking;
	return {
		key: `builtin:${def.flag}`,
		kind: 'builtin',
		id: def.flag,
		name: backing.name,
		description: backing.description,
		category: backing.category,
		state: on ? 'enabled' : 'not-installed',
		beta: def.beta,
		pluginBacked: true,
		firstParty: backing.firstParty,
		pluginId: backing.id,
		permissions: backing.permissions,
		settingsNamespace: backing.settingsNamespace,
		backgroundServiceId: backing.backgroundServices[0]?.id,
		flag: def.flag,
		dependsOn: BUILTIN_DEPENDENCIES[def.flag],
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
