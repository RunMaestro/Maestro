/**
 * MaestroEditor — shared CodeMirror 6 editor component.
 *
 * Controlled React wrapper around a CM6 EditorView used as the editing
 * surface for the expanded PromptComposerModal and the FilePreview
 * markdown / source edit mode. Builds the EditorView once on mount and
 * reconfigures the reactive bits (language, theme, read-only flag,
 * placeholder, caller-supplied extensions) through Compartments so prop
 * changes don't remount the editor.
 *
 * Column-mode editing primitives — rectangular selection on Option+drag
 * via `rectangularSelection()` and add-cursor-above / add-cursor-below
 * via `useColumnModeKeymap()` — are wired here automatically. The
 * multi-cursor chords are user-rebindable through Settings → Shortcuts.
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
	EditorView,
	crosshairCursor,
	drawSelection,
	dropCursor,
	highlightActiveLine,
	keymap,
	placeholder as placeholderExt,
	rectangularSelection,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

import { useSettings } from '../../../hooks';
import { THEMES, type Theme } from '../../../constants/themes';
import { buildEditorTheme } from '../../FilePreview/giantPreview/themeAdapter';
import {
	hasLanguageSupport,
	loadLanguageExtension,
} from '../../FilePreview/giantPreview/languageLoader';
import { useColumnModeKeymap } from './useColumnModeKeymap';

export type MaestroEditorLanguage =
	| 'markdown'
	| 'yaml'
	| 'json'
	| 'javascript'
	| 'python'
	| 'plain';

export interface MaestroEditorHandle {
	focus: () => void;
	blur: () => void;
	/**
	 * Underlying CodeMirror `EditorView`, or `null` before mount / after
	 * unmount. Exposed so consumers can read selection, dispatch
	 * transactions, or attach view-level effects. Prefer the higher-level
	 * props (`value`, `onChange`, `extensions`) when they suffice.
	 */
	getView: () => EditorView | null;
}

export interface MaestroEditorProps {
	value: string;
	onChange: (value: string) => void;
	language?: MaestroEditorLanguage;
	placeholder?: string;
	readOnly?: boolean;
	minHeight?: number;
	maxHeight?: number;
	autoFocus?: boolean;
	className?: string;
	/** Additional CodeMirror extensions appended after the built-in set. */
	extensions?: Extension[];
	onBlur?: () => void;
	/**
	 * Optional key handler invoked before CodeMirror's own bindings. Return
	 * `true` to mark the event handled and stop CM6's default handling.
	 */
	onKeyDown?: (event: KeyboardEvent) => boolean;
}

/**
 * Resolve the active Maestro theme from settings — mirrors the memoized
 * lookup in `App.tsx` so the `custom` theme picks up live color edits.
 */
function useActiveTheme(): Theme {
	const { activeThemeId, customThemeColors } = useSettings();
	return useMemo(() => {
		if (activeThemeId === 'custom') {
			return { ...THEMES.custom, colors: customThemeColors };
		}
		return THEMES[activeThemeId];
	}, [activeThemeId, customThemeColors]);
}

