/**
 * @file kanban-ways-in.test.ts
 * @description Proves the Kanban board has three ways in - a keybinding, a
 * command palette entry, and a Left Bar launcher item - by reading the REAL
 * `examples/plugins/maestro-kanban/plugin.json` through the host's own manifest
 * and contribution validators, rather than by clicking the app.
 *
 * Reading the shipped manifest (not a fixture) is the point: these assertions
 * fail if someone renames the `open` command, drops the keybinding, moves the
 * launcher to a surface no host region renders, or takes away the capability
 * that gates the launcher. A fixture would keep passing while the plugin a user
 * installs had lost its way in.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { validatePluginManifest, type PluginManifest } from '../../shared/plugins/plugin-manifest';
import {
	collectContributions,
	gateContributions,
	isPluginUiSurface,
	UI_SURFACES,
} from '../../shared/plugins/contributions';
import type { PluginCapability } from '../../shared/plugins/permissions';
import { findReservedShortcutCombo } from '../../shared/shortcutKeys';
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../renderer/constants/shortcuts';
import { buildPluginCommandPaletteCommands } from '../../renderer/components/QuickActionsModal/commands/pluginCommandPaletteCommands';

const require = createRequire(import.meta.url);
const manifestPath = require.resolve('../../../examples/plugins/maestro-kanban/plugin.json');

/** The shipped manifest, through the host's own validator. A manifest that does
 * not validate has no ways in at all, so every other assertion here rides on
 * this one. */
function loadManifest(): PluginManifest {
	const result = validatePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
	if (!result.manifest) throw new Error(`manifest invalid: ${result.errors.join('; ')}`);
	// A non-fatal error is still a user-visible defect in the shipped manifest.
	expect(result.errors).toEqual([]);
	return result.manifest;
}

/** Contributions the host would hand the renderer for a fully granted install. */
function contributionsOf(manifest: PluginManifest, granted: readonly PluginCapability[]) {
	const collected = collectContributions(manifest);
	return gateContributions(collected, (capability) => granted.includes(capability));
}

/** Every capability the manifest asks for, which is what the user is shown at
 * consent and therefore what the plugin actually runs with once approved. */
function requestedCapabilities(manifest: PluginManifest): PluginCapability[] {
	return (manifest.permissions ?? []).map((p) => p.capability);
}

/** Chord tokens compared the way `usePluginKeybindings.parseChord` reads them:
 * case-insensitively, order-independently, with Ctrl/Cmd/Meta collapsed. */
function chordKey(tokens: readonly string[]): string {
	return [...tokens]
		.map((token) => {
			const lower = token.trim().toLowerCase();
			if (['ctrl', 'control', 'cmd', 'command', 'meta'].includes(lower)) return 'meta';
			if (lower === 'option') return 'alt';
			return lower;
		})
		.sort()
		.join('+');
}

