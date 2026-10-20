import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { Compartment, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { vim, getCM } from '@replit/codemirror-vim';
import { useSettingsStore } from '../../../stores/settingsStore';

/**
 * "Vim keys in a CodeMirror surface", in one place.
 *
 * `MarkdownEditor` is the only caller today, but the gate is three separate
 * pieces of knowledge that a second CodeMirror surface would otherwise have to
 * rediscover, and each one was a bug before it was written down:
 *
 *   1. WHICH setting decides. Vim editing follows the app-wide `keyboardMode`,
 *      not a per-surface prop. A surface that reads a prop instead ends up with
 *      Vim keys in the file preview and not in the memory viewer, for no reason
 *      a user could explain.
 *   2. WHERE the extension sits. `vim()` claims keys through a plain
 *      `eventHandlers.keydown` at DEFAULT precedence, while `keymap.of([...])`
 *      runs its bindings through `Prec.default(...)`. Two extensions at the same
 *      precedence are offered the key in ARRAY ORDER, so the Vim compartment has
 *      to come BEFORE the compartment holding `defaultKeymap` or the default
 *      keymap answers first and Vim is a no-op on every key they share. This is
 *      what the package README means by "make sure vim is included before other
 *      keymaps". A host handler at `Prec.highest` still outranks both, which is
 *      how Cmd+S / Cmd+E and the template autocomplete keep winning.
 *   3. HOW the switch is applied. Reconfiguring a compartment keeps the SAME
 *      `EditorState`, so the document, the caret, the scroll offset, and the
 *      undo history all survive the user flipping the setting. Recreating the
 *      view instead throws away all four.
 *   4. WHO WINS a key Maestro also binds. Vim claims Escape and twenty-odd Ctrl
 *      chords, several of which close a tab or move focus in Maestro. The
 *      decisions, and the two predicates the rest of the app asks them through,
 *      are the second half of this file: `vimEditorOwnsEscape` and
 *      `vimEditorOwnsCtrlChord`, over `VIM_EDITOR_CTRL_BINDINGS`.
 *
 * Keep this file as the one home for those rules: a second copy drifts the
 * first time one of them changes.
 */

/**
 * The Vim subtree for a CodeMirror compartment, gated on `active`.
 *
 * Pure, so a caller outside React (or a test asking what the gate produces)
 * does not have to stand up a store. The empty array is a real extension to
 * CM6 - it is how a compartment holds "nothing" without being removed.
 */
export function vimKeysExtension(active: boolean): Extension {
	return active ? vim() : [];
}

/** Whether editor-level Vim keys are live right now, per the app-wide setting. */
export function useVimKeysActive(): boolean {
	return useSettingsStore((s) => s.keyboardMode === 'vim');
}

export interface VimKeysCompartment {
	/**
	 * Put `compartment.of(extension)` FIRST in the editor's extension array,
	 * ahead of whatever holds `keymap.of([...defaultKeymap])`. See rule 2 above.
	 */
	compartment: Compartment;
	/** The Vim subtree as it should be right now. Stable while the mode is. */
	extension: Extension;
}

/**
 * Own the Vim compartment for a CodeMirror view: build it, seed it with the
 * mode at mount, and reconfigure it in place whenever the mode changes.
 *
 * The caller keeps its own `EditorView` ref and mounts the view itself; this
 * hook only needs to reach the view to dispatch the reconfigure.
 */
export function useVimKeysCompartment(viewRef: RefObject<EditorView | null>): VimKeysCompartment {
	const active = useVimKeysActive();
	const compartment = useMemo(() => new Compartment(), []);
	const extension = useMemo(() => vimKeysExtension(active), [active]);

	// Which way the compartment was last configured. Seeded with the value the
	// caller's mount effect uses, so the effect below skips its no-op first run
	// instead of tearing down and rebuilding the plugin the mount just installed.
	const appliedRef = useRef(active);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		if (appliedRef.current === active) return;
		appliedRef.current = active;
		view.dispatch({ effects: compartment.reconfigure(extension) });
	}, [active, extension, compartment, viewRef]);

	return { compartment, extension };
}

