import {
	EditorView,
	keymap,
	rectangularSelection,
	type Command,
	type KeyBinding,
} from '@codemirror/view';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import {
	acceptCompletion,
	autocompletion,
	closeBrackets,
	closeBracketsKeymap,
	completeAnyWord,
	completionStatus,
} from '@codemirror/autocomplete';
import {
	copyLineDown,
	copyLineUp,
	moveLineDown,
	moveLineUp,
	toggleComment,
} from '@codemirror/commands';
import { selectNextOccurrence } from '@codemirror/search';
import { isMacOS } from '../../../../shared/platformDetection';

/**
 * When the completion popup opens.
 *
 * - `typing`: as the user types, the way a code editor behaves.
 * - `request`: only on Ctrl+Space. Prose (markdown, plain text) uses this so a
 *   word followed by Enter stays a line break instead of accepting a guess.
 * - `off`: no completion at all (the Giant-tier file sizes).
 */
export type CompletionActivation = 'typing' | 'request' | 'off';

/**
 * Above this many characters the editor skips completion. Matches the Giant
 * preview tier (`GIANT_TIER_BYTES`): a file that big already gets the
 * stripped-down read path, and its editor should not pay for a syntax-tree
 * walk on every keystroke either. Everything else in the code-editing set is
 * per-keystroke cheap, so it stays on at any size.
 */
export const CODE_COMPLETION_MAX_CHARS = 8 * 1024 * 1024;

/**
 * Ids of the editor chords that Maestro tracks for keyboard mastery. They are
 * registered in `FIXED_SHORTCUTS` (`src/renderer/constants/shortcuts.ts`) so the
 * Shortcuts Help modal lists them and the mastery denominator counts them.
 */
export const CODE_EDITOR_SHORTCUT_IDS = {
	toggleComment: 'editorToggleComment',
	selectNextOccurrence: 'editorSelectNextOccurrence',
	moveLineUp: 'editorMoveLineUp',
	moveLineDown: 'editorMoveLineDown',
	duplicateLineUp: 'editorDuplicateLineUp',
	duplicateLineDown: 'editorDuplicateLineDown',
	acceptCompletion: 'editorAcceptCompletion',
} as const;

export type CodeEditorShortcutId =
	(typeof CODE_EDITOR_SHORTCUT_IDS)[keyof typeof CODE_EDITOR_SHORTCUT_IDS];

/**
 * CodeMirror's default keymap binds chords that Maestro already owns at the
 * window level. The window handler listens in the bubble phase and does not
 * check `defaultPrevented`, so without this list one keystroke runs BOTH:
 * Cmd+[ outdents the line and switches to the previous agent.
 *
 * - `Mod-[` / `Mod-]`: Previous / Next Agent. Tab and Shift+Tab indent and
 *   outdent instead.
 * - `Shift-Mod-k`: Clear Terminal / Toggle Show Thinking. CM uses it for
 *   "delete line".
 */
export const APP_OWNED_EDITOR_CHORDS: readonly string[] = ['Mod-[', 'Mod-]', 'Shift-Mod-k'];

/**
 * Chords the code editor claims from Maestro while it has focus. `Mod-/` is
 * Show Shortcuts everywhere else; in a code editor it is Toggle Comment, which
 * is what anyone typing it there means. The keydown stops propagating so the
 * window handler never sees it; the editor's own keymap still runs.
 */
export const EDITOR_OWNED_CHORDS: readonly string[] = ['Mod-/'];

/** Drop the bindings Maestro owns from a CodeMirror keymap. */
export function withoutAppOwnedChords(bindings: readonly KeyBinding[]): KeyBinding[] {
	return bindings.filter(
		(b) =>
			!APP_OWNED_EDITOR_CHORDS.includes(b.key ?? '') &&
			!APP_OWNED_EDITOR_CHORDS.includes(b.mac ?? '')
	);
}

/** True when `event` is the `Mod-<key>` chord, with `Mod` = Cmd on macOS, Ctrl elsewhere. */
function isModChord(event: KeyboardEvent, key: string): boolean {
	const mod = isMacOS() ? event.metaKey : event.ctrlKey;
	const other = isMacOS() ? event.ctrlKey : event.metaKey;
	return mod && !other && !event.altKey && !event.shiftKey && event.key === key;
}

function isEditorOwnedChord(event: KeyboardEvent): boolean {
	return EDITOR_OWNED_CHORDS.some((chord) => isModChord(event, chord.slice('Mod-'.length)));
}

