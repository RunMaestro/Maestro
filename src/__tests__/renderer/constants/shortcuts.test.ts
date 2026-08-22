/**
 * Regression guard for keyboard shortcut wiring.
 *
 * `useKeyboardShortcutHelpers.isShortcut`/`isTabShortcut` only resolve action
 * ids against the user-configurable `shortcuts` (= DEFAULT_SHORTCUTS + saved
 * overrides) and `tabShortcuts` (= TAB_SHORTCUTS + saved overrides) maps.
 * Shortcuts that live only in FIXED_SHORTCUTS are NEVER merged into those
 * maps, so any handler calling `ctx.isShortcut(e, 'somethingOnlyInFixed')`
 * silently never fires.
 *
 * This has bitten us multiple times - most recently with `clearTerminal`
 * (Cmd+Shift+K), which was moved into FIXED_SHORTCUTS by mistake and
 * stopped working entirely.
 *
 * These tests scan the renderer source for every `ctx.isShortcut(...)` and
 * `ctx.isTabShortcut(...)` call site and assert each referenced id is present
 * in the right registry, so future moves between registries fail loudly.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../../renderer/constants/shortcuts';
import type { Shortcut } from '../../../shared/shortcut-types';

const RENDERER_ROOT = join(__dirname, '../../../renderer');

function walk(dir: string, files: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const s = statSync(full);
		if (s.isDirectory()) walk(full, files);
		else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full);
	}
	return files;
}

function collectShortcutRefs(): {
	isShortcutIds: Set<string>;
	isTabShortcutIds: Set<string>;
} {
	const isShortcutIds = new Set<string>();
	const isTabShortcutIds = new Set<string>();
	// Match calls like `ctx.isShortcut(e, 'foo')` or `isShortcut(e, "bar")`.
	// Tolerates the receiver (`ctx.`) being absent.
	const isShortcutRe =
		/\bisShortcut\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*['"]([A-Za-z][A-Za-z0-9]*)['"]\s*\)/g;
	const isTabShortcutRe =
		/\bisTabShortcut\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*['"]([A-Za-z][A-Za-z0-9]*)['"]\s*\)/g;

	for (const file of walk(RENDERER_ROOT)) {
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(isShortcutRe)) isShortcutIds.add(m[1]);
		for (const m of src.matchAll(isTabShortcutRe)) isTabShortcutIds.add(m[1]);
	}

	return { isShortcutIds, isTabShortcutIds };
}

describe('keyboard shortcut registry wiring', () => {
	const { isShortcutIds, isTabShortcutIds } = collectShortcutRefs();

	it('finds shortcut references to scan (sanity check)', () => {
		// If the regex breaks, the rest of these tests would pass vacuously.
		expect(isShortcutIds.size).toBeGreaterThan(10);
	});

	it('every isShortcut(e, <id>) call references DEFAULT_SHORTCUTS', () => {
		const missing = [...isShortcutIds].filter((id) => !(id in DEFAULT_SHORTCUTS));
		expect(
			missing,
			`These ids are passed to isShortcut() but are not in DEFAULT_SHORTCUTS - the matcher will never fire. Most likely cause: the entry was placed in FIXED_SHORTCUTS, which isn't merged into the user shortcuts map.`
		).toEqual([]);
	});

	it('every isTabShortcut(e, <id>) call references TAB_SHORTCUTS or DEFAULT_SHORTCUTS', () => {
		const missing = [...isTabShortcutIds].filter(
			(id) => !(id in TAB_SHORTCUTS) && !(id in DEFAULT_SHORTCUTS)
		);
		expect(
			missing,
			`These ids are passed to isTabShortcut() but are not in TAB_SHORTCUTS (or DEFAULT_SHORTCUTS as a documented fallback).`
		).toEqual([]);
	});

	it('clearTerminal must live in DEFAULT_SHORTCUTS, not FIXED_SHORTCUTS', () => {
		// Specific guard for the regression that triggered this test file:
		// clearTerminal was accidentally placed in FIXED_SHORTCUTS, breaking
		// Cmd+Shift+K. Keep this dedicated check so the failure is unambiguous
		// even if someone adjusts the broader scan above.
		expect(DEFAULT_SHORTCUTS.clearTerminal).toBeDefined();
		expect(FIXED_SHORTCUTS.clearTerminal).toBeUndefined();
	});

	it('DEFAULT_SHORTCUTS, TAB_SHORTCUTS, and FIXED_SHORTCUTS ids are mutually disjoint', () => {
		const overlap = (a: Record<string, unknown>, b: Record<string, unknown>) =>
			Object.keys(a).filter((k) => k in b);
		expect(overlap(DEFAULT_SHORTCUTS, FIXED_SHORTCUTS)).toEqual([]);
		expect(overlap(DEFAULT_SHORTCUTS, TAB_SHORTCUTS)).toEqual([]);
		expect(overlap(TAB_SHORTCUTS, FIXED_SHORTCUTS)).toEqual([]);
	});

	// Multi-window (Phase 6): agent cycling and the Command-K / agent switcher are
	// scoped to the owning window. Tab tiling adds the Ctrl+Cmd pane family, which
	// acts only on the panes in the active window's panel and is likewise flagged.
	// The shortcut-help modal renders a "Window" badge off the `windowScoped` flag,
	// so guard the exact set of flagged ids here.
	it('marks agent cycling, the agent switcher, and pane tiling as windowScoped', () => {
		const windowScopedIds = Object.values(DEFAULT_SHORTCUTS)
			.filter((sc) => sc.windowScoped)
			.map((sc) => sc.id)
			.sort();
		expect(windowScopedIds).toEqual(
			[
				'agentSwitcher',
				'cycleNext',
				'cyclePrev',
				'paneClose',
				'paneCycleNext',
				'paneCyclePrev',
				'paneFocusDown',
				'paneFocusLeft',
				'paneFocusRight',
				'paneFocusUp',
				'paneRebalance',
				'paneSplitColumn',
				'paneSplitRow',
				'paneZoom',
				'quickAction',
				'tileTerminalBelow',
			].sort()
		);
	});

	it('does not flag window-global shortcuts as windowScoped', () => {
		// Spot-check a few app-global shortcuts stay unflagged so the badge does
		// not leak onto shortcuts that act across the whole app.
		expect(DEFAULT_SHORTCUTS.newInstance.windowScoped).toBeUndefined();
		expect(DEFAULT_SHORTCUTS.settings.windowScoped).toBeUndefined();
		expect(DEFAULT_SHORTCUTS.help.windowScoped).toBeUndefined();
	});

	/**
	 * On macOS a bare Opt+letter is a TEXT-ENTRY combination: Opt+C types "ç",
	 * Opt+U starts a dead-key umlaut, Opt+E an acute accent. Whenever the
	 * composer has focus - Maestro's usual state - the keypress lands as a
	 * character and the shortcut never fires, so the binding reads as broken.
	 * Adding Cmd (Opt+Cmd+X) suppresses the character.
	 *
	 * Concerto shipped on Opt+C and had to be rebound for exactly this. The
	 * allowlist below is the set that predates the rule; it is deliberately NOT
	 * a blessing of the pattern, just an honest record of what is already out
	 * there. Do not extend it - pick an Opt+Cmd binding instead.
	 */
	const LEGACY_PLAIN_ALT_BINDINGS = new Set([
		'jumpToBottom', // Opt+J
		'openCue', // Opt+Q
		'filterUnreadAgents', // Opt+U
		'newFileTab', // Opt+N
	]);

	it('binds no NEW shortcut to a bare Opt+letter, which types a character on macOS', () => {
		const offenders: string[] = [];
		for (const registry of [DEFAULT_SHORTCUTS, TAB_SHORTCUTS, FIXED_SHORTCUTS]) {
			for (const [id, shortcut] of Object.entries(registry as Record<string, Shortcut>)) {
				const keys = shortcut.keys.map((k) => k.toLowerCase());
				const isPlainAlt =
					keys.includes('alt') &&
					!keys.includes('meta') &&
					!keys.includes('ctrl') &&
					!keys.includes('command');
				const mainKey = keys[keys.length - 1];
				if (isPlainAlt && /^[a-z]$/.test(mainKey) && !LEGACY_PLAIN_ALT_BINDINGS.has(id)) {
					offenders.push(`${id} (${shortcut.keys.join('+')})`);
				}
			}
		}

		expect(
			offenders,
			`Bare Opt+letter types a character on macOS and will not fire from the composer. Use Opt+Cmd instead: ${offenders.join(', ')}`
		).toEqual([]);
	});

	it('keeps the Concerto surfaces on a modifier pair that produces no text', () => {
		for (const id of ['toggleConcerto', 'toggleCadenzas'] as const) {
			const keys = DEFAULT_SHORTCUTS[id].keys.map((k) => k.toLowerCase());
			expect(keys, `${id} must hold Alt`).toContain('alt');
			expect(keys, `${id} must pair Alt with Meta so it cannot type a character`).toContain('meta');
		}
	});
});