/** Which Vim mode an editor is in. Replace mode reads as `insert`. */
export type VimEditorMode = 'normal' | 'insert' | 'visual';

/** A CodeMirror view with Vim keys live on it, and the state of that Vim. */
export interface ActiveVimEditor {
	view: EditorView;
	mode: VimEditorMode;
	/**
	 * A Vim command line (`:` or `/`) is open. It is an `<input>` in the
	 * editor's panel with its own bubble-phase Escape handler, so it has the
	 * same claim on Escape that insert mode does.
	 */
	dialogOpen: boolean;
}

/**
 * The only part of a keyboard event these predicates read beyond the key
 * itself. Shaped as a bag rather than `KeyboardEvent` so a React synthetic
 * event, a native one, and a test's `{ target }` all satisfy it.
 */
export interface KeyEventOrigin {
	readonly target?: EventTarget | null;
}

/**
 * The Vim editor containing `node`, or null when there is not one.
 *
 * Resolved through the DOM rather than from a React ref because the callers
 * that need the answer have no view to hand: the layer stack is a window-level
 * keydown listener, and `buildEditorExtensions` composes its handler before any
 * view exists. `.cm-editor` is the editor's own wrapper, `findFromDOM` turns it
 * back into the view, and `getCM` returns null unless the Vim plugin installed
 * itself on it - so "is Vim live here" needs no second source of truth.
 */
export function vimEditorAt(node: EventTarget | null): ActiveVimEditor | null {
	if (!(node instanceof Element)) return null;
	const host = node.closest('.cm-editor');
	if (!(host instanceof HTMLElement)) return null;
	const view = EditorView.findFromDOM(host);
	if (!view) return null;
	const cm = getCM(view);
	const vimState = cm?.state.vim;
	if (!cm || !vimState) return null;
	return {
		view,
		mode: vimState.insertMode ? 'insert' : vimState.visualMode ? 'visual' : 'normal',
		dialogOpen: !!cm.state.dialog,
	};
}

/**
 * The live Vim editor behind a keyboard event: the event's own target first,
 * then whatever holds focus.
 *
 * Both, and in that order, because they disagree in both directions. A handler
 * bound to `window` sees the focused element as the target, but the Vim command
 * line moves focus into its `<input>` while the keydown that opened it was
 * still dispatched from the content element. Either one naming an editor is
 * enough: unlike `isNormalMode`, which has to be conservative about Maestro
 * CLAIMING a key, this asks whether Maestro should DECLINE one.
 */
function activeVimEditor(
	event?: KeyEventOrigin | null,
	doc: Document = document
): ActiveVimEditor | null {
	return vimEditorAt(event?.target ?? null) ?? vimEditorAt(doc.activeElement);
}

/**
 * Whether Escape belongs to a Vim editor rather than to Maestro's layer stack.
 *
 * Escape means two incompatible things in Vim mode: "leave insert mode" to
 * CodeMirror, and "close the topmost layer" to Maestro. The layer stack hears
 * it first and unconditionally - `LayerStackProvider` listens on `window` in
 * the CAPTURE phase, so it runs before anything inside the editor, including
 * Vim's own `eventHandlers.keydown` and the host hook at `Prec.highest`. There
 * is no listener order that fixes that from inside the editor (a capture
 * listener on the same target runs in registration order, and the provider
 * mounts with the app), so the layer stack has to ask this question instead -
 * exactly how it already declines to Deck mode's armed leader.
 *
 * The split:
 *
 *   - INSERT or VISUAL mode, or an open `:` / `/` command line: the editor
 *     genuinely handles the key, so Maestro declines and Vim's own handler ends
 *     the mode and calls `stopPropagation` itself.
 *   - NORMAL mode: Escape clears a pending count or operator, which is a no-op
 *     the overwhelming majority of the time. Swallowing it there would strand
 *     the user in a modal whose Escape had silently stopped working, so the
 *     layer stack keeps it.
 *   - Vim not live on this editor (default keyboard mode, or focus outside an
 *     editor): false, so nothing about today's behavior changes.
 */
