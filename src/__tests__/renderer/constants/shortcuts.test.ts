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
import { VIM_SHORTCUTS, VIM_TAB_SHORTCUTS } from '../../../renderer/constants/vimShortcuts';
import {
	KEYBOARD_MODES,
	KEYBOARD_MODE_LABELS,
	asKeyboardMode,
} from '../../../shared/shortcut-types';
import type { KeyboardMode, Shortcut, ShortcutOverride } from '../../../shared/shortcut-types';
import {
	findReservedShortcutCombo,
	shortcutKeysCollide,
	shortcutKeysEqual,
	shortcutSequencesEqual,
} from '../../../shared/shortcutKeys';
import { resolveEffectiveShortcuts } from '../../../shared/effectiveShortcuts';
import type { ShortcutBaseMaps, ShortcutOverrideMaps } from '../../../shared/effectiveShortcuts';

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

	it('keeps the Concerto and Throughput Gauge toggles on a modifier pair that produces no text', () => {
		for (const id of ['toggleConcerto', 'toggleCadenzas', 'toggleThroughputGauge'] as const) {
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
 * Chords that more than one action may legitimately claim, each with the gate
 * that keeps them apart. Add to this ONLY with the reason written down.
 *
 * Read by two blocks below. The shipped-defaults guard matches a group by its
 * `chord`, because that is the chord default mode gives the group. The per-mode
 * guard matches on `ids` alone: the gate that keeps a group apart is its scope,
 * not the chord it happens to sit on, so a mode that moves the group to another
 * chord keeps the exemption and a group that gains a member loses it.
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
 * the same moment. Each such group is listed in `INTENTIONALLY_SHARED` above
 * WITH the reason it is safe. Anything not on that list is a bug - which is the point. A future action that
 * takes an already-used chord fails here rather than in a bug report.
 */
describe('DEFAULT_SHORTCUTS / TAB_SHORTCUTS / FIXED_SHORTCUTS duplicate bindings', () => {
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
 * The shipped tables must not contain a chord `RESERVED_SHORTCUT_COMBOS` owns.
 *
 * `migrateShortcuts` strips a reserved binding on load and falls back to the
 * action's bundled default - but only when that default is itself free, and
 * otherwise leaves the action UNBOUND. So a reserved chord shipped as a default
 * does not just fail to fire: it silently unbinds the action for every user who
 * never customized it, on the quietest possible path. Adding an entry to
 * `RESERVED_SHORTCUT_COMBOS` without checking the tables first is exactly how
 * that happens, which is what this test is here to stop.
 */
describe('shipped bindings avoid reserved chords', () => {
	const TABLES: [string, Record<string, Shortcut>][] = [
		['DEFAULT_SHORTCUTS', DEFAULT_SHORTCUTS],
		['TAB_SHORTCUTS', TAB_SHORTCUTS],
		['FIXED_SHORTCUTS', FIXED_SHORTCUTS],
	];

	it.each(TABLES)('%s ships no binding the OS or the app menu owns', (_name, table) => {
		const offenders = Object.values(table)
			.map((sc) => ({ sc, reserved: findReservedShortcutCombo(sc.keys) }))
			.filter(({ reserved }) => reserved !== null)
			.map(({ sc, reserved }) => `${sc.id} (${sc.keys.join('+')}): ${reserved?.reason}`);

		expect(offenders).toEqual([]);
	});
});

describe('keyboard modes', () => {
	it('lists default first, which is the mode that ships', () => {
		// The Settings toggle renders this list in order, so flipping it would
		// put Vim in the first slot and read as the active mode at a glance.
		expect(KEYBOARD_MODES).toEqual(['default', 'vim']);
	});

	it('narrows only the two known modes', () => {
		for (const mode of KEYBOARD_MODES) expect(asKeyboardMode(mode)).toBe(mode);
		for (const value of ['Vim', 'VIM', 'emacs', '', ' vim', null, undefined, 0, {}, ['vim']]) {
			expect(asKeyboardMode(value)).toBeUndefined();
		}
	});

	it('names every mode for the surfaces that switch modes', () => {
		// The toggle, the Quick Actions entry, the menu item and the switch toast
		// all say the mode's name. A mode with no label here renders as its raw
		// id in whichever of them forgot to handle it.
		expect(KEYBOARD_MODE_LABELS).toEqual({ default: 'Default', vim: 'Vim' });
		for (const mode of KEYBOARD_MODES) {
			expect(KEYBOARD_MODE_LABELS[mode]).toBeTruthy();
		}
	});
});

/**
 * Structural guard for the Vim override tables.
 *
 * These are the invariants that hold on the SHIPPED constants alone, before any
 * resolver or persisted state is involved, so they fail at the table rather
 * than three layers downstream where the symptom is a dead key:
 *
 *  - An override id that is not a real action id binds nothing at all. The
 *    resolver ignores an override whose id is absent from the base tables, so a
 *    typo here is silent.
 *  - A mismatched label would show the user two different names for one action
 *    depending on the mode.
 *  - A `FIXED_SHORTCUTS` id is shared by both modes and is not rebindable, so an
 *    override on one describes a binding that can never take effect.
 *  - A chord holding both a Ctrl-family key and `Meta` is the pane-tiling
 *    spelling, matched by `isPaneShortcut` (which requires both physical keys
 *    held) rather than the shared matcher. Vim chords say `'Ctrl'` only, because
 *    the matcher collapses Ctrl and Cmd into one modifier anyway.
 *
 * The reachability and one-chord-one-action rules cannot be read off these
 * tables, because both depend on what a mode INHERITS. They live in the
 * per-mode block below, computed over each mode's resolved effective set.
 */
describe('Vim override tables', () => {
	const VIM_TABLES: [string, Record<string, ShortcutOverride>][] = [
		['VIM_SHORTCUTS', VIM_SHORTCUTS],
		['VIM_TAB_SHORTCUTS', VIM_TAB_SHORTCUTS],
	];

	// An override id may be declared in EITHER base table: `isTabShortcut` reads
	// `tabShortcuts[id] || shortcuts[id]`, so a tab action can live in
	// DEFAULT_SHORTCUTS (`prevTab` and `nextTab` do).
	const BASE_ACTIONS: Record<string, Shortcut> = {
		...(DEFAULT_SHORTCUTS as Record<string, Shortcut>),
		...(TAB_SHORTCUTS as Record<string, Shortcut>),
	};

	it.each(VIM_TABLES)('%s keys its entries by their own id', (_name, table) => {
		const mismatched = Object.entries(table)
			.filter(([key, override]) => key !== override.id)
			.map(([key, override]) => `${key} -> ${override.id}`);

		expect(mismatched).toEqual([]);
	});

	it.each(VIM_TABLES)('%s overrides only real actions, with the same label', (_name, table) => {
		const offenders = Object.values(table)
			.filter((override) => BASE_ACTIONS[override.id]?.label !== override.label)
			.map((override) =>
				BASE_ACTIONS[override.id]
					? `${override.id}: label "${override.label}" !== "${BASE_ACTIONS[override.id].label}"`
					: `${override.id}: not an action in DEFAULT_SHORTCUTS or TAB_SHORTCUTS`
			);

		expect(offenders).toEqual([]);
	});

	it.each(VIM_TABLES)('%s overrides no FIXED_SHORTCUTS id', (_name, table) => {
		const offenders = Object.keys(table).filter((id) => id in FIXED_SHORTCUTS);

		expect(offenders).toEqual([]);
	});

	it.each(VIM_TABLES)('%s ships no empty chord', (_name, table) => {
		const offenders = Object.values(table)
			.filter((override) => override.keys !== undefined && override.keys.length === 0)
			.map((override) => override.id);

		expect(offenders).toEqual([]);
	});

	it.each(VIM_TABLES)('%s never combines a Ctrl-family key with Meta', (_name, table) => {
		const offenders = Object.values(table)
			.filter((override) => {
				const lower = (override.keys ?? []).map((k) => k.toLowerCase());
				return lower.includes('meta') && (lower.includes('ctrl') || lower.includes('control'));
			})
			.map((override) => `${override.id} (${override.keys?.join('+')})`);

		expect(offenders).toEqual([]);
	});

	it.each(VIM_TABLES)('%s ships no chord the OS or the app menu owns', (_name, table) => {
		const offenders = Object.values(table)
			.map((override) => ({ override, reserved: findReservedShortcutCombo(override.keys) }))
			.filter(({ reserved }) => reserved !== null)
			.map(
				({ override, reserved }) =>
					`${override.id} (${override.keys?.join('+')}): ${reserved?.reason}`
			);

		expect(offenders).toEqual([]);
	});

	/**
	 * Escape never changes meaning, in either mode.
	 *
	 * The layer stack has first claim on it: `LayerStackProvider` listens in the
	 * CAPTURE phase and calls `stopPropagation()`, so the topmost open layer
	 * closes before the main keydown listener (BUBBLE phase) is reached at all.
	 * A Vim binding on Escape would therefore be one of two bugs, both silent -
	 * dead while anything is open, or stealing the keypress that closes it. The
	 * in-field escape is `jk` precisely so that it never touches this.
	 *
	 * Checked on both triggers, because `SequenceMatcher.feed` short-circuits on
	 * Escape before it ever looks at a step: a sequence step spelling Escape
	 * would be unmatchable rather than merely wrong.
	 */
	it.each(VIM_TABLES)('%s binds Escape in no chord and no sequence step', (_name, table) => {
		const namesEscape = (keys: readonly string[] | undefined) =>
			(keys ?? []).some((key) => key.toLowerCase() === 'escape' || key.toLowerCase() === 'esc');
		const offenders = Object.values(table)
			.filter(
				(override) =>
					namesEscape(override.keys) || (override.sequence ?? []).some((step) => namesEscape(step))
			)
			.map((override) => override.id);

		expect(offenders).toEqual([]);
	});

	/**
	 * The resolver-free half of rule 3, "a displaced action always gets an
	 * explicit Vim chord".
	 *
	 * A Vim chord taking a chord some default action holds is ALLOWED and is the
	 * point of the override bucket (one mode is live at a time). What is not
	 * allowed is taking it and leaving the other action to inherit nothing: the
	 * override wins, so that action is unbound in Vim mode unless this file gives
	 * it a chord of its own. The region family does exactly that to the five
	 * Cmd+Shift+H/J/K/L actions, and each one appears in a Vim table with its own
	 * Ctrl+Alt+Shift chord.
	 *
	 * `FIXED_SHORTCUTS` is the exception with no escape hatch: it is shared by
	 * both modes and no override bucket may name it (the test above pins that),
	 * so a Vim chord landing on one of its chords can never be resolved and is
	 * always a bug.
	 *
	 * This is the table-level check. The resolved-set version, which also covers
	 * a collision between two Vim chords, is `displaced` being empty in the
	 * per-mode block below.
	 */
	it('gives every action a shipped Vim chord displaces a Vim chord of its own', () => {
		const vimChords = VIM_TABLES.flatMap(([, table]) =>
			Object.values(table).map((override) => ({ id: override.id, keys: override.keys ?? [] }))
		);
		// An id with a chord in EITHER bucket is resolved; `collectOverrideField`
		// reads both, preferring the one mirroring the base map that declares it.
		const rebound = new Set(vimChords.filter((vim) => vim.keys.length > 0).map((vim) => vim.id));
		const defaults: [string, Record<string, Shortcut>][] = [
			['DEFAULT_SHORTCUTS', DEFAULT_SHORTCUTS],
			['TAB_SHORTCUTS', TAB_SHORTCUTS],
			['FIXED_SHORTCUTS', FIXED_SHORTCUTS],
		];

		const unresolved: string[] = [];
		for (const vim of vimChords) {
			for (const [tableName, table] of defaults) {
				for (const sc of Object.values(table)) {
					// An action keeping its own chord in Vim mode displaces nothing.
					if (sc.id === vim.id) continue;
					if (!shortcutKeysCollide(sc.keys, vim.keys)) continue;
					// Resolved: the displaced action is rebound in a Vim table. A
					// FIXED_SHORTCUTS id never can be, so it is reported either way.
					if (tableName !== 'FIXED_SHORTCUTS' && rebound.has(sc.id)) continue;
					unresolved.push(`${vim.id} (${vim.keys.join('+')}) vs ${tableName}.${sc.id}`);
				}
			}
		}

		expect(
			unresolved,
			'These Vim chords take a chord another action holds in default mode and leave it unbound in Vim mode. Give the displaced action its own Vim chord and record it in the displacement table in vimShortcuts.ts.'
		).toEqual([]);
	});
});

/**
 * Per-mode structural guard, computed over the EFFECTIVE binding set of each
 * mode rather than over the tables.
 *
 * The rules here are the ones a table alone cannot answer, because each one
 * depends on what a mode INHERITS. A mode's effective set is its override bucket
 * plus the default chord for every action the bucket does not mention, so an
 * override can take a chord some OTHER action inherits, and that action then
 * holds nothing in this mode. Reading `VIM_SHORTCUTS` on its own shows a
 * perfectly good chord and says nothing about the action it just unbound.
 *
 * `FIXED_SHORTCUTS` is part of every mode's set: it is not rebindable and no
 * override bucket may name it, so both modes are matched against it as it
 * ships and a mode chord that lands on one of its chords is a real collision.
 *
 * Every test but one runs over `KEYBOARD_MODES`, so a third mode is covered the
 * day it is added, and later phases filling the Vim tables keep them honest: a
 * new override that displaces an action fails here instead of reading as a dead
 * key in the mode it was added for.
 */
describe('effective binding set, per keyboard mode', () => {
	const BASE: ShortcutBaseMaps = {
		shortcuts: DEFAULT_SHORTCUTS as Record<string, Shortcut>,
		tabShortcuts: TAB_SHORTCUTS as Record<string, Shortcut>,
	};

	/**
	 * Each mode's override bucket, so adding a mode is one row here.
	 *
	 * Default mode's is empty on purpose, and that is not a stand-in for the real
	 * thing: default mode IS the base tables, which is why
	 * `selectActiveShortcuts` hands back the bucket itself without resolving.
	 * `resolveEffectiveShortcuts` returns those same maps by identity when the
	 * overrides are empty, so running both modes through one builder measures
	 * exactly what the live mode is matched against.
	 */
	const OVERRIDES: Record<KeyboardMode, ShortcutOverrideMaps> = {
		default: { vimShortcuts: {}, vimTabShortcuts: {} },
		vim: { vimShortcuts: VIM_SHORTCUTS, vimTabShortcuts: VIM_TAB_SHORTCUTS },
	};

	/** Every action a mode can fire, with the chord it fires on in that mode. */
	function effectiveActions(mode: KeyboardMode): Shortcut[] {
		const resolved = resolveEffectiveShortcuts(BASE, OVERRIDES[mode]);
		return [
			...Object.values(resolved.shortcuts),
			...Object.values(resolved.tabShortcuts),
			...Object.values(FIXED_SHORTCUTS),
		];
	}

	/**
	 * Actions that ship with no chord at all, derived from the constants rather
	 * than listed by hand so a new unassigned action needs no edit here.
	 *
	 * `keys: []` is the registered-but-unassigned convention: the action is in
	 * Settings > Shortcuts and the command palette, waiting for a chord the user
	 * picks (`openLeaderboard`, the four media player controls, the git actions).
	 * These are the ONLY actions a mode may leave unbound.
	 */
	const SHIPS_UNASSIGNED = [
		...Object.values(BASE.shortcuts),
		...Object.values(BASE.tabShortcuts),
		...Object.values(FIXED_SHORTCUTS),
	]
		.filter((sc) => sc.keys.length === 0)
		.map((sc) => sc.id);

	/** The ids a mode is allowed to leave unbound: ships unassigned, and this mode does not bind it. */
	function expectedUnbound(mode: KeyboardMode): string[] {
		const { vimShortcuts, vimTabShortcuts } = OVERRIDES[mode];
		return SHIPS_UNASSIGNED.filter(
			(id) => !vimShortcuts[id]?.keys?.length && !vimTabShortcuts[id]?.keys?.length
		).sort();
	}

	it.each(KEYBOARD_MODES)('%s mode carries every action the tables declare', (mode) => {
		// Sanity check: a resolver that dropped a map would make the tests below
		// pass vacuously, and inheritance means the list is exact - a mode adds and
		// removes no action, it only ever changes chords.
		expect(
			effectiveActions(mode)
				.map((sc) => sc.id)
				.sort()
		).toEqual(
			[
				...Object.keys(BASE.shortcuts),
				...Object.keys(BASE.tabShortcuts),
				...Object.keys(FIXED_SHORTCUTS),
			].sort()
		);
	});

	it('gives the shipped Vim overrides the chord they ask for', () => {
		// `prevTab` / `nextTab` are declared in DEFAULT_SHORTCUTS but overridden in
		// VIM_TAB_SHORTCUTS, the crossing the resolver has to handle. If it only
		// matched the tab bucket against TAB_SHORTCUTS these two would resolve to
		// their default chords and Vim's tab walk would silently not exist.
		const byId = new Map(effectiveActions('vim').map((sc) => [sc.id, sc.keys]));
		const wrong = [...Object.values(VIM_SHORTCUTS), ...Object.values(VIM_TAB_SHORTCUTS)]
			// An override that omits `keys` is the explicit spelling of "inherit the
			// default-mode chord" (`goToTab1` and `goToLastTab` add a `g g` / `G`
			// sequence and keep Cmd+1 / Cmd+0), so there is no chord to check. Only
			// an override that ASKS for a chord has to get it.
			.filter((override) => override.keys !== undefined)
			.filter((override) => !shortcutKeysEqual(byId.get(override.id) ?? [], override.keys ?? []))
			.map(
				(override) =>
					`${override.id}: ${byId.get(override.id)?.join('+')} !== ${override.keys?.join('+')}`
			);

		expect(wrong).toEqual([]);
	});

	it('gives the shipped Vim overrides the sequence they ask for, and leaves the chord alone', () => {
		// The two triggers resolve INDEPENDENTLY, and this is the half with no
		// shipped data behind it until now: an override spelling only a `sequence`
		// must gain that sequence AND keep the chord it inherits. Resolving them
		// together would make `g g` silently unbind Cmd+1.
		const resolved = resolveEffectiveShortcuts(BASE, OVERRIDES.vim);
		const byId = new Map(
			[...Object.values(resolved.shortcuts), ...Object.values(resolved.tabShortcuts)].map((sc) => [
				sc.id,
				sc,
			])
		);

		const wrong: string[] = [];
		for (const override of [...Object.values(VIM_SHORTCUTS), ...Object.values(VIM_TAB_SHORTCUTS)]) {
			if (override.sequence === undefined) continue;
			const effective = byId.get(override.id);
			if (!shortcutSequencesEqual(effective?.sequence, override.sequence)) {
				wrong.push(`${override.id}: sequence not applied`);
			}
			// Sequence-only overrides keep the inherited chord rather than losing it.
			if (override.keys === undefined && !effective?.keys.length) {
				wrong.push(`${override.id}: a sequence override took away the inherited chord`);
			}
		}

		expect(wrong).toEqual([]);
	});

	it.each(KEYBOARD_MODES)('%s mode leaves no action unreachable', (mode) => {
		// The failure this catches: an override takes a chord another action
		// inherits, the resolver reports that action in `displaced` and unbinds it,
		// and nothing in the UI explains why a key that worked yesterday is dead.
		// The fix is always to give the displaced action its own chord in the
		// mode's table, never to drop the override.
		const unbound = effectiveActions(mode)
			.filter((sc) => sc.keys.length === 0)
			.map((sc) => sc.id)
			.sort();
		const displaced = resolveEffectiveShortcuts(BASE, OVERRIDES[mode]).displaced;

		expect(displaced, `${mode} mode overrides take a chord these actions inherit`).toEqual([]);
		// Equality, not a subset: an action that GAINS a chord in this mode drops
		// out of the expectation too, so the list stays exact as later phases bind
		// the actions that ship unassigned.
		expect(unbound, `unbound in ${mode} mode but not shipped unassigned`).toEqual(
			expectedUnbound(mode)
		);
	});

	it.each(KEYBOARD_MODES)('%s mode gives one chord to one action', (mode) => {
		// Compared with `shortcutKeysCollide`, not key equality: Ctrl and Cmd are
		// ONE modifier to `eventMatchesShortcutKeys`, so a Vim chord spelled
		// `['Ctrl', 'o']` fights a default spelled `['Meta', 'o']` at runtime while
		// reading as a different chord on the page.
		const groups: { keys: string[]; ids: string[] }[] = [];
		for (const sc of effectiveActions(mode)) {
			// An unassigned action claims no keypress and cannot collide.
			if (sc.keys.length === 0) continue;
			const group = groups.find((g) => shortcutKeysCollide(g.keys, sc.keys));
			if (group) group.ids.push(sc.id);
			else groups.push({ keys: sc.keys, ids: [sc.id] });
		}

		const unexplained = groups
			.filter((g) => g.ids.length > 1)
			.filter((g) => {
				// The allowlist must match EXACTLY, in every mode: a group gaining a
				// member is a new decision about scope and has to be made on purpose.
				const ids = [...g.ids].sort().join(',');
				return !INTENTIONALLY_SHARED.some((shared) => [...shared.ids].sort().join(',') === ids);
			})
			.map((g) => `${g.keys.join('+')} is claimed by: ${g.ids.join(', ')}`);

		expect(
			unexplained,
			`Two actions on one keypress in ${mode} mode: the earlier branch in useMainKeyboardHandler wins and the other silently never fires.`
		).toEqual([]);
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
		'toggleInAppToasts',
		'openThemeSettings',
		// Phase 03's region/zen family. Registered unassigned so Settings ->
		// Shortcuts and Cmd+K can reach them and Vim mode can bind them; these rows
		// are what pin that binding a key to one actually does something.
		'focusRegionLeft',
		'focusRegionRight',
		'focusRegionUp',
		'focusRegionDown',
		'growRegion',
		'shrinkRegion',
		'toggleZenMode',
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

/**
 * Phase 03's nine actions - four region focus, two region resize, zen, and the
 * two tab nudges - all ship REGISTERED BUT UNASSIGNED. That is the whole
 * reason the phase could promise default mode behaves exactly as it did
 * before: an action with no chord claims no keypress, so the only routes to it
 * are Settings > Shortcuts, Quick Actions, and (from Phase 04) Vim mode.
 *
 * The per-mode reachability check above DERIVES its exemption list from
 * `keys.length === 0` on these same tables, which is what keeps that list
 * maintenance-free. The flip side is that its default-mode leg cannot notice
 * one of these actions quietly GAINING a chord: the id leaves both sides of
 * the equality at once and the assertion still passes. Naming the family here
 * is what turns the promise into something a later change has to argue with.
 *
 * `moveTabLeft` / `moveTabRight` live in `TAB_SHORTCUTS`, so the `UNBOUND_IDS`
 * block above - which reads `DEFAULT_SHORTCUTS` - cannot hold them. These rows
 * are their only `keys: []` pin.
 */
describe("Phase 03's region, resize, zen, and tab-nudge actions ship unassigned", () => {
	const REGION_AND_ZEN_IDS = [
		'focusRegionLeft',
		'focusRegionRight',
		'focusRegionUp',
		'focusRegionDown',
		'growRegion',
		'shrinkRegion',
		'toggleZenMode',
	];
	const TAB_NUDGE_IDS = ['moveTabLeft', 'moveTabRight'];

	it('registers all nine with no chord, in the table each one belongs to', () => {
		const problems: string[] = [];
		const check = (id: string, table: Record<string, Shortcut>, tableName: string) => {
			const shortcut = table[id];
			if (!shortcut) problems.push(`${id} is missing from ${tableName}`);
			else if (shortcut.keys.length)
				problems.push(`${id} ships bound to ${shortcut.keys.join('+')}`);
		};

		for (const id of REGION_AND_ZEN_IDS) {
			check(id, DEFAULT_SHORTCUTS as Record<string, Shortcut>, 'DEFAULT_SHORTCUTS');
		}
		for (const id of TAB_NUDGE_IDS) {
			check(id, TAB_SHORTCUTS as Record<string, Shortcut>, 'TAB_SHORTCUTS');
		}

		expect(
			problems,
			'A default chord for one of these changes what a default-mode keypress does, which Phase 03 promised not to do - and it is also what makes the action exempt from the per-mode reachability check above. Bind it in the Vim tables instead, or change this list on purpose.'
		).toEqual([]);
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

/**
 * A shortcut's LABEL is its only search index: Settings -> Shortcuts, the help
 * sheet, and the command palette each filter on `label` alone. So a word
 * missing from a label is a word that cannot find the action - "Change Branch"
 * was invisible to anyone who typed `git`.
 *
 * These guards keep the families searchable by their obvious keyword. They are
 * deliberately keyed off the action ID, not the label, so renaming a label back
 * to something unsearchable fails here rather than silently shipping.
 */
describe('shortcut labels carry their family keyword', () => {
	const ALL_SHORTCUTS = { ...DEFAULT_SHORTCUTS, ...TAB_SHORTCUTS, ...FIXED_SHORTCUTS };

	/** Every action whose label must contain a given word to be findable. */
	const FAMILY_KEYWORDS: { keyword: string; ids: string[] }[] = [
		{
			keyword: 'git',
			ids: ['viewGitDiff', 'viewGitLog', 'gitPull', 'gitPush', 'gitChangeBranch', 'gitCreatePR'],
		},
		{
			keyword: 'agent',
			// `killInstance` read only "Remove" and `moveToGroup` said "Session",
			// so neither surfaced when someone searched the noun they act on.
			ids: ['killInstance', 'moveToGroup', 'newInstance', 'agentSwitcher', 'filterSessions'],
		},
		{
			keyword: 'tab',
			// These two read "New Browser" / "New File" and were missed by `tab`,
			// even though the app menu had already spelled them out in full.
			ids: ['newTab', 'newBrowserTab', 'newFileTab', 'toggleMode'],
		},
		{ keyword: 'media', ids: ['openMediaPlayer', 'mediaPlayPause', 'mediaNext', 'mediaPrev'] },
		{ keyword: 'unread', ids: ['filterUnreadAgents', 'nextUnreadTab', 'previousUnreadTab'] },
		{ keyword: 'font', ids: ['fontSizeReset', 'fontSizeIncrease', 'fontSizeDecrease'] },
	];

	it.each(FAMILY_KEYWORDS)('searching "$keyword" finds the whole family', ({ keyword, ids }) => {
		const missing = ids.filter((id) => {
			const label = ALL_SHORTCUTS[id]?.label;
			return !label || !label.toLowerCase().includes(keyword);
		});
		expect(missing, `labels that would not match "${keyword}"`).toEqual([]);
	});

	it('gives every git action the same prefix so the list groups them', () => {
		// The help sheet and the palette both SORT by label, so a shared prefix is
		// what draws the family as one block instead of scattering it.
		const gitIds = [
			'viewGitDiff',
			'viewGitLog',
			'gitPull',
			'gitPush',
			'gitChangeBranch',
			'gitCreatePR',
		];
		const unprefixed = gitIds.filter((id) => !DEFAULT_SHORTCUTS[id]?.label.startsWith('Git: '));
		expect(unprefixed, 'git actions missing the "Git: " prefix').toEqual([]);
	});

	it('gives the command palette the same git names the shortcut list uses', () => {
		// Two names for one action is two things to learn and one of them fails to
		// match whichever word the user picked.
		const palette = readFileSync(
			join(RENDERER_ROOT, 'components/QuickActionsModal/commands/gitWorktreeCommands.ts'),
			'utf-8'
		);
		const labels = [...palette.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
		const gitLabels = labels.filter((l) => /branch|pull|push|worktree|repositor|diff|log/i.test(l));
		expect(gitLabels.filter((l) => !l.startsWith('Git: '))).toEqual([]);
		// Create Pull Request builds its label from a ternary, so the scan above
		// cannot see it. Assert the branchless arm directly rather than leaving the
		// one entry that started this whole change unguarded.
		expect(palette).toContain("'Git: Create Pull Request'");
		expect(palette).toContain('`Git: Create Pull Request (${gitActions.branch})`');
	});
});
