import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { EditorState, EditorSelection, StateEffect, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildBaseExtensions } from './extensions';
import { buildEditorTheme } from './themeAdapter';
import { loadLanguageExtension, hasLanguageSupport } from './languageLoader';
import { findAllInDoc } from './searchEngine';
import { softWrapLongLines, mapToWrappedOffset, SOFT_WRAP_MAX_LINE_LENGTH } from './softWrap';
import { nthLineStartOffset } from '../lineSync';
import type { GiantPreviewHandle, GiantPreviewProps } from './types';

/**
 * Giant tier preview for multi-MB / multi-million-line files.
 *
 * Uses CodeMirror 6 in read-only mode. CM6 renders the document via its own
 * virtualization (only the visible viewport is in the DOM), so 50 MB files
 * mount instantly. Built-in search panel + CodeMirror language packs cover
 * find / syntax highlighting.
 *
 * Thin React shell - the heavy lifting (extension composition, theme
 * mapping, language loading, search bridge) lives in sibling modules.
 *
 * Lifecycle:
 *   1. Mount: create `EditorState` synchronously with base extensions
 *      (read-only, search, line numbers) + theme. Document mounts immediately.
 *   2. Async: kick off `loadLanguageExtension(language)`. When it resolves,
 *      dispatch a `reconfigure` to inject the language extension. The text
 *      already on screen re-tokenizes - usually unnoticeable.
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

	// Base extensions don't depend on content - memoize to avoid rebuilding on each render.
	const baseExtensions = useMemo<Extension[]>(
		() => [buildBaseExtensions(), buildEditorTheme(theme)],
		[theme]
	);

	// Soft-wrap pathologically long lines so CM6's per-line measurement pass
	// doesn't freeze the renderer. Lines under the threshold pass through
	// unchanged. The insertion map lets the search handle navigate CM6 to
	// the correct (wrapped) offset for a hit located against the ORIGINAL
	// content - so a query that straddles a wrap boundary still matches.
	const wrap = useMemo(() => softWrapLongLines(content, SOFT_WRAP_MAX_LINE_LENGTH), [content]);
	const displayContent = wrap.wrapped;

	// Mount / remount the editor when content, language or theme changes.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		const state = EditorState.create({
			doc: displayContent,
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
	}, [displayContent, language, baseExtensions]);

	// Bridge CM6's content element (not the host) to the parent containerRef.
	// useFilePreviewSearch walks this container for DOM ranges to register CSS
	// Highlights; scoping to `.cm-content` excludes the gutter (line numbers)
	// so a search like "123" doesn't paint highlights on gutter digits and
	// also keeps the all-matches count accurate when CM6's own match-count
	// has to agree with the DOM-walker fallback.
	useEffect(() => {
		if (!containerRef) return;
		const host = hostRef.current;
		// `.cm-content` is a `<div>` in CM6, but querySelector returns the
		// generic HTMLElement; widen to HTMLDivElement for the ref signature.
		const contentEl = (host?.querySelector('.cm-content') as HTMLDivElement | null) ?? host;
		containerRef.current = contentEl;
	});

	useImperativeHandle(
		ref,
		() => ({
			findInContent: (query: string, options) => {
				// Search the ORIGINAL content (not view.state.doc which has the
				// soft-wrap newlines). This keeps matches that straddle a wrap
				// boundary findable. The search is pure on `content`, so it
				// must run even before CM6 has mounted - scrollToMatch handles
				// mount-state on its own.
				return findAllInDoc(content, query, options);
			},
			scrollToMatch: (hit) => {
				const view = viewRef.current;
				// Defensive: same-render race between useFilePreviewSearch's
				// count + navigate effects can pass undefined when a fresh
				// query shrinks the hit count below the current index.
				if (!view || !hit) return;
				const docLength = view.state.doc.length;
				const wrappedStart = mapToWrappedOffset(wrap.insertionsAt, hit.sourceOffset);
				const wrappedEnd = mapToWrappedOffset(wrap.insertionsAt, hit.sourceOffset + hit.length);
				const from = Math.max(0, Math.min(wrappedStart, docLength));
				const to = Math.max(from, Math.min(wrappedEnd, docLength));
				view.dispatch({
					selection: EditorSelection.single(from, to),
					effects: EditorView.scrollIntoView(from, { y: 'center' }),
				});
			},
			getTopLine: () => {
				const view = viewRef.current;
				if (!view) return 1;
				// Wrapped doc line at the top, then subtract the synthetic lines
				// soft-wrap inserted above it to recover the SOURCE line.
				const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
				const wrappedLine = view.state.doc.lineAt(block.from).number;
				const ins = wrap.insertionsAt;
				let synthetic = 0;
				// `ins[k] + k` is the wrapped offset of the k-th inserted newline.
				for (let k = 0; k < ins.length; k++) {
					if (ins[k] + k < block.from) synthetic++;
					else break;
				}
				return Math.max(1, wrappedLine - synthetic);
			},
			scrollToLine: (line: number) => {
				const view = viewRef.current;
				if (!view) return;
				const srcOffset = nthLineStartOffset(content, line);
				const wrappedOffset = mapToWrappedOffset(wrap.insertionsAt, srcOffset);
				const docLength = view.state.doc.length;
				const from = view.state.doc.lineAt(Math.max(0, Math.min(wrappedOffset, docLength))).from;
				view.dispatch({
					effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 0 }),
				});
			},
		}),
		[content, wrap.insertionsAt]
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
