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

interface OpenModalOptions {
	tab?: string;
	list?: boolean;
	json?: boolean;
}

/** Formatted hotkey for a surface, or `undefined` when it has none. */
function shortcutFor(surface: UiSurface): string | undefined {
	if (!surface.shortcutId) return undefined;
	const shortcut = DEFAULT_SHORTCUTS[surface.shortcutId] ?? FIXED_SHORTCUTS[surface.shortcutId];
	// An action can be registered with no default binding, in which case there is
	// no hotkey to print - same answer as a surface that names no shortcut at all.
	if (!shortcut?.keys?.length) return undefined;
	return formatShortcutKeysFor(shortcut.keys, isMacOS(), '+');
}

function printSurfaceList(options: OpenModalOptions): void {
	if (options.json) {
		console.log(
			JSON.stringify(
				UI_SURFACES.map((surface) => ({
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
	const width = Math.max(...UI_SURFACES.map((surface) => surface.id.length));
	for (const surface of UI_SURFACES) {
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
		const valid = UI_SURFACES.map((entry) => entry.id).join(', ');
		fail(`Unknown surface "${surfaceName}". Valid surfaces: ${valid}`, options);
	}

	let tabId: string | undefined;
	if (options.tab !== undefined) {
		const tab = resolveUiSurfaceTab(surface, options.tab);
		if (!tab) {
			const valid = surfaceTabIds(surface);
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
		fail(error instanceof Error ? error.message : String(error), options);
	}
}

function fail(message: string, options: OpenModalOptions): never {
	if (options.json) console.log(JSON.stringify({ success: false, error: message }));
	else console.error(`Error: ${message}`);
	process.exit(1);
}
