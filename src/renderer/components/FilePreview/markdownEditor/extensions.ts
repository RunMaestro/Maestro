import {
	EditorView,
	lineNumbers as cmLineNumbers,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	drawSelection,
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
		keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
	];

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
					keydown(event) {
						return opts.onKeyDown?.(event) === true;
					},
				})
			)
		);
	}

	return exts;
}
