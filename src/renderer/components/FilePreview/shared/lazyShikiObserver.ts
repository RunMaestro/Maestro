/**
 * Shared lazy-Shiki highlighter factory used by every FilePreview tier that
 * renders source code inside virtualized blocks/pages (markdown Fast tier
 * code fences, text Fast tier code pages).
 *
 * Why one factory:
 *   The markdown and text Fast tiers used to ship near-identical highlighters
 *   in their own modules. The Phase 3 plan called the dedup out explicitly,
 *   and our CI flake fixes had to touch both files for the same root cause -
 *   exactly the drift this consolidation prevents.
 *
 * Strategy (unchanged from per-tier versions):
 *   1. Blocks render as `<pre><code class="language-X">…</code></pre>` first.
 *   2. An IntersectionObserver fires for each `<code>` element scrolled into
 *      view.
 *   3. First observation triggers a dynamic `import('shiki')` so the ~60 KB
 *      highlighter stays out of the main bundle until needed.
 *   4. Each code element is highlighted exactly once. `data-shiki-highlighted`
 *      marker keeps re-mounts cheap.
 *
 * Per-tier variation:
 *   - `selector` - different tiers attach the highlighter to different DOM
 *     shapes.
 *   - `componentName` - used in `captureException.extra.component` so Sentry
 *     reports stay traceable to the tier that produced them.
 *   - `themeName` - derived from the Theme.mode by the caller (or passed
 *     directly for tests).
 */

import type { Theme } from '../../../constants/themes';
import { captureException } from '../../../utils/sentry';
import {
	ensureLanguage,
	getHighlighter,
	resolveLanguageSync,
	themeNameForMode,
} from '../../../utils/shiki/highlighterManager';

/** Marker attribute placed on highlighted `<code>` elements (idempotency). */
export const HIGHLIGHTED_ATTR = 'data-shiki-highlighted';

export interface LazyShikiObserverHandle {
	/** Start observing matching elements inside `root`. */
	observe(root: HTMLElement): void;
	/** Disconnect the IntersectionObserver and drop the Shiki promise. */
	disconnect(): void;
}

export interface LazyShikiObserverOptions {
	theme: Theme;
	/**
	 * CSS selector that matches the `<code>` elements to highlight. Both
	 * current consumers use `'pre > code[class*="language-"]'`, but the
	 * parameter is kept generic so a future tier with a different DOM shape
	 * can plug in without rewriting the factory.
	 */
	selector?: string;
	/**
	 * Component label used when reporting errors to Sentry. Lets us tell the
	 * markdown vs text tier apart in field data.
	 */
	componentName: string;
}

const DEFAULT_SELECTOR = 'pre > code[class*="language-"]';

/**
 * Create a lazy-Shiki highlighter bound to a theme + selector. Returns an
 * imperative handle the React shell calls from a lifecycle effect.
 */
export function createLazyShikiObserver(
	options: LazyShikiObserverOptions
): LazyShikiObserverHandle {
	const themeName = themeNameForMode(options.theme.mode);
	const selector = options.selector ?? DEFAULT_SELECTOR;
	const componentName = options.componentName;

	let observer: IntersectionObserver | null = null;

	const highlight = async (el: HTMLElement): Promise<void> => {
		if (el.getAttribute(HIGHLIGHTED_ATTR) === 'true') return;
		// Mark up-front so concurrent observers don't double-highlight.
		el.setAttribute(HIGHLIGHTED_ATTR, 'true');

		const rawLang = extractFenceLang(el);
		// Fast path: keep the legacy "preloaded only" behaviour to avoid pulling
		// extra language grammars in the file-preview hot path.
		const lang = resolveLanguageSync(rawLang);
		if (!lang) return;

		const code = el.textContent ?? '';
		if (!code.trim()) return;

		try {
			const hl = await getHighlighter();
			const resolved = await ensureLanguage(hl, lang);
			if (!resolved) return;
			const html = hl.codeToHtml(code, { lang: resolved, theme: themeName });
			el.innerHTML = stripShikiWrapper(html);
		} catch (err) {
			// Unknown language or runtime error - fall back to the existing
			// plain-text rendering and clear the marker so a future observation
			// can retry. Report so we hear about real Shiki regressions.
			el.removeAttribute(HIGHLIGHTED_ATTR);
			captureException(err, {
				extra: { component: componentName, lang, themeName },
			});
		}
	};

	const onIntersect: IntersectionObserverCallback = (entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const code = entry.target as HTMLElement;
			observer?.unobserve(code);
			void highlight(code);
		}
	};

	return {
		observe(root) {
			if (typeof IntersectionObserver === 'undefined') return;
			if (!observer) {
				try {
					observer = new IntersectionObserver(onIntersect, { rootMargin: '200px' });
				} catch (err) {
					// Test environments may stub IntersectionObserver as a non-
					// constructable mock; degrade gracefully. Only report when
					// the message isn't the classic stub error.
					const msg = err instanceof Error ? err.message : '';
					if (!msg.includes('not a constructor')) {
						captureException(err, {
							extra: { component: componentName, stage: 'IntersectionObserver' },
						});
					}
					return;
				}
			}
			for (const code of selectElements(root, selector)) {
				observer.observe(code);
			}
		},
		disconnect() {
			observer?.disconnect();
			observer = null;
		},
	};
}

function selectElements(root: HTMLElement, selector: string): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
		(el) => el.getAttribute(HIGHLIGHTED_ATTR) !== 'true'
	);
}

function extractFenceLang(el: HTMLElement): string | null {
	const className = el.getAttribute('class') ?? '';
	const match = /\blanguage-([\w+\-#]+)/.exec(className);
	return match ? match[1] : null;
}

function stripShikiWrapper(html: string): string {
	const match = /<code[^>]*>([\s\S]*)<\/code>/.exec(html);
	return match ? match[1] : html;
}
