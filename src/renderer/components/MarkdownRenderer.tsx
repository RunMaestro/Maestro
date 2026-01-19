import React, { memo, useMemo, useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Clipboard, Loader2, ImageOff } from 'lucide-react';
import type { Theme } from '../types';
import type { FileNode } from '../types/fileTree';
import { remarkFileLinks, buildFileTreeIndices } from '../utils/remarkFileLinks';
import remarkFrontmatter from 'remark-frontmatter';
import { remarkFrontmatterTable } from '../utils/remarkFrontmatterTable';

// ============================================================================
// LocalImage - Loads local images via IPC
// ============================================================================

// Module-level cache for local images to prevent flicker on re-render
const localImageCache = new Map<string, string>();

interface LocalImageProps {
	src?: string;
	alt?: string;
	theme: Theme;
	width?: number; // Optional width in pixels (from ![[image|300]] syntax)
	sshRemoteId?: string; // SSH remote ID for remote file operations
}

// Helper to compute initial image state synchronously from cache
// This prevents flickering when ReactMarkdown rebuilds the component tree
function getLocalImageInitialState(src: string | undefined) {
	if (!src) {
		return { dataUrl: null, loading: false };
	}

	// Data URLs are ready immediately
	if (src.startsWith('data:')) {
		return { dataUrl: src, loading: false };
	}

	// HTTP URLs are ready immediately (browser handles loading)
	if (src.startsWith('http://') || src.startsWith('https://')) {
		return { dataUrl: src, loading: false };
	}

	// Check cache for file paths
	let filePath = src;
	if (src.startsWith('file://')) {
		filePath = decodeURIComponent(src.replace('file://', ''));
	}

	if (localImageCache.has(filePath)) {
		return { dataUrl: localImageCache.get(filePath)!, loading: false };
	}

	// Need to load
	return { dataUrl: null, loading: true };
}

const LocalImage = memo(({ src, alt, theme, width, sshRemoteId }: LocalImageProps) => {
	// Compute initial state synchronously from cache to prevent flicker
	const initialState = useMemo(() => getLocalImageInitialState(src), [src]);

	const [dataUrl, setDataUrl] = useState<string | null>(initialState.dataUrl);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(initialState.loading);

	useEffect(() => {
		// If we already have data from cache, skip loading
		if (initialState.dataUrl) {
			return;
		}

		let isStale = false;

		if (!src) {
			setLoading(false);
			return;
		}

		// For file:// URLs, extract the path and load via IPC
		let filePath = src;
		if (src.startsWith('file://')) {
			filePath = decodeURIComponent(src.replace('file://', ''));
		}

		// Double-check cache
		if (localImageCache.has(filePath)) {
			setDataUrl(localImageCache.get(filePath)!);
			setLoading(false);
			return;
		}

		window.maestro.fs
			.readFile(filePath, sshRemoteId)
			.then((result) => {
				if (isStale) return;
				if (result.startsWith('data:')) {
					localImageCache.set(filePath, result);
					setDataUrl(result);
				} else {
					setError('Invalid image data');
				}
				setLoading(false);
			})
			.catch((err) => {
				if (isStale) return;
				setError(`Failed to load image: ${err.message || 'Unknown error'}`);
				setLoading(false);
			});

		return () => {
			isStale = true;
		};
	}, [src, sshRemoteId, initialState.dataUrl]);

	if (loading) {
		return (
			<span
				className="inline-flex items-center gap-2 px-3 py-2 rounded"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.textDim }} />
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Loading image...
				</span>
			</span>
		);
	}

	if (error) {
		return (
			<span
				className="inline-flex items-center gap-2 px-3 py-2 rounded text-xs"
				style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				title={error}
			>
				<ImageOff className="w-4 h-4" />
				<span>{alt || 'Image'}</span>
			</span>
		);
	}

	if (!dataUrl) {
		return null;
	}

	// Build style based on whether width is specified
	const imageStyle: React.CSSProperties = width
		? { width: `${width}px`, height: 'auto', borderRadius: '4px' }
		: { maxWidth: '100%', height: 'auto', borderRadius: '4px' };

	return <img src={dataUrl} alt={alt || ''} style={imageStyle} />;
});

