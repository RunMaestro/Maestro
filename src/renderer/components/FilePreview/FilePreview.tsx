import React, {
	useState,
	useRef,
	useEffect,
	useMemo,
	useCallback,
	forwardRef,
	useImperativeHandle,
	lazy,
	Suspense,
} from 'react';
import ReactMarkdown from 'react-markdown';
import { urlTransformAllowingMaestro } from '../../utils/markdownUrlTransform';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { getSyntaxStyle } from '../../utils/syntaxTheme';
import {
	FileCode,
	ChevronUp,
	ChevronDown,
	AlertTriangle,
	RefreshCw,
	X,
	Filter,
	Type,
	Regex,
	Hash,
} from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import { captureException } from '../../utils/sentry';
import { safeClipboardWrite, safeClipboardWriteImage } from '../../utils/clipboard';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { notifyToast } from '../../stores/notificationStore';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useClickOutside } from '../../hooks/ui/useClickOutside';
import { Modal, ModalFooter } from '../ui/Modal';
import { MermaidRenderer } from '../MermaidRenderer';
import { CsvTableRenderer } from '../CsvTableRenderer';
import { JsonlViewer, SYNTAX_EXAMPLES } from '../JsonlViewer';
import { getEncoder } from '../../utils/tokenCounter';
import { remarkFileLinks, buildFileTreeIndices } from '../../utils/remarkFileLinks';
import { getHomeDir, getHomeDirAsync } from '../../utils/homeDir';
import remarkFrontmatter from 'remark-frontmatter';
import { remarkFrontmatterTable } from '../../utils/remarkFrontmatterTable';
import { REMARK_GFM_PLUGINS, createMarkdownComponents } from '../../utils/markdownConfig';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { buildFileDeepLink } from '../../../shared/deep-link-urls';
import { useUIStore } from '../../stores/uiStore';
import { openUrl } from '../../utils/openUrl';
import { isWebDesktop } from '../../utils/runtimeContext';
import { isImageFile } from '../../../shared/gitUtils';
import type { FilePreviewProps, FilePreviewHandle, FileStats } from './types';
import {
	getLanguageFromFilename,
	isBinaryContent,
	isBinaryExtension,
	formatFileSize,
	countMarkdownTasks,
	extractHeadings,
	isReadableTextPreview,
	isCodeFile,
	LARGE_FILE_TOKEN_SKIP_THRESHOLD,
	LARGE_FILE_PREVIEW_LIMIT,
	pickPreviewTier,
	scanLineStats,
} from './filePreviewUtils';
import { BionifyTextBlock } from '../../utils/bionifyReadingMode';
import { MarkdownImage } from './MarkdownImage';
import { remarkHighlight } from './remarkHighlight';
import { useFilePreviewSearch } from '../../hooks/file';
import type { FilePreviewSearchAdapter } from './search/types';
import { FilePreviewHeader } from './FilePreviewHeader';
import { ImageViewer } from './ImageViewer';
import { ImageSaveModal } from './ImageSaveModal';
import { useImageAnnotatorStore } from '../ImageAnnotator/imageAnnotatorStore';
import { getParentDir, getBasename } from '../../../shared/formatters';
import { FilePreviewToc } from './FilePreviewToc';
import { MarkdownEditor } from './markdownEditor';
import type { MarkdownEditorHandle } from './markdownEditor';
import {
	domGetTopLine,
	domScrollToLine,
	domGetTopLineByAttr,
	domScrollToLineByAttr,
} from './lineSync';
import { rehypeSourceLine } from './rehypeSourceLine';
import { logger } from '../../utils/logger';

// Lazy-loaded large-file markdown renderer. Keeping it out of the main bundle
// means small-file previews don't pay the ~135 KB cost of markdown-it +
// react-virtuoso + DOMPurify until a large file actually triggers it.
const MarkdownPreviewFast = lazy(() => import('./markdownFast'));

// Lazy-loaded Fast tier preview for plain text and code files. Same lazy
// strategy as the markdown Fast tier — small text files don't pay for
// TanStack Virtual + Shiki until a large file triggers the Fast tier.
const TextPreviewFast = lazy(() => import('./textFast'));

// Lazy-loaded Giant tier preview (CodeMirror 6). Used for multi-MB / multi-
// million-line files where even the Fast tiers would struggle to parse +
// render. CM6 is ~300 KB gz so we keep it well off the main bundle.
const GiantPreview = lazy(() => import('./giantPreview'));

