/**
 * Markdown - the single, unified react-markdown renderer for the desktop app.
 *
 * One component, selected by `preset`, replaces the previously separate chat
 * renderer, document factory wiring, wizard-bubble, and release-notes render
 * paths. It owns the shared responsibilities (preprocess -> plugins ->
 * components -> ReactMarkdown, plus chat context-menu state) while delegating
 * element rendering to per-preset component maps that share the same leaf
 * modules (links, inline code, code fences, image loader).
 *
 * The chat preset is the historical MarkdownRenderer; `MarkdownRenderer` is now
 * a thin wrapper around `<Markdown preset="chat">`.
 */

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import 'katex/dist/katex.min.css';
import type { PluggableList } from 'unified';
import type { Theme } from '../../types';
import type { FileNode } from '../../types/fileTree';
import { buildFileTreeIndices } from '../../utils/remarkFileLinks';
import { urlTransformAllowingMaestro } from '../../utils/markdownUrlTransform';
import { getHomeDir, getHomeDirAsync } from '../../utils/homeDir';
import {
	createMarkdownComponents,
	createWizardBubbleMarkdownComponents,
	createReleaseNotesMarkdownComponents,
	type MarkdownComponentsOptions,
} from '../../utils/markdownConfig';
import { LinkContextMenu, type LinkContextMenuState } from '../LinkContextMenu';
import { FileContextMenu, type FileContextMenuState } from '../FileContextMenu';
import { buildMarkdownPlugins } from './plugins';
import { preprocessMarkdown } from './preprocess';
import { createChatMarkdownComponents } from './chatComponents';
import type { MarkdownPreset } from './config';

export interface MarkdownProps {
	/** The markdown content to render. */
	content: string;
	/** The current theme. */
	theme: Theme;
	/** Which rendering surface this is. Defaults to 'chat'. */
	preset?: MarkdownPreset;
	/** Additional className for the chat preset's prose container. */
	className?: string;

	// --- File linking (chat + document) ---
	/** File tree for validating + linking relative file references. */
	fileTree?: FileNode[];
	/** Current working directory for proximity-based matching. */
	cwd?: string;
	/** Project root absolute path - converts absolute paths to relative. */
	projectRoot?: string;
	/** Callback when an internal file link is clicked. */
	onFileClick?: (path: string, options?: { openInNewTab?: boolean }) => void;
	/** SSH remote ID for remote file/image operations. */
	sshRemoteId?: string;

	// --- Bionify reading mode (chat + document) ---
	enableBionifyReadingMode?: boolean;
	bionifyIntensity?: number;
	bionifyAlgorithm?: string;

	// --- Chat preset ---
	/** Copy callback for code-fence copy buttons (required for chat). */
	onCopy?: (text: string) => void;
	/** Allow raw HTML passthrough via rehype-raw (DOMPurify-sanitized). */
	allowRawHtml?: boolean;
	/** Treat single newlines as hard line breaks (#622). */
	chatLineBreaks?: boolean;
	/** Render `$...$` / `$$...$$` as KaTeX math (#622). */
	chatMath?: boolean;

	// --- Document preset ---
	/** Render YAML frontmatter as a table. Defaults to true for document. */
	frontmatter?: boolean;
	/** Custom image renderer (e.g. AutoRun's AttachmentImage, FilePreview's MarkdownImage). */
	imageRenderer?: React.ComponentType<{ src?: string; alt?: string }>;
	/** Custom per-language block renderers (e.g. mermaid). */
	customLanguageRenderers?: Record<string, React.ComponentType<{ code: string; theme: Theme }>>;
	/** External link click handler (document). */
	onExternalLinkClick?: (href: string, options?: { ctrlKey?: boolean }) => void;
	/** Anchor (#section) click handler (document). */
	onAnchorClick?: (anchorId: string) => void;
	/** Container ref for in-component anchor scrolling (document). */
	containerRef?: React.RefObject<HTMLElement>;
	/** Search highlighting options (document). */
	searchHighlight?: MarkdownComponentsOptions['searchHighlight'];
	/** Style overrides for syntax-highlighted code blocks (document). */
	codeBlockStyle?: MarkdownComponentsOptions['codeBlockStyle'];
	/** Extra remark plugins appended after the standard stack (e.g. remarkHighlight). */
	extraRemarkPlugins?: PluggableList;
	/** Extra rehype plugins appended after the standard stack (e.g. rehype-slug). */
	extraRehypePlugins?: PluggableList;
}

const EMPTY_PLUGINS: PluggableList = [];