LocalImage.displayName = 'LocalImage';

// ============================================================================
// CodeBlockWithCopy - Code block with copy button overlay
// ============================================================================

interface CodeBlockWithCopyProps {
	language: string;
	codeContent: string;
	theme: Theme;
	onCopy: (text: string) => void;
}

const CodeBlockWithCopy = memo(
	({ language, codeContent, theme, onCopy }: CodeBlockWithCopyProps) => {
		return (
			<div className="relative group/codeblock">
				<button
					onClick={() => onCopy(codeContent)}
					className="absolute bottom-2 right-2 p-1.5 rounded opacity-0 group-hover/codeblock:opacity-70 hover:!opacity-100 transition-opacity z-10"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textDim,
						border: `1px solid ${theme.colors.border}`,
					}}
					title="Copy code"
				>
					<Clipboard className="w-3.5 h-3.5" />
				</button>
				<SyntaxHighlighter
					language={language}
					style={vscDarkPlus}
					customStyle={{
						margin: '0.5em 0',
						padding: '1em',
						background: theme.colors.bgSidebar,
						fontSize: '0.9em',
						borderRadius: '6px',
					}}
					PreTag="div"
				>
					{codeContent}
				</SyntaxHighlighter>
			</div>
		);
	}
);

CodeBlockWithCopy.displayName = 'CodeBlockWithCopy';

// ============================================================================
// MarkdownRenderer - Unified markdown rendering component for AI responses
// ============================================================================

interface MarkdownRendererProps {
	/** The markdown content to render */
	content: string;
	/** The current theme */
	theme: Theme;
	/** Callback to copy text to clipboard */
	onCopy: (text: string) => void;
	/** Optional additional className for the container */
	className?: string;
	/** File tree for linking file references */
	fileTree?: FileNode[];
	/** Current working directory for proximity-based matching */
	cwd?: string;
	/** Project root absolute path - used to convert absolute paths to relative */
	projectRoot?: string;
	/** Callback when a file link is clicked */
	onFileClick?: (path: string) => void;
	/** Allow raw HTML passthrough via rehype-raw (may break GFM table rendering) */
	allowRawHtml?: boolean;
	/** SSH remote ID for remote file operations */
	sshRemoteId?: string;
}

/**
 * MarkdownRenderer provides consistent markdown rendering across the application.
 *
 * Features:
 * - GitHub Flavored Markdown support (tables, strikethrough, task lists, etc.)
 * - Syntax highlighted code blocks with copy button
 * - External link handling (opens in browser)
 * - Theme-aware styling
 *
 * Note: Prose styles are injected at the TerminalOutput container level for performance.
 * This component assumes those styles are already present in a parent container.
 */
