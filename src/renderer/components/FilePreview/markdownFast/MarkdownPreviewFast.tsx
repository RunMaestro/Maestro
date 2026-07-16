import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { buildBlocks } from './pipeline';
import { sanitizeBlock } from './sanitize';
import { resolveLinkAction } from './linkRouter';
import { openMaestroLink } from '../../../utils/openMaestroLink';
import { createCodeHighlighter } from './codeHighlighter';
import { createMermaidRenderer } from './mermaidRenderer';
import { findHits } from './searchHits';
import { buildRangeAtOffset, scrollRangeIntoView } from '../search/scrollToOffset';
import { FAST_BLOCK_CLASS, generateProseCss } from './proseStyles';
import { SvgContextMenu } from '../../SvgContextMenu';
import { useSvgContextMenu } from '../../../hooks/ui/useSvgContextMenu';
import type { MarkdownBlock, MarkdownPreviewFastHandle, MarkdownPreviewFastProps } from './types';

/**
 * Threshold above which parsing is deferred to a microtask so the first frame
 * can paint a "Parsing…" skeleton instead of blocking input. Below this size
 * the parse completes synchronously and the document appears instantly.
 */
const SYNC_PARSE_BYTES = 64 * 1024;

/** Pixels above/below the viewport to keep mounted as a render buffer. */
const VIRTUOSO_OVERSCAN_PX = 600;

/**
 * Fast tier markdown preview: virtualized, sanitized HTML rendering of
 * markdown documents too large for the Rich tier's full React render.
 *
 * This component is intentionally a thin shell. All non-React concerns live
 * in sibling modules (pipeline, sanitize, linkRouter, proseStyles) and are
 * separately testable.
 */
