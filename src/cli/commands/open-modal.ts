/**
 * `maestro-cli open <surface> [--tab <tab>]` - open one of Maestro's modals
 * or dashboards in the running desktop app, optionally on a specific tab.
 *
 * The point is teaching, not just navigating: an agent answering "where do I
 * see my scheduled tasks?" can open the surface AND relay the manual paths
 * (hotkey, command palette, click target) printed alongside the confirmation.
 * Surfaces, their tabs, and those hints all come from `shared/uiSurfaces.ts`.
 */

import { withMaestroClient } from '../services/maestro-client';
import { isMacOS } from '../../shared/platformDetection';
import { formatShortcutKeysFor } from '../../shared/shortcutKeys';
import { DEFAULT_SHORTCUTS, TAB_SHORTCUTS } from '../../renderer/constants/shortcuts';
import {
	resolveShortcutKeys,
	type ShortcutDisplayMaps,
} from '../../renderer/utils/shortcutResolve';
import { asKeyboardMode, type Shortcut, type ShortcutOverride } from '../../shared/shortcut-types';
import {
	UI_SURFACES,
	describeSurfaceAccess,
	resolveUiSurface,
	resolveUiSurfaceTab,
	surfaceTabIds,
	type UiSurface,
} from '../../shared/uiSurfaces';
import { exitIfMaestroNotRunning } from '../services/session-command';
import { readEncoreFlags, requireEncore } from '../utils/encore-gate';
import { readSettings } from '../services/storage';
import {
	resolveEffectiveShortcuts,
	type ShortcutBaseMaps,
	type ShortcutOverrideMaps,
} from '../../shared/effectiveShortcuts';

interface OpenModalOptions {
	tab?: string;
	list?: boolean;
	json?: boolean;
}

/**
 * The maps the live keyboard mode is matched against, built from persisted
 * settings exactly the way the renderer builds them.
 *
 * Four things this has to get right, and each was wrong before it was written
 * down here:
 *
 *  1. The user's OWN bindings are the base. The renderer resolves against
 *     `state.shortcuts` / `state.tabShortcuts`, which are the persisted buckets
 *     merged over the shipped tables. Resolving against the shipped tables alone
 *     printed the chord Maestro ships for an action the user had rebound.
 *  2. `TAB_SHORTCUTS` is a base map, not an afterthought. Every surface's
 *     `shortcutId` happens to live in `DEFAULT_SHORTCUTS` today, so leaving it
 *     out cost nothing yet - which is exactly how it would stay broken until
 *     someone moved one.
 *  3. `FIXED_SHORTCUTS` is NOT a base map. It is the table no mode overrides
 *     and no user rebinds, and `resolveShortcutKeys` reads it separately.
 *     Feeding it in as `tabShortcuts` put it inside the inheritance and
 *     displacement rules, so a Vim override could have taken a fixed chord.
 *  4. One settings read. `printSurfaceList` asks for a chord once per surface
 *     and the JSON path asks twice, so reading the file inside the per-surface
 *     lookup meant a parse of `maestro-settings.json` per row.
 */
function activeShortcutMaps(): ShortcutDisplayMaps {
	const settings = readSettings();

	// Persisted over shipped, per bucket - the same merge `hydrateShortcutsSettings`
	// performs in the renderer. An id the persisted bucket does not mention keeps
	// its shipped chord; a retired id it still carries is simply never asked for.
	const base: ShortcutBaseMaps = {
		shortcuts: {
			...DEFAULT_SHORTCUTS,
			...((settings.shortcuts as Record<string, Shortcut>) ?? {}),
		},
		tabShortcuts: {
			...TAB_SHORTCUTS,
			...((settings.tabShortcuts as Record<string, Shortcut>) ?? {}),
		},
	};

	// Only the live mode's override buckets apply. Default mode is the set every
	// other mode inherits FROM, so it resolves against empty overrides and comes
	// back with the base maps unchanged.
	const vim = asKeyboardMode(settings.keyboardMode) === 'vim';
	const overrides: ShortcutOverrideMaps = {
		vimShortcuts: vim ? ((settings.vimShortcuts as Record<string, ShortcutOverride>) ?? {}) : {},
		vimTabShortcuts: vim
			? ((settings.vimTabShortcuts as Record<string, ShortcutOverride>) ?? {})
			: {},
	};

	return resolveEffectiveShortcuts(base, overrides);
}

/**
 * Formatted hotkey for a surface, or `undefined` when it has none.
 *
 * `maps` is passed in so a list of surfaces reads settings once; omitted, it
 * resolves them for this one lookup.
 */
