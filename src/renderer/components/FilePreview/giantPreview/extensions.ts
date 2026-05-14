import {
	EditorView,
	lineNumbers,
	highlightActiveLine,
	highlightActiveLineGutter,
} from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
	bracketMatching,
	defaultHighlightStyle,
	syntaxHighlighting,
	indentOnInput,
	foldGutter,
	foldKeymap,
} from '@codemirror/language';

/**
 * Compose the base CodeMirror 6 extension set used by the Giant tier.
 *
 * Intentionally read-only: `EditorState.readOnly.of(true)` blocks editing
 * commands, `EditorView.editable.of(false)` hides the cursor caret while
 * still allowing selection (useful for copy-paste).
 *
 * `search()` mounts the search panel; we open it programmatically via
 * `openSearchPanel(view)` in `searchBridge.ts` when the user presses Cmd+F.
 * `highlightSelectionMatches` paints same-string occurrences without
 * needing the panel.
 *
 * The `defaultHighlightStyle` is provided as a fallback for tags the theme
 * adapter doesn't cover — applied via `fallback: true` so the adapter's
 * colors win for tags it specifies.
 */
export function buildBaseExtensions(): Extension {
	return [
		lineNumbers(),
		foldGutter(),
		highlightActiveLine(),
		highlightActiveLineGutter(),
		bracketMatching(),
		indentOnInput(),
		history(),
		search({ top: true }),
		highlightSelectionMatches(),
		syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
		keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap]),
		EditorState.readOnly.of(true),
		EditorView.editable.of(false),
		// Keyboard-only focus support (the editor element still receives
		// focus, just no caret).
		EditorView.contentAttributes.of({ tabIndex: '0' }),
		// `lineWrapping` is intentional — Giant tier is the escalation target
		// for files with pathologically long single lines (see
		// LINE_LENGTH_GIANT_THRESHOLD in filePreviewUtils). Without wrapping,
		// a single 500k-character line becomes a multi-million-pixel-wide
		// DOM element and Chromium's wide-layer paint paths freeze the main
		// thread. Wrapping costs readability on structured logs but avoids
		// the freeze on the input shapes we explicitly route here.
		EditorView.lineWrapping,
	];
}
