import {
	EditorView,
	lineNumbers,
	highlightActiveLine,
	highlightActiveLineGutter,
} from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { keymap } from '@codemirror/view';
import { highlightSelectionMatches } from '@codemirror/search';
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
 * Search note: we deliberately omit `search()` and `searchKeymap`. Cmd+F is
 * intercepted by FilePreview and routed to the app's shared search bar so
 * the same UI works across Rich / Fast / Giant tiers (see search-hardening
 * plan B4). `highlightSelectionMatches` is kept because it paints same-
 * string occurrences when the user manually selects a range - independent
 * of the search bar.
 *
 * The `defaultHighlightStyle` is provided as a fallback for tags the theme
 * adapter doesn't cover - applied via `fallback: true` so the adapter's
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
		highlightSelectionMatches(),
		syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
		keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap]),
		EditorState.readOnly.of(true),
		EditorView.editable.of(false),
		// Keyboard-only focus support (the editor element still receives
		// focus, just no caret).
		EditorView.contentAttributes.of({ tabIndex: '0' }),
		// `lineWrapping` is intentional - Giant tier is the escalation target
		// for files with pathologically long single lines (see
		// LINE_LENGTH_GIANT_THRESHOLD in filePreviewUtils). Without wrapping,
		// a single 500k-character line becomes a multi-million-pixel-wide
		// DOM element and Chromium's wide-layer paint paths freeze the main
		// thread. Wrapping costs readability on structured logs but avoids
		// the freeze on the input shapes we explicitly route here.
		EditorView.lineWrapping,
		// `lineWrapping` alone uses `white-space: pre-wrap`, which only breaks
		// at whitespace. A 500k-character line with no whitespace (e.g.
		// minified JSON, an `AAAA…AAAA` log line) therefore still renders as
		// one giant flat element and hits the same wide-layer freeze. Pair
		// `overflow-wrap: anywhere` so the browser can break at any character
		// boundary when no whitespace is available.
		EditorView.theme({
			'.cm-content, .cm-line': {
				overflowWrap: 'anywhere',
				wordBreak: 'break-word',
			},
		}),
	];
}
