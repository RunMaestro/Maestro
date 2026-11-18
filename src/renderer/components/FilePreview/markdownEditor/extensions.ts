import {
	EditorView,
	lineNumbers as cmLineNumbers,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	drawSelection,
	placeholder as cmPlaceholder,
} from '@codemirror/view';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
	bracketMatching,
	defaultHighlightStyle,
	syntaxHighlighting,
	indentOnInput,
	foldGutter,
	foldKeymap,
} from '@codemirror/language';
import { highlightSelectionMatches } from '@codemirror/search';
import {
	buildCodeEditingExtensions,
	editorClaimsKey,
	withoutAppOwnedChords,
	type BuildCodeEditingExtensionsOptions,
} from './codeEditing';
import type { EditorSelectionDetails } from './types';

/**
 * The main selection with its 1-based line span, or null for a bare caret.
 * A selection that ends at column 0 of a line (the usual result of selecting
 * whole lines by dragging down) does not count that last line.
 */
export function mainSelectionDetails(state: EditorState): EditorSelectionDetails | null {
	const { from, to } = state.selection.main;
	if (from === to) return null;
	const startLine = state.doc.lineAt(from).number;
	const endLineInfo = state.doc.lineAt(to);
	const endLine =
		endLineInfo.from === to && endLineInfo.number > startLine
			? endLineInfo.number - 1
			: endLineInfo.number;
	return { text: state.sliceDoc(from, to), from, to, startLine, endLine };
}

export interface BuildEditorExtensionsOptions {
	wrap: boolean;
	showLineNumbers: boolean;
	spellCheck: boolean;
	/** Render the document without letting the user type into it. */
	readOnly?: boolean;
	onGutterContextMenu?: (lineNumber: number, event: MouseEvent) => void;
	/**
	 * DOM-level keydown, run BEFORE CodeMirror's own keymap. Return `true` to
	 * swallow the key - that is how a host-owned popup (the template-variable
	 * autocomplete) claims Up/Down/Enter/Escape while it is open. Returning
	 * anything else leaves the key to the editor.
	 */
	onKeyDown?: (event: KeyboardEvent) => boolean | void;
	/**
	 * DOM-level paste, run BEFORE CodeMirror's own paste handler. Return `true`
	 * to swallow the event - that is how a host claims a paste it wants to
	 * rewrite (trimming whitespace, turning an image on the clipboard into a
	 * saved attachment). Anything else leaves the paste to the editor.
	 */
	onPaste?: (event: ClipboardEvent) => boolean | void;
	/** Hint text painted while the document is empty. */
	placeholder?: string;
	/**
	 * Turn on the code-editor set from `./codeEditing` (completion, bracket
	 * auto-close, multiple cursors, editing chords). Omit for prose editors.
	 */
	codeEditing?: BuildCodeEditingExtensionsOptions;
	/**
	 * Right-click on selected text. Fires only when the click lands inside the
	 * main selection; anywhere else the native menu (spellcheck, copy) opens.
	 */
	onSelectionContextMenu?: (selection: EditorSelectionDetails, event: MouseEvent) => void;
}

/**
 * Compose the writable base extension set for `MarkdownEditor`.
 *
 * Differences vs the read-only Giant tier extensions:
 *   - editor is editable (no `EditorState.readOnly.of(true)`)
 *   - line numbers/wrap/spellcheck are prop-driven, not fixed
 *   - DOM-level keydown is forwarded so the host can keep its Cmd+S handler
 *   - gutter line numbers expose a contextmenu hook for "copy deep link"
 *
 * Search panel is intentionally omitted - the host app provides its own
 * search bar that drives the editor via the imperative handle, identical to
 * how the Giant tier handles it.
 */
export function buildEditorExtensions(opts: BuildEditorExtensionsOptions): Extension {
	const exts: Extension[] = [
		history(),
		drawSelection(),
		foldGutter(),
		highlightActiveLine(),
		highlightActiveLineGutter(),
		bracketMatching(),
		indentOnInput(),
		highlightSelectionMatches(),
		syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
		keymap.of([
			...(opts.codeEditing ? withoutAppOwnedChords(defaultKeymap) : defaultKeymap),
			...historyKeymap,
			...foldKeymap,
			indentWithTab,
		]),
	];

	if (opts.codeEditing) {
		exts.push(buildCodeEditingExtensions(opts.codeEditing));
	}

	if (opts.showLineNumbers) {
		exts.push(
			cmLineNumbers(
				opts.onGutterContextMenu
					? {
							domEventHandlers: {
								contextmenu(view, line, event) {
									const lineNumber = view.state.doc.lineAt(line.from).number;
									(event as MouseEvent).preventDefault();
									opts.onGutterContextMenu?.(lineNumber, event as MouseEvent);
									return true;
								},
							},
						}
					: undefined
			)
		);
	}

	if (opts.placeholder) {
		exts.push(cmPlaceholder(opts.placeholder));
	}

	if (opts.wrap) {
		exts.push(EditorView.lineWrapping);
	}

	exts.push(
		EditorView.contentAttributes.of({
			spellcheck: opts.spellCheck ? 'true' : 'false',
			autocorrect: 'off',
			autocapitalize: 'off',
		})
	);

	if (opts.readOnly) {
		// Both halves matter: `readOnly` refuses edits, `editable` also drops the
		// caret and the contenteditable attribute, so a read-only pane reads as a
		// document rather than as a text box that silently ignores typing.
		exts.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
	}

	if (opts.onKeyDown) {
		exts.push(
			// Highest precedence so the host sees the key BEFORE the editor's own
			// keymap. Without it the arrow keys would have already moved the caret
			// (and stopped the chain) by the time the host's popup was offered them.
			Prec.highest(
				EditorView.domEventHandlers({
					keydown(event, view) {
						// An open completion popup, or several cursors, own Escape /
						// Enter / the arrows (see editorClaimsKey). Keep them from the
						// host and from the window: the editor answers this one.
						if (editorClaimsKey(event, view.state)) {
							event.stopPropagation();
							return false;
						}
						return opts.onKeyDown?.(event) === true;
					},
				})
			)
		);
	}

	if (opts.onPaste) {
		exts.push(
			// Same reasoning as the keydown handler: CM6's built-in paste handler
			// inserts the clipboard text and stops the chain, so a host that wants
			// to rewrite the paste has to see it first.
			Prec.highest(
				EditorView.domEventHandlers({
					paste(event) {
						return opts.onPaste?.(event) === true;
					},
				})
			)
		);
	}

	if (opts.onSelectionContextMenu) {
		exts.push(
			EditorView.domEventHandlers({
				contextmenu(event, view) {
					const selection = mainSelectionDetails(view.state);
					if (!selection) return false;
					const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
					if (pos === null || pos < selection.from || pos > selection.to) return false;
					event.preventDefault();
					opts.onSelectionContextMenu?.(selection, event);
					return true;
				},
			})
		);
	}

	return exts;
}
