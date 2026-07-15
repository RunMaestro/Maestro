import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { paginate, DEFAULT_LINES_PER_PAGE } from './pagination';
import { createTextCodeHighlighter } from './codeHighlighter';
import { findTextHits } from './searchHits';
import { buildRangeAtOffset, scrollRangeIntoView } from '../search/scrollToOffset';
import {
	TEXT_PAGE_CLASS,
	TEXT_PAGE_GUTTER_CLASS,
	TEXT_PAGE_CONTENT_CLASS,
	generateTextProseCss,
} from './proseStyles';
import type { TextPage, TextPreviewFastHandle, TextPreviewFastProps } from './types';

/** Threshold above which parse is deferred to a macrotask so the first frame
 * can paint a skeleton rather than blocking input. */
const SYNC_PARSE_BYTES = 64 * 1024;

/** Approximate per-page rendered height in CSS pixels. Each page is
 * `DEFAULT_LINES_PER_PAGE` lines × 13px font × 1.6 line-height. Fixed-size
 * virtualization means we don't need real measurement. */
const PAGE_HEIGHT_PX = Math.ceil(DEFAULT_LINES_PER_PAGE * 13 * 1.6);

/** Pixels of overscan above/below the viewport - TanStack Virtual unit is
 * items, not pixels. With ~1280px-tall pages, 1 item ≈ a full page; 1 is
 * usually enough to hide the next-page mount flash. */
const OVERSCAN_PAGES = 1;

/** A language is treated as "code" (Shiki-eligible) when it isn't plain text
 * or markdown. We mirror the existing language detection used by
 * `getLanguageFromFilename`, so this stays in sync with file-type routing. */
function isCodeLanguage(language: string): boolean {
	return language !== 'text' && language !== 'markdown';
}

