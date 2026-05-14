/**
 * Lazy Shiki highlighting for Fast tier text pages.
 *
 * Mirrors the pattern in `markdownFast/codeHighlighter.ts` (separate module
 * because the selector and the "what to highlight" differ — markdown has
 * code FENCES inside larger blocks, text Fast tier has a whole code PAGE).
 * The two could share a base in the future; for now, keeping them separate
 * is the lower-risk choice given that markdownFast is already shipped and
 * its tests cover its exact selector contract.
 *
 * Strategy:
 *   1. Code pages render initially as `<pre><code class="language-X">…</code></pre>`.
 *   2. An IntersectionObserver fires for each visible page.
 *   3. First observation triggers a dynamic `import('shiki')` → ~60 KB gz of
 *      JS stays out of the main bundle until needed.
 *   4. Each page is highlighted exactly once; a `data-shiki-highlighted`
 *      marker prevents re-highlighting on re-scroll.
 */

import type { Theme } from '../../../constants/themes';
import { captureException } from '../../../utils/sentry';

type ShikiModule = typeof import('shiki');
type Highlighter = Awaited<ReturnType<ShikiModule['createHighlighter']>>;

/** Languages registered with Shiki by default. Keep in sync with the
 * markdown Fast tier's list so both tiers highlight the same set. */
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

const LANGUAGE_ALIASES: Record<string, SupportedLanguage> = {
	ts: 'typescript',
	js: 'javascript',
	py: 'python',
	zsh: 'bash',
};

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

export const HIGHLIGHTED_ATTR = 'data-shiki-highlighted';

export interface TextCodeHighlighterHandle {
	observe(root: HTMLElement): void;
	disconnect(): void;
}

export interface TextCodeHighlighterOptions {
	theme: Theme;
}

/**
 * Create a per-page code highlighter. Returns an imperative handle that the
 * React component plumbs in/out of a lifecycle effect.
 */
export function createTextCodeHighlighter(
	options: TextCodeHighlighterOptions
): TextCodeHighlighterHandle {
	const themeName = options.theme.mode === 'light' ? LIGHT_THEME : DARK_THEME;

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
				extra: { component: 'textFast/codeHighlighter', lang, themeName },
			});
		}
	};

	const onIntersect: IntersectionObserverCallback = (entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const target = entry.target as HTMLElement;
			observer?.unobserve(target);
			void highlight(target);
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
							extra: {
								component: 'textFast/codeHighlighter',
								stage: 'IntersectionObserver',
							},
						});
					}
					return;
				}
			}
			for (const code of selectCodeElements(root)) {
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

function selectCodeElements(root: HTMLElement): HTMLElement[] {
	// In textFast each code PAGE is a `<pre><code class="language-X">…</code></pre>`.
	// Same selector as the markdown tier — both render code in the same shape.
	return Array.from(root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')).filter(
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