describe('maestro-kanban: the board has three ways in', () => {
	it('validates as a manifest and declares all three entry points', () => {
		const manifest = loadManifest();
		const { commands, keybindings, uiItems, panels, errors } = contributionsOf(
			manifest,
			requestedCapabilities(manifest)
		);

		// No contribution was dropped with a reason: a dropped keybinding or
		// uiItem is a way in that silently does not exist.
		expect(errors).toEqual([]);
		expect(panels.map((p) => p.localId)).toContain('board');
		expect(commands.map((c) => c.localId)).toContain('open');
		expect(keybindings.map((k) => k.command)).toContain('open');
		expect(uiItems.map((i) => i.command)).toContain('open');
	});

	describe('way in 1: the keybinding', () => {
		it('parses, targets the open command, and is not a reserved combo', () => {
			const { keybindings } = contributionsOf(loadManifest(), []);
			const binding = keybindings.find((k) => k.command === 'open');
			expect(binding).toBeDefined();
			if (!binding) return;

			// The chord has a concrete key and at least one hard modifier, which is
			// what usePluginKeybindings requires to fire while the composer (the
			// app's resting focus) has focus.
			const tokens = binding.key.split('+').map((t) => t.trim().toLowerCase());
			expect(tokens).toContain('alt');
			expect(tokens.filter((t) => !['alt', 'shift', 'meta', 'ctrl', 'cmd'].includes(t))).toEqual([
				'k',
			]);

			// Keybindings are a tier >= 1 contribution and this plugin is tier 2.
			expect(loadManifest().tier).toBeGreaterThanOrEqual(1);

			expect(findReservedShortcutCombo(binding.key.split('+'))).toBeNull();
		});

		it('collides with no shortcut the app itself binds', () => {
			const { keybindings } = contributionsOf(loadManifest(), []);
			const binding = keybindings.find((k) => k.command === 'open');
			expect(binding).toBeDefined();
			if (!binding) return;
			const boardChord = chordKey(binding.key.split('+'));

			const appChords = [
				...Object.values(DEFAULT_SHORTCUTS),
				...Object.values(FIXED_SHORTCUTS),
				...Object.values(TAB_SHORTCUTS),
			]
				.filter((s): s is { id: string; label: string; keys: string[] } => Array.isArray(s.keys))
				.map((s) => ({ id: s.id, chord: chordKey(s.keys) }));

			// Guard the guard: a refactor that renamed the exports would otherwise
			// leave this scanning an empty list and passing for the wrong reason.
			expect(appChords.length).toBeGreaterThan(20);
			expect(appChords.filter((s) => s.chord === boardChord)).toEqual([]);
		});
	});

	describe('way in 2: the command palette', () => {
		it("surfaces the board's open command as a palette entry that invokes it", async () => {
			const manifest = loadManifest();
			const { commands, uiItems } = contributionsOf(manifest, requestedCapabilities(manifest));
			const invokeCommand = vi.fn().mockResolvedValue({ dispatched: true });

			const actions = buildPluginCommandPaletteCommands({
				commands,
				macros: [],
				uiItems,
				invokeCommand,
				setQuickActionOpen: vi.fn(),
			});

			const entry = actions.find((a) => a.id === 'maestro-kanban/open');
			expect(entry).toBeDefined();
			expect(entry?.label).toBe('Kanban: Open Board');
			// Non-suppressible provenance, same contract every plugin entry keeps.
			expect(entry?.subtext).toContain('from maestro-kanban');

			await entry?.action();
			expect(invokeCommand).toHaveBeenCalledWith('maestro-kanban/open');
		});
	});

	describe('way in 3: the Left Bar launcher', () => {
		it('mounts on a host surface that exists and runs the open command', () => {
			const manifest = loadManifest();
			const { uiItems } = contributionsOf(manifest, requestedCapabilities(manifest));
			const launcher = uiItems.find((i) => i.command === 'open');
			expect(launcher).toBeDefined();
			if (!launcher) return;

			// A surface no host region renders is a launcher nobody can click, so
			// assert both the allowlist AND that the surface is `sidebar`, the Left
			// Bar action row PluginUiItemsSlot mounts.
			expect(isPluginUiSurface(launcher.surface)).toBe(true);
			expect(UI_SURFACES).toContain(launcher.surface);
			expect(launcher.surface).toBe('sidebar');

			expect(launcher.label).toBe('Kanban Board');
			// PluginUiItemsSlot invokes `<pluginId>/<command>`, so the local command
			// id has to be one the plugin actually registers.
			expect(launcher.id).toBe('maestro-kanban/launch');
			expect(launcher.pluginId).toBe('maestro-kanban');
		});

		it('is gated on the ui:contribute capability the manifest asks for', () => {
			const manifest = loadManifest();
			expect(requestedCapabilities(manifest)).toContain('ui:contribute');

			// Without the grant the host drops the launcher rather than rendering an
			// ungranted item, which is why the capability has to be requested.
			const ungranted = gateContributions(
				collectContributions(manifest),
				(capability) => capability !== 'ui:contribute'
			);
			expect(ungranted.uiItems).toEqual([]);
		});
	});
});