export const FilePreview = React.memo(
	forwardRef<FilePreviewHandle, FilePreviewProps>(function FilePreview(
		{
			file,
			onClose,
			theme,
			markdownEditMode,
			setMarkdownEditMode,
			onSave,
			shortcuts,
			fileTree,
			cwd,
			onFileClick,
			canGoBack,
			canGoForward,
			onNavigateBack,
			onNavigateForward,
			backHistory,
			forwardHistory,
			onNavigateToIndex,
			currentHistoryIndex,
			onOpenFuzzySearch,
			onShortcutUsed,
			ghCliAvailable,
			onPublishGist,
			hasGist,
			onOpenInGraph,
			onOpenInBrowser,
			sshRemoteId,
			externalEditContent,
			onEditContentChange,
			initialScrollTop,
			onScrollPositionChange,
			initialSearchQuery,
			onSearchQueryChange,
			isTabMode,
			lastModified,
			onReloadFile,
			previewTierOverride,
			onPreviewTierChange,
			htmlRenderMode = false,
			onHtmlRenderModeChange,
			pendingScrollToLine,
			onPendingScrollToLineConsumed,
		},
		ref
	) {
		const [showTocOverlay, setShowTocOverlay] = useState(false);
		const [fileStats, setFileStats] = useState<FileStats | null>(null);
		const [showStatsBar, setShowStatsBar] = useState(true);
		const [tokenCount, setTokenCount] = useState<number | null>(null);
		const [showRemoteImages, setShowRemoteImages] = useState(false);
		const [showFullContent, setShowFullContent] = useState(false);
		// Edit mode state - use external content when provided (for file tab persistence).
		// Initialize from file.content so hasChanges isn't a false positive on first render
		// (effect below keeps it in sync when the file changes).
		const [internalEditContent, setInternalEditContent] = useState(file?.content ?? '');
		// Computed edit content - prefer external if provided
		const editContent = externalEditContent ?? internalEditContent;
		// Wrapper to update both internal state and notify parent
		const setEditContent = useCallback(
			(content: string) => {
				setInternalEditContent(content);
				onEditContentChange?.(content);
			},
			[onEditContentChange]
		);
		const [isSaving, setIsSaving] = useState(false);
		const [showUnsavedChangesModal, setShowUnsavedChangesModal] = useState(false);
		// Image-edit save flow: holds the annotator's composited data URL while the
		// user picks a save destination (overwrite vs new file). Null when idle.
		const [imageSaveData, setImageSaveData] = useState<string | null>(null);
		const [imageSaveBusy, setImageSaveBusy] = useState(false);
		const openAnnotator = useImageAnnotatorStore((s) => s.openAnnotator);
		const [searchMode, setSearchMode] = useState<'text' | 'jq'>('text');
		const [showJqHelp, setShowJqHelp] = useState(false);
		const [jqError, setJqError] = useState<string | null>(null);
		const jqHelpRef = useRef<HTMLDivElement>(null);
		const [lineCtxMenu, setLineCtxMenu] = useState<{
			lineNumber: number;
			x: number;
			y: number;
		} | null>(null);

		const codeContainerRef = useRef<HTMLDivElement>(null);
		const contentRef = useRef<HTMLDivElement>(null);
		const containerRef = useRef<HTMLDivElement>(null);
		// Imperative handle for the CodeMirror-based markdown/text edit editor.
		// Replaces the raw <textarea> ref the previous implementation passed
		// around — see ./markdownEditor for the surface this exposes.
		const editorRef = useRef<MarkdownEditorHandle>(null);
		const markdownContainerRef = useRef<HTMLDivElement>(null);
		const layerIdRef = useRef<string>();
		const cancelButtonRef = useRef<HTMLButtonElement>(null);
		const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const tocButtonRef = useRef<HTMLButtonElement>(null);
		const tocOverlayRef = useRef<HTMLDivElement>(null);
		// Imperative handle for the lazy-loaded Fast tier preview. Used by the
		// TOC to scroll to a heading via virtuoso.scrollToIndex when in Fast tier.
		const markdownFastRef = useRef<import('./markdownFast').MarkdownPreviewFastHandle>(null);
		// Imperative handle for the lazy-loaded text/code Fast tier preview.
		// Cmd+F search delegates to this handle when in Fast tier non-markdown.
		const textFastRef = useRef<import('./textFast').TextPreviewFastHandle>(null);
		// Imperative handle for the lazy-loaded Giant tier preview. Cmd+F in
		// Giant tier opens CodeMirror's native search panel via this handle.
		const giantRef = useRef<import('./giantPreview').GiantPreviewHandle>(null);
		// Top source line of each view, kept fresh by a capture-phase scroll
		// listener so toggling between preview and edit can re-anchor on the
		// same line. The conditional render unmounts the outgoing view before
		// effects run, so we cannot read its scroll position at toggle time -
		// hence the running refs.
		const previewTopLineRef = useRef(1);
		const editorTopLineRef = useRef(1);

		// Reset full content view when file changes
		useEffect(() => {
			setShowFullContent(false);
		}, [file?.path]);

		// File change detection state
		const [fileChangedOnDisk, setFileChangedOnDisk] = useState(false);
		// True once the file can no longer be stat'd at its cached path (deleted, or
		// moved/renamed elsewhere). Distinct from fileChangedOnDisk: there is nothing
		// to reload, so the banner offers only Dismiss.
		const [fileMissingOnDisk, setFileMissingOnDisk] = useState(false);
		const lastModifiedRef = useRef(lastModified);

		// Keep ref in sync with prop (reset when parent reloads content with new lastModified)
		useEffect(() => {
			lastModifiedRef.current = lastModified;
			setFileChangedOnDisk(false);
			setFileMissingOnDisk(false);
		}, [lastModified]);

		// Reset the missing banner when navigating to a different file.
		useEffect(() => {
			setFileMissingOnDisk(false);
		}, [file?.path]);

		// Poll file stat to detect external changes (every 3s for the active file)
		useEffect(() => {
			if (!file?.path || !lastModified || fileChangedOnDisk || fileMissingOnDisk) return;

			const interval = setInterval(async () => {
				try {
					const stat = await window.maestro?.fs?.stat(file.path, sshRemoteId);
					if (!stat?.modifiedAt) return;
					const currentMtime = new Date(stat.modifiedAt).getTime();
					if (currentMtime > (lastModifiedRef.current ?? 0)) {
						setFileChangedOnDisk(true);
					}
				} catch {
					// stat threw: the file no longer exists at this path. It was deleted
					// or moved/renamed out from under the open tab. Surface it so the user
					// knows their edits would no longer save in place.
					setFileMissingOnDisk(true);
				}
			}, 3000);

			return () => clearInterval(interval);
		}, [file?.path, lastModified, sshRemoteId, fileChangedOnDisk, fileMissingOnDisk]);

		// Handle reload click
		const handleReloadFile = useCallback(() => {
			setFileChangedOnDisk(false);
			onReloadFile?.();
		}, [onReloadFile]);

		// Expose focus method to parent via ref
		useImperativeHandle(
			ref,
			() => ({
				focus: () => {
					containerRef.current?.focus();
				},
			}),
			[]
		);

		// Track if content has been modified. Not gated on markdownEditMode so the
		// user can save unsaved edits after toggling back to preview (Cmd+S, etc.).
		const hasChanges = editContent !== (file?.content ?? '');

		// Deep-link scroll-to-line. Fires when a maestro://file/...#L<n> link
		// opens this file: flip to edit mode, jump the editor to that line,
		// then notify the parent so it clears the transient flag (otherwise
		// we'd re-jump on every render).
		useEffect(() => {
			if (!pendingScrollToLine || !file) return;
			// The editor only exists in edit mode. If we're still in preview,
			// flip to edit first — the next render lands back here with the
			// editor mounted and the handle available.
			if (!markdownEditMode) {
				setMarkdownEditMode(true);
				return;
			}
			const editor = editorRef.current;
			if (!editor) return;
			editor.focus();
			editor.scrollToLine(pendingScrollToLine);
			onPendingScrollToLineConsumed?.();
		}, [
			pendingScrollToLine,
			markdownEditMode,
			setMarkdownEditMode,
			onPendingScrollToLineConsumed,
			file,
		]);

		const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();

		// Compute derived values - must be before any early returns but after hooks
		const language = file ? getLanguageFromFilename(file.name) : '';
		const isMarkdown = language === 'markdown';
		const isHtml = file ? /\.html?$/i.test(file.name) : false;
		// Mermaid diagram files render as a diagram by default (like markdown);
		// Cmd+E drops into source editing since they're plain editable text.
		const isMermaid = file ? /\.(mmd|mermaid)$/i.test(file.name) : false;
		const isReadableText = file ? !isMarkdown && isReadableTextPreview(file.name) : false;
		const isCsv = language === 'csv';
		const isJsonl = language === 'jsonl';
		const isJson = language === 'json';
		const supportsJq = isJsonl || isJson;
		const csvDelimiter = file?.name.toLowerCase().endsWith('.tsv') ? '\t' : ',';
		const isImage = file ? isImageFile(file.name) : false;

		// Check for binary files - either by extension or by content analysis
		// Memoize to avoid recalculating on every render (content analysis can be expensive)
		const isBinary = useMemo(() => {
			if (!file) return false;
			if (isImage) return false;
			return isBinaryExtension(file.name) || isBinaryContent(file.content);
		}, [isImage, file]);

		// Any non-binary, non-image file can be edited as text
		const isEditableText = !isImage && !isBinary;

		// Check if file is large (for performance optimizations)
		const isLargeFile = useMemo(() => {
			if (!file?.content) return false;
			return file.content.length > LARGE_FILE_TOKEN_SKIP_THRESHOLD;
		}, [file?.content]);

		// Choose preview tier based on file size + line shape. Applies to all
		// text-like content (markdown, plain text, source code) — binary and
		// image files always stay in Rich. Tier is memoized on path so
		// switching tabs and coming back doesn't re-decide.
		//
		// `scanLineStats` returns both line count and longest single line in
		// one pass; the long-line signal pushes pathological files (e.g. a
		// 488 KB single line) past Fast straight into Giant, where CM6's
		// `lineWrapping` extension keeps the renderer responsive.
		const autoTier = useMemo(() => {
			if (!file?.content || isImage || isBinary) return 'rich' as const;
			const bytes = file.content.length;
			const { lines, maxLineLength } = scanLineStats(file.content);
			return pickPreviewTier(bytes, lines, maxLineLength, isMarkdown);
		}, [file?.path, file?.content, isImage, isBinary, isMarkdown]);

		// Effective tier respects the user's per-tab override, falling back to
		// the auto-picked tier. The PreviewTierChip in the header lets the user
		// flip between modes; selection is persisted via onPreviewTierChange.
		const previewTier = previewTierOverride ?? autoTier;

		// For very large files, truncate content for syntax highlighting to prevent freezes
		const displayContent = useMemo(() => {
			if (!file?.content) return '';
			if (
				!showFullContent &&
				!isMarkdown &&
				!isImage &&
				!isBinary &&
				file.content.length > LARGE_FILE_PREVIEW_LIMIT
			) {
				return file.content.substring(0, LARGE_FILE_PREVIEW_LIMIT);
			}
			return file.content;
		}, [file?.content, isMarkdown, isImage, isBinary, showFullContent]);

		// Tier-aware search adapter, memoized so its identity only changes when
		// the routing actually flips. useFilePreviewSearch lists searchAdapter
		// in its effect dependency array, so an unstable identity would re-run
		// the effect on every render — refs are stable so they don't belong in
		// the deps even though the callbacks close over them.
		//   Fast markdown  → markdownFast handle (block-virtualized hit map)
		//   Fast text/code → textFast handle (page-virtualized hit map)
		//   Giant any kind → GiantPreview handle (CM6 owns the search panel)
		const searchAdapter = useMemo<FilePreviewSearchAdapter | undefined>(() => {
			if (previewTier === 'fast' && isMarkdown) {
				return {
					findHits: (q) => markdownFastRef.current?.findInContent(q) ?? [],
					scrollToMatch: (hit) => markdownFastRef.current?.scrollToMatch(hit),
				};
			}
			if (previewTier === 'fast' && !markdownEditMode && !isImage && !isBinary) {
				return {
					findHits: (q) => textFastRef.current?.findInContent(q) ?? [],
					scrollToMatch: (hit) => textFastRef.current?.scrollToMatch(hit),
				};
			}
			if (previewTier === 'giant' && !markdownEditMode && !isImage && !isBinary) {
				return {
					findHits: (q) => giantRef.current?.findInContent(q) ?? [],
					scrollToMatch: (hit) => giantRef.current?.scrollToMatch(hit),
				};
			}
			return undefined;
		}, [previewTier, isMarkdown, markdownEditMode, isImage, isBinary]);

		// Whether the active preview shows line numbers; gates the regex / line
		// search chip (left of the Cmd+F input). True for the code editor and the
		// code/text preview tiers; false for rendered markdown, CSV, JSON-jq, HTML
		// render, and images.
		const viewHasLineNumbers = useMemo(() => {
			if (isImage || isBinary) return false;
			if (isEditableText && markdownEditMode) return true; // CM6 editor
			if (markdownEditMode) return false;
			if (isMarkdown || isCsv || isJsonl) return false;
			if (isMermaid) return false; // rendered diagram has no source gutter
			if (isJson && searchMode === 'jq') return false;
			if (isHtml && htmlRenderMode) return false;
			// Rich-tier readable text uses a wrapped prose block with no gutter; the
			// Fast and Giant tiers render a numbered gutter, so exclude readable text
			// only when it falls outside those tiers.
			if (isReadableText && previewTier !== 'fast' && previewTier !== 'giant') return false;
			return true;
		}, [
			isImage,
			isBinary,
			isEditableText,
			markdownEditMode,
			isMarkdown,
			isMermaid,
			isCsv,
			isJsonl,
			isJson,
			searchMode,
			isHtml,
			htmlRenderMode,
			isReadableText,
			previewTier,
		]);

		// Search state and effects (code highlighting, markdown CSS Highlight API, edit textarea)
		const {
			searchQuery,
			setSearchQuery,
			searchOpen,
			setSearchOpen,
			currentMatchIndex,
			totalMatches,
			goToNextMatch,
			goToPrevMatch,
			searchInputRef,
			setMatchCount,
			searchKind,
			cycleSearchKind,
			regexError,
		} = useFilePreviewSearch({
			codeContainerRef,
			markdownContainerRef,
			contentRef,
			editorRef,
			isMarkdown,
			isReadableText,
			isImage,
			isCsv,
			isJsonl,
			isJson,
			isEditableText,
			markdownEditMode,
			editContent,
			fileContent: file?.content,
			accentColor: theme.colors.accent,
			searchMode,
			supportsLineSearch: viewHasLineNumbers,
			displayedContentLength: displayContent.length,
			initialSearchQuery,
			onSearchQueryChange,
			searchAdapter,
		});

		// Bionify reading mode follows the global setting; disabled while search highlights are active.
		const bionifyReadingMode = useSettingsStore((s) => s.bionifyReadingMode);
		const bionifyIntensity = useSettingsStore((s) => s.bionifyIntensity);
		const bionifyAlgorithm = useSettingsStore((s) => s.bionifyAlgorithm);
		const spellCheckEnabled = useSettingsStore((s) => s.spellCheck);
		const fileEditWordWrap = useSettingsStore((s) => s.fileEditWordWrap);
		const setFileEditWordWrap = useSettingsStore((s) => s.setFileEditWordWrap);
		const fileEditShowLineNumbers = useSettingsStore((s) => s.fileEditShowLineNumbers);
		const filePreviewToolbarVisibility = useSettingsStore((s) => s.filePreviewToolbarVisibility);
		const hasActiveSearch = searchQuery.trim().length > 0;
		const effectiveBionifyReadingMode = bionifyReadingMode && !hasActiveSearch;

		// Close jq help on outside click or Escape
		useEffect(() => {
			if (!showJqHelp) return;
			const handleClick = (e: MouseEvent) => {
				if (jqHelpRef.current && !jqHelpRef.current.contains(e.target as Node)) {
					setShowJqHelp(false);
				}
			};
			const handleKey = (e: KeyboardEvent) => {
				if (e.key === 'Escape') {
					setShowJqHelp(false);
					e.stopPropagation();
				}
			};
			document.addEventListener('mousedown', handleClick);
			document.addEventListener('keydown', handleKey, true);
			return () => {
				document.removeEventListener('mousedown', handleClick);
				document.removeEventListener('keydown', handleKey, true);
			};
		}, [showJqHelp]);

		// Reset search mode when file changes
		useEffect(() => {
			setSearchMode('text');
			setShowJqHelp(false);
			setJqError(null);
		}, [file?.path]);

		// Track if content is truncated for display
		const isContentTruncated = file?.content && displayContent.length < file.content.length;

		// Calculate task counts for markdown files
		const taskCounts = useMemo(() => {
			if (!isMarkdown || !file?.content) return null;
			const counts = countMarkdownTasks(file.content);
			// Only return if there are any tasks
			if (counts.open === 0 && counts.closed === 0) return null;
			return counts;
		}, [isMarkdown, file?.content]);

		// Extract table of contents entries for markdown files
		const tocEntries = useMemo(() => {
			if (!isMarkdown || !file?.content) return [];
			return extractHeadings(file.content);
		}, [isMarkdown, file?.content]);

		// Compute dynamic ToC overlay width based on longest heading text
		const tocWidth = useMemo(() => {
			if (tocEntries.length === 0) return 200;
			const MIN_WIDTH = 200;
			const MAX_WIDTH = 500;
			const CHAR_WIDTH = 7.5; // approximate px per character at ~0.8rem
			const BASE_PADDING = 24; // px padding inside buttons
			const HEADER_EXTRA = 100; // "CONTENTS" header + headings count badge

			let maxNeeded = HEADER_EXTRA;
			for (const entry of tocEntries) {
				const indent = (entry.level - 1) * 12 + 8;
				const textWidth = entry.text.length * CHAR_WIDTH;
				maxNeeded = Math.max(maxNeeded, indent + textWidth + BASE_PADDING);
			}
			return Math.min(Math.max(Math.ceil(maxNeeded), MIN_WIDTH), MAX_WIDTH);
		}, [tocEntries]);

		const scrollMarkdownToBoundary = useCallback((direction: 'top' | 'bottom') => {
			// Use contentRef which is the actual scrollable container
			const container = contentRef.current;
			if (!container) return;
			const top = direction === 'top' ? 0 : container.scrollHeight;
			container.scrollTo({ top, behavior: 'smooth' });
		}, []);

		// Memoize file tree indices to avoid O(n) traversal on every render
		const fileTreeIndices = useMemo(() => {
			if (fileTree && fileTree.length > 0) {
				return buildFileTreeIndices(fileTree);
			}
			return null;
		}, [fileTree]);

		// Resolve homeDir for tilde path expansion
		const [homeDir, setHomeDir] = useState<string | undefined>(getHomeDir);
		useEffect(() => {
			if (!homeDir) {
				getHomeDirAsync()?.then(setHomeDir);
			}
		}, [homeDir]);

		// Memoize remarkPlugins to prevent infinite render loops
		// Creating new arrays/objects on each render causes ReactMarkdown to re-render children
		const remarkPlugins = useMemo(
			() => [
				...REMARK_GFM_PLUGINS,
				remarkFrontmatter,
				remarkFrontmatterTable,
				remarkHighlight,
				...(fileTree && fileTree.length > 0 && cwd !== undefined
					? [[remarkFileLinks, { indices: fileTreeIndices || undefined, cwd, homeDir }] as any]
					: homeDir
						? [[remarkFileLinks, { cwd: cwd || '', homeDir }] as any]
						: []),
			],
			[fileTree, fileTreeIndices, cwd, homeDir]
		);

		// Memoize rehypePlugins array to prevent unnecessary re-renders.
		// rehypeSourceLine runs first so it reads the original source positions
		// before rehypeRaw re-parses raw HTML (which discards position info).
		const rehypePlugins = useMemo(() => [rehypeSourceLine, rehypeRaw, rehypeSlug], []);

		// Shared handler for external links clicked inside rendered markdown, used
		// by both the ReactMarkdown and fast-preview render paths. In the desktop
		// app a file:// link opens on the host via the shell bridge. In the
		// web-desktop build that bridge targets the HOST machine, not the browser
		// user's device, so opening a local path there is meaningless - surface a
		// toast instead. http/mailto links open the same way in both builds.
		const handleExternalLinkClick = useCallback((href: string, opts?: { ctrlKey?: boolean }) => {
			if (/^file:\/\//.test(href)) {
				if (isWebDesktop()) {
					notifyToast({
						color: 'theme',
						title: 'Open file',
						message: 'Available in the desktop app',
					});
					return;
				}
				void window.maestro.shell.openPath(href.replace(/^file:\/\//, ''));
				return;
			}
			if (/^https?:\/\/|^mailto:/.test(href)) {
				openUrl(href, opts);
			}
		}, []);

		// Memoize ReactMarkdown components to prevent infinite render loops
		// The img component was causing loops because MarkdownImage useEffect sets state,
		// which triggers parent re-render, creating new components object, remounting MarkdownImage
		const markdownComponents = useMemo(() => {
			const components = createMarkdownComponents({
				theme,
				customLanguageRenderers: {
					mermaid: ({ code, theme: t }) => <MermaidRenderer chart={code} theme={t} />,
				},
				onFileClick: (filePath, options) => onFileClick?.(filePath, options),
				onExternalLinkClick: handleExternalLinkClick,
				containerRef: markdownContainerRef,
				enableBionifyReadingMode: effectiveBionifyReadingMode,
				bionifyIntensity,
				bionifyAlgorithm,
			});
			return {
				...components,
				img: ({ src, alt, ...props }: any) => {
					// Check if this image came from file tree (set by remarkFileLinks)
					const isFromTree = props['data-maestro-from-tree'] === 'true';
					let projectRootForImage: string | undefined;

					if (isFromTree && cwd && file) {
						// Resolve project root so relative image links from tree render correctly.
						const cwdIndex = file.path.indexOf(`/${cwd}/`);
						if (cwdIndex !== -1) {
							projectRootForImage = file.path.substring(0, cwdIndex);
						} else {
							const firstCwdSegment = cwd.split('/')[0];
							const segmentIndex = file.path.indexOf(`/${firstCwdSegment}/`);
							if (segmentIndex !== -1) {
								projectRootForImage = file.path.substring(0, segmentIndex);
							}
						}
					}

					return (
						<MarkdownImage
							src={src}
							alt={alt}
							markdownFilePath={file?.path || ''}
							theme={theme}
							showRemoteImages={showRemoteImages}
							isFromFileTree={isFromTree}
							projectRoot={projectRootForImage}
							sshRemoteId={sshRemoteId}
						/>
					);
				},
				// Strip event handler attributes (e.g. onToggle) that rehype-raw may
				// pass through as strings from AI-generated HTML, which React rejects.
				// Fixes MAESTRO-8Q
				details: ({ node: _node, onToggle: _onToggle, ...props }: any) => <details {...props} />,
			};
		}, [
			onFileClick,
			handleExternalLinkClick,
			theme,
			cwd,
			file,
			showRemoteImages,
			sshRemoteId,
			effectiveBionifyReadingMode,
			bionifyIntensity,
			bionifyAlgorithm,
		]);

		// Extract directory path without filename
		const directoryPath = file ? file.path.substring(0, file.path.lastIndexOf('/')) : '';

		const showPath = showStatsBar && !!directoryPath;
		const headerIconClass = 'w-4 h-4';
		const headerBtnClass =
			'inline-flex min-w-9 min-h-9 items-center justify-center p-2 rounded hover:bg-white/10 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-white/30';

		// Fetch file stats when file changes
		useEffect(() => {
			if (file?.path) {
				window.maestro.fs
					.stat(file.path, sshRemoteId)
					.then((stats) =>
						// stat returns null for a missing path - clear stats like the catch.
						setFileStats(
							stats
								? {
										size: stats.size,
										createdAt: stats.createdAt,
										modifiedAt: stats.modifiedAt,
									}
								: null
						)
					)
					.catch((err) => {
						logger.error('Failed to get file stats:', undefined, err);
						setFileStats(null);
					});
			}
		}, [file?.path, sshRemoteId]);

		// Count tokens when file content changes (skip for images, binary files, and large files)
		// Large files would freeze the UI during token encoding
		useEffect(() => {
			if (!file?.content || isImage || isBinary || isLargeFile) {
				setTokenCount(null);
				return;
			}

			getEncoder()
				.then((encoder) => {
					const tokens = encoder.encode(file.content);
					setTokenCount(tokens.length);
				})
				.catch((err) => {
					logger.error('Failed to count tokens:', undefined, err);
					setTokenCount(null);
				});
		}, [file?.content, isImage, isBinary, isLargeFile]);

		// Sync internal edit content when file changes (only when NOT using external content)
		// When externalEditContent is provided (file tab mode), the parent manages the state
		useEffect(() => {
			if (file?.content && externalEditContent === undefined) {
				setInternalEditContent(file.content);
			}
		}, [file?.content, file?.path, externalEditContent]);

		// Focus appropriate element and sync scroll position when mode changes
		// Which active preview reports real source lines (vs. percent-only views
		// like CSV/JSON/HTML/rendered-markdown). Mirrors the render branch order
		// below so it agrees with what's actually on screen.
		const previewSyncSource = (): 'giant' | 'text-fast' | 'text-dom' | 'markdown-dom' | null => {
			if (isHtml && htmlRenderMode) return null;
			if (isMermaid) return null;
			if (isCsv) return null;
			if (isJsonl || (isJson && searchMode === 'jq')) return null;
			if (previewTier === 'giant') return 'giant';
			// Fast-tier markdown scrolls inside its own virtuoso container, which
			// the data-source-line walk can't target - leave it on percent.
			if (isMarkdown && previewTier === 'fast') return null;
			// Rich markdown renders into markdownContainerRef inside contentRef;
			// rehypeSourceLine tags each block so we can map render ⇄ source line.
			if (isMarkdown) return 'markdown-dom';
			if (isReadableText && previewTier === 'fast') return 'text-fast';
			if (isReadableText) return 'text-dom';
			return null;
		};

		// 1-based source line at the top of the active preview, or null when the
		// active view can't report one.
		const readPreviewTopLine = (): number | null => {
			switch (previewSyncSource()) {
				case 'giant':
					return giantRef.current?.getTopLine() ?? null;
				case 'text-fast':
					return textFastRef.current?.getTopLine() ?? null;
				case 'text-dom': {
					const scroller = contentRef.current;
					const containerEl = markdownContainerRef.current;
					if (!scroller || !containerEl) return null;
					return domGetTopLine(scroller, containerEl, displayContent);
				}
				case 'markdown-dom': {
					const scroller = contentRef.current;
					const containerEl = markdownContainerRef.current;
					if (!scroller || !containerEl) return null;
					return domGetTopLineByAttr(scroller, containerEl);
				}
				default:
					return null;
			}
		};

		// Scroll the active preview so `line` sits at the top. Returns false when
		// the active view has no line mapping (caller falls back to percent).
		const scrollPreviewToLine = (line: number): boolean => {
			switch (previewSyncSource()) {
				case 'giant':
					giantRef.current?.scrollToLine(line);
					return true;
				case 'text-fast':
					textFastRef.current?.scrollToLine(line);
					return true;
				case 'text-dom': {
					const scroller = contentRef.current;
					const containerEl = markdownContainerRef.current;
					if (!scroller || !containerEl) return false;
					domScrollToLine(scroller, containerEl, displayContent, line);
					return true;
				}
				case 'markdown-dom': {
					const scroller = contentRef.current;
					const containerEl = markdownContainerRef.current;
					if (!scroller || !containerEl) return false;
					return domScrollToLineByAttr(scroller, containerEl, line);
				}
				default:
					return false;
			}
		};

		// Capture-phase scroll listener keeps the top-line refs fresh. Stored in a
		// ref so the listener (attached once) always runs against current state.
		const captureTopLineRef = useRef<() => void>(() => {});
		captureTopLineRef.current = () => {
			if (markdownEditMode) {
				const line = editorRef.current?.getTopLine();
				if (line) editorTopLineRef.current = line;
			} else {
				const line = readPreviewTopLine();
				if (line != null) previewTopLineRef.current = line;
			}
		};

		useEffect(() => {
			const root = contentRef.current;
			if (!root) return;
			let raf: number | null = null;
			const onScroll = () => {
				if (raf != null) return;
				raf = requestAnimationFrame(() => {
					raf = null;
					captureTopLineRef.current();
				});
			};
			// Capture phase so scrolls from the nested tier scrollers (CodeMirror,
			// the virtualized fast tiers) and the editor all reach this one listener.
			root.addEventListener('scroll', onScroll, true);
			return () => {
				if (raf != null) cancelAnimationFrame(raf);
				root.removeEventListener('scroll', onScroll, true);
			};
		}, [file?.path]);

		const prevMarkdownEditModeRef = useRef(markdownEditMode);
		useEffect(() => {
			const wasEditMode = prevMarkdownEditModeRef.current;
			prevMarkdownEditModeRef.current = markdownEditMode;
			if (markdownEditMode === wasEditMode) return;

			if (markdownEditMode && editorRef.current) {
				// Entering edit mode - focus the editor and land it on the line that
				// was at the top of the preview (so the view doesn't jump).
				const canSyncLine = previewSyncSource() !== null;
				const line = previewTopLineRef.current;
				editorTopLineRef.current = line;
				// Sync scroll one frame in (after the editor lays out).
				requestAnimationFrame(() => {
					if (canSyncLine) {
						editorRef.current?.scrollToLine(line, { select: false });
					} else if (contentRef.current) {
						// Percent fallback for views without a 1:1 line map.
						const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
						const maxScroll = scrollHeight - clientHeight;
						editorRef.current?.setScrollPercent(maxScroll > 0 ? scrollTop / maxScroll : 0);
					}
				});
				// Focus must wait until AFTER the freshly-mounted editor has
				// painted: a rAF callback runs BEFORE the next paint, and calling
				// focus() on a not-yet-painted contenteditable silently no-ops -
				// focus falls to <body>, which is what broke the Cmd+E toggle
				// (the user had to click into the editor before Cmd+E worked
				// again). setTimeout(0) runs as a macrotask after paint, where
				// focus reliably sticks.
				setTimeout(() => editorRef.current?.focus(), 0);
			} else if (!markdownEditMode && wasEditMode && containerRef.current) {
				// Exiting edit mode - the editor has already unmounted, so use the
				// scroll-tracked top line to re-anchor the preview.
				const line = editorTopLineRef.current;
				requestAnimationFrame(() => {
					scrollPreviewToLine(line);
				});
				containerRef.current.focus();
			}
		}, [markdownEditMode]);

		// Save handler
		const handleSave = useCallback(async () => {
			if (!file || !onSave || !hasChanges || isSaving) return;

			setIsSaving(true);
			try {
				const result = await onSave(file.path, editContent);
				if (result === false) return; // User cancelled save dialog
				// Update lastModifiedRef so the file-change poller doesn't flag our own save
				try {
					const stat = await window.maestro?.fs?.stat(file.path, sshRemoteId);
					if (stat?.modifiedAt) {
						lastModifiedRef.current = new Date(stat.modifiedAt).getTime();
					}
				} catch {
					// Non-critical — worst case the banner appears briefly
				}
				notifyCenterFlash({ message: 'File Saved', color: 'theme' });
			} catch (err) {
				logger.error('Failed to save file:', undefined, err);
				notifyToast({
					type: 'error',
					title: 'Save Failed',
					message: err instanceof Error ? err.message : 'Could not save file.',
				});
			} finally {
				setIsSaving(false);
			}
		}, [file, onSave, hasChanges, isSaving, editContent, sshRemoteId]);

		// Open the previewed image in the annotator. The annotator hands back a
		// composited data URL via onSave; we stash it and let the user pick a save
		// destination (overwrite vs new file) before writing to disk.
		const handleEditImage = useCallback(() => {
			if (!file || !isImage) return;
			openAnnotator(file.content, (newDataUrl) => setImageSaveData(newDataUrl));
		}, [file, isImage, openAnnotator]);

		// Format the annotator exports, derived from its data URL mime
		// (e.g. "data:image/png;base64,..." -> "png"). The annotator only ever
		// produces PNG, but we read it from the payload to stay honest.
		const editedImageExtension = useMemo(() => {
			if (!imageSaveData) return 'png';
			const match = /^data:image\/([a-z0-9.+-]+)/i.exec(imageSaveData);
			const sub = match?.[1]?.toLowerCase();
			if (!sub) return 'png';
			if (sub === 'svg+xml') return 'svg';
			if (sub === 'jpeg') return 'jpg';
			return sub;
		}, [imageSaveData]);

		// Original file's normalized extension. Overwrite-in-place is only valid
		// when it matches the editor's output format; otherwise we'd be writing
		// (PNG) bytes under a misleading extension.
		const originalImageExtension = useMemo(() => {
			if (!file) return '';
			const ext = (getBasename(file.name).split('.').pop() ?? '').toLowerCase();
			return ext === 'jpeg' ? 'jpg' : ext;
		}, [file]);

		const canOverwriteImage = originalImageExtension === editedImageExtension;

		// Sibling name used when the original format can't be reproduced
		// (e.g. photo.jpg -> photo.png).
		const imageFallbackName = useMemo(() => {
			if (!file) return '';
			const name = getBasename(file.name);
			const dot = name.lastIndexOf('.');
			const base = dot > 0 ? name.slice(0, dot) : name;
			return `${base}.${editedImageExtension}`;
		}, [file, editedImageExtension]);

		// Build a path for a file sitting next to the previewed one, preserving
		// the original path's separator style (Windows vs POSIX).
		const siblingImagePath = useCallback(
			(name: string): string => {
				const basePath = file?.path ?? '';
				const parent = getParentDir(basePath);
				const sep = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/';
				return `${parent}${sep}${name}`;
			},
			[file?.path]
		);

		const writeEditedImage = useCallback(
			async (targetPath: string, reloadAfter: boolean, flashMessage = 'Image Saved') => {
				if (!imageSaveData) return;
				setImageSaveBusy(true);
				try {
					await window.maestro.fs.writeImageFile(targetPath, imageSaveData, sshRemoteId);
					// Keep our own write from tripping the file-change poller.
					try {
						const stat = await window.maestro?.fs?.stat(targetPath, sshRemoteId);
						if (stat?.modifiedAt && reloadAfter) {
							lastModifiedRef.current = new Date(stat.modifiedAt).getTime();
						}
					} catch {
						// Non-critical - worst case the change banner flashes briefly.
					}
					setImageSaveData(null);
					notifyCenterFlash({ message: flashMessage, color: 'theme' });
					// Overwrite changes the file we're viewing - refresh so the preview
					// reflects the edited pixels. A new file leaves the original intact.
					if (reloadAfter) onReloadFile?.();
				} catch (err) {
					logger.error('Failed to save edited image:', undefined, err);
					notifyToast({
						type: 'error',
						title: 'Save Failed',
						message: err instanceof Error ? err.message : 'Could not save the edited image.',
					});
				} finally {
					setImageSaveBusy(false);
				}
			},
			[imageSaveData, sshRemoteId, onReloadFile]
		);

		const handleOverwriteImage = useCallback(() => {
			if (!file) return;
			if (canOverwriteImage) {
				void writeEditedImage(file.path, true);
				return;
			}
			// Can't reproduce the original format - write a sibling file in the
			// editor's format instead and tell the user what landed where.
			void writeEditedImage(
				siblingImagePath(imageFallbackName),
				false,
				`Saved as ${imageFallbackName}`
			);
		}, [file, canOverwriteImage, imageFallbackName, siblingImagePath, writeEditedImage]);

		const handleSaveImageAs = useCallback(
			(newName: string) => {
				if (!file) return;
				const targetPath = siblingImagePath(newName);
				const isNewPath = getBasename(targetPath) !== getBasename(file.path);
				void writeEditedImage(targetPath, !isNewPath, `Saved as ${newName}`);
			},
			[file, siblingImagePath, writeEditedImage]
		);

		// Track scroll position to show/hide stats bar and report changes
		useEffect(() => {
			const contentEl = contentRef.current;
			if (!contentEl) return;

			const handleScroll = () => {
				// Show stats bar when scrolled to top (within 10px), hide otherwise
				setShowStatsBar(contentEl.scrollTop <= 10);

				// Throttled scroll position save (200ms) - same timing as TerminalOutput
				if (onScrollPositionChange) {
					if (scrollSaveTimerRef.current) {
						clearTimeout(scrollSaveTimerRef.current);
					}
					scrollSaveTimerRef.current = setTimeout(() => {
						onScrollPositionChange(contentEl.scrollTop);
						scrollSaveTimerRef.current = null;
					}, 200);
				}
			};

			contentEl.addEventListener('scroll', handleScroll, { passive: true });
			return () => {
				contentEl.removeEventListener('scroll', handleScroll);
				// Clear any pending scroll save timer
				if (scrollSaveTimerRef.current) {
					clearTimeout(scrollSaveTimerRef.current);
					scrollSaveTimerRef.current = null;
				}
			};
		}, [onScrollPositionChange]);

		// Restore scroll position when initialScrollTop is provided (file tab switching)
		// Use a ref to track if we've already restored for this file to avoid re-scrolling on re-renders
		const hasRestoredScrollRef = useRef<string | null>(null);
		useEffect(() => {
			const contentEl = contentRef.current;
			if (!contentEl || !file?.path) return;

			// Only restore if this is a new file and we have a scroll position to restore
			if (
				initialScrollTop !== undefined &&
				initialScrollTop > 0 &&
				hasRestoredScrollRef.current !== file.path
			) {
				// Use requestAnimationFrame to ensure DOM is ready
				requestAnimationFrame(() => {
					contentEl.scrollTop = initialScrollTop;
				});
				hasRestoredScrollRef.current = file.path;
			} else if (hasRestoredScrollRef.current !== file.path) {
				// New file without saved scroll position - reset to top
				hasRestoredScrollRef.current = file.path;
			}
		}, [file?.path, initialScrollTop]);

		// Auto-focus on mount and when file changes so keyboard shortcuts work immediately
		useEffect(() => {
			containerRef.current?.focus();
			// Close TOC overlay when file changes
			setShowTocOverlay(false);
		}, [file?.path]); // Run on mount and when navigating to a different file

		// Helper to handle escape key - shows confirmation modal if there are unsaved changes
		// In tab mode: Escape only closes internal UI (search, TOC), not the tab itself
		// Tabs close via Cmd+W or clicking the close button, not Escape
		const handleEscapeRequest = useCallback(() => {
			if (showTocOverlay) {
				setShowTocOverlay(false);
				containerRef.current?.focus();
			} else if (searchOpen) {
				setSearchOpen(false);
				setSearchQuery('');
				setSearchMode('text');
				setJqError(null);
				// Refocus container so keyboard navigation (arrow keys) still works
				containerRef.current?.focus();
			} else if (!isTabMode) {
				// Only close the preview if NOT in tab mode (overlay behavior)
				// Tabs should not close on Escape - use Cmd+W or close button
				if (hasChanges) {
					// Show confirmation modal if there are unsaved changes
					setShowUnsavedChangesModal(true);
				} else {
					onClose();
				}
			}
			// In tab mode with no internal UI open, Escape does nothing
		}, [showTocOverlay, searchOpen, hasChanges, onClose, isTabMode]);

		// Register layer on mount - only for overlay mode (not tab mode)
		// Tab mode: File preview is part of the main panel content, not an overlay
		// It doesn't need layer registration since it doesn't block keyboard shortcuts or need focus trapping
		// Note: handleEscapeRequest is intentionally NOT in the dependency array to prevent
		// infinite re-registration loops when its dependencies (hasChanges, searchOpen) change.
		// The subsequent useEffect with updateLayerHandler handles keeping the handler current.
		useEffect(() => {
			// Skip layer registration entirely in tab mode - tabs are main content, not overlays
			if (isTabMode) {
				return;
			}

			layerIdRef.current = registerLayer({
				type: 'overlay',
				priority: MODAL_PRIORITIES.FILE_PREVIEW,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'lenient',
				ariaLabel: 'File Preview',
				onEscape: handleEscapeRequest,
				allowClickOutside: false,
			});

			return () => {
				if (layerIdRef.current) {
					unregisterLayer(layerIdRef.current);
				}
			};
		}, [registerLayer, unregisterLayer, isTabMode]);

		// Update handler when dependencies change (only for overlay mode)
		useEffect(() => {
			if (layerIdRef.current && !isTabMode) {
				updateLayerHandler(layerIdRef.current, handleEscapeRequest);
			}
		}, [handleEscapeRequest, updateLayerHandler, isTabMode]);

		// Click outside to dismiss (same behavior as Escape)
		// Use delay to prevent the click that opened the preview from immediately closing it
		// Disable click-outside in tab mode - tabs should only close via explicit user action
		useClickOutside(containerRef, handleEscapeRequest, !!file && !isTabMode, { delay: true });

		// Click outside ToC overlay to dismiss (exclude both overlay and the toggle button)
		// Use delay to prevent the click that opened it from immediately closing it
		const closeTocOverlay = useCallback(() => setShowTocOverlay(false), []);
		useClickOutside<HTMLElement>([tocOverlayRef, tocButtonRef], closeTocOverlay, showTocOverlay, {
			delay: true,
		});

		// Code + markdown + edit search highlighting handled by useFilePreviewSearch hook

		const failClipboardToast = (title: string) =>
			notifyToast({
				type: 'error',
				title,
				message: 'Clipboard write was rejected. Check browser permissions and try again.',
			});

		const copyPathToClipboard = async () => {
			if (!file) return;
			try {
				const ok = await safeClipboardWrite(file.path);
				if (ok) {
					flashCopiedToClipboard(file.path, 'File Path Copied');
				} else {
					failClipboardToast('Failed to Copy Path');
				}
			} catch (err) {
				captureException(err);
				failClipboardToast('Failed to Copy Path');
			}
		};

		// Copy a maestro:// deep link that points to the current file at a
		// specific line. Bound to the right-click handler on the editor's line
		// gutter. The link includes the session ID so it reopens in the same
		// agent context where it was captured.
		const copyDeepLinkToLine = useCallback(
			async (lineNumber: number) => {
				if (!file) return;
				const sessionId = useSessionStore.getState().activeSessionId;
				if (!sessionId) {
					notifyToast({
						type: 'error',
						title: 'No active agent',
						message: 'Deep links need an active agent to scope the file to. Select one first.',
					});
					return;
				}
				const url = buildFileDeepLink(sessionId, file.path, lineNumber);
				try {
					const ok = await safeClipboardWrite(url);
					if (ok) {
						flashCopiedToClipboard(url, `Deep Link Copied (L${lineNumber})`);
					} else {
						failClipboardToast('Failed to Copy Deep Link');
					}
				} catch (err) {
					captureException(err);
					failClipboardToast('Failed to Copy Deep Link');
				}
			},
			[file]
		);

		const copyContentToClipboard = async () => {
			if (!file) return;
			if (isImage) {
				const ok = await safeClipboardWriteImage(file.content);
				if (ok) {
					flashCopiedToClipboard(undefined, 'Image Copied');
				} else {
					failClipboardToast('Failed to Copy Image');
				}
			} else {
				const ok = await safeClipboardWrite(file.content);
				if (ok) {
					flashCopiedToClipboard(undefined, 'Content Copied');
				} else {
					failClipboardToast('Failed to Copy Content');
				}
			}
		};

		// Helper to check if a shortcut matches
		const isShortcut = (e: React.KeyboardEvent, shortcutId: string) => {
			const shortcut = shortcuts[shortcutId];
			if (!shortcut) return false;

			const hasModifier = (key: string) => {
				if (key === 'Meta') return e.metaKey;
				if (key === 'Ctrl') return e.ctrlKey;
				if (key === 'Alt') return e.altKey;
				if (key === 'Shift') return e.shiftKey;
				return false;
			};

			const modifiers = shortcut.keys.filter((k: string) =>
				['Meta', 'Ctrl', 'Alt', 'Shift'].includes(k)
			);
			const mainKey = shortcut.keys.find(
				(k: string) => !['Meta', 'Ctrl', 'Alt', 'Shift'].includes(k)
			);

			const modifiersMatch = modifiers.every((m: string) => hasModifier(m));
			const keyMatches = mainKey?.toLowerCase() === e.key.toLowerCase();

			return modifiersMatch && keyMatches;
		};

		// Handle keyboard events
		const handleKeyDown = (e: React.KeyboardEvent) => {
			// Handle Escape key - dismiss overlays in priority order
			// In tab mode, layer system isn't registered, so we handle Escape directly here
			if (e.key === 'Escape') {
				if (showTocOverlay) {
					e.preventDefault();
					e.stopPropagation();
					setShowTocOverlay(false);
					containerRef.current?.focus();
					return;
				}
				if (searchOpen) {
					e.preventDefault();
					e.stopPropagation();
					setSearchOpen(false);
					setSearchQuery('');
					setSearchMode('text');
					setJqError(null);
					containerRef.current?.focus();
					return;
				}
				// If not in tab mode and nothing is open, let the layer system handle it
				// (for overlay mode close behavior)
				return;
			}

			if (e.key.toLowerCase() === 'f' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
				e.preventDefault();
				e.stopPropagation();
				// All three tiers (Rich / Fast / Giant) now share the same search
				// bar. Giant tier exposes findInContent/scrollToMatch through its
				// adapter so the count + navigation flow through the same UI.
				// Cmd+Shift+F is goToFiles — let it bubble to the global handler.
				setSearchOpen(true);
				setTimeout(() => searchInputRef.current?.focus(), 0);
			} else if (
				e.key === 's' &&
				(e.metaKey || e.ctrlKey) &&
				isEditableText &&
				(markdownEditMode || hasChanges)
			) {
				// Cmd+S to save — works in edit mode, and also in preview when there
				// are still unsaved edits from a prior edit session.
				e.preventDefault();
				e.stopPropagation();
				handleSave();
			} else if (isShortcut(e, 'copyFilePath')) {
				e.preventDefault();
				e.stopPropagation();
				copyPathToClipboard();
				onShortcutUsed?.('copyFilePath');
			} else if (isEditableText && isShortcut(e, 'toggleMarkdownMode')) {
				e.preventDefault();
				e.stopPropagation();
				setMarkdownEditMode(!markdownEditMode);
			} else if (isImage && isShortcut(e, 'toggleMarkdownMode')) {
				// Cmd+E on an image jumps straight into the annotator (the image
				// "editor"), mirroring how the same shortcut opens the text editor.
				e.preventDefault();
				e.stopPropagation();
				handleEditImage();
			} else if (
				isShortcut(e, 'toggleFilePreviewToc') &&
				isMarkdown &&
				!markdownEditMode &&
				tocEntries.length > 0
			) {
				e.preventDefault();
				e.stopPropagation();
				setShowTocOverlay((v) => {
					// Restore focus to the preview container when closing so subsequent
					// shortcuts keep firing (heading button is about to unmount).
					if (v) containerRef.current?.focus();
					return !v;
				});
				onShortcutUsed?.('toggleFilePreviewToc');
			} else if (e.key === 'ArrowUp') {
				// In edit mode, let the textarea handle arrow keys for cursor movement
				// Only intercept when NOT in edit mode (preview/code view)
				if (isEditableText && markdownEditMode) return;

				// Don't scroll the preview when logical focus is elsewhere (e.g. the
				// file panel, where the same arrow keys navigate the file list). The
				// FilePreview container keeps DOM focus across activeFocus changes
				// because shortcuts like Cmd+Shift+F move logical focus only.
				if (useUIStore.getState().activeFocus !== 'main') return;

				e.preventDefault();
				const container = contentRef.current;
				if (!container) return;

				if (e.metaKey || e.ctrlKey) {
					// Cmd/Ctrl + Up: Jump to top
					container.scrollTop = 0;
				} else if (e.altKey) {
					// Alt + Up: Page up
					container.scrollTop -= container.clientHeight;
				} else {
					// Arrow Up: Scroll up
					container.scrollTop -= 40;
				}
			} else if (e.key === 'ArrowDown') {
				// In edit mode, let the textarea handle arrow keys for cursor movement
				// Only intercept when NOT in edit mode (preview/code view)
				if (isEditableText && markdownEditMode) return;

				if (useUIStore.getState().activeFocus !== 'main') return;

				e.preventDefault();
				const container = contentRef.current;
				if (!container) return;

				if (e.metaKey || e.ctrlKey) {
					// Cmd/Ctrl + Down: Jump to bottom
					container.scrollTop = container.scrollHeight;
				} else if (e.altKey) {
					// Alt + Down: Page down
					container.scrollTop += container.clientHeight;
				} else {
					// Arrow Down: Scroll down
					container.scrollTop += 40;
				}
			} else if (e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
				// Cmd+Left: Navigate back in history (disabled in edit mode)
				if (isEditableText && markdownEditMode) return;
				e.preventDefault();
				e.stopPropagation();
				if (canGoBack && onNavigateBack) {
					onNavigateBack();
					onShortcutUsed?.('filePreviewBack');
				}
			} else if (e.key === 'ArrowRight' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
				// Cmd+Right: Navigate forward in history (disabled in edit mode)
				if (isEditableText && markdownEditMode) return;
				e.preventDefault();
				e.stopPropagation();
				if (canGoForward && onNavigateForward) {
					onNavigateForward();
					onShortcutUsed?.('filePreviewForward');
				}
			} else if (
				e.key === 'g' &&
				(e.metaKey || e.ctrlKey) &&
				e.shiftKey &&
				isMarkdown &&
				onOpenInGraph
			) {
				// Cmd+Shift+G: Open Document Graph focused on this file (markdown files only)
				// Must come before fuzzyFileSearch check since isShortcut doesn't check for extra modifiers
				e.preventDefault();
				e.stopPropagation();
				onOpenInGraph();
			} else if (isShortcut(e, 'fuzzyFileSearch') && onOpenFuzzySearch) {
				// Cmd+G: Open fuzzy file search (only in preview mode, not edit mode)
				if (isEditableText && markdownEditMode) return;
				e.preventDefault();
				e.stopPropagation();
				onOpenFuzzySearch();
			} else if (e.key === 'c' && (e.metaKey || e.ctrlKey) && isImage) {
				// Cmd+C: Copy image to clipboard when viewing an image
				e.preventDefault();
				e.stopPropagation();
				copyContentToClipboard().catch(captureException);
			}
		};

		// Early return if no file - must be after all hooks
		if (!file) return null;

		return (
			<div
				ref={containerRef}
				className="flex flex-col h-full outline-none"
				style={{ backgroundColor: theme.colors.bgMain }}
				tabIndex={0}
				onKeyDown={handleKeyDown}
			>
				{/* CSS for Custom Highlight API */}
				<style>{`
        ::highlight(search-results) {
          background-color: #ffd700;
          color: #000;
        }
        ::highlight(search-current) {
          background-color: ${theme.colors.accent};
          color: #fff;
        }
      `}</style>

				{/* Header */}
				<FilePreviewHeader
					file={file}
					theme={theme}
					isMarkdown={isMarkdown}
					isImage={isImage}
					isEditableText={isEditableText}
					markdownEditMode={markdownEditMode}
					showRemoteImages={showRemoteImages}
					setShowRemoteImages={setShowRemoteImages}
					setMarkdownEditMode={setMarkdownEditMode}
					onSave={onSave ? handleSave : undefined}
					hasChanges={hasChanges}
					isSaving={isSaving}
					fileStats={fileStats}
					tokenCount={tokenCount}
					taskCounts={taskCounts}
					showStatsBar={showStatsBar}
					directoryPath={directoryPath}
					showPath={showPath}
					shortcuts={shortcuts}
					canGoBack={canGoBack}
					canGoForward={canGoForward}
					onNavigateBack={onNavigateBack}
					onNavigateForward={onNavigateForward}
					backHistory={backHistory}
					forwardHistory={forwardHistory}
					onNavigateToIndex={onNavigateToIndex}
					currentHistoryIndex={currentHistoryIndex}
					ghCliAvailable={ghCliAvailable}
					onPublishGist={onPublishGist}
					hasGist={hasGist}
					onOpenInGraph={onOpenInGraph}
					onOpenInBrowser={onOpenInBrowser}
					sshRemoteId={sshRemoteId}
					copyContentToClipboard={copyContentToClipboard}
					copyPathToClipboard={copyPathToClipboard}
					onEditImage={isImage ? handleEditImage : undefined}
					headerBtnClass={headerBtnClass}
					headerIconClass={headerIconClass}
					isHtml={isHtml}
					htmlRenderMode={htmlRenderMode}
					setHtmlRenderMode={(v) => onHtmlRenderModeChange?.(v)}
					showTierChip={
						!markdownEditMode &&
						!isImage &&
						!isBinary &&
						!(isHtml && htmlRenderMode) &&
						(isMarkdown || isReadableText || isCodeFile(language)) &&
						!!file
					}
					autoTier={autoTier}
					previewTierOverride={previewTierOverride}
					onPreviewTierChange={onPreviewTierChange}
					wordWrap={fileEditWordWrap}
					setWordWrap={setFileEditWordWrap}
					toolbarVisibility={filePreviewToolbarVisibility}
				/>

				{/* File changed on disk banner */}
				{fileChangedOnDisk && (
					<div
						className="flex items-center gap-3 px-6 py-2 border-b shrink-0"
						style={{
							backgroundColor: theme.colors.accent + '15',
							borderColor: theme.colors.accent + '40',
						}}
					>
						<RefreshCw className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
						<span className="flex-1 text-xs" style={{ color: theme.colors.textMain }}>
							{hasChanges
								? 'File changed on disk. You have unsaved edits — reloading will discard them.'
								: 'File changed on disk.'}
						</span>
						<div className="flex items-center gap-2 shrink-0">
							<button
								onClick={handleReloadFile}
								className="px-2 py-1 text-xs font-medium rounded hover:opacity-80 transition-opacity"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground ?? '#000',
								}}
							>
								Reload
							</button>
							<GhostIconButton onClick={() => setFileChangedOnDisk(false)} title="Dismiss">
								<X className="w-3 h-3" style={{ color: theme.colors.textDim }} />
							</GhostIconButton>
						</div>
					</div>
				)}

				{/* File no longer on disk banner (deleted or moved/renamed elsewhere) */}
				{fileMissingOnDisk && (
					<div
						className="flex items-center gap-3 px-6 py-2 border-b shrink-0"
						style={{
							backgroundColor: theme.colors.warning + '15',
							borderColor: theme.colors.warning + '40',
						}}
					>
						<AlertTriangle
							className="w-3.5 h-3.5 shrink-0"
							style={{ color: theme.colors.warning }}
						/>
						<span className="flex-1 text-xs" style={{ color: theme.colors.textMain }}>
							This file no longer exists at its original location. It may have been deleted or
							moved.
							{hasChanges ? ' Saving will prompt you for a new location.' : ''}
						</span>
						<div className="flex items-center gap-2 shrink-0">
							<button
								onClick={() => setFileMissingOnDisk(false)}
								className="px-2 py-1 text-xs font-medium rounded hover:opacity-80 transition-opacity"
								style={{
									backgroundColor: theme.colors.warning,
									color: theme.colors.accentForeground ?? '#000',
								}}
							>
								Dismiss
							</button>
						</div>
					</div>
				)}

				{/* Content - isolated scroll to prevent scroll chaining */}
				<div
					ref={contentRef}
					className="flex-1 overflow-y-auto px-6 pt-3 pb-6 scrollbar-thin"
					style={{ overscrollBehavior: 'contain' }}
				>
					{/* Floating Search */}
					{searchOpen && (
						<div className="sticky top-0 z-10 pb-4" ref={jqHelpRef}>
							<div className="relative">
								<div className="flex items-center gap-2">
									{/* jq mode toggle for JSON/JSONL files */}
									{supportsJq && (
										<button
											onClick={() => {
												const next = searchMode === 'text' ? 'jq' : 'text';
												setSearchMode(next);
												setSearchQuery('');
												setShowJqHelp(false);
												setJqError(null);
												setTimeout(() => searchInputRef.current?.focus(), 0);
											}}
											className="flex items-center gap-1 px-2 rounded border text-xs font-medium whitespace-nowrap transition-colors self-stretch"
											style={{
												borderColor:
													searchMode === 'jq' ? theme.colors.accent : theme.colors.border,
												backgroundColor:
													searchMode === 'jq' ? theme.colors.accent + '20' : theme.colors.bgSidebar,
												color: searchMode === 'jq' ? theme.colors.accent : theme.colors.textDim,
											}}
											title={searchMode === 'jq' ? 'Switch to text search' : 'Switch to jq filter'}
										>
											<Filter className="w-3 h-3" />
											jq
										</button>
									)}
									{/* Search-kind chip: plain text → regex → line number.
									    Only shown for line-numbered code/text views. */}
									{searchMode !== 'jq' && viewHasLineNumbers && (
										<button
											onClick={() => {
												cycleSearchKind();
												setTimeout(() => searchInputRef.current?.focus(), 0);
											}}
											className="flex items-center gap-1 px-2 rounded border text-xs font-medium whitespace-nowrap transition-colors self-stretch"
											style={{
												borderColor:
													searchKind === 'text' ? theme.colors.border : theme.colors.accent,
												backgroundColor:
													searchKind === 'text'
														? theme.colors.bgSidebar
														: theme.colors.accent + '20',
												color: searchKind === 'text' ? theme.colors.textDim : theme.colors.accent,
											}}
											title={
												searchKind === 'text'
													? 'Plain-text search (click to switch to regex)'
													: searchKind === 'regex'
														? 'Regex search (click to switch to line-number jump)'
														: 'Go to line (click to switch to plain-text search)'
											}
										>
											{searchKind === 'text' ? (
												<Type className="w-3 h-3" />
											) : searchKind === 'regex' ? (
												<Regex className="w-3 h-3" />
											) : (
												<Hash className="w-3 h-3" />
											)}
											{searchKind === 'text' ? 'Text' : searchKind === 'regex' ? 'Regex' : 'Line'}
										</button>
									)}
									<input
										ref={searchInputRef}
										type="text"
										value={searchQuery}
										onChange={(e) => setSearchQuery(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === 'Escape') {
												e.preventDefault();
												e.stopPropagation();
												if (showJqHelp) {
													setShowJqHelp(false);
												} else {
													setSearchOpen(false);
													setSearchQuery('');
													setSearchMode('text');
													setJqError(null);
													containerRef.current?.focus();
												}
											} else if (searchMode === 'text' && searchKind !== 'line') {
												if (e.key === 'Enter' && !e.shiftKey) {
													e.preventDefault();
													goToNextMatch();
												} else if (e.key === 'Enter' && e.shiftKey) {
													e.preventDefault();
													goToPrevMatch();
												}
											}
										}}
										onFocus={() => {
											if (searchMode === 'jq' && !searchQuery) setShowJqHelp(true);
										}}
										placeholder={
											searchMode === 'jq'
												? 'jq filter — .field, select(.x == "y"), keys, contains("...")'
												: searchKind === 'line'
													? 'Go to line number…'
													: searchKind === 'regex'
														? 'Search by regex... (Enter: next, Shift+Enter: prev)'
														: 'Search in file... (Enter: next, Shift+Enter: prev)'
										}
										className="flex-1 px-3 py-2 rounded border bg-transparent outline-none text-sm"
										style={{
											borderColor:
												searchMode === 'jq'
													? jqError
														? theme.colors.error + '80'
														: searchQuery
															? theme.colors.accent + '60'
															: theme.colors.border
													: regexError
														? theme.colors.error + '80'
														: theme.colors.accent,
											color: theme.colors.textMain,
											backgroundColor: theme.colors.bgSidebar,
											fontFamily:
												searchMode === 'jq'
													? 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
													: undefined,
											fontSize: searchMode === 'jq' ? '12px' : undefined,
										}}
										spellCheck={searchMode === 'jq' ? false : undefined}
										autoFocus
									/>
									{/* Text / regex search: match count + prev/next navigation
									    (line-number mode jumps live and shows no match chrome) */}
									{searchMode === 'text' && searchKind !== 'line' && searchQuery.trim() && (
										<>
											<span
												className="text-xs whitespace-nowrap"
												style={{ color: theme.colors.textDim }}
											>
												{totalMatches > 0
													? `${currentMatchIndex + 1}/${totalMatches}`
													: 'No matches'}
											</span>
											<button
												onClick={goToPrevMatch}
												disabled={totalMatches === 0}
												className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-30"
												style={{ color: theme.colors.textDim }}
												title="Previous match (Shift+Enter)"
											>
												<ChevronUp className="w-4 h-4" />
											</button>
											<button
												onClick={goToNextMatch}
												disabled={totalMatches === 0}
												className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-30"
												style={{ color: theme.colors.textDim }}
												title="Next match (Enter)"
											>
												<ChevronDown className="w-4 h-4" />
											</button>
										</>
									)}
									{/* jq mode: clear button + help toggle */}
									{searchMode === 'jq' && (
										<>
											{searchQuery && (
												<button
													onClick={() => {
														setSearchQuery('');
														searchInputRef.current?.focus();
													}}
													className="p-1 rounded hover:bg-white/10 transition-colors"
													style={{ color: theme.colors.textDim }}
													title="Clear filter"
												>
													<X className="w-3.5 h-3.5" />
												</button>
											)}
											<button
												onClick={() => setShowJqHelp((p) => !p)}
												className="flex items-center justify-center px-2 rounded border text-xs font-medium transition-colors self-stretch"
												style={{
													borderColor: showJqHelp ? theme.colors.accent : theme.colors.border,
													backgroundColor: showJqHelp
														? theme.colors.accent + '20'
														: theme.colors.bgSidebar,
													color: showJqHelp ? theme.colors.accent : theme.colors.textDim,
												}}
												title="Show syntax help"
											>
												?
											</button>
										</>
									)}
								</div>
								{/* regex error */}
								{searchMode !== 'jq' && searchKind === 'regex' && regexError && (
									<div
										className="mt-1 px-2 py-1 rounded text-xs"
										style={{ color: theme.colors.error }}
									>
										{regexError}
									</div>
								)}
								{/* jq error */}
								{searchMode === 'jq' && jqError && (
									<div
										className="mt-1 px-2 py-1 rounded text-xs"
										style={{ color: theme.colors.error }}
									>
										{jqError}
									</div>
								)}
								{/* jq syntax help popup */}
								{searchMode === 'jq' && showJqHelp && (
									<div
										className="absolute top-full left-0 right-0 mt-1 rounded-lg shadow-xl overflow-hidden z-50"
										style={{
											backgroundColor: theme.colors.bgSidebar,
											border: `1px solid ${theme.colors.border}`,
										}}
									>
										<div
											className="px-3 py-2 text-xs font-medium"
											style={{
												color: theme.colors.textDim,
												borderBottom: `1px solid ${theme.colors.border}`,
											}}
										>
											jq Filter Syntax
										</div>
										<div className="max-h-64 overflow-y-auto scrollbar-thin">
											{SYNTAX_EXAMPLES.map(({ expr, desc }) => (
												<button
													key={expr}
													className="w-full flex items-center gap-3 px-3 py-1.5 text-left hover:bg-white/5 transition-colors"
													onClick={() => {
														setSearchQuery(expr);
														setShowJqHelp(false);
														searchInputRef.current?.focus();
													}}
												>
													<code
														className="flex-shrink-0 px-1.5 py-0.5 rounded text-xs"
														style={{
															backgroundColor: theme.colors.accent + '20',
															color: theme.colors.accent,
															fontFamily:
																'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
														}}
													>
														{expr}
													</code>
													<span
														className="text-xs truncate"
														style={{ color: theme.colors.textDim }}
													>
														{desc}
													</span>
												</button>
											))}
										</div>
									</div>
								)}
							</div>
						</div>
					)}
					{isImage ? (
						<ImageViewer src={file.content} alt={file.name} theme={theme} />
					) : isBinary ? (
						<div className="flex flex-col items-center justify-center h-full gap-4">
							<FileCode className="w-16 h-16" style={{ color: theme.colors.textDim }} />
							<div className="text-center">
								<p className="text-lg font-medium" style={{ color: theme.colors.textMain }}>
									Binary File
								</p>
								<p className="text-sm mt-1" style={{ color: theme.colors.textDim }}>
									This file cannot be displayed as text.
								</p>
								{/* "Open in default app" hands the file to the HOST machine's OS
								    opener via the shell bridge. In the web-desktop build the host
								    is not the browser user's device, so the button is disabled with
								    an explaining tooltip instead of silently acting on the wrong
								    machine. */}
								<button
									disabled={isWebDesktop()}
									title={isWebDesktop() ? 'Available in the desktop app' : undefined}
									onClick={async () => {
										if (isWebDesktop()) return;
										// Local files open in place. Remote files don't exist on this
										// machine, so download a binary-safe copy to a temp dir over SSH
										// first, then hand the local path to the OS opener.
										if (!sshRemoteId) {
											void window.maestro.shell.openPath(file.path);
											return;
										}
										try {
											notifyCenterFlash({ message: 'Downloading…', color: 'theme' });
											const { path: localPath } = await window.maestro.fs.downloadRemoteFile(
												file.path,
												sshRemoteId
											);
											await window.maestro.shell.openPath(localPath);
										} catch (error) {
											notifyToast({
												color: 'red',
												title: 'Open failed',
												message:
													error instanceof Error
														? error.message
														: 'Could not download the remote file',
											});
										}
									}}
									className="mt-4 px-4 py-2 rounded text-sm hover:opacity-80 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:opacity-50"
									style={{
										backgroundColor: theme.colors.accent,
										color: theme.colors.accentForeground,
									}}
								>
									{sshRemoteId ? 'Download & Open' : 'Open in Default App'}
								</button>
							</div>
						</div>
					) : isEditableText && markdownEditMode ? (
						// Edit mode - CodeMirror 6 editor for any text file.
						// Key on file path so switching files remounts the editor —
						// keeps each file's undo history isolated (the previous
						// textarea-based implementation got that "for free" since
						// changing value reset the input).
						<MarkdownEditor
							key={file.path}
							ref={editorRef}
							value={editContent}
							onChange={setEditContent}
							language={language}
							theme={theme}
							spellCheck={spellCheckEnabled}
							wrap={fileEditWordWrap}
							showLineNumbers={fileEditShowLineNumbers}
							onLineNumberContextMenu={(lineNumber, event) => {
								setLineCtxMenu({
									lineNumber,
									x: event.clientX,
									y: event.clientY,
								});
							}}
							onKeyDown={(e) => {
								// CodeMirror's defaultKeymap already binds Cmd/Ctrl+ArrowUp/Down
								// to doc start/end, PageUp/PageDown for paging, and the usual
								// selection / word-jump shortcuts — no need to reimplement them
								// against a textarea ref. We only intercept the app-level
								// shortcuts (save, exit edit mode, toggle preview/edit).
								//
								// `e` here is a native KeyboardEvent forwarded by CodeMirror's
								// dom handler. isShortcut only reads modifier/key fields that
								// exist on both native and React events, so the cast is safe.
								if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									e.stopPropagation();
									handleSave();
								} else if (e.key === 'Escape') {
									e.preventDefault();
									e.stopPropagation();
									setMarkdownEditMode(false);
								} else if (isShortcut(e as unknown as React.KeyboardEvent, 'toggleMarkdownMode')) {
									// Handle the toggle here too: while the CodeMirror
									// contenteditable holds focus, relying on the keydown to
									// bubble out to the container handler is unreliable, so the
									// editor → preview direction would silently no-op until the
									// user clicked elsewhere. Toggling directly keeps Cmd+E
									// working both ways without a focus round-trip.
									e.preventDefault();
									e.stopPropagation();
									setMarkdownEditMode(false);
								}
							}}
						/>
					) : isHtml && htmlRenderMode && !markdownEditMode ? (
						// Rendered HTML preview. Feeds file.content into an iframe via
						// srcDoc so local and SSH-remote files work the same way — the
						// bytes are already in memory. Sandbox lets scripts/popups/forms
						// run but withholds same-origin so the page cannot reach the host
						// renderer.
						<iframe
							title={file.name}
							srcDoc={file.content}
							sandbox="allow-scripts allow-popups allow-forms"
							referrerPolicy="no-referrer"
							data-testid="html-render-iframe"
							style={{
								width: '100%',
								height: '100%',
								minHeight: '60vh',
								border: 'none',
								backgroundColor: '#fff',
							}}
						/>
					) : isMermaid && !markdownEditMode ? (
						// Rendered Mermaid diagram. Reuses the same theme-aware,
						// DOMPurify-sanitized renderer that draws ```mermaid``` blocks
						// inside markdown. Cmd+E toggles to source editing.
						<div className="p-4">
							<MermaidRenderer chart={file.content} theme={theme} />
						</div>
					) : isCsv && !markdownEditMode ? (
						<CsvTableRenderer
							content={file.content}
							theme={theme}
							delimiter={csvDelimiter}
							searchQuery={searchQuery}
							onMatchCount={setMatchCount}
						/>
					) : (isJsonl || (isJson && searchMode === 'jq')) && !markdownEditMode ? (
						<JsonlViewer
							content={file.content}
							theme={theme}
							parseMode={isJson ? 'json' : 'jsonl'}
							searchQuery={searchMode === 'text' ? searchQuery : undefined}
							jqFilter={searchMode === 'jq' ? searchQuery : undefined}
							onMatchCount={searchMode === 'text' ? setMatchCount : undefined}
							onJqError={setJqError}
						/>
					) : previewTier === 'giant' && !markdownEditMode && !isImage && !isBinary ? (
						<Suspense
							fallback={
								<div
									style={{
										padding: '24px',
										color: theme.colors.textDim,
										fontSize: '13px',
									}}
								>
									Loading giant preview…
								</div>
							}
						>
							<GiantPreview
								ref={giantRef}
								content={file.content}
								language={language}
								theme={theme}
								containerRef={markdownContainerRef}
								filePath={file.path}
							/>
						</Suspense>
					) : isMarkdown && previewTier === 'fast' && !markdownEditMode ? (
						<Suspense
							fallback={
								<div
									style={{
										padding: '24px',
										color: theme.colors.textDim,
										fontSize: '13px',
									}}
								>
									Loading fast preview…
								</div>
							}
						>
							<MarkdownPreviewFast
								ref={markdownFastRef}
								content={file.content}
								theme={theme}
								markdownContainerRef={markdownContainerRef}
								fileTreeIndices={fileTreeIndices}
								cwd={cwd}
								homeDir={homeDir}
								filePath={file.path}
								onFileClick={onFileClick}
								onExternalLinkClick={handleExternalLinkClick}
							/>
						</Suspense>
					) : isMarkdown ? (
						<div
							ref={markdownContainerRef}
							className="file-preview-content prose prose-sm max-w-none"
							style={{ color: theme.colors.textMain }}
						>
							{/* Scoped prose styles to avoid CSS conflicts with other prose containers */}
							<style>{`
              .file-preview-content.prose h1 { color: ${theme.colors.accent}; font-size: 2em; font-weight: bold; margin: 0.67em 0; }
              .file-preview-content.prose h2 { color: ${theme.colors.success}; font-size: 1.5em; font-weight: bold; margin: 0.75em 0; }
              .file-preview-content.prose h3 { color: ${theme.colors.warning}; font-size: 1.17em; font-weight: bold; margin: 0.83em 0; }
              .file-preview-content.prose h4 { color: ${theme.colors.textMain}; font-size: 1em; font-weight: bold; margin: 1em 0; opacity: 0.9; }
              .file-preview-content.prose h5 { color: ${theme.colors.textMain}; font-size: 0.83em; font-weight: bold; margin: 1.17em 0; opacity: 0.8; }
              .file-preview-content.prose h6 { color: ${theme.colors.textDim}; font-size: 0.67em; font-weight: bold; margin: 1.33em 0; }
              .file-preview-content.prose p { color: ${theme.colors.textMain}; margin: 0.5em 0; }
              .file-preview-content.prose ul, .file-preview-content.prose ol { color: ${theme.colors.textMain}; margin: 0.5em 0; padding-left: 1.5em; }
              .file-preview-content.prose li { margin: 0.25em 0; }
              .file-preview-content.prose li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.5em; }
              .file-preview-content.prose code { background-color: ${theme.colors.bgActivity}; color: ${theme.colors.textMain}; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
              .file-preview-content.prose pre { background-color: ${theme.colors.bgActivity}; color: ${theme.colors.textMain}; padding: 1em; border-radius: 6px; overflow-x: auto; }
              .file-preview-content.prose pre code { background: none; padding: 0; }
              .file-preview-content.prose blockquote { border-left: 4px solid ${theme.colors.border}; padding-left: 1em; margin: 0.5em 0; color: ${theme.colors.textDim}; }
              .file-preview-content.prose a { color: ${theme.colors.accent}; text-decoration: underline; }
              .file-preview-content.prose hr { border: none; border-top: 2px solid ${theme.colors.border}; margin: 1em 0; }
              .file-preview-content.prose table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
              .file-preview-content.prose th, .file-preview-content.prose td { border: 1px solid ${theme.colors.border}; padding: 0.5em; text-align: left; }
              .file-preview-content.prose th { background-color: ${theme.colors.bgActivity}; font-weight: bold; }
              .file-preview-content.prose strong { font-weight: bold; }
              .file-preview-content.prose em { font-style: italic; }
              .file-preview-content.prose img { display: block; max-width: 100%; height: auto; }
            `}</style>
							<ReactMarkdown
								remarkPlugins={remarkPlugins}
								rehypePlugins={rehypePlugins}
								urlTransform={urlTransformAllowingMaestro}
								components={markdownComponents}
							>
								{file.content}
							</ReactMarkdown>
						</div>
					) : isReadableText && previewTier === 'fast' && !markdownEditMode ? (
						<Suspense
							fallback={
								<div
									style={{
										padding: '24px',
										color: theme.colors.textDim,
										fontSize: '13px',
									}}
								>
									Loading fast preview…
								</div>
							}
						>
							<TextPreviewFast
								ref={textFastRef}
								content={file.content}
								language="text"
								theme={theme}
								containerRef={markdownContainerRef}
								filePath={file.path}
							/>
						</Suspense>
					) : isReadableText && !markdownEditMode ? (
						<div>
							{/* Large file truncation banner (readable text) */}
							{isContentTruncated && (
								<div
									className="px-4 py-2 flex items-center gap-2 text-sm"
									style={{
										backgroundColor: theme.colors.warning + '20',
										borderBottom: `1px solid ${theme.colors.warning}40`,
										color: theme.colors.warning,
									}}
								>
									<AlertTriangle className="w-4 h-4 flex-shrink-0" />
									<span>
										Large file preview truncated. Showing first{' '}
										{formatFileSize(LARGE_FILE_PREVIEW_LIMIT)} of{' '}
										{formatFileSize(file.content.length)}.
									</span>
									<button
										className="px-2 py-0.5 rounded text-xs font-medium hover:brightness-125 transition-all"
										style={{
											backgroundColor: theme.colors.warning + '30',
											border: `1px solid ${theme.colors.warning}60`,
											color: theme.colors.warning,
										}}
										onClick={() => setShowFullContent(true)}
									>
										Load full file
									</button>
								</div>
							)}
							<BionifyTextBlock
								ref={markdownContainerRef}
								className="prose prose-sm max-w-none whitespace-pre-wrap break-words"
								style={{ color: theme.colors.textMain }}
								enabled={effectiveBionifyReadingMode}
								intensity={bionifyIntensity}
								algorithm={bionifyAlgorithm}
								theme={theme}
							>
								{displayContent}
							</BionifyTextBlock>
						</div>
					) : previewTier === 'fast' && !markdownEditMode && !isImage && !isBinary ? (
						<Suspense
							fallback={
								<div
									style={{
										padding: '24px',
										color: theme.colors.textDim,
										fontSize: '13px',
									}}
								>
									Loading fast preview…
								</div>
							}
						>
							<TextPreviewFast
								ref={textFastRef}
								content={file.content}
								language={language}
								theme={theme}
								containerRef={markdownContainerRef}
								filePath={file.path}
							/>
						</Suspense>
					) : (
						<div ref={codeContainerRef}>
							{/* Large file truncation banner */}
							{isContentTruncated && (
								<div
									className="px-4 py-2 flex items-center gap-2 text-sm"
									style={{
										backgroundColor: theme.colors.warning + '20',
										borderBottom: `1px solid ${theme.colors.warning}40`,
										color: theme.colors.warning,
									}}
								>
									<AlertTriangle className="w-4 h-4 flex-shrink-0" />
									<span>
										Large file preview truncated. Showing first{' '}
										{formatFileSize(LARGE_FILE_PREVIEW_LIMIT)} of{' '}
										{formatFileSize(file.content.length)}.
									</span>
									<button
										className="px-2 py-0.5 rounded text-xs font-medium hover:brightness-125 transition-all"
										style={{
											backgroundColor: theme.colors.warning + '30',
											border: `1px solid ${theme.colors.warning}60`,
											color: theme.colors.warning,
										}}
										onClick={() => setShowFullContent(true)}
									>
										Load full file
									</button>
								</div>
							)}
							<SyntaxHighlighter
								language={language}
								style={getSyntaxStyle(theme.mode)}
								customStyle={{
									margin: 0,
									padding: '24px',
									background: 'transparent',
									fontSize: '13px',
								}}
								showLineNumbers
								PreTag="div"
							>
								{displayContent}
							</SyntaxHighlighter>
						</div>
					)}

					{/* Table of Contents */}
					<FilePreviewToc
						theme={theme}
						tocEntries={tocEntries}
						tocWidth={tocWidth}
						showTocOverlay={showTocOverlay}
						setShowTocOverlay={setShowTocOverlay}
						scrollMarkdownToBoundary={scrollMarkdownToBoundary}
						markdownContainerRef={markdownContainerRef}
						tocButtonRef={tocButtonRef}
						tocOverlayRef={tocOverlayRef}
						isMarkdown={isMarkdown}
						markdownEditMode={markdownEditMode}
						onSelectHeading={
							previewTier === 'fast'
								? (slug) => markdownFastRef.current?.scrollToHeading(slug) ?? false
								: undefined
						}
					/>
				</div>

				{/* Copy / save flashes are now rendered globally by <CenterFlash /> */}

				{/* Image-edit save destination modal (overwrite vs new file) */}
				{imageSaveData && file && (
					<ImageSaveModal
						theme={theme}
						fileName={file.name}
						outputExtension={editedImageExtension}
						canOverwrite={canOverwriteImage}
						fallbackFileName={imageFallbackName}
						originalExtension={originalImageExtension}
						onOverwrite={handleOverwriteImage}
						onSaveAs={handleSaveImageAs}
						onCancel={() => setImageSaveData(null)}
						isSaving={imageSaveBusy}
					/>
				)}

				{/* Unsaved Changes Confirmation Modal */}
				{showUnsavedChangesModal && (
					<Modal
						theme={theme}
						title="Unsaved Changes"
						priority={MODAL_PRIORITIES.CONFIRM}
						onClose={() => setShowUnsavedChangesModal(false)}
						width={450}
						zIndex={10000}
						headerIcon={
							<AlertTriangle className="w-5 h-5" style={{ color: theme.colors.warning }} />
						}
						initialFocusRef={cancelButtonRef}
						footer={
							<ModalFooter
								theme={theme}
								onCancel={() => setShowUnsavedChangesModal(false)}
								onConfirm={() => {
									setShowUnsavedChangesModal(false);
									onClose();
								}}
								cancelLabel="No, Stay"
								confirmLabel="Yes, Discard"
								destructive
								cancelButtonRef={cancelButtonRef}
							/>
						}
					>
						<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
							You have unsaved changes. Are you sure you want to close without saving?
						</p>
					</Modal>
				)}

				{/* Line-number gutter right-click menu. Single action: copy a
				    maestro:// deep link pointing at this exact line. */}
				{lineCtxMenu && (
					<>
						<div
							className="fixed inset-0 z-40"
							onClick={() => setLineCtxMenu(null)}
							onContextMenu={(e) => {
								e.preventDefault();
								setLineCtxMenu(null);
							}}
						/>
						<div
							className="fixed z-50 py-1 rounded-md shadow-xl border whitespace-nowrap"
							style={{
								left: lineCtxMenu.x,
								top: lineCtxMenu.y,
								backgroundColor: theme.colors.bgSidebar,
								borderColor: theme.colors.border,
								minWidth: '14rem',
							}}
						>
							<button
								type="button"
								onClick={() => {
									copyDeepLinkToLine(lineCtxMenu.lineNumber);
									setLineCtxMenu(null);
								}}
								className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								Copy deep link to line {lineCtxMenu.lineNumber}
							</button>
						</div>
					</>
				)}
			</div>
		);
	})
);