export const MarkdownRenderer = memo(
	({
		content,
		theme,
		onCopy,
		className = '',
		fileTree,
		cwd,
		projectRoot,
		onFileClick,
		allowRawHtml = false,
		sshRemoteId,
	}: MarkdownRendererProps) => {
		// Memoize file tree indices to avoid O(n) traversal on every render
		// Only rebuild when fileTree reference changes
		const fileTreeIndices = useMemo(() => {
			if (fileTree && fileTree.length > 0) {
				return buildFileTreeIndices(fileTree);
			}
			return null;
		}, [fileTree]);

		// Memoize remark plugins to avoid recreating on every render
		const remarkPlugins = useMemo(() => {
			const plugins: any[] = [remarkGfm, remarkFrontmatter, remarkFrontmatterTable];
			// Add remarkFileLinks if we have file tree for relative paths,
			// OR if we have projectRoot for absolute paths (even with empty file tree)
			if ((fileTree && fileTree.length > 0 && cwd !== undefined) || projectRoot) {
				plugins.push([
					remarkFileLinks,
					{ indices: fileTreeIndices || undefined, cwd: cwd || '', projectRoot },
				]);
			}
			return plugins;
		}, [fileTree, fileTreeIndices, cwd, projectRoot]);

		return (
			<div
				className={`prose prose-sm max-w-none text-sm ${className}`}
				style={{ color: theme.colors.textMain, lineHeight: 1.4, paddingLeft: '0.5em' }}
			>
				<ReactMarkdown
					remarkPlugins={remarkPlugins}
					rehypePlugins={allowRawHtml ? [rehypeRaw] : undefined}
					components={{
						a: ({ node: _node, href, children, ...props }) => {
							// Check for maestro-file:// protocol OR data-maestro-file attribute
							// (data attribute is fallback when rehype strips custom protocols)
							const dataFilePath = (props as any)['data-maestro-file'];
							const isMaestroFile = href?.startsWith('maestro-file://') || !!dataFilePath;
							const filePath =
								dataFilePath ||
								(href?.startsWith('maestro-file://') ? href.replace('maestro-file://', '') : null);

							return (
								<a
									href={href}
									{...props}
									onClick={(e) => {
										e.preventDefault();
										if (isMaestroFile && filePath && onFileClick) {
											onFileClick(filePath);
										} else if (href) {
											window.maestro.shell.openExternal(href);
										}
									}}
									style={{
										color: theme.colors.accent,
										textDecoration: 'underline',
										cursor: 'pointer',
									}}
								>
									{children}
								</a>
							);
						},
						code: ({ node: _node, inline, className, children, ...props }: any) => {
							const match = (className || '').match(/language-(\w+)/);
							const language = match ? match[1] : 'text';
							const codeContent = String(children).replace(/\n$/, '');

							return !inline && match ? (
								<CodeBlockWithCopy
									language={language}
									codeContent={codeContent}
									theme={theme}
									onCopy={onCopy}
								/>
							) : (
								<code className={className} {...props}>
									{children}
								</code>
							);
						},
						img: ({ node: _node, src, alt, ...props }: any) => {
							// Use LocalImage component to handle file:// URLs via IPC
							// Extract width from data-maestro-width attribute if present
							const widthStr = props['data-maestro-width'];
							const width = widthStr ? parseInt(widthStr, 10) : undefined;

							return (
								<LocalImage
									src={src}
									alt={alt}
									theme={theme}
									width={width}
									sshRemoteId={sshRemoteId}
								/>
							);
						},
						table: ({ node: _node, style, ...props }: any) => (
							<div className="overflow-x-auto scrollbar-thin" style={{ maxWidth: '100%' }}>
								<table
									{...props}
									style={{
										minWidth: '100%',
										borderCollapse: 'collapse',
										...(style || {}),
									}}
								/>
							</div>
						),
						th: ({ node: _node, style, ...props }: any) => (
							<th
								{...props}
								style={{
									padding: '8px 12px',
									textAlign: 'left',
									borderBottom: `1px solid ${theme.colors.border}`,
									whiteSpace: 'nowrap',
									...(style || {}),
								}}
							/>
						),
						td: ({ node: _node, style, ...props }: any) => (
							<td
								{...props}
								style={{
									padding: '8px 12px',
									borderBottom: `1px solid ${theme.colors.border}`,
									wordWrap: 'break-word',
									overflowWrap: 'break-word',
									whiteSpace: 'normal',
									verticalAlign: 'top',
									...(style || {}),
								}}
							/>
						),
					}}
				>
					{content}
				</ReactMarkdown>
			</div>
		);
	}
);

MarkdownRenderer.displayName = 'MarkdownRenderer';

// Also export CodeBlockWithCopy for cases where only the code block is needed
export { CodeBlockWithCopy };
export type { CodeBlockWithCopyProps, MarkdownRendererProps };