export function vimEditorOwnsEscape(
	event?: KeyEventOrigin | null,
	doc: Document = document
): boolean {
	const editor = activeVimEditor(event, doc);
	if (!editor) return false;
	return editor.dialogOpen || editor.mode === 'insert' || editor.mode === 'visual';
}

/** One Ctrl chord `@replit/codemirror-vim` binds, and what it costs Maestro. */
export interface VimEditorCtrlBinding {
	/** The chord as Maestro spells one, so `shortcutKeysCollide` can read it. */
	keys: string[];
	/** `event.key` for the non-modifier half, lower-cased. */
	eventKey: string;
	/** What the package does with it. */
	vimAction: string;
	/** The Vim modes the package binds it in. */
	modes: VimEditorMode[];
	/**
	 * Maestro action ids this chord fires in the VIM-MODE effective set, under
	 * `shortcutKeysCollide`. Empty when the chord is free there.
	 */
	collides: string[];
}

/**
 * Every Ctrl chord `@replit/codemirror-vim` registers, checked against the
 * Vim-mode effective set, with the decision for each overlap.
 *
 * ## The decision, once, for all of them
 *
 * The EDITOR wins while it has focus in Vim normal or visual mode. Two reasons
 * it is not close:
 *
 *  1. These chords are Vim. `<C-d>`, `<C-u>`, `<C-o>`, `<C-r>` and `<C-v>` are
 *     muscle memory from the first hour of using the editor, and a Vim mode
 *     where half of them close a tab instead is not Vim mode.
 *  2. Nothing is lost. `eventMatchesShortcutKeys` collapses Meta and Ctrl into
 *     one modifier, so every Maestro action below ALSO answers to its Cmd
 *     spelling, and the package reads the PHYSICAL `event.ctrlKey`. Cmd+W still
 *     closes the tab from inside the editor; Ctrl+W is Vim's. The user keeps
 *     both, which is why "the editor wins" costs nothing here and would be the
 *     wrong call for a chord that existed only as Ctrl.
 *
 * ## How it is enforced, and the one place that needed code
 *
 * Mostly by construction. `useMainKeyboardHandler` listens on `window` in the
 * BUBBLE phase, and Vim's `eventHandlers.keydown` sits on the content element
 * and calls `preventDefault` + `stopPropagation` on every key it handles. A
 * chord Vim handles therefore never reaches Maestro's matcher at all, and one
 * it declines (`Ctrl+T` outside insert mode, say) falls through to Maestro the
 * same way it does today.
 *
 * The exception is a host hook at `Prec.highest` inside the editor, which runs
 * AHEAD of Vim: FilePreview's Cmd+E / Cmd+S handler and Auto Run's editor
 * keyboard both match with `e.metaKey || e.ctrlKey`, so physical Ctrl+E and
 * Ctrl+F were landing on the host instead of on Vim. `vimEditorOwnsCtrlChord`
 * below is what those handlers are gated on, applied once in
 * `buildEditorExtensions` so every surface rendering this editor gets it.
 *
 * ## The audit
 *
 * `markdownEditorVimCollisions.test.ts` recomputes the `collides` column from
 * `effectiveShortcutsForMode('vim')` and fails if this table drifts from it in
 * either direction, so a rebind cannot quietly empty the list. Normal/visual is
 * what the column is about, and `Ctrl+T` is listed because it is a real chord
 * of the package's even though its only context is insert.
 *
 * Twelve of the twenty-two overlap. The ten that are free in Vim mode -
 * `Ctrl+Space`, `Ctrl+Backspace`, `Ctrl+Escape`, `Ctrl+A`, `Ctrl+C`, `Ctrl+D`,
 * `Ctrl+I`, `Ctrl+Q`, `Ctrl+V`, `Ctrl+X` - are listed anyway: the point of the
 * table is to be the complete record, and a chord that is free today is the
 * next collision the moment someone binds it.
 *
 * Four of those ten are free for a reason that cuts the other way, and it is
 * worth knowing before anyone tries to bind them. `Ctrl+A`, `Ctrl+C`,
 * `Ctrl+V`, `Ctrl+X` collapse to the Cmd chords `RESERVED_SHORTCUT_COMBOS`
 * holds for the macOS Edit menu, so Maestro cannot take them at all. The
 * package can: an NSMenu accelerator is Cmd-based, so the PHYSICAL Ctrl
 * spelling reaches the renderer untouched and Vim's increment, decrement,
 * blockwise-visual and Escape-alias all work.
 */
