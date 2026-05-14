import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { EditorState, StateEffect, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildBaseExtensions } from './extensions';
import { buildEditorTheme } from './themeAdapter';
import { loadLanguageExtension, hasLanguageSupport } from './languageLoader';
import { openSearch, closeSearch } from './searchBridge';
import type { GiantPreviewHandle, GiantPreviewProps } from './types';

/**
 * Giant tier preview for multi-MB / multi-million-line files.
 *
 * Uses CodeMirror 6 in read-only mode. CM6 renders the document via its own
 * virtualization (only the visible viewport is in the DOM), so 50 MB files
 * mount instantly. Built-in search panel + CodeMirror language packs cover
 * find / syntax highlighting.
 *
 * Thin React shell — the heavy lifting (extension composition, theme
 * mapping, language loading, search bridge) lives in sibling modules.
 *
 * Lifecycle:
 *   1. Mount: create `EditorState` synchronously with base extensions
 *      (read-only, search, line numbers) + theme. Document mounts immediately.
 *   2. Async: kick off `loadLanguageExtension(language)`. When it resolves,
 *      dispatch a `reconfigure` to inject the language extension. The text
 *      already on screen re-tokenizes — usually unnoticeable.
 *   3. Cleanup: `view.destroy()` on unmount.
 *
 * Content / theme changes: rather than mutating the existing state we
 * destroy and rebuild the view. CM6 transactions COULD mutate the doc, but
 * for huge documents the rebuild cost is negligible and the code is simpler.
 */
export const GiantPreview = forwardRef<GiantPreviewHandle, GiantPreviewProps>(function GiantPreview(
	{ content, language, theme, containerRef, filePath: _filePath },
	ref
) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const [_isReady, setIsReady] = useState(false);

	// Base extensions don't depend on content — memoize to avoid rebuilding on each render.
	const baseExtensions = useMemo<Extension[]>(
		() => [buildBaseExtensions(), buildEditorTheme(theme)],
		[theme]
	);

	// Mount / remount the editor when content, language or theme changes.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		const state = EditorState.create({
			doc: content,
			extensions: baseExtensions,
		});

		const view = new EditorView({ state, parent: host });
		viewRef.current = view;
		setIsReady(true);

		// Asynchronously load the language pack and reconfigure once it
		// arrives. Plain text / unsupported languages skip this entirely.
		let cancelled = false;
		if (hasLanguageSupport(language)) {
			void loadLanguageExtension(language).then((langExt) => {
				if (cancelled || !langExt || !viewRef.current) return;
				viewRef.current.dispatch({
					effects: StateEffect.reconfigure.of([...baseExtensions, langExt]),
				});
			});
		}

		return () => {
			cancelled = true;
			view.destroy();
			viewRef.current = null;
			setIsReady(false);
		};
	}, [content, language, baseExtensions]);

	// Bridge the host element to the parent containerRef so the existing
	// search hook can scope to it for adapter-driven search effects.
	useEffect(() => {
		if (containerRef) containerRef.current = hostRef.current;
	});

	useImperativeHandle(
		ref,
		() => ({
			openSearch: (initialQuery?: string) => {
				if (viewRef.current) openSearch(viewRef.current, initialQuery);
			},
			closeSearch: () => {
				if (viewRef.current) closeSearch(viewRef.current);
			},
			// Giant tier doesn't enumerate matches — CM6's panel handles
			// everything. The adapter contract still wants a function, so we
			// return an empty array and the no-match path in the hook just
			// shows "0 of 0" while the user uses CM6's panel directly.
			findInContent: () => [],
			scrollToMatch: () => {
				/* CM6 search handles its own scrolling */
			},
		}),
		[]
	);

	return (
		<div
			ref={hostRef}
			data-testid="giant-preview-root"
			className="file-preview-content"
			style={{
				height: '100%',
				overflow: 'hidden',
				display: 'flex',
				flexDirection: 'column',
			}}
		/>
	);
});

export default GiantPreview;
