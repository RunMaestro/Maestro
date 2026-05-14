/**
 * Lazy Mermaid diagram rendering for the Fast tier.
 *
 * Mermaid diagrams are expensive to lay out and parse, so a 300k-line document
 * with 50 diagrams must not render them all up front. This module mirrors the
 * codeHighlighter pattern:
 *   1. Diagrams are emitted as `<pre><code class="language-mermaid">…</code></pre>`
 *      by markdown-it (no transformation at parse time).
 *   2. IntersectionObserver fires for each block as it scrolls into view.
 *   3. The first observation triggers `import('mermaid')` so the ~600 KB
 *      diagram library stays out of the main bundle.
 *   4. Each diagram is rendered exactly once; the resulting SVG replaces the
 *      `<pre>` wrapper.
 *
 * Pure separation: this module knows nothing about React. The component calls
 * `observe(container)` / `disconnect()` from a lifecycle effect.
 */

import type { Theme } from '../../../constants/themes';
import { captureException } from '../../../utils/sentry';

type MermaidModule = typeof import('mermaid');

/** Marker placed on rendered diagrams (idempotency). */
export const MERMAID_RENDERED_ATTR = 'data-mermaid-rendered';

export interface MermaidRendererHandle {
	/** Start observing `pre > code.language-mermaid` elements inside `root`. */
	observe(root: HTMLElement): void;
	/** Stop all observation. */
	disconnect(): void;
}

export interface MermaidRendererOptions {
	theme: Theme;
}

let nextRenderId = 0;

/**
 * Create a Mermaid renderer bound to a theme. Returns an imperative handle.
 *
 * Mermaid is initialized once per handle (different theme → different handle).
 * On each visible-block intersection we call `mermaid.render(id, source)`
 * which returns a Promise resolving to `{ svg, ...}`; we then swap the SVG
 * into the DOM in place of the original `<pre>`.
 */
export function createMermaidRenderer(options: MermaidRendererOptions): MermaidRendererHandle {
	const themeName = options.theme.mode === 'light' ? 'default' : 'dark';

	let observer: IntersectionObserver | null = null;
	let mermaidPromise: Promise<MermaidModule['default']> | null = null;

	const ensureMermaid = async (): Promise<MermaidModule['default']> => {
		if (mermaidPromise) return mermaidPromise;
		mermaidPromise = (async () => {
			const mod = await import('mermaid');
			const mermaid = mod.default;
			mermaid.initialize({
				startOnLoad: false,
				theme: themeName,
				securityLevel: 'strict',
			});
			return mermaid;
		})();
		return mermaidPromise;
	};

	const renderDiagram = async (codeEl: HTMLElement): Promise<void> => {
		if (codeEl.getAttribute(MERMAID_RENDERED_ATTR) === 'true') return;
		codeEl.setAttribute(MERMAID_RENDERED_ATTR, 'true');

		const source = (codeEl.textContent ?? '').trim();
		if (!source) return;

		// Replace the entire <pre> wrapper, not just the inner <code>: Mermaid
		// returns a complete SVG and our prose CSS gives `<pre>` a background
		// that looks wrong around a diagram.
		const wrapper = codeEl.closest('pre') ?? codeEl;

		try {
			const mermaid = await ensureMermaid();
			const id = `mermaid-fast-${++nextRenderId}`;
			// Mermaid runs with securityLevel: 'strict' (see ensureMermaid below)
			// so its own output is sanitized. Injection of the returned SVG via
			// innerHTML is the documented integration path.
			const { svg } = await mermaid.render(id, source);
			const container = document.createElement('div');
			container.className = 'markdown-fast-mermaid';
			container.innerHTML = svg;
			wrapper.replaceWith(container);
		} catch (err) {
			// Bad syntax in the diagram source is the common case and noisy by
			// design (the user pastes broken syntax, sees no diagram, edits, etc.).
			// We don't want to flood Sentry with those; only report when the
			// error doesn't look like a parse/syntax problem so real runtime
			// failures (e.g. dynamic import error) still surface.
			codeEl.removeAttribute(MERMAID_RENDERED_ATTR);
			const isLikelyParseError =
				err instanceof Error &&
				/parse|syntax|expecting/i.test(err.message + ' ' + (err.name ?? ''));
			if (!isLikelyParseError) {
				captureException(err, {
					extra: {
						component: 'markdownFast/mermaidRenderer',
						sourcePreview: source.slice(0, 100),
					},
				});
			}
		}
	};

	const onIntersect: IntersectionObserverCallback = (entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const target = entry.target as HTMLElement;
			observer?.unobserve(target);
			void renderDiagram(target);
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
								component: 'markdownFast/mermaidRenderer',
								stage: 'IntersectionObserver',
							},
						});
					}
					return;
				}
			}
			for (const code of selectMermaidElements(root)) {
				observer.observe(code);
			}
		},
		disconnect() {
			observer?.disconnect();
			observer = null;
		},
	};
}

function selectMermaidElements(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')).filter(
		(el) => el.getAttribute(MERMAID_RENDERED_ATTR) !== 'true'
	);
}