function escapeHtmlForPre(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Fast tier preview for plain text and code files. Virtualizes the document
 * into 80-line pages via TanStack Virtual; lazy Shiki upgrades visible code
 * pages from plain text to highlighted output on intersection.
 *
 * Thin React shell - all non-React concerns live in sibling modules
 * (pagination, codeHighlighter, searchHits, proseStyles).
 */
export const TextPreviewFast = forwardRef<TextPreviewFastHandle, TextPreviewFastProps>(
	function TextPreviewFast({ content, language, theme, containerRef, filePath: _filePath }, ref) {
		const isCode = isCodeLanguage(language);
		const scrollRef = useRef<HTMLDivElement | null>(null);
		const [pages, setPages] = useState<TextPage[]>([]);

		// Keep refs to the latest values so the imperative handle's closures
		// (which we want stable across renders) can read fresh data.
		const pagesRef = useRef<TextPage[]>([]);
		pagesRef.current = pages;
		const contentRef = useRef(content);
		contentRef.current = content;

		// Parse pipeline. Defer large parses so the first frame paints a skeleton
		// rather than blocking input.
		useEffect(() => {
			let cancelled = false;
			if (content.length < SYNC_PARSE_BYTES) {
				const parsed = paginate(content);
				if (!cancelled) setPages(parsed);
				return () => {
					cancelled = true;
				};
			}

			setPages([]);
			const handle = setTimeout(() => {
				if (cancelled) return;
				const parsed = paginate(content);
				if (!cancelled) setPages(parsed);
			}, 0);
			return () => {
				cancelled = true;
				clearTimeout(handle);
			};
		}, [content]);

		const virtualizer = useVirtualizer({
			count: pages.length,
			getScrollElement: () => scrollRef.current,
			estimateSize: () => PAGE_HEIGHT_PX,
			overscan: OVERSCAN_PAGES,
		});

		// Lazy Shiki for code pages only. Plain-text Fast tier never loads Shiki.
		useEffect(() => {
			if (!isCode) return;
			const root = scrollRef.current;
			if (!root) return;
			const highlighter = createTextCodeHighlighter({ theme });
			highlighter.observe(root);
			const rafId = requestAnimationFrame(() => highlighter.observe(root));
			return () => {
				cancelAnimationFrame(rafId);
				highlighter.disconnect();
			};
		}, [theme, pages, isCode]);

		useImperativeHandle(
			ref,
			() => ({
				getPageCount: () => pagesRef.current.length,
				findInContent: (query: string, options) =>
					findTextHits(contentRef.current, query, pagesRef.current, options),
				scrollToMatch: (hit) => {
					// Defensive: same-render race between the count effect's
					// setCurrentMatchIndex(0) and the navigate effect's dispatch
					// can pass undefined when a new query shrinks the hits array.
					if (!hit) return;
					const idx = hit.blockIndex;
					if (idx < 0 || idx >= pagesRef.current.length) return;
					virtualizer.scrollToIndex(idx, { align: 'center' });
					// Post-scroll precision: walk text nodes inside the matched
					// page's content element (skipping the line-number gutter) so
					// the matched word - not just the page top - comes into view.
					requestAnimationFrame(() => {
						const root = scrollRef.current;
						if (!root) return;
						const targetPage = root.querySelector<HTMLElement>(`[data-virtual-page="${idx}"]`);
						if (!targetPage) return;
						const contentEl = targetPage.querySelector<HTMLElement>(`.${TEXT_PAGE_CONTENT_CLASS}`);
						if (!contentEl) return;
						const range = buildRangeAtOffset(contentEl, hit.offsetWithinBlock, hit.length);
						scrollRangeIntoView(range);
					});
				},
				// Fixed-size virtualization (every page is PAGE_HEIGHT_PX tall, holding
				// up to DEFAULT_LINES_PER_PAGE lines) makes the line ⇄ pixel mapping a
				// constant multiply - no per-line measurement needed.
				getTopLine: () => {
					const root = scrollRef.current;
					if (!root) return 1;
					const lineHeight = PAGE_HEIGHT_PX / DEFAULT_LINES_PER_PAGE;
					const pageList = pagesRef.current;
					const total = pageList.length ? pageList[pageList.length - 1].endLine : 1;
					const line = Math.floor(root.scrollTop / lineHeight) + 1;
					return Math.min(Math.max(1, line), Math.max(1, total));
				},
				scrollToLine: (line: number) => {
					const root = scrollRef.current;
					if (!root) return;
					const lineHeight = PAGE_HEIGHT_PX / DEFAULT_LINES_PER_PAGE;
					root.scrollTop = Math.max(0, (line - 1) * lineHeight);
				},
			}),
			[virtualizer]
		);

		// Bridge the scroll container to the parent's containerRef so the
		// existing search hook + scroll-to-boundary code can target it.
		const setContainer = useCallback(
			(el: HTMLDivElement | null) => {
				scrollRef.current = el;
				if (containerRef) containerRef.current = el;
			},
			[containerRef]
		);

		const proseCss = useMemo(() => generateTextProseCss(theme), [theme]);

		// Pre-compute the gutter contents per page once per parse - line
		// numbers are stable so we don't need to do this in render.
		const pageGutter = useCallback((page: TextPage) => {
			const numbers: string[] = [];
			for (let n = page.startLine; n < page.endLine; n++) {
				numbers.push(String(n + 1));
			}
			return numbers.join('\n');
		}, []);

		const renderPage = (page: TextPage) => {
			const text = page.lines.join('\n');
			if (isCode) {
				// Code pages render with a `language-X` class so the lazy Shiki
				// observer upgrades the inner HTML on intersection. Until then,
				// the escaped raw text is what the user sees.
				return (
					<>
						<div className={TEXT_PAGE_GUTTER_CLASS}>{pageGutter(page)}</div>
						<div className={TEXT_PAGE_CONTENT_CLASS}>
							<pre>
								<code
									className={`language-${language}`}
									dangerouslySetInnerHTML={{ __html: escapeHtmlForPre(text) }}
								/>
							</pre>
						</div>
					</>
				);
			}
			return (
				<>
					<div className={TEXT_PAGE_GUTTER_CLASS}>{pageGutter(page)}</div>
					<div className={TEXT_PAGE_CONTENT_CLASS}>{text}</div>
				</>
			);
		};

		const totalSize = virtualizer.getTotalSize();
		const virtualItems = virtualizer.getVirtualItems();

		return (
			<div
				ref={setContainer}
				className="file-preview-content text-fast-root"
				data-testid="text-fast-root"
				style={{ height: '100%', overflow: 'auto', position: 'relative' }}
			>
				<style>{proseCss}</style>
				{pages.length === 0 ? (
					<div
						data-testid="text-fast-skeleton"
						style={{ padding: '24px', color: theme.colors.textDim, fontSize: '13px' }}
					>
						Parsing large file…
					</div>
				) : (
					<div style={{ height: `${totalSize}px`, width: '100%', position: 'relative' }}>
						{virtualItems.map((item) => {
							const page = pages[item.index];
							return (
								<div
									key={page.id}
									data-virtual-page={item.index}
									className={TEXT_PAGE_CLASS}
									style={{
										position: 'absolute',
										top: 0,
										left: 0,
										width: '100%',
										transform: `translateY(${item.start}px)`,
										height: `${PAGE_HEIGHT_PX}px`,
									}}
								>
									{renderPage(page)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		);
	}
);

export default TextPreviewFast;