function shortcutFor(surface: UiSurface, maps: ShortcutDisplayMaps): string | undefined {
	// The canonical display resolver, not a hand-rolled lookup: it applies the
	// fixed-then-tab-then-global fallback order that `isTabShortcut` matches on,
	// so the chord the CLI prints is the one that actually fires. An action can
	// be registered with no binding, in which case there is no hotkey to print -
	// the same answer as a surface that names no shortcut at all.
	const resolved = resolveShortcutKeys(surface.shortcutId, maps);
	if (resolved.keys.length === 0) return undefined;
	return formatShortcutKeysFor(resolved.keys, isMacOS(), '+');
}

/**
 * The surfaces, and their tabs, that exist right now: a switched-off Encore
 * Feature's are left out, the same as in the app.
 */
function availableSurfaces(): UiSurface[] {
	const flags = readEncoreFlags();
	const exists = (entry: { encore?: UiSurface['encore'] }) => !entry.encore || flags[entry.encore];
	return UI_SURFACES.filter(exists).map((surface) =>
		surface.tabs ? { ...surface, tabs: surface.tabs.filter(exists) } : surface
	);
}

function printSurfaceList(options: OpenModalOptions): void {
	const surfaces = availableSurfaces();
	const maps = activeShortcutMaps();
	if (options.json) {
		console.log(
			JSON.stringify(
				surfaces.map((surface) => ({
					id: surface.id,
					label: surface.label,
					aliases: surface.aliases ?? [],
					description: surface.description,
					tabs: surfaceTabIds(surface),
					shortcut: shortcutFor(surface, maps) ?? '',
					command_palette: surface.commandPalette ?? '',
					encore: surface.encore ?? '',
				}))
			)
		);
		return;
	}
	const width = Math.max(...surfaces.map((surface) => surface.id.length));
	for (const surface of surfaces) {
		const shortcut = shortcutFor(surface, maps);
		const tabs = surfaceTabIds(surface);
		const extras = [
			shortcut ? `key: ${shortcut}` : null,
			tabs.length > 0 ? `tabs: ${tabs.join(', ')}` : null,
		]
			.filter(Boolean)
			.join('  |  ');
		console.log(
			`${surface.id.padEnd(width)}  ${surface.description}${extras ? `\n${' '.repeat(width + 2)}${extras}` : ''}`
		);
	}
}

export async function openModal(
	surfaceName: string | undefined,
	options: OpenModalOptions
): Promise<void> {
	if (options.list || !surfaceName) {
		printSurfaceList(options);
		if (!surfaceName && !options.list) {
			console.error('\nError: missing <surface>. Pick one of the ids above.');
			process.exit(1);
		}
		return;
	}

	const surface = resolveUiSurface(surfaceName);
	if (!surface) {
		const valid = availableSurfaces()
			.map((entry) => entry.id)
			.join(', ');
		fail(`Unknown surface "${surfaceName}". Valid surfaces: ${valid}`, options);
	}
	if (surface.encore) requireEncore(surface.encore, options.json);

	let tabId: string | undefined;
	if (options.tab !== undefined) {
		const tab = resolveUiSurfaceTab(surface, options.tab);
		if (tab?.encore) requireEncore(tab.encore, options.json);
		if (!tab) {
			const valid = surfaceTabIds(
				availableSurfaces().find((entry) => entry.id === surface.id) ?? surface
			);
			fail(
				valid.length > 0
					? `Unknown tab "${options.tab}" for ${surface.label}. Valid tabs: ${valid.join(', ')}`
					: `${surface.label} has no tabs, so --tab does not apply.`,
				options
			);
		}
		tabId = tab.id;
	}

	try {
		const result = await withMaestroClient(async (client) =>
			client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{ type: 'open_modal', surface: surface.id, tab: tabId },
				'open_modal_result'
			)
		);

		if (!result.success) {
			fail(result.error || `Failed to open ${surface.label}`, options);
		}

		const shortcut = shortcutFor(surface, activeShortcutMaps());
		const hint = describeSurfaceAccess(surface, shortcut);
		if (options.json) {
			console.log(
				JSON.stringify({
					success: true,
					surface: surface.id,
					label: surface.label,
					tab: tabId ?? '',
					shortcut: shortcut ?? '',
					command_palette: surface.commandPalette ?? '',
					click: surface.click ?? '',
					hint,
				})
			);
			return;
		}
		const tabSuffix = tabId ? ` (${tabId} tab)` : '';
		console.log(`Opened ${surface.label}${tabSuffix} in Maestro.`);
		if (hint) console.log(hint);
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json });
		fail(error instanceof Error ? error.message : String(error), options);
	}
}

function fail(message: string, options: OpenModalOptions): never {
	if (options.json) console.log(JSON.stringify({ success: false, error: message }));
	else console.error(`Error: ${message}`);
	process.exit(1);
}
