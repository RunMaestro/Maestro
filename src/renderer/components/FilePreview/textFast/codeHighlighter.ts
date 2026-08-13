/**
 * Lazy syntax highlighting for code pages inside the Fast tier text preview.
 * Thin shell over `shared/lazyShikiObserver` - same factory the markdown
 * Fast tier uses, so a bug fix in one place propagates to both.
 */

import type { Theme } from '../../../constants/themes';
import {
	createLazyShikiObserver,
	HIGHLIGHTED_ATTR,
	type LazyShikiObserverHandle,
} from '../shared/lazyShikiObserver';

export { HIGHLIGHTED_ATTR };

export type TextCodeHighlighterHandle = LazyShikiObserverHandle;

export interface TextCodeHighlighterOptions {
	theme: Theme;
}

/**
 * Create a code highlighter for the text Fast tier. Same selector as the
 * markdown tier - both render code in `<pre><code class="language-X">…</code></pre>`
 * shape, just inside different containers (page wrapper vs block wrapper).
 */
export function createTextCodeHighlighter(
	options: TextCodeHighlighterOptions
): TextCodeHighlighterHandle {
	return createLazyShikiObserver({
		theme: options.theme,
		componentName: 'textFast/codeHighlighter',
	});
}
