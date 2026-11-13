import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';
import type { Theme } from '../../../constants/themes';
import { getElevatedSurfaceColors } from '../../../utils/elevatedSurface';

/** Unzoomed editor font size, in CSS pixels. */
export const EDITOR_BASE_FONT_PX = 13;

/**
 * Build a CodeMirror 6 theme extension from the app's Theme object.
 *
 * CM6 themes are layered: `EditorView.theme` sets the chrome (background,
 * gutter, line numbers, scrollbar), and `syntaxHighlighting(HighlightStyle)`
 * paints token colors. We return one composite Extension so the caller
 * doesn't care about the split.
 *
 * Colors map roughly to the app's existing palette:
 *   - editor background → bgMain
 *   - editor text       → textMain
 *   - gutter            → bgActivity (slightly darker)
 *   - selection         → accent + alpha
 *   - keywords / types  → accent / success
 *   - strings           → warning
 *   - comments          → textDim
 *
 * `fontScale` is the reader's font zoom (1 = unzoomed). It lives in the theme
 * rather than in a CSS rule because CM6 injects its own scoped stylesheet for
 * `.cm-scroller`; an app-level rule of equal specificity would win or lose on
 * injection order. CM6 re-measures line heights on reconfigure, so scrolling
 * and the gutter stay aligned after a zoom.
 *
 * Pure: theme in, extension out. No side effects, no DOM.
 */