/** Keys the open completion popup answers before anything else may. */
const COMPLETION_KEYS = new Set([
	'Escape',
	'Enter',
	'Tab',
	'ArrowUp',
	'ArrowDown',
	'PageUp',
	'PageDown',
]);

/**
 * Whether the editor itself must answer `event` before the host's keydown hook
 * sees it. Two cases:
 *
 * - The completion popup is open: Enter accepts, Escape closes, the arrows
 *   move the highlight. A host that grabbed Escape would leave edit mode with
 *   the popup still on screen.
 * - Several cursors are active and the key is Escape: Escape collapses them
 *   to one. Leaving edit mode instead would throw the multi-cursor edit away.
 *
 * Exported for the keydown forwarder in `./extensions` and for tests.
 */
export function editorClaimsKey(event: KeyboardEvent, state: EditorState): boolean {
	if (completionStatus(state) === 'active' && COMPLETION_KEYS.has(event.key)) return true;
	return event.key === 'Escape' && state.selection.ranges.length > 1;
}

export interface BuildCodeEditingExtensionsOptions {
	completion: CompletionActivation;
	/** Called after a tracked chord ran, with its `FIXED_SHORTCUTS` id. */
	onShortcutUsed?: (id: CodeEditorShortcutId) => void;
}

/**
 * The extensions that turn the file editor into a code editor: completion,
 * auto-closing brackets and quotes, multiple cursors, and the editing chords.
 * Tag auto-close needs nothing here: the HTML, XML, and JSX language packs
 * that `languageLoader` installs ship it themselves.
 *
 * Only the File Preview editor turns this on. Auto Run, Memory, and the prompt
 * editor keep the plain set from `./extensions`: Auto Run documents are prose,
 * and the prompt editor owns its own template-variable popup.
 */
export function buildCodeEditingExtensions(opts: BuildCodeEditingExtensionsOptions): Extension {
	const tracked =
		(id: CodeEditorShortcutId, command: Command): Command =>
		(view) => {
			const ran = command(view);
			if (ran) opts.onShortcutUsed?.(id);
			return ran;
		};

	const ids = CODE_EDITOR_SHORTCUT_IDS;
	const editingKeymap: KeyBinding[] = [
		{ key: 'Mod-/', run: tracked(ids.toggleComment, toggleComment) },
		{
			key: 'Mod-d',
			run: tracked(ids.selectNextOccurrence, selectNextOccurrence),
			preventDefault: true,
		},
		{ key: 'Alt-ArrowUp', run: tracked(ids.moveLineUp, moveLineUp) },
		{ key: 'Alt-ArrowDown', run: tracked(ids.moveLineDown, moveLineDown) },
		{ key: 'Shift-Alt-ArrowUp', run: tracked(ids.duplicateLineUp, copyLineUp) },
		{ key: 'Shift-Alt-ArrowDown', run: tracked(ids.duplicateLineDown, copyLineDown) },
	];

	const exts: Extension[] = [
		// Multiple cursors. Option/Alt-click adds one (the platform's own
		// Cmd/Ctrl-click keeps working too); Shift+Option/Alt-drag draws a
		// rectangular (column) selection, which is where VS Code puts it.
		EditorState.allowMultipleSelections.of(true),
		EditorView.clickAddsSelectionRange.of(
			(event) => event.altKey || (isMacOS() ? event.metaKey : event.ctrlKey)
		),
		rectangularSelection({ eventFilter: (event) => event.altKey && event.shiftKey }),
		closeBrackets(),
		// Above the base keymap so these win over CodeMirror's defaults for the
		// same chords (and so the mastery tracking wrapper is what runs).
		Prec.high(keymap.of([...closeBracketsKeymap, ...editingKeymap])),
		// Highest so it runs before the keymap handler, which stops the handler
		// chain once a binding matches. Returning false leaves the key to it.
		Prec.highest(
			EditorView.domEventHandlers({
				keydown(event) {
					if (isEditorOwnedChord(event)) event.stopPropagation();
					return false;
				},
			})
		),
	];

	if (opts.completion !== 'off') {
		exts.push(
			autocompletion({ activateOnTyping: opts.completion === 'typing' }),
			// Words from the open document, in every language. Language packs add
			// their own sources (JS/TS keywords and snippets, CSS properties, HTML
			// tags and attributes, Python, SQL) through the same facet, and the
			// popup merges them.
			EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
			// Tab accepts like Enter does. Highest so it runs before the base
			// keymap's indentWithTab; with no popup open it returns false and Tab
			// indents as before.
			Prec.highest(
				keymap.of([{ key: 'Tab', run: tracked(ids.acceptCompletion, acceptCompletion) }])
			)
		);
	}

	return exts;
}