export const MaestroEditor = forwardRef<MaestroEditorHandle, MaestroEditorProps>(
	function MaestroEditor(
		{
			value,
			onChange,
			language = 'plain',
			placeholder,
			readOnly = false,
			minHeight,
			maxHeight,
			autoFocus = false,
			className,
			extensions,
			onBlur,
			onKeyDown,
		},
		ref
	) {
		const columnModeKeymap = useColumnModeKeymap();
		const hostRef = useRef<HTMLDivElement | null>(null);
		const viewRef = useRef<EditorView | null>(null);

		// Compartments let us reconfigure reactive extensions without
		// destroying the EditorView. Refs (not state) — they're identity
		// stable across renders and don't trigger re-mount.
		const languageCompartment = useRef(new Compartment());
		const themeCompartment = useRef(new Compartment());
		const readOnlyCompartment = useRef(new Compartment());
		const placeholderCompartment = useRef(new Compartment());
		const userExtensionsCompartment = useRef(new Compartment());
		const columnKeymapCompartment = useRef(new Compartment());

		// Latest callback refs — keeps the EditorView listeners stable while
		// allowing parents to swap their handler implementations between
		// renders without remounting CM6.
		const onChangeRef = useRef(onChange);
		onChangeRef.current = onChange;
		const onBlurRef = useRef(onBlur);
		onBlurRef.current = onBlur;
		const onKeyDownRef = useRef(onKeyDown);
		onKeyDownRef.current = onKeyDown;

		const theme = useActiveTheme();

		// Build the EditorView exactly once. Subsequent prop changes flow
		// through compartments (theme/language/etc.) or transactions (value).
		useEffect(() => {
			const host = hostRef.current;
			if (!host) return;

			const updateListener = EditorView.updateListener.of((update) => {
				if (update.docChanged) {
					onChangeRef.current(update.state.doc.toString());
				}
			});

			const domEventHandlers = EditorView.domEventHandlers({
				blur: () => {
					onBlurRef.current?.();
					return false;
				},
				keydown: (event) => onKeyDownRef.current?.(event) ?? false,
			});

			const baseExtensions: Extension[] = [
				EditorView.lineWrapping,
				history(),
				rectangularSelection({ eventFilter: (e) => e.altKey }),
				crosshairCursor(),
				drawSelection(),
				dropCursor(),
				highlightActiveLine(),
				// Combined keymap: defaults + history. The column-mode slice
				// is held in its own compartment so the hook can swap its
				// bindings without rebuilding the EditorView.
				keymap.of([...defaultKeymap, ...historyKeymap]),
				columnKeymapCompartment.current.of(keymap.of(columnModeKeymap)),
				languageCompartment.current.of([]),
				themeCompartment.current.of(buildEditorTheme(theme)),
				readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
				placeholderCompartment.current.of(placeholder ? placeholderExt(placeholder) : []),
				userExtensionsCompartment.current.of(extensions ?? []),
				updateListener,
				domEventHandlers,
			];

			const view = new EditorView({
				state: EditorState.create({ doc: value, extensions: baseExtensions }),
				parent: host,
			});
			viewRef.current = view;

			if (autoFocus) {
				view.focus();
			}

			// Asynchronously load the language pack and slot it into the
			// language compartment. Plain text / unsupported languages keep
			// the empty stub. The closure captures `language` at mount; the
			// dedicated effect below reacts to subsequent prop changes.
			let cancelled = false;
			if (language !== 'plain' && hasLanguageSupport(language)) {
				void loadLanguageExtension(language).then((langExt) => {
					if (cancelled || !langExt || !viewRef.current) return;
					viewRef.current.dispatch({
						effects: languageCompartment.current.reconfigure(langExt),
					});
				});
			}

			return () => {
				cancelled = true;
				view.destroy();
				viewRef.current = null;
			};
			// Mount-only — every reactive prop is handled by its own effect
			// below via the compartment system.
		}, []);

		// Sync external `value` prop into the editor doc. We only dispatch
		// when the prop diverges from the current doc to avoid the
		// onChange → setState → re-render → dispatch ping-pong.
		useEffect(() => {
			const view = viewRef.current;
			if (!view) return;
			const current = view.state.doc.toString();
			if (current === value) return;
			view.dispatch({
				changes: { from: 0, to: current.length, insert: value },
			});
		}, [value]);

		// Reconfigure language when the prop changes after mount.
		useEffect(() => {
			const view = viewRef.current;
			if (!view) return;
			let cancelled = false;
			if (language === 'plain' || !hasLanguageSupport(language)) {
				view.dispatch({
					effects: languageCompartment.current.reconfigure([]),
				});
				return;
			}
			void loadLanguageExtension(language).then((langExt) => {
				if (cancelled || !viewRef.current) return;
				viewRef.current.dispatch({
					effects: languageCompartment.current.reconfigure(langExt ?? []),
				});
			});
			return () => {
				cancelled = true;
			};
		}, [language]);

		// Reconfigure theme.
		useEffect(() => {
			const view = viewRef.current;
			if (!view) return;
			view.dispatch({
				effects: themeCompartment.current.reconfigure(buildEditorTheme(theme)),
			});
		}, [theme]);

		// Reconfigure read-only flag.
		useEffect(() => {
			const view = viewRef.current;
			if (!view) return;
			view.dispatch({
				effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
			});
		}, [readOnly]);

		// Reconfigure placeholder.
		useEffect(() => {
			const view = viewRef.current;
			if (!view) return;
			view.dispatch({
				effects: placeholderCompartment.current.reconfigure(
					placeholder ? placeholderExt(placeholder) : []
				),
			});
		}, [placeholder]);

		// Reconfigure caller-supplied extensions.
		useEffect(() => {
			const view = viewRef.current;
			if (!view) return;
			view.dispatch({
				effects: userExtensionsCompartment.current.reconfigure(extensions ?? []),
			});
		}, [extensions]);

		// Reconfigure column-mode keymap when the user rebinds the chord.
		useEffect(() => {
			const view = viewRef.current;
			if (!view) return;
			view.dispatch({
				effects: columnKeymapCompartment.current.reconfigure(keymap.of(columnModeKeymap)),
			});
		}, [columnModeKeymap]);

		useImperativeHandle(
			ref,
			() => ({
				focus: () => {
					viewRef.current?.focus();
				},
				blur: () => {
					viewRef.current?.contentDOM.blur();
				},
				getView: () => viewRef.current,
			}),
			[]
		);

		const containerStyle: React.CSSProperties = {
			minHeight,
			maxHeight,
			overflow: 'auto',
		};

		// `select-text` opts back in to text selection so any ancestor
		// `select-none` modal rule does not block selection inside CM6.
		const rootClassName = ['select-text', className].filter(Boolean).join(' ');

		return <div ref={hostRef} className={rootClassName} style={containerStyle} />;
	}
);

export default MaestroEditor;