export function buildEditorTheme(
	theme: Theme,
	fontScale = 1,
	fontFamily?: string,
	baseFontPx: number = EDITOR_BASE_FONT_PX
): Extension {
	const c = theme.colors;
	const isDark = theme.mode !== 'light';
	const elevated = getElevatedSurfaceColors(c);

	const editorTheme = EditorView.theme(
		{
			'&': {
				backgroundColor: c.bgMain,
				color: c.textMain,
				height: '100%',
			},
			'.cm-scroller': {
				// CM6 sets its own font on `.cm-scroller`, so the surface font cannot
				// arrive by inheritance from the pane the way the prose tiers get it -
				// it has to be threaded in here. Undefined keeps the built-in stack,
				// which is what the read-only Giant tier used before per-surface fonts.
				fontFamily:
					fontFamily ??
					'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
				// `baseFontPx` is the File Preview / File Editor size setting; the
				// hard-coded constant survives only as its default. `fontScale` is
				// the pane's own zoom control, which multiplies on top - two
				// independent knobs, and the surface size is the one that persists.
				fontSize: `${Math.round(baseFontPx * fontScale * 10) / 10}px`,
				lineHeight: '1.6',
			},
			'.cm-content': {
				caretColor: c.accent,
			},
			'.cm-gutters': {
				backgroundColor: c.bgActivity,
				color: c.textDim,
				border: 'none',
				borderRight: `1px solid ${c.border}`,
			},
			'.cm-activeLine': {
				backgroundColor: c.accent + '10',
			},
			'.cm-activeLineGutter': {
				backgroundColor: c.accent + '20',
			},
			'.cm-selectionBackground, .cm-content ::selection': {
				backgroundColor: c.accent + '40',
			},
			'.cm-cursor': {
				borderLeftColor: c.accent,
			},
			// Search panel chrome - CM6 renders the panel as plain HTML, so
			// we style it via descendant selectors here.
			'.cm-panels': {
				backgroundColor: c.bgSidebar,
				color: c.textMain,
				borderTop: `1px solid ${c.border}`,
			},
			'.cm-panels .cm-textfield': {
				backgroundColor: c.bgMain,
				color: c.textMain,
				border: `1px solid ${c.border}`,
				padding: '2px 6px',
			},
			'.cm-panels .cm-button': {
				backgroundColor: c.bgActivity,
				color: c.textMain,
				border: `1px solid ${c.border}`,
			},
			'.cm-searchMatch': {
				backgroundColor: c.warning + '40',
			},
			'.cm-searchMatch-selected': {
				backgroundColor: c.accent + '60',
				outline: `1px solid ${c.accent}`,
			},
			// Host-driven search match decorations (see markdownEditor/searchHighlight).
			// Kept in this shared theme so both writable editors and any future
			// CM6-based read path pick up the same colors. Naming is prefixed
			// `cm-app-` to make it unambiguous that these come from app code,
			// not CodeMirror itself.
			'.cm-app-search-match': {
				backgroundColor: c.warning + '40',
			},
			'.cm-app-search-current': {
				backgroundColor: c.accent + '60',
				outline: `1px solid ${c.accent}`,
			},

			// ── Code-editor chrome (markdownEditor/codeEditing) ──────────────
			// CM6's base theme paints these with `&light` / `&dark` selectors (one
			// class more specific than a plain rule) and, for the focused
			// selection, a five-class chain. Matching that specificity is what
			// lets the palette win: at a tie, a theme beats the base theme.
			'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
				backgroundColor: c.accent + '40',
			},
			// Every caret, including the extra ones from Option/Alt-click. The
			// secondary carets are a step dimmer so the primary stays findable.
			'&.cm-editor .cm-cursor, &.cm-editor .cm-dropCursor': {
				borderLeftColor: c.accent,
			},
			'&.cm-editor .cm-cursor-secondary': {
				borderLeftColor: c.accent + 'b0',
			},
			// Other occurrences of the selected word (highlightSelectionMatches).
			'.cm-selectionMatch': {
				backgroundColor: c.accent + '26',
			},
			'&.cm-editor .cm-matchingBracket': {
				backgroundColor: c.accent + '30',
				outline: `1px solid ${c.accent}80`,
			},
			'&.cm-editor .cm-nonmatchingBracket': {
				backgroundColor: c.error + '30',
			},
			// Completion popup: the same elevated surface every other Maestro
			// popover uses, so it reads as a menu rather than as editor text.
			'&.cm-editor .cm-tooltip': {
				backgroundColor: elevated.background,
				color: c.textMain,
				border: `1px solid ${elevated.border}`,
				boxShadow: elevated.shadow,
				borderRadius: '6px',
			},
			'&.cm-editor .cm-tooltip-autocomplete > ul': {
				fontFamily: 'inherit',
				maxHeight: '16em',
			},
			'&.cm-editor .cm-tooltip-autocomplete > ul > li': {
				padding: '2px 8px',
			},
			'&.cm-editor .cm-tooltip-autocomplete ul li[aria-selected]': {
				backgroundColor: c.accent + '33',
				color: c.textMain,
			},
			'.cm-completionMatchedText': {
				color: c.accent,
				textDecoration: 'none',
				fontWeight: 'bold',
			},
			'.cm-completionDetail': {
				color: c.textDim,
				fontStyle: 'normal',
				marginLeft: '0.75em',
			},
			'.cm-completionIcon': {
				color: c.textDim,
				opacity: '1',
			},
			'&.cm-editor .cm-tooltip.cm-completionInfo': {
				padding: '4px 8px',
				maxWidth: '28em',
			},
			// Vim mode (@replit/codemirror-vim): the block cursor and the status
			// line it draws under the editor.
			'.cm-fat-cursor': {
				background: c.accent + '90',
				color: c.bgMain,
			},
			'&:not(.cm-focused) .cm-fat-cursor': {
				background: 'none',
				outline: `1px solid ${c.accent}`,
				color: 'transparent',
			},
			'.cm-vim-panel': {
				backgroundColor: c.bgSidebar,
				color: c.textMain,
				fontFamily: 'inherit',
				padding: '0 8px',
			},
			'.cm-vim-panel input': {
				color: c.textMain,
				backgroundColor: 'transparent',
			},
		},
		{ dark: isDark }
	);

	// Syntax highlight style keyed to common Lezer tags.
	const highlightStyle = HighlightStyle.define([
		{ tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: c.accent, fontWeight: 'bold' },
		{ tag: [t.typeName, t.className, t.namespace], color: c.success },
		{ tag: [t.string, t.special(t.string), t.regexp], color: c.warning },
		{ tag: [t.number, t.bool, t.null], color: c.warning },
		{
			tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
			color: c.textDim,
			fontStyle: 'italic',
		},
		{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: c.accent },
		{ tag: [t.propertyName], color: c.textMain },
		{ tag: [t.variableName], color: c.textMain },
		{ tag: [t.operator, t.punctuation], color: c.textDim },
		{ tag: [t.heading], color: c.accent, fontWeight: 'bold' },
		{ tag: [t.link, t.url], color: c.accent, textDecoration: 'underline' },
		{ tag: [t.emphasis], fontStyle: 'italic' },
		{ tag: [t.strong], fontWeight: 'bold' },
		{ tag: [t.atom, t.modifier], color: c.success },
		{ tag: [t.tagName], color: c.accent },
		{ tag: [t.attributeName], color: c.success },
		{ tag: [t.attributeValue], color: c.warning },
		{ tag: [t.invalid], color: c.error },
	]);

	return [editorTheme, syntaxHighlighting(highlightStyle)];
}
