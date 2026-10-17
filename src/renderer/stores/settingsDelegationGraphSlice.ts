/**
 * Delegation Graph settings slice for settingsStore.
 *
 * Part of the same domain-slice decomposition as settingsAnnotatorSlice.ts -
 * see that file for the pattern this follows.
 *
 * It holds one record: where the user left each agent on the Delegation Graph,
 * per scope. This is the persisted store the graph needs. The Document Graph's
 * `saveNodePositions` is a module-level `Map` that dies with the renderer, and
 * a hand-arranged team picture has to still be there tomorrow.
 *
 * The record joins two modules that stay apart on purpose: the layout
 * vocabulary (`delegationLayoutTypes.ts`, a leaf) and the position storage
 * rules (`shared/delegationGraphLayout.ts`).
 */

import type { StateCreator } from 'zustand';
import type { SettingsStore } from './settingsStore';
import type { DelegationGraphScope } from '../../shared/delegationGraph';
import {
	DELEGATION_GRAPH_LAYOUTS_SETTING,
	parseSavedPositions,
	parseScopeStorageKey,
	scopeStorageKey,
	type DelegationSavedPositions,
} from '../../shared/delegationGraphLayout';
import {
	DEFAULT_DELEGATION_LAYOUT,
	isDelegationLayoutType,
	type DelegationLayoutType,
} from '../components/DelegationGraph/delegationLayoutTypes';

/** One scope's arrangement: which layout it is on, and where each agent sits. */
export interface DelegationScopeLayout {
	layout: DelegationLayoutType;
	positions: DelegationSavedPositions;
}

/**
 * Every saved arrangement, keyed by `scopeStorageKey(scope)`. Sparse: a scope
 * with no entry is on the default layout with nothing placed by hand.
 */
export type DelegationGraphLayouts = Record<string, DelegationScopeLayout>;

export interface DelegationGraphState {
	delegationGraphLayouts: DelegationGraphLayouts;
}

export interface DelegationGraphActions {
	/** Save one scope's arrangement. The other scopes are not touched. */
	setDelegationScopeLayout: (scope: DelegationGraphScope, value: DelegationScopeLayout) => void;
	/** Forget one scope's arrangement, so it opens on the default layout again. */
	resetDelegationScopeLayout: (scope: DelegationGraphScope) => void;
}

export type DelegationGraphSlice = DelegationGraphState & DelegationGraphActions;

/**
 * The entry to store for a scope, or `null` when it says nothing a missing
 * entry does not already say.
 *
 * Two rules keep the record honest:
 *
 *   - `manual` means "leave every agent where it was put". With no positions
 *     there is nothing that was put anywhere, so it is not `manual`. Stored
 *     as-is, the next open would treat every agent as new and pile them up.
 *   - The default layout with no positions is exactly what an absent entry
 *     means, so it is not stored.
 */
function normalizeScopeLayout(
	layout: unknown,
	rawPositions: unknown
): DelegationScopeLayout | null {
	const positions = parseSavedPositions(rawPositions);
	const hasPositions = Object.keys(positions).length > 0;

	let resolved = isDelegationLayoutType(layout) ? layout : DEFAULT_DELEGATION_LAYOUT;
	if (resolved === 'manual' && !hasPositions) resolved = DEFAULT_DELEGATION_LAYOUT;

	if (resolved === DEFAULT_DELEGATION_LAYOUT && !hasPositions) return null;
	return { layout: resolved, positions };
}

/**
 * The usable part of a stored `delegationGraphLayouts` value. Drops a key that
 * is not a scope key, a layout this build cannot draw (the scope falls back to
 * the default and keeps its positions), and any coordinate that is not a pair
 * of finite numbers.
 */
export function sanitizeDelegationGraphLayouts(raw: unknown): DelegationGraphLayouts {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

	const layouts: DelegationGraphLayouts = {};
	for (const [key, value] of Object.entries(raw)) {
		if (parseScopeStorageKey(key) === null) continue;
		if (!value || typeof value !== 'object') continue;
		const stored = value as Partial<Record<keyof DelegationScopeLayout, unknown>>;
		const entry = normalizeScopeLayout(stored.layout, stored.positions);
		if (entry) layouts[key] = entry;
	}
	return layouts;
}

export const createDelegationGraphSlice: StateCreator<
	SettingsStore,
	[],
	[],
	DelegationGraphSlice
> = (set, get) => ({
	delegationGraphLayouts: {},

	setDelegationScopeLayout: (scope, value) => {
		const key = scopeStorageKey(scope);
		const { [key]: _previous, ...rest } = get().delegationGraphLayouts;
		const entry = normalizeScopeLayout(value.layout, value.positions);
		const next: DelegationGraphLayouts = entry ? { ...rest, [key]: entry } : rest;
		set({ delegationGraphLayouts: next });
		window.maestro.settings.set(DELEGATION_GRAPH_LAYOUTS_SETTING, next);
	},

	resetDelegationScopeLayout: (scope) => {
		const key = scopeStorageKey(scope);
		const { [key]: previous, ...rest } = get().delegationGraphLayouts;
		// Nothing saved for this scope: there is nothing to forget and nothing to write.
		if (!previous) return;
		set({ delegationGraphLayouts: rest });
		window.maestro.settings.set(DELEGATION_GRAPH_LAYOUTS_SETTING, rest);
	},
});

/** Mutates `patch` in place with the persisted Delegation Graph layouts found in `allSettings`. */
export function hydrateDelegationGraphSettings(
	allSettings: Record<string, unknown>,
	patch: Partial<DelegationGraphState>
): void {
	if (allSettings[DELEGATION_GRAPH_LAYOUTS_SETTING] !== undefined) {
		patch.delegationGraphLayouts = sanitizeDelegationGraphLayouts(
			allSettings[DELEGATION_GRAPH_LAYOUTS_SETTING]
		);
	}
}