export const VIM_EDITOR_CTRL_BINDINGS: readonly VimEditorCtrlBinding[] = [
	{
		keys: ['Ctrl', 'Backspace'],
		eventKey: 'backspace',
		vimAction: '`B`, back one WORD',
		modes: ['normal', 'visual'],
		collides: [],
	},
	{
		keys: ['Ctrl', 'Escape'],
		eventKey: 'escape',
		vimAction: 'same as Escape (iPad keyboards send this instead of `<C-[>`)',
		modes: ['normal', 'visual', 'insert'],
		collides: [],
	},
	{
		keys: ['Ctrl', 'Space'],
		eventKey: ' ',
		vimAction: '`W`, forward one WORD',
		modes: ['normal', 'visual'],
		collides: [],
	},
	{
		keys: ['Ctrl', '['],
		eventKey: '[',
		vimAction: 'same as Escape',
		modes: ['normal', 'visual', 'insert'],
		collides: ['cyclePrev'],
	},
	{
		keys: ['Ctrl', 'a'],
		eventKey: 'a',
		vimAction: 'increment the number under the caret',
		modes: ['normal', 'visual'],
		collides: [],
	},
	{
		keys: ['Ctrl', 'b'],
		eventKey: 'b',
		vimAction: 'back one page',
		modes: ['normal', 'visual'],
		collides: ['newBrowserTab'],
	},
	{
		keys: ['Ctrl', 'c'],
		eventKey: 'c',
		vimAction: 'same as Escape',
		modes: ['normal', 'visual', 'insert'],
		collides: [],
	},
	{
		keys: ['Ctrl', 'd'],
		eventKey: 'd',
		vimAction: 'half a page down; un-indent the line in insert',
		modes: ['normal', 'visual', 'insert'],
		collides: [],
	},
	{
		keys: ['Ctrl', 'e'],
		eventKey: 'e',
		vimAction: 'scroll one line down',
		modes: ['normal', 'visual'],
		collides: ['toggleMarkdownMode', 'renameAgentSession'],
	},
	{
		keys: ['Ctrl', 'f'],
		eventKey: 'f',
		vimAction: 'forward one page',
		modes: ['normal', 'visual'],
		collides: [
			'filterFiles',
			'filterSessions',
			'filterHistory',
			'searchLogs',
			'searchOutput',
			'searchDirectorNotes',
		],
	},
	{
		keys: ['Ctrl', 'i'],
		eventKey: 'i',
		vimAction: 'forward in the jump list',
		modes: ['normal', 'visual'],
		collides: [],
	},
	{
		keys: ['Ctrl', 'n'],
		eventKey: 'n',
		vimAction: '`j`, down one line',
		modes: ['normal', 'visual'],
		collides: ['newInstance'],
	},
	{
		keys: ['Ctrl', 'o'],
		eventKey: 'o',
		vimAction: 'back in the jump list; one normal-mode command in insert',
		modes: ['normal', 'visual', 'insert'],
		collides: ['agentSwitcher'],
	},
	{
		keys: ['Ctrl', 'p'],
		eventKey: 'p',
		vimAction: '`k`, up one line',
		modes: ['normal', 'visual'],
		collides: ['copyFilePath'],
	},
	{
		keys: ['Ctrl', 'q'],
		eventKey: 'q',
		vimAction: 'blockwise visual mode',
		modes: ['normal', 'visual'],
		collides: [],
	},
	{
		keys: ['Ctrl', 'r'],
		eventKey: 'r',
		vimAction: 'redo; paste a register in insert',
		modes: ['normal', 'visual', 'insert'],
		collides: ['toggleReadOnlyMode'],
	},
	{
		keys: ['Ctrl', 't'],
		eventKey: 't',
		vimAction: 'indent the line (insert only)',
		modes: ['insert'],
		collides: ['newTab'],
	},
	{
		keys: ['Ctrl', 'u'],
		eventKey: 'u',
		vimAction: 'half a page up; delete to the start of the line in insert',
		modes: ['normal', 'visual', 'insert'],
		collides: ['filterUnreadTabs'],
	},
	{
		keys: ['Ctrl', 'v'],
		eventKey: 'v',
		vimAction: 'blockwise visual mode',
		modes: ['normal', 'visual'],
		collides: [],
	},
	{
		keys: ['Ctrl', 'w'],
		eventKey: 'w',
		vimAction:
			'the `<C-w>` window prefix, reserved and inert; delete the word before the caret in insert',
		modes: ['normal', 'insert'],
		collides: ['closeTab'],
	},
	{
		keys: ['Ctrl', 'x'],
		eventKey: 'x',
		vimAction: 'decrement the number under the caret',
		modes: ['normal', 'visual'],
		collides: [],
	},
	{
		keys: ['Ctrl', 'y'],
		eventKey: 'y',
		vimAction: 'scroll one line up',
		modes: ['normal', 'visual'],
		collides: ['openImageCarousel'],
	},
];

