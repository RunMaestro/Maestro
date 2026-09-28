import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Wrap a callback so its identity never changes while it still calls the latest
 * version. The React "event callback" pattern: the returned function is created
 * once, and each render points a ref at the newest implementation.
 *
 * Use this when a callback is passed somewhere that treats a new identity as a
 * structural change rather than as a fresh value. The motivating case is
 * `createMarkdownComponents()`: it returns a map of freshly-created component
 * functions, so React sees a NEW component TYPE for every element the moment
 * that map is rebuilt, and unmounts and remounts the whole rendered document.
 * That drops the reader's scroll position, restarts images, and re-runs Mermaid.
 * A toggle handler that closes over the document content changes identity on
 * every keystroke, so without this the preview tore itself down constantly.
 *
 * The ref is updated in a layout effect so the swap lands before any child's
 * effects or event handlers can fire in the same commit.
 *
 * Do NOT reach for this to silence an exhaustive-deps warning. It intentionally
 * hides the callback from dependency arrays, so an effect that should re-run
 * when the callback's captured values change will no longer do so.
 */
export function useStableCallback<Args extends unknown[], Result>(
	callback: (...args: Args) => Result
): (...args: Args) => Result {
	const ref = useRef(callback);

	useLayoutEffect(() => {
		ref.current = callback;
	});

	return useCallback((...args: Args) => ref.current(...args), []);
}
