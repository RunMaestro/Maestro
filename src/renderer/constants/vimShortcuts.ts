// Import the override type from the shared module rather than `../types`, for
// the same reason `shortcuts.ts` does: the CLI reads these tables (Phase 07
// resolves the effective set in `maestro-cli open` so it prints the hotkey the
// user actually has), and `../types` drags renderer-only, DOM-dependent modules
// into that build.
import type { ShortcutOverride } from '../../shared/shortcut-types';

/**
 * VIM MODE OVERRIDES.
 *
 * These tables are SPARSE. An action appears here only when Vim mode binds it
 * to a different chord than default mode; everything else inherits its default
 * chord. The rules this file lives under, each of which a test in
 * `src/__tests__/renderer/constants/shortcuts.test.ts` enforces:
 *
 * 1. **One mode is live at a time.** Default mode and Vim mode are never both
 *    being matched, so a Vim chord MAY reuse a chord that default mode gives to
 *    a different action. That is the whole reason the override bucket exists
 *    separately instead of rewriting `DEFAULT_SHORTCUTS`.
 * 2. **Collisions are checked WITHIN a mode.** Inside one mode no chord may
 *    fire two actions (bar the context-scoped pairs default mode already ships
 *    on purpose). Across modes a shared chord is expected and fine.
 * 3. **A displaced action always gets an explicit Vim chord.** When a Vim
 *    override takes a chord another action holds in default mode, that action
 *    cannot inherit its default chord here (the override wins), so it must
 *    appear in this file with a chord of its own. Switching modes never leaves
 *    an action silently unreachable.
 * 4. **Ctrl and Cmd are ONE modifier.** `eventMatchesShortcutKeys` collapses
 *    `metaKey || ctrlKey` into a single flag, so `['Ctrl', 'x']` and
 *    `['Meta', 'x']` are the same binding at runtime and both physical keys fire
 *    it. Vim chords are spelled with `'Ctrl'` so macOS renders the Vim-native
 *    `⌃` glyph instead of `⌘`, and they never combine `Ctrl` with `Meta` in one
 *    chord: that spelling means the pane-tiling family, which `isPaneShortcut`
 *    matches separately by requiring both physical keys held.
 * 5. **Reserved chords are unusable in both modes.** `findReservedShortcutCombo`
 *    covers the text-field selection chords and the chords the macOS app menu
 *    swallows before the renderer sees them, so Cmd+H, Opt+Cmd+H, Cmd+Q, Cmd+M,
 *    and the Edit menu's cut / copy / paste / select-all are off the table here
 *    too. That is why Vim region focus is `Ctrl+Shift+H/J/K/L` rather than the
 *    more Vim-native `Ctrl+H/J/K/L`: Ctrl+H is Cmd+H to the matcher, which the
 *    app menu owns, so the binding would read as a dead key on a Mac.
 *
 * Every id here must already exist in `DEFAULT_SHORTCUTS` or `TAB_SHORTCUTS`
 * with the IDENTICAL label, and no id may be a `FIXED_SHORTCUTS` id: a fixed
 * shortcut is shared by both modes and is not rebindable, so overriding one
 * would describe a binding that cannot take effect. The shipped tables never
 * use `keys: []`; omit the entry instead and let the action inherit.
 */

/**
 * Overrides for the actions in `DEFAULT_SHORTCUTS`.
 *
 * Empty in this phase. Phase 03 registers the region-focus and other new
 * actions, and Phase 04 fills this table in.
 */
export const VIM_SHORTCUTS: Record<string, ShortcutOverride> = {};

/**
 * Overrides for tab actions, the ones matched through `isTabShortcut`.
 *
 * `prevTab` / `nextTab` are the only override whose action already existed when
 * this file was added. They sit in THIS table rather than `VIM_SHORTCUTS`
 * because `isTabShortcut` is what matches them, even though the two ids are
 * declared in `DEFAULT_SHORTCUTS` rather than `TAB_SHORTCUTS` (`isTabShortcut`
 * reads `tabShortcuts[id] || shortcuts[id]`, so a tab action can be declared in
 * either map). `resolveEffectiveShortcuts` therefore has to look an override id
 * up in BOTH base maps and apply it to whichever one declares the action. If it
 * only ever matched this table against `TAB_SHORTCUTS` it would drop these two
 * on the floor, and if it wrote them into the resolved tab map while leaving the
 * general map's inherited chord in place, Settings > Shortcuts would list
 * Previous Tab twice with two different chords (it renders `shortcuts` and
 * `tabShortcuts` as separate sections).
 *
 * `Ctrl+PageUp` / `Ctrl+PageDown` are Vim's own `<C-PageUp>` / `<C-PageDown>`.
 * No shipped table binds `PageUp` or `PageDown` in any chord, so these displace
 * nothing.
 */
export const VIM_TAB_SHORTCUTS: Record<string, ShortcutOverride> = {
	prevTab: { id: 'prevTab', label: 'Previous Tab', keys: ['Ctrl', 'PageUp'] },
	nextTab: { id: 'nextTab', label: 'Next Tab', keys: ['Ctrl', 'PageDown'] },
};
