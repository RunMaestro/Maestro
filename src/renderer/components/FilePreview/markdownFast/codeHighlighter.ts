/**
 * Lazy syntax highlighting for code blocks inside the Fast tier markdown
 * preview. Thin shell over `shared/lazyShikiObserver` - the heavy lifting
 * (IntersectionObserver, dynamic Shiki import, idempotency marker) lives in
 * the shared factory so any drift between this tier and the textFast tier
 * shows up in one place.
 */

import type { Theme } from '../../../constants/themes';
import {
	createLazyShikiObserver,
	HIGHLIGHTED_ATTR,
	type LazyShikiObserverHandle,
} from '../shared/lazyShikiObserver';

export { HIGHLIGHTED_ATTR };

export type CodeHighlighterHandle = LazyShikiObserverHandle;

export interface CodeHighlighterOptions {
	theme: Theme;
}

/**
 * Create a code highlighter for the markdown Fast tier. Selects
 * `pre > code[class*="language-"]` - the shape markdown-it emits for fenced
 * code blocks.
 */
export function createCodeHighlighter(options: CodeHighlighterOptions): CodeHighlighterHandle {
	return createLazyShikiObserver({
		theme: options.theme,
		componentName: 'markdownFast/codeHighlighter',
	});
}
