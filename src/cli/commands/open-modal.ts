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
import { DEFAULT_SHORTCUTS, FIXED_SHORTCUTS } from '../../renderer/constants/shortcuts';
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
import { resolveEffectiveShortcuts } from '../../shared/effectiveShortcuts';

interface OpenModalOptions {
	tab?: string;
	list?: boolean;
	json?: boolean;
}

/** Formatted hotkey for a surface, or `undefined` when it has none. */
function shortcutFor(surface: UiSurface): string | undefined {
	if (!surface.shortcutId) return undefined;

	// Read persisted settings and resolve through the active keyboard mode
	const settings = readSettings();
	const keyboardMode = (settings.keyboardMode ?? 'default') as string;

	// Build the base maps from DEFAULT_SHORTCUTS and FIXED_SHORTCUTS
	const base = {
		shortcuts: DEFAULT_SHORTCUTS,
		tabShortcuts: {}, // FIXED_SHORTCUTS are merged here
	};

	// Merge FIXED_SHORTCUTS into tabShortcuts for the effective resolution
	Object.assign(base.tabShortcuts, FIXED_SHORTCUTS);

	// Get override maps from settings
	const vimShortcuts = (settings.vimShortcuts as Record<string, any>) ?? {};
	const vimTabShortcuts = (settings.vimTabShortcuts as Record<string, any>) ?? {};

	// Select the appropriate override maps based on keyboard mode
	const overrides =
		keyboardMode === 'vim'
			? { vimShortcuts, vimTabShortcuts }
			: { vimShortcuts: {}, vimTabShortcuts: {} };

	// Resolve the effective shortcuts for the active mode
	const effective = resolveEffectiveShortcuts(base, overrides);

	// Look up the action in the effective maps
	const shortcut =
		effective.shortcuts[surface.shortcutId] ?? effective.tabShortcuts[surface.shortcutId];

	// An action can be registered with no default binding, in which case there is
	// no hotkey to print - same answer as a surface that names no shortcut at all.
	if (!shortcut?.keys?.length) return undefined;
	return formatShortcutKeysFor(shortcut.keys, isMacOS(), '+');
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
	if (options.json) {
		console.log(
			JSON.stringify(
				surfaces.map((surface) => ({
					id: surface.id,
					label: surface.label,
					aliases: surface.aliases ?? [],
					description: surface.description,
					tabs: surfaceTabIds(surface),
					shortcut: shortcutFor(surface) ?? '',
					command_palette: surface.commandPalette ?? '',
					encore: surface.encore ?? '',
				}))
			)
		);
		return;
	}
	const width = Math.max(...surfaces.map((surface) => surface.id.length));
	for (const surface of surfaces) {
		const shortcut = shortcutFor(surface);
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

		const hint = describeSurfaceAccess(surface, shortcutFor(surface));
		if (options.json) {
			console.log(
				JSON.stringify({
					success: true,
					surface: surface.id,
					label: surface.label,
					tab: tabId ?? '',
					shortcut: shortcutFor(surface) ?? '',
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
