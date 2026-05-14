/**
 * Lazy syntax highlighting for code blocks inside the Fast tier preview.
 *
 * Highlighting strategy:
 *   1. Don't run Shiki at parse time — code blocks render as
 *      `<pre><code class="language-X">…</code></pre>` first.
 *   2. After Virtuoso mounts blocks, an IntersectionObserver fires for each
 *      `pre code[class*="language-"]` element that scrolls into view.
 *   3. The first observation triggers a dynamic `import('shiki')` so the
 *      30 KB+ highlighter never enters the main bundle for small files.
 *   4. Each code block is highlighted exactly once; already-highlighted blocks
 *      are tagged with `data-shiki-highlighted` so re-mounts don't re-run.
 *
 * Pure separation: this module owns the Shiki integration. The React component
 * only calls `observe(container)` / `disconnect()` from a lifecycle effect.
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

/**
 * Common aliases used in markdown code fences (e.g. ` ```ts `). Mapped to the
 * canonical language name we register with Shiki.
 */
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

export interface CodeHighlighterHandle {
	/** Start observing `<pre><code>` elements inside `root`. */
	observe(root: HTMLElement): void;
	/** Stop all observation and disconnect the IntersectionObserver. */
	disconnect(): void;
}

export interface CodeHighlighterOptions {
	theme: Theme;
}

/**
 * Create a code highlighter bound to a theme. Returns an imperative handle.
 *
 * Why imperative: the component scrolls Virtuoso, blocks mount and unmount on
 * their own schedule. An IntersectionObserver attached to the scroll container
 * is the cleanest fit; it survives mount/unmount cycles without re-binding per
 * element.
 */
export function createCodeHighlighter(options: CodeHighlighterOptions): CodeHighlighterHandle {
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
		// Mark up-front so concurrent observers don't double-highlight.
		el.setAttribute(HIGHLIGHTED_ATTR, 'true');

		const lang = detectLanguage(el);
		if (!lang) return;

		const code = el.textContent ?? '';
		if (!code.trim()) return;

		try {
			const hl = await ensureHighlighter();
			const html = hl.codeToHtml(code, { lang, theme: themeName });
			// Shiki emits a `<pre><code>` wrapper; we already have one, so unwrap
			// to keep DOM stable for prose CSS rules.
			const inner = stripShikiWrapper(html);
			el.innerHTML = inner;
		} catch (err) {
			// Unsupported language or runtime error — fall back to the existing
			// plain-text rendering and clear the marker so a future observation
			// can retry. Report so we hear about real Shiki regressions.
			el.removeAttribute(HIGHLIGHTED_ATTR);
			captureException(err, {
				extra: { component: 'markdownFast/codeHighlighter', lang, themeName },
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
					// constructable mock; degrade gracefully instead of crashing
					// the component. Only report when the message isn't the
					// classic "is not a constructor" — that one is the test
					// stub and would just spam Sentry.
					const msg = err instanceof Error ? err.message : '';
					if (!msg.includes('not a constructor')) {
						captureException(err, {
							extra: {
								component: 'markdownFast/codeHighlighter',
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

/**
 * Find unhighlighted `<code class="language-X">` descendants. Skips elements
 * already tagged so re-observing the container after a Virtuoso block remount
 * is cheap.
 */
function selectCodeElements(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')).filter(
		(el) => el.getAttribute(HIGHLIGHTED_ATTR) !== 'true'
	);
}

/**
 * Extract the supported language from a `class="language-X"` attribute. Returns
 * null when the language is not in our supported set (caller leaves the block
 * as plain text).
 */
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

/**
 * Shiki's codeToHtml returns `<pre class="shiki"><code>…</code></pre>`. We
 * already have a `<pre><code>` wrapper from markdown-it; extract just the
 * inner HTML so we don't end up with `<pre><code><pre><code>…`.
 */
function stripShikiWrapper(html: string): string {
	const match = /<code[^>]*>([\s\S]*)<\/code>/.exec(html);
	return match ? match[1] : html;
}
