import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';
import type { Theme } from '../../../constants/themes';

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
 * Pure: theme in, extension out. No side effects, no DOM.
 */
export function buildEditorTheme(theme: Theme): Extension {
	const c = theme.colors;
	const isDark = theme.mode !== 'light';

	const editorTheme = EditorView.theme(
		{
			'&': {
				backgroundColor: c.bgMain,
				color: c.textMain,
				height: '100%',
			},
			'.cm-scroller': {
				fontFamily:
					'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
				fontSize: '13px',
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
