import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { buildBlocks } from './pipeline';
import { sanitizeBlock } from './sanitize';
import { resolveLinkAction } from './linkRouter';
import { FAST_BLOCK_CLASS, generateProseCss } from './proseStyles';
import type { MarkdownBlock, MarkdownPreviewFastProps } from './types';

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
export const MarkdownPreviewFast: React.FC<MarkdownPreviewFastProps> = ({
	content,
	theme,
	markdownContainerRef,
	onFileClick,
	onExternalLinkClick,
}) => {
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [blocks, setBlocks] = useState<MarkdownBlock[]>([]);

	// Parse pipeline. Defers large parses so the first frame paints a skeleton
	// rather than blocking input.
	useEffect(() => {
		let cancelled = false;

		if (content.length < SYNC_PARSE_BYTES) {
			const parsed = buildBlocks(content);
			if (!cancelled) setBlocks(parsed);
			return () => {
				cancelled = true;
			};
		}

		setBlocks([]);
		const handle = setTimeout(() => {
			if (cancelled) return;
			const parsed = buildBlocks(content);
			if (!cancelled) setBlocks(parsed);
		}, 0);

		return () => {
			cancelled = true;
			clearTimeout(handle);
		};
	}, [content]);

	// Sanitize lazily per-block so blocks the user never scrolls to don't pay
	// the cost.
	const renderBlock = useCallback((_index: number, block: MarkdownBlock) => {
		return (
			<div
				className={FAST_BLOCK_CLASS}
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

	return (
		<div
			ref={setContainer}
			className="file-preview-content"
			style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
			onClick={onClick}
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
		</div>
	);
};

export default MarkdownPreviewFast;