export const MarkdownPreviewFast = forwardRef<MarkdownPreviewFastHandle, MarkdownPreviewFastProps>(
	function MarkdownPreviewFast(
		{
			content,
			theme,
			markdownContainerRef,
			fileTreeIndices,
			cwd,
			homeDir,
			projectRoot,
			onFileClick,
			onExternalLinkClick,
		},
		ref
	) {
		const virtuosoRef = useRef<VirtuosoHandle>(null);
		const containerRef = useRef<HTMLDivElement | null>(null);
		const [blocks, setBlocks] = useState<MarkdownBlock[]>([]);
		const blocksRef = useRef<MarkdownBlock[]>([]);
		blocksRef.current = blocks;

		// Imperative handle exposed to the parent FilePreview. Drives TOC scroll
		// and Cmd+F search navigation in the Fast tier. Stable across renders
		// thanks to the refs (blocksRef, contentRef) it closes over.
		const contentRef = useRef(content);
		contentRef.current = content;
		useImperativeHandle(
			ref,
			() => ({
				scrollToHeading: (slug: string) => {
					const idx = blocksRef.current.findIndex((b) => b.headingSlug === slug);
					if (idx === -1) return false;
					virtuosoRef.current?.scrollToIndex({ index: idx, align: 'start', behavior: 'auto' });
					return true;
				},
				findInContent: (query: string) => {
					const blockRanges = blocksRef.current
						.filter(
							(b): b is typeof b & { sourceStart: number; sourceEnd: number } =>
								b.sourceStart !== undefined && b.sourceEnd !== undefined
						)
						.map((b) => ({ start: b.sourceStart, end: b.sourceEnd }));
					return findHits(contentRef.current, query, blockRanges);
				},
				scrollToMatch: (hit) => {
					// Defensive: an out-of-range index in useFilePreviewSearch can
					// occasionally pass undefined here during the same-render race
					// between count-effect setState and navigate-effect dispatch.
					if (!hit || hit.blockIndex < 0 || hit.blockIndex >= blocksRef.current.length) {
						return;
					}
					virtuosoRef.current?.scrollToIndex({
						index: hit.blockIndex,
						align: 'center',
						behavior: 'auto',
					});
					// After the virtualizer mounts the target block, walk the block's
					// text nodes to find the exact match offset and nudge it into
					// view. Virtuoso updates the DOM in a layout-effect; rAF runs
					// after that paint cycle, so the block is mounted by the time
					// we query for it.
					requestAnimationFrame(() => {
						const root = containerRef.current;
						if (!root) return;
						const blockEls = root.querySelectorAll<HTMLElement>(`.${FAST_BLOCK_CLASS}`);
						// Virtuoso renders only the visible window. The block at the
						// matched index is the one we just scrolled to; it should now
						// be present. If not (rare race), bail - the block-level
						// scroll already landed the user close enough.
						const targetBlock = Array.from(blockEls).find(
							(el) => el.getAttribute('data-block-index') === String(hit.blockIndex)
						);
						if (!targetBlock) return;
						const range = buildRangeAtOffset(targetBlock, hit.offsetWithinBlock, hit.length);
						scrollRangeIntoView(range);
					});
				},
			}),
			[]
		);

		// File-link config bundled once so the parse effect's dependency list
		// stays stable across renders (caller already memoizes fileTreeIndices).
		const fileLinksOptions = useMemo(
			() => ({
				indices: fileTreeIndices ?? undefined,
				cwd,
				homeDir,
				projectRoot,
			}),
			[fileTreeIndices, cwd, homeDir, projectRoot]
		);

		// Parse pipeline. Defers large parses so the first frame paints a skeleton
		// rather than blocking input.
		useEffect(() => {
			let cancelled = false;

			if (content.length < SYNC_PARSE_BYTES) {
				const parsed = buildBlocks(content, { fileLinks: fileLinksOptions });
				if (!cancelled) setBlocks(parsed);
				return () => {
					cancelled = true;
				};
			}

			setBlocks([]);
			const handle = setTimeout(() => {
				if (cancelled) return;
				const parsed = buildBlocks(content, { fileLinks: fileLinksOptions });
				if (!cancelled) setBlocks(parsed);
			}, 0);

			return () => {
				cancelled = true;
				clearTimeout(handle);
			};
		}, [content, fileLinksOptions]);

		// Sanitize lazily per-block so blocks the user never scrolls to don't pay
		// the cost. `data-block-index` lets the imperative scrollToMatch helper
		// locate the matched block in the (sparse) Virtuoso-rendered DOM.
		const renderBlock = useCallback((index: number, block: MarkdownBlock) => {
			return (
				<div
					className={FAST_BLOCK_CLASS}
					data-block-index={index}
					dangerouslySetInnerHTML={{ __html: sanitizeBlock(block.html) }}
				/>
			);
		}, []);

		// Single delegated click handler at the scroll container. React listeners
		// do not reach into innerHTML, so all markdown links route through here.
		const onClick = useCallback(
			(event: React.MouseEvent<HTMLDivElement>) => {
				const anchor = (event.target as HTMLElement).closest('a') as HTMLAnchorElement | null;
				if (!anchor) return;

				const action = resolveLinkAction(
					{
						href: anchor.getAttribute('href') ?? '',
						dataMaestroFile: anchor.getAttribute('data-maestro-file'),
					},
					{
						metaKey: event.metaKey,
						ctrlKey: event.ctrlKey,
						button: event.button,
					}
				);

				switch (action.kind) {
					case 'maestro-file':
						event.preventDefault();
						onFileClick?.(action.path, { openInNewTab: action.openInNewTab });
						return;
					case 'maestro-deep-link':
						event.preventDefault();
						openMaestroLink(action.href);
						return;
					case 'external':
						event.preventDefault();
						onExternalLinkClick?.(action.href, { ctrlKey: action.openInNewTab });
						return;
					case 'anchor':
						// Anchor navigation requires heading slug ids which markdown-it does
						// not emit by default. Phase 2 will wire virtuoso.scrollToIndex
						// against the headings extracted by extractHeadings().
						return;
					case 'none':
						return;
				}
			},
			[onFileClick, onExternalLinkClick]
		);

		// Bridge our scroll container to the parent's markdownContainerRef so the
		// existing search and scroll-to-boundary hooks keep working without
		// modification.
		const setContainer = useCallback(
			(el: HTMLDivElement | null) => {
				containerRef.current = el;
				if (markdownContainerRef) {
					markdownContainerRef.current = el;
				}
			},
			[markdownContainerRef]
		);

		const proseCss = useMemo(() => generateProseCss(theme), [theme]);

		// Mermaid diagrams in this tier are injected imperatively into the scroll
		// root, so they get the same right-click Copy/Save menu as every other
		// SVG surface via the shared container handler.
		const { svgMenu, dismissSvgMenu, openSvgMenuFromContainer } = useSvgContextMenu();

		// Lazy code-block syntax highlighter: observes the scroll container and
		// fires Shiki on each code block as it scrolls into view. Disconnects on
		// unmount so we don't leak the IntersectionObserver or the Shiki bundle.
		useEffect(() => {
			const root = containerRef.current;
			if (!root) return;
			const highlighter = createCodeHighlighter({ theme });
			const mermaid = createMermaidRenderer({ theme });
			highlighter.observe(root);
			mermaid.observe(root);
			// Re-observe after the next paint - new Virtuoso items may have
			// mounted in the layout pass that just finished.
			const rafId = requestAnimationFrame(() => {
				highlighter.observe(root);
				mermaid.observe(root);
			});
			return () => {
				cancelAnimationFrame(rafId);
				highlighter.disconnect();
				mermaid.disconnect();
			};
		}, [theme, blocks]);

		return (
			<div
				ref={setContainer}
				className="file-preview-content"
				style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
				onClick={onClick}
				onContextMenu={openSvgMenuFromContainer}
			>
				<style>{proseCss}</style>
				{blocks.length === 0 ? (
					<div
						data-testid="markdown-fast-skeleton"
						style={{ padding: '24px', color: theme.colors.textDim, fontSize: '13px' }}
					>
						Parsing large markdown…
					</div>
				) : (
					<Virtuoso
						ref={virtuosoRef}
						data={blocks}
						itemContent={renderBlock}
						style={{ flex: 1, padding: '0 24px' }}
						increaseViewportBy={{ top: VIRTUOSO_OVERSCAN_PX, bottom: VIRTUOSO_OVERSCAN_PX }}
					/>
				)}
				{svgMenu && <SvgContextMenu menu={svgMenu} theme={theme} onDismiss={dismissSvgMenu} />}
			</div>
		);
	}
);

export default MarkdownPreviewFast;
