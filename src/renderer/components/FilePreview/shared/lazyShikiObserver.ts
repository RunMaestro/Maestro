/**
 * Shared lazy-Shiki highlighter factory used by every FilePreview tier that
 * renders source code inside virtualized blocks/pages (markdown Fast tier
 * code fences, text Fast tier code pages).
 *
 * Why one factory:
 *   The markdown and text Fast tiers used to ship near-identical highlighters
 *   in their own modules. The Phase 3 plan called the dedup out explicitly,
 *   and our CI flake fixes had to touch both files for the same root cause —
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
 *   - `selector` — different tiers attach the highlighter to different DOM
 *     shapes.
 *   - `componentName` — used in `captureException.extra.component` so Sentry
 *     reports stay traceable to the tier that produced them.
 *   - `themeName` — derived from the Theme.mode by the caller (or passed
 *     directly for tests).
 *
 * Pure separation: this module owns Shiki + IntersectionObserver. Tier shells
 * pass an HTMLElement root and forward the imperative handle to React.
 */

import type { Theme } from '../../../constants/themes';
import { captureException } from '../../../utils/sentry';

type ShikiModule = typeof import('shiki');
type Highlighter = Awaited<ReturnType<ShikiModule['createHighlighter']>>;

/** Languages we eagerly load. Others fall through to plain rendering. */
const SUPPORTED_LANGUAGES = [
	'javascript',
	'typescript',
	'tsx',
	'jsx',
	'json',
	'python',
	'bash',
	'shell',
	'sh',
	'html',
	'css',
	'scss',
	'markdown',
	'md',
	'yaml',
	'yml',
	'rust',
	'go',
	'java',
	'c',
	'cpp',
	'sql',
	'xml',
] as const;

type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Aliases commonly used in markdown fences (`ts`, `js`, `py`, `zsh`). */
const LANGUAGE_ALIASES: Record<string, SupportedLanguage> = {
	ts: 'typescript',
	js: 'javascript',
	py: 'python',
	zsh: 'bash',
};

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

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
	const themeName = options.theme.mode === 'light' ? LIGHT_THEME : DARK_THEME;
	const selector = options.selector ?? DEFAULT_SELECTOR;
	const componentName = options.componentName;

	let observer: IntersectionObserver | null = null;
	let highlighterPromise: Promise<Highlighter> | null = null;

	const ensureHighlighter = async (): Promise<Highlighter> => {
		if (highlighterPromise) return highlighterPromise;
		highlighterPromise = (async () => {
			const shiki = await import('shiki');
			return shiki.createHighlighter({
				themes: [LIGHT_THEME, DARK_THEME],
				langs: [...SUPPORTED_LANGUAGES],
			});
		})();
		return highlighterPromise;
	};

	const highlight = async (el: HTMLElement): Promise<void> => {
		if (el.getAttribute(HIGHLIGHTED_ATTR) === 'true') return;
		// Mark up-front so concurrent observers don't double-highlight.
		el.setAttribute(HIGHLIGHTED_ATTR, 'true');

		const lang = detectLanguage(el);
		if (!lang) return;

		const code = el.textContent ?? '';
		if (!code.trim()) return;

		try {
			const hl = await ensureHighlighter();
			const html = hl.codeToHtml(code, { lang, theme: themeName });
			el.innerHTML = stripShikiWrapper(html);
		} catch (err) {
			// Unknown language or runtime error — fall back to the existing
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
			highlighterPromise = null;
		},
	};
}

function selectElements(root: HTMLElement, selector: string): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
		(el) => el.getAttribute(HIGHLIGHTED_ATTR) !== 'true'
	);
}

function detectLanguage(el: HTMLElement): SupportedLanguage | null {
	const className = el.getAttribute('class') ?? '';
	const match = /\blanguage-([\w+\-#]+)/.exec(className);
	if (!match) return null;
	const lang = match[1].toLowerCase();
	if ((SUPPORTED_LANGUAGES as readonly string[]).includes(lang)) {
		return lang as SupportedLanguage;
	}
	if (LANGUAGE_ALIASES[lang]) {
		return LANGUAGE_ALIASES[lang];
	}
	return null;
}

function stripShikiWrapper(html: string): string {
	const match = /<code[^>]*>([\s\S]*)<\/code>/.exec(html);
	return match ? match[1] : html;
}
