import {
	EditorView,
	lineNumbers as cmLineNumbers,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	drawSelection,
} from '@codemirror/view';
import type { Extension } from '@codemirror/state';
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
	onGutterContextMenu?: (lineNumber: number, event: MouseEvent) => void;
	onKeyDown?: (event: KeyboardEvent) => void;
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

	if (opts.onKeyDown) {
		exts.push(
			EditorView.domEventHandlers({
				keydown(event) {
					opts.onKeyDown?.(event);
					return false; // never swallow - host may not preventDefault
				},
			})
		);
	}

	return exts;
}
