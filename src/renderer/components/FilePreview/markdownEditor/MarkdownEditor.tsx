import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { EditorState, EditorSelection, Compartment, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildEditorTheme } from '../giantPreview/themeAdapter';
import { loadLanguageExtension, hasLanguageSupport } from '../giantPreview/languageLoader';
import { buildEditorExtensions } from './extensions';
import { searchHighlightExtension, setSearchMatchesEffect } from './searchHighlight';
import type { MarkdownEditorHandle, MarkdownEditorProps } from './types';

/**
 * Writable CodeMirror 6 editor for the markdown / text edit mode in
 * FilePreview. Replaces the textarea + syntax-overlay implementation.
 *
 * Why CM6 instead of a textarea: CM6 lays out each logical line as its own
 * block element, so the line-number gutter stays aligned with the text
 * regardless of soft-wrap. The previous fixed-row gutter drifted as soon as
 * a line wrapped — which made markdown tables (one row per line, but each
 * row is wider than the viewport) look unreadable.
 *
 * Reuses the Giant tier's `themeAdapter` (palette → CM6 theme) and
 * `languageLoader` (lazy `@codemirror/lang-*` dynamic import). The base
 * extension set lives in `./extensions` and the search highlight plugin
 * (host-driven, not CM6's panel) in `./searchHighlight`.
 *
 * Lifecycle:
 *   - The view is created once on mount and torn down on unmount.
 *   - `value` changes from the parent are diffed and applied as transactions
 *     so the cursor / scroll / undo history are preserved during external
 *     reformatting (e.g. autosave write-through, undo via the host).
 *   - Toggle-able extensions (wrap, line numbers, spellcheck, theme,
 *     language) are wrapped in CM6 `Compartment`s so we can `reconfigure`
 *     in place instead of remounting.
 *
 * Imperative handle (see `./types`) is the only abstraction the host uses;
 * the underlying CM6 view is intentionally not exposed.
 */