/** The table above by `event.key`, built once. */
const CTRL_BINDINGS_BY_KEY = new Map(VIM_EDITOR_CTRL_BINDINGS.map((b) => [b.eventKey, b]));

/**
 * Whether a Ctrl chord belongs to the Vim editor rather than to a host handler
 * composed above it.
 *
 * Call it from anything that claims a chord with `e.metaKey || e.ctrlKey` and
 * runs INSIDE the editor - `buildEditorExtensions` does it for every surface,
 * which is the only place it should be needed. An app-level handler on `window`
 * does not need the question asked: Vim has already called `stopPropagation`
 * by the time the event would reach it.
 *
 * Physical Ctrl only, and never with Cmd also held, because that is the half
 * that keeps the user whole. `Vim.vimKeyFromEvent` reads `event.ctrlKey`, so
 * Cmd+W is simply not a Vim key, and leaving it to the host is what means
 * "the editor wins" takes nothing away.
 */
export function vimEditorOwnsCtrlChord(
	event: KeyEventOrigin & {
		readonly key: string;
		readonly ctrlKey: boolean;
		readonly metaKey: boolean;
	},
	doc: Document = document
): boolean {
	if (!event.ctrlKey || event.metaKey) return false;
	const binding = CTRL_BINDINGS_BY_KEY.get(event.key.toLowerCase());
	if (!binding) return false;
	const editor = activeVimEditor(event, doc);
	if (!editor) return false;
	// Normal and visual only. Insert mode is the user TYPING, and a host chord
	// they pressed there (Cmd+S's Ctrl spelling, Auto Run's Ctrl+L checkbox) is
	// far likelier to be what they meant than a Vim command would be.
	if (editor.mode !== 'normal' && editor.mode !== 'visual') return false;
	return binding.modes.includes(editor.mode);
}