export const Markdown = memo(function Markdown({
	content,
	theme,
	preset = 'chat',
	className = '',
	fileTree,
	cwd,
	projectRoot,
	onFileClick,
	sshRemoteId,
	enableBionifyReadingMode = false,
	bionifyIntensity,
	bionifyAlgorithm,
	onCopy,
	allowRawHtml,
	chatLineBreaks = false,
	chatMath = false,
	frontmatter = true,
	imageRenderer,
	customLanguageRenderers,
	onExternalLinkClick,
	onAnchorClick,
	containerRef,
	searchHighlight,
	codeBlockStyle,
	extraRemarkPlugins,
	extraRehypePlugins,
}: MarkdownProps) {
	const isChat = preset === 'chat';

	// Chat surfaces render sanitized raw HTML (inline SVG, etc.) by default so
	// agents can show diagrams and illustrations, not just a terminal's worth of
	// text. Sanitization happens at the HAST level via rehype-sanitize. Other
	// presets stay opt-in. An explicit prop always wins over the per-preset default.
	const effectiveAllowRawHtml = allowRawHtml ?? isChat;

	// Resolve homeDir for tilde path expansion (module-level cache, fetched once).
	const [homeDir, setHomeDir] = useState<string | undefined>(getHomeDir);
	useEffect(() => {
		if (!homeDir) {
			getHomeDirAsync()?.then(setHomeDir);
		}
	}, [homeDir]);

	// Memoize file tree indices to avoid O(n) traversal on every render.
	const fileTreeIndices = useMemo(() => {
		if (fileTree && fileTree.length > 0) {
			return buildFileTreeIndices(fileTree);
		}
		return null;
	}, [fileTree]);

	// Right-click context menus (chat only).
	const [linkMenu, setLinkMenu] = useState<LinkContextMenuState | null>(null);
	const dismissLinkMenu = useCallback(() => setLinkMenu(null), []);
	const [fileMenu, setFileMenu] = useState<FileContextMenuState | null>(null);
	const dismissFileMenu = useCallback(() => setFileMenu(null), []);

	// Build the remark/rehype plugin stack per preset.
	const { remarkPlugins, rehypePlugins } = useMemo(() => {
		// Release notes render plain CommonMark (no GFM, no frontmatter) - preserved.
		if (preset === 'release-notes') {
			return { remarkPlugins: EMPTY_PLUGINS, rehypePlugins: undefined };
		}
		// Wizard bubbles: GFM only.
		if (preset === 'wizard-bubble') {
			return buildMarkdownPlugins({ frontmatter: false });
		}
		return buildMarkdownPlugins({
			frontmatter,
			chatLineBreaks: isChat ? chatLineBreaks : false,
			chatMath: isChat ? chatMath : false,
			allowRawHtml: effectiveAllowRawHtml,
			fileLinks: { indices: fileTreeIndices, cwd, projectRoot, homeDir },
			extraRemarkPlugins,
			extraRehypePlugins,
		});
	}, [
		preset,
		frontmatter,
		isChat,
		chatLineBreaks,
		chatMath,
		effectiveAllowRawHtml,
		fileTreeIndices,
		cwd,
		projectRoot,
		homeDir,
		extraRemarkPlugins,
		extraRehypePlugins,
	]);

	// Preprocess: link-space fix always; chat math normalization for chat.
	// Raw-HTML sanitization happens downstream at the HAST level (rehype-sanitize).
	const processedContent = useMemo(
		() => preprocessMarkdown(content, { chatMath: isChat ? chatMath : false }),
		[content, isChat, chatMath]
	);

	// Build the component map per preset (all share the leaf modules).
	const components = useMemo(() => {
		switch (preset) {
			case 'chat':
				return createChatMarkdownComponents({
					theme,
					onCopy: onCopy ?? (() => {}),
					onFileClick,
					projectRoot,
					sshRemoteId,
					enableBionifyReadingMode,
					bionifyIntensity,
					bionifyAlgorithm,
					onLinkContextMenu: (e, url) => setLinkMenu({ x: e.clientX, y: e.clientY, url }),
					onFileContextMenu: (e, absPath, fileName) =>
						setFileMenu({ x: e.clientX, y: e.clientY, filePath: absPath, fileName }),
				});
			case 'wizard-bubble':
				return createWizardBubbleMarkdownComponents(theme);
			case 'release-notes':
				return createReleaseNotesMarkdownComponents(theme);
			case 'document':
			default:
				return createMarkdownComponents({
					theme,
					imageRenderer,
					customLanguageRenderers,
					onFileClick,
					onExternalLinkClick,
					onAnchorClick,
					containerRef,
					searchHighlight,
					codeBlockStyle,
					enableBionifyReadingMode,
					bionifyIntensity,
					bionifyAlgorithm,
				});
		}
	}, [
		preset,
		theme,
		onCopy,
		onFileClick,
		projectRoot,
		sshRemoteId,
		enableBionifyReadingMode,
		bionifyIntensity,
		bionifyAlgorithm,
		imageRenderer,
		customLanguageRenderers,
		onExternalLinkClick,
		onAnchorClick,
		containerRef,
		searchHighlight,
		codeBlockStyle,
	]);

	const markdown = (
		<ReactMarkdown
			remarkPlugins={remarkPlugins}
			rehypePlugins={rehypePlugins}
			urlTransform={urlTransformAllowingMaestro}
			components={components}
		>
			{processedContent}
		</ReactMarkdown>
	);

	// Chat owns its prose container + context menus. Other presets render bare so
	// callers keep their own scoped prose containers.
	if (!isChat) {
		return markdown;
	}

	return (
		<div
			className={`prose prose-sm max-w-none text-sm ${className}`}
			style={{ color: theme.colors.textMain, lineHeight: 1.4, paddingLeft: '0.5em' }}
		>
			{markdown}
			{linkMenu && <LinkContextMenu menu={linkMenu} theme={theme} onDismiss={dismissLinkMenu} />}
			{fileMenu && (
				<FileContextMenu
					menu={fileMenu}
					theme={theme}
					onDismiss={dismissFileMenu}
					onPreview={onFileClick}
					projectRoot={projectRoot}
					sshRemote={!!sshRemoteId}
				/>
			)}
		</div>
	);
});

Markdown.displayName = 'Markdown';