export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
	function MarkdownEditor(
		{
			value,
			onChange,
			language,
			theme,
			spellCheck = false,
			wrap = true,
			showLineNumbers = true,
			onLineNumberContextMenu,
			onKeyDown,
			className,
		},
		ref
	) {
		const hostRef = useRef<HTMLDivElement | null>(null);
		const viewRef = useRef<EditorView | null>(null);

		// Refs to the latest callbacks so the long-lived CM6 view always sees
		// fresh closures without us reconfiguring on every prop change.
		const onChangeRef = useRef(onChange);
		const onKeyDownRef = useRef(onKeyDown);
		const onGutterContextRef = useRef(onLineNumberContextMenu);
		useEffect(() => {
			onChangeRef.current = onChange;
		}, [onChange]);
		useEffect(() => {
			onKeyDownRef.current = onKeyDown;
		}, [onKeyDown]);
		useEffect(() => {
			onGutterContextRef.current = onLineNumberContextMenu;
		}, [onLineNumberContextMenu]);

		// Suppress the next-update onChange when we apply external value changes
		// via dispatch — otherwise the controlled-input feedback loop would fire
		// onChange with the value the parent just gave us, which is harmless but
		// confusing in devtools.
		const applyingExternalRef = useRef(false);

		// Compartments let us swap individual extension subtrees without
		// rebuilding the whole state. One per prop that can change at runtime.
		const compartments = useMemo(
			() => ({
				theme: new Compartment(),
				language: new Compartment(),
				base: new Compartment(),
			}),
			[]
		);

		// Mount once. All subsequent prop changes flow through dispatch or
		// reconfigure below.
		useEffect(() => {
			const host = hostRef.current;
			/* v8 ignore next */
			if (!host) return;

			const baseExt: Extension = buildEditorExtensions({
				wrap,
				showLineNumbers,
				spellCheck,
				onGutterContextMenu: (lineNumber, event) => onGutterContextRef.current?.(lineNumber, event),
				onKeyDown: (event) => onKeyDownRef.current?.(event),
			});

			const updateListener = EditorView.updateListener.of((update) => {
				if (!update.docChanged) return;
				if (applyingExternalRef.current) return;
				onChangeRef.current?.(update.state.doc.toString());
			});

			const state = EditorState.create({
				doc: value,
				extensions: [
					compartments.base.of(baseExt),
					compartments.theme.of(buildEditorTheme(theme)),
					compartments.language.of([]),
					searchHighlightExtension(),
					updateListener,
				],
			});

			const view = new EditorView({ state, parent: host });
			viewRef.current = view;

			// Async language load.
			let cancelled = false;
			if (hasLanguageSupport(language)) {
				void loadLanguageExtension(language).then((langExt) => {
					if (cancelled || !langExt || !viewRef.current) return;
					viewRef.current.dispatch({
						effects: compartments.language.reconfigure(langExt),
					});
				});
			}

			return () => {
				cancelled = true;
				view.destroy();
				viewRef.current = null;
			};
			// Mount-only: prop changes are handled by the dedicated effects below.
		}, []);

		// External `value` → editor doc. Diff so identical strings are a no-op
		// and we preserve cursor/scroll/history. CM6 transactions are cheap.
		useEffect(() => {
			const view = viewRef.current;
			/* v8 ignore next */
			if (!view) return;
			const current = view.state.doc.toString();
			if (current === value) return;
			applyingExternalRef.current = true;
			try {
				view.dispatch({
					changes: { from: 0, to: current.length, insert: value },
				});
			} finally {
				applyingExternalRef.current = false;
			}
		}, [value]);

		// Theme change → reconfigure the theme compartment.
		useEffect(() => {
			const view = viewRef.current;
			/* v8 ignore next */
			if (!view) return;
			view.dispatch({ effects: compartments.theme.reconfigure(buildEditorTheme(theme)) });
		}, [theme, compartments.theme]);

		// Language change → reload + reconfigure. Plain-text falls through to
		// an empty extension so the previously loaded grammar is cleared.
		useEffect(() => {
			const view = viewRef.current;
			/* v8 ignore next */
			if (!view) return;
			let cancelled = false;
			if (!hasLanguageSupport(language)) {
				view.dispatch({ effects: compartments.language.reconfigure([]) });
				return;
			}
			void loadLanguageExtension(language).then((langExt) => {
				if (cancelled || !langExt || !viewRef.current) return;
				viewRef.current.dispatch({
					effects: compartments.language.reconfigure(langExt),
				});
			});
			return () => {
				cancelled = true;
			};
		}, [language, compartments.language]);

		// Toggle-able base options → reconfigure the base compartment.
		useEffect(() => {
			const view = viewRef.current;
			/* v8 ignore next */
			if (!view) return;
			const baseExt = buildEditorExtensions({
				wrap,
				showLineNumbers,
				spellCheck,
				onGutterContextMenu: (lineNumber, event) => onGutterContextRef.current?.(lineNumber, event),
				onKeyDown: (event) => onKeyDownRef.current?.(event),
			});
			view.dispatch({ effects: compartments.base.reconfigure(baseExt) });
		}, [wrap, showLineNumbers, spellCheck, compartments.base]);

		useImperativeHandle(
			ref,
			() => ({
				focus() {
					// Focus the contentDOM element directly rather than CM6's
					// view.focus(). On a view mounted in the same frame (which is
					// exactly the enter-edit-mode case), view.focus() silently
					// no-ops and focus falls to <body>, breaking the Cmd+E toggle
					// until the user clicks in. A plain contentDOM.focus() sticks.
					const view = viewRef.current;
					if (!view) return;
					view.contentDOM.focus({ preventScroll: true });
				},
				scrollToLine(line: number, opts?: { select?: boolean }) {
					const view = viewRef.current;
					if (!view) return;
					const totalLines = view.state.doc.lines;
					const targetLine = Math.min(Math.max(1, Math.floor(line)), totalLines);
					const lineInfo = view.state.doc.line(targetLine);
					const select = opts?.select ?? true;
					view.dispatch({
						selection: select ? EditorSelection.single(lineInfo.from) : undefined,
						effects: EditorView.scrollIntoView(lineInfo.from, {
							y: 'start',
							yMargin: select ? 80 : 0,
						}),
					});
				},
				getTopLine() {
					const view = viewRef.current;
					if (!view) return 1;
					const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
					return view.state.doc.lineAt(block.from).number;
				},
				getScrollPercent() {
					const view = viewRef.current;
					if (!view) return 0;
					const el = view.scrollDOM;
					const max = el.scrollHeight - el.clientHeight;
					return max > 0 ? el.scrollTop / max : 0;
				},
				setScrollPercent(percent: number) {
					const view = viewRef.current;
					if (!view) return;
					const el = view.scrollDOM;
					const max = el.scrollHeight - el.clientHeight;
					const clamped = Math.max(0, Math.min(1, percent));
					el.scrollTop = Math.round(clamped * max);
				},
				setSelection(from: number, to: number, scrollIntoView = false) {
					const view = viewRef.current;
					if (!view) return;
					const docLen = view.state.doc.length;
					const clampedFrom = Math.max(0, Math.min(from, docLen));
					const clampedTo = Math.max(clampedFrom, Math.min(to, docLen));
					view.dispatch({
						selection: EditorSelection.single(clampedFrom, clampedTo),
						effects: scrollIntoView
							? EditorView.scrollIntoView(clampedFrom, { y: 'center' })
							: undefined,
					});
				},
				setSearchMatches(matches, currentIndex) {
					const view = viewRef.current;
					if (!view) return;
					view.dispatch({
						effects: setSearchMatchesEffect.of({ matches, currentIndex }),
					});
				},
				getContentEl() {
					const host = hostRef.current;
					if (!host) return null;
					return host.querySelector('.cm-content') as HTMLElement | null;
				},
			}),
			[]
		);

		return (
			<div
				ref={hostRef}
				data-testid="markdown-editor-root"
				className={`relative w-full h-full ${className ?? ''}`}
				style={{ overflow: 'hidden' }}
			/>
		);
	}
);

export default MarkdownEditor;
