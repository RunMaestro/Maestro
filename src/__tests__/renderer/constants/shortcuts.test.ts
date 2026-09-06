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
	isPaneShortcutIds: Set<string>;
} {
	const isShortcutIds = new Set<string>();
	const isTabShortcutIds = new Set<string>();
	const isPaneShortcutIds = new Set<string>();
	// Match calls like `ctx.isShortcut(e, 'foo')` or `isShortcut(e, "bar")`.
	// Tolerates the receiver (`ctx.`) being absent. `isShortcutRe` does not also
	// match `isPaneShortcut(` - there is no word boundary inside the longer name.
	const isShortcutRe =
		/\bisShortcut\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*['"]([A-Za-z][A-Za-z0-9]*)['"]\s*\)/g;
	const isTabShortcutRe =
		/\bisTabShortcut\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*['"]([A-Za-z][A-Za-z0-9]*)['"]\s*\)/g;
	const isPaneShortcutRe =
		/\bisPaneShortcut\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*['"]([A-Za-z][A-Za-z0-9]*)['"]\s*\)/g;

	for (const file of walk(RENDERER_ROOT)) {
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(isShortcutRe)) isShortcutIds.add(m[1]);
		for (const m of src.matchAll(isTabShortcutRe)) isTabShortcutIds.add(m[1]);
		for (const m of src.matchAll(isPaneShortcutRe)) isPaneShortcutIds.add(m[1]);
	}

	return { isShortcutIds, isTabShortcutIds, isPaneShortcutIds };
}

describe('keyboard shortcut registry wiring', () => {
	const { isShortcutIds, isTabShortcutIds, isPaneShortcutIds } = collectShortcutRefs();

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

	it('every isPaneShortcut(e, <id>) call references a Ctrl+Cmd DEFAULT_SHORTCUTS entry', () => {
		// isPaneShortcut hard-requires BOTH physical modifiers and returns false for
		// anything else, so an id bound without a 'Control' token in its keys is
		// registered, dispatched, and permanently dead.
		const broken = [...isPaneShortcutIds].filter((id) => {
			const sc = (DEFAULT_SHORTCUTS as Record<string, Shortcut>)[id];
			if (!sc) return true;
			const keys = sc.keys.map((k) => k.toLowerCase());
			const hasCtrl = keys.includes('control') || keys.includes('ctrl');
			const hasMeta = keys.includes('meta') || keys.includes('command');
			return !hasCtrl || !hasMeta;
		});
		expect(
			broken,
			`These ids are matched with isPaneShortcut() but are missing from DEFAULT_SHORTCUTS or are not bound to a Ctrl+Cmd chord - isPaneShortcut can never match them.`
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
				'tileAiBelow',
				'tileBrowserBelow',
				'tileFileBelow',
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

	/**
	 * Two global shortcuts on the same combination is a SILENT failure: the
	 * keyboard handler is an if/else-if chain, so whichever branch is written
	 * first wins and the other simply never fires. Nothing warns, and the losing
	 * feature just looks broken.
	 *
	 * This nearly shipped when Concerto took Opt+Cmd+C while New Group Chat still
	 * held it. Scoped to DEFAULT_SHORTCUTS on purpose: FIXED_SHORTCUTS
	 * deliberately reuses Cmd+F across panels (each scoped to whichever panel has
	 * focus), so the same rule there would be wrong.
	 */
	it('binds no two global shortcuts to the same combination', () => {
		const MODIFIERS = ['meta', 'alt', 'shift', 'ctrl', 'command'];
		const canonical = (keys: string[]): string => {
			const lower = keys.map((k) => k.toLowerCase());
			const mods = lower.filter((k) => MODIFIERS.includes(k)).sort();
			const rest = lower.filter((k) => !MODIFIERS.includes(k));
			return [...mods, ...rest].join('+');
		};

		const byCombo = new Map<string, string[]>();
		for (const [id, shortcut] of Object.entries(DEFAULT_SHORTCUTS as Record<string, Shortcut>)) {
			// An empty binding is the "unbound by default" convention (the media
			// player, Show Snoozed Tabs), not a collision - every one of them would
			// otherwise collide with every other.
			if (shortcut.keys.length === 0) continue;
			const combo = canonical(shortcut.keys);
			if (!byCombo.has(combo)) byCombo.set(combo, []);
			byCombo.get(combo)!.push(id);
		}

		const collisions = [...byCombo.entries()]
			.filter(([, ids]) => ids.length > 1)
			.map(([combo, ids]) => `${combo} -> ${ids.join(', ')}`);

		expect(
			collisions,
			`Two shortcuts on one combination: the earlier branch in useMainKeyboardHandler wins and the other silently never fires. ${collisions.join('; ')}`
		).toEqual([]);
	});
});

/**
 * Duplicate-binding guard for the shipped defaults.
 *
 * Two actions in the SAME scope answering to one chord means one of them loses,
 * silently, with nothing in the UI to explain it - the user just reports that a
 * key they have used for months stopped working. `ShortcutsTab` now rejects
 * this when a user records a binding by hand, but that check cannot see the
 * defaults table, so a duplicate shipped as a default slips straight past it.
 *
 * Scope is real and this test has to respect it, or it fails on correct design:
 * several actions deliberately share a chord because they can never be live at
 * the same moment. Each such group is listed below WITH the reason it is safe.
 * Anything not on that list is a bug - which is the point. A future action that
 * takes an already-used chord fails here rather than in a bug report.
 */
describe('DEFAULT_SHORTCUTS / TAB_SHORTCUTS / FIXED_SHORTCUTS duplicate bindings', () => {
	/**
	 * Chords that more than one action may legitimately claim, each with the
	 * gate that keeps them apart. Add to this ONLY with the reason written down.
	 */
	const INTENTIONALLY_SHARED: { chord: string; ids: string[]; why: string }[] = [
		{
			chord: 'Meta+f',
			ids: [
				'filterFiles',
				'filterSessions',
				'filterHistory',
				'searchLogs',
				'searchOutput',
				'searchDirectorNotes',
			],
			why: "Each is scoped to the surface that has focus (Files tab, Left Panel, History tab, System Log viewer, Main Window, Director's Notes). Only one of those surfaces is focused at a time.",
		},
		{
			chord: 'Meta+e',
			ids: ['toggleMarkdownMode', 'renameAgentSession'],
			why: 'The Sessions Browser is a modal layer that blocks lower layers, and its own handler consumes the key before the app-level one runs. With the browser closed there is no session row to rename; with it open there is no markdown pane to flip.',
		},
		{
			chord: 'Meta+Shift+k',
			ids: ['clearTerminal', 'toggleShowThinking'],
			why: 'Mutually exclusive by input mode: clearTerminal is gated on inputMode === "terminal" (useMainKeyboardHandler), toggleShowThinking is a tab shortcut reached only in AI mode.',
		},
	];

	const normalize = (keys: string[]): string => [...keys].sort().join('+');

	it('ships no unexplained duplicate binding', () => {
		const all = [
			...Object.values(DEFAULT_SHORTCUTS),
			...Object.values(TAB_SHORTCUTS),
			...Object.values(FIXED_SHORTCUTS),
		];

		const byChord = new Map<string, string[]>();
		for (const sc of all) {
			// An unassigned action (keys: []) claims nothing and cannot collide.
			if (!sc.keys?.length) continue;
			const chord = normalize(sc.keys);
			byChord.set(chord, [...(byChord.get(chord) ?? []), sc.id]);
		}

		const unexplained: string[] = [];
		for (const [chord, ids] of byChord) {
			if (ids.length < 2) continue;
			const allowed = INTENTIONALLY_SHARED.find((g) => g.chord === chord);
			// The allowlist must match EXACTLY. Listing a chord does not license
			// every future action to join that group - a new arrival is a new
			// decision and has to be made deliberately.
			if (allowed && [...allowed.ids].sort().join(',') === [...ids].sort().join(',')) continue;
			unexplained.push(`${chord} is claimed by: ${ids.join(', ')}`);
		}

		expect(unexplained).toEqual([]);
	});

	it('keeps every allowlisted group honest - each id still exists', () => {
		const known = new Set([
			...Object.keys(DEFAULT_SHORTCUTS),
			...Object.keys(TAB_SHORTCUTS),
			...Object.keys(FIXED_SHORTCUTS),
		]);
		const missing = INTENTIONALLY_SHARED.flatMap((g) =>
			g.ids.filter((id) => !known.has(id)).map((id) => `${g.chord}: ${id}`)
		);
		// A stale allowlist entry is how an exemption outlives the reason for it.
		expect(missing).toEqual([]);
	});
});

/**
 * Unbound ids are only useful if the app can act on them once a user binds a
 * key. `showSnoozeList` shipped registered-but-unhandled: it appeared in the
 * overlay, counted toward the total, and binding a key to it did nothing. This
 * pins the invariant so the next unbound id cannot repeat that shape.
 */
describe('every registered action has a handler', () => {
	const UNBOUND_IDS = [
		'showSnoozeList',
		'openMediaPlayer',
		'mediaPlayPause',
		'mediaNext',
		'mediaPrev',
		'openLeaderboard',
		'clearAllNotifications',
		'openThemeSettings',
	];

	it('registers each unbound id with empty keys', () => {
		for (const id of UNBOUND_IDS) {
			expect(DEFAULT_SHORTCUTS[id], `${id} missing from DEFAULT_SHORTCUTS`).toBeDefined();
			expect(DEFAULT_SHORTCUTS[id].keys, `${id} should ship unbound`).toEqual([]);
		}
	});

	it('handles each unbound id somewhere in the keyboard handler', () => {
		const handler = readFileSync(
			join(RENDERER_ROOT, 'hooks/keyboard/useMainKeyboardHandler.ts'),
			'utf-8'
		);
		const unhandled = UNBOUND_IDS.filter((id) => !handler.includes(`'${id}'`));
		expect(unhandled, 'registered but never dispatched').toEqual([]);
	});
});

describe('App keyboard context wiring', () => {
	it('supplies every ctx method invoked by useMainKeyboardHandler', () => {
		const handler = readFileSync(
			join(RENDERER_ROOT, 'hooks/keyboard/useMainKeyboardHandler.ts'),
			'utf-8'
		);
		const app = readFileSync(join(RENDERER_ROOT, 'App.tsx'), 'utf-8');
		const start = app.indexOf('keyboardHandlerRef.current = {');
		const end = app.indexOf('\n\t};', start);

		expect(start, 'keyboardHandlerRef.current assignment missing').toBeGreaterThanOrEqual(0);
		expect(end, 'keyboardHandlerRef.current assignment is not closed').toBeGreaterThan(start);

		const context = app.slice(start, end);
		const invoked = new Set(
			[...handler.matchAll(/\bctx\.([A-Za-z_$][\w$]*)\s*\??\.?\s*\(/g)].map((match) => match[1])
		);
		const missing = [...invoked].filter((method) => !new RegExp(`\\b${method}\\b`).test(context));

		expect(missing, 'keyboard handler methods missing from the App context').toEqual([]);
	});
});
