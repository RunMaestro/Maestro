/**
 * MarkdownRenderer - chat-surface markdown renderer.
 *
 * This is now a thin wrapper around the unified <Markdown> component (chat
 * preset). The full implementation lives in components/Markdown/*. The wrapper
 * is preserved so the many existing import sites and tests keep working
 * unchanged.
 */

import { memo } from 'react';
import type { Theme } from '../types';
import type { FileNode } from '../types/fileTree';
import { Markdown } from './Markdown/Markdown';

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
	/** Allow raw HTML passthrough via rehype-raw (sanitized with DOMPurify for XSS protection) */
	allowRawHtml?: boolean;
	/** SSH remote ID for remote file operations */
	sshRemoteId?: string;
	/** Apply Bionify reading-mode emphasis to prose text only when explicitly enabled */
	enableBionifyReadingMode?: boolean;
	/** Visual intensity for Bionify emphasis */
	bionifyIntensity?: number;
	/** Algorithm string controlling Bionify highlight lengths */
	bionifyAlgorithm?: string;
	/**
	 * Treat single newlines as hard line breaks (chat-style rendering).
	 *
	 * Default CommonMark collapses single `\n` between non-blank lines into a
	 * space. That's correct for document/file preview, but wrong for chat
	 * surfaces where users expect line structure to be preserved (#622). When
	 * enabled, this routes content through `remark-breaks` so single newlines
	 * render as `<br>`.
	 */
	chatLineBreaks?: boolean;
	/**
	 * Render `$...$` and `$$...$$` as math via KaTeX (chat-style rendering).
	 *
	 * Off by default so file/doc preview keeps treating `$` as literal text -
	 * markdown files with currency or shell prompts shouldn't suddenly parse
	 * as math. Enable on chat surfaces so a line-isolated `$$x+y$$` renders
	 * as a centered block formula (#622).
	 */
	chatMath?: boolean;
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
export const MarkdownRenderer = memo((props: MarkdownRendererProps) => (
	<Markdown preset="chat" {...props} />
));

MarkdownRenderer.displayName = 'MarkdownRenderer';

export type { MarkdownRendererProps };
