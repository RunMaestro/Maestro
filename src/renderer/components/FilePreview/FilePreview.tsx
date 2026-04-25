import React, {
	useState,
	useRef,
	useEffect,
	useMemo,
	useCallback,
	forwardRef,
	useImperativeHandle,
} from 'react';
import ReactMarkdown from 'react-markdown';
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
} from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import { captureException } from '../../utils/sentry';
import { safeClipboardWrite, safeClipboardWriteBlob } from '../../utils/clipboard';
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
import { openUrl } from '../../utils/openUrl';
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
	LARGE_FILE_TOKEN_SKIP_THRESHOLD,
	LARGE_FILE_PREVIEW_LIMIT,
} from './filePreviewUtils';
import { BionifyTextBlock } from '../../utils/bionifyReadingMode';
import { MarkdownImage } from './MarkdownImage';
import { remarkHighlight } from './remarkHighlight';
import { useFilePreviewSearch } from '../../hooks/file';
import { FilePreviewHeader } from './FilePreviewHeader';
import { ImageViewer } from './ImageViewer';
import { FilePreviewToc } from './FilePreviewToc';
import { HighlightedCodeEditor } from './HighlightedCodeEditor';
import { logger } from '../../utils/logger';

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
		},
		ref
	) {
		const [showCopyNotification, setShowCopyNotification] = useState(false);
		const [showTocOverlay, setShowTocOverlay] = useState(false);
		const [fileStats, setFileStats] = useState<FileStats | null>(null);
		const [showStatsBar, setShowStatsBar] = useState(true);
		const [tokenCount, setTokenCount] = useState<number | null>(null);
		const [showRemoteImages, setShowRemoteImages] = useState(false);
		const [showFullContent, setShowFullContent] = useState(false);
		// Edit mode state - use external content when provided (for file tab persistence)
		const [internalEditContent, setInternalEditContent] = useState('');
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
		const [copyNotificationMessage, setCopyNotificationMessage] = useState('');
		const [searchMode, setSearchMode] = useState<'text' | 'jq'>('text');
		const [showJqHelp, setShowJqHelp] = useState(false);
		const [jqError, setJqError] = useState<string | null>(null);
		const jqHelpRef = useRef<HTMLDivElement>(null);
		const notificationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

		// Clear notification timeout on unmount
		useEffect(() => {
			return () => {
				if (notificationTimeoutRef.current) clearTimeout(notificationTimeoutRef.current);
			};
		}, []);

		const showNotification = useCallback((message: string) => {
			setCopyNotificationMessage(message);
			setShowCopyNotification(true);
			if (notificationTimeoutRef.current) clearTimeout(notificationTimeoutRef.current);
			notificationTimeoutRef.current = setTimeout(() => setShowCopyNotification(false), 2000);
		}, []);

		const codeContainerRef = useRef<HTMLDivElement>(null);
		const contentRef = useRef<HTMLDivElement>(null);
		const containerRef = useRef<HTMLDivElement>(null);
		const textareaRef = useRef<HTMLTextAreaElement>(null);
		const markdownContainerRef = useRef<HTMLDivElement>(null);
		const layerIdRef = useRef<string>();
		const cancelButtonRef = useRef<HTMLButtonElement>(null);
		const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const tocButtonRef = useRef<HTMLButtonElement>(null);
		const tocOverlayRef = useRef<HTMLDivElement>(null);

		// Reset full content view when file changes
		useEffect(() => {
			setShowFullContent(false);
		}, [file?.path]);

		// File change detection state
		const [fileChangedOnDisk, setFileChangedOnDisk] = useState(false);
		const lastModifiedRef = useRef(lastModified);

		// Keep ref in sync with prop (reset when parent reloads content with new lastModified)
		useEffect(() => {
			lastModifiedRef.current = lastModified;
			setFileChangedOnDisk(false);
		}, [lastModified]);

		// Poll file stat to detect external changes (every 3s for the active file)
		useEffect(() => {
			if (!file?.path || !lastModified || fileChangedOnDisk) return;

			const interval = setInterval(async () => {
				try {
					const stat = await window.maestro?.fs?.stat(file.path, sshRemoteId);
					if (!stat?.modifiedAt) return;
					const currentMtime = new Date(stat.modifiedAt).getTime();
					if (currentMtime > (lastModifiedRef.current ?? 0)) {
						setFileChangedOnDisk(true);
					}
				} catch {
					// Silently ignore — file may have been deleted or become inaccessible
				}
			}, 3000);

			return () => clearInterval(interval);
		}, [file?.path, lastModified, sshRemoteId, fileChangedOnDisk]);

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

		// Track if content has been modified
		const hasChanges = markdownEditMode && editContent !== file?.content;

		const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();

		// Compute derived values - must be before any early returns but after hooks
		const language = file ? getLanguageFromFilename(file.name) : '';
		const isMarkdown = language === 'markdown';
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
		} = useFilePreviewSearch({
			codeContainerRef,
			markdownContainerRef,
			contentRef,
			textareaRef,
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
			displayedContentLength: displayContent.length,
			initialSearchQuery,
			onSearchQueryChange,
		});

		// Bionify reading mode follows the global setting; disabled while search highlights are active.
		const bionifyReadingMode = useSettingsStore((s) => s.bionifyReadingMode);
		const bionifyIntensity = useSettingsStore((s) => s.bionifyIntensity);
		const bionifyAlgorithm = useSettingsStore((s) => s.bionifyAlgorithm);
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

		// Memoize rehypePlugins array to prevent unnecessary re-renders
		const rehypePlugins = useMemo(() => [rehypeRaw, rehypeSlug], []);

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
				onExternalLinkClick: (href, opts) => {
					if (/^file:\/\//.test(href)) {
						void window.maestro.shell.openPath(href.replace(/^file:\/\//, ''));
						return;
					}
					if (/^https?:\/\/|^mailto:/.test(href)) {
						openUrl(href, opts);
					}
				},
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
						setFileStats({
							size: stats.size,
							createdAt: stats.createdAt,
							modifiedAt: stats.modifiedAt,
						})
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
		const prevMarkdownEditModeRef = useRef(markdownEditMode);
		useEffect(() => {
			const wasEditMode = prevMarkdownEditModeRef.current;
			prevMarkdownEditModeRef.current = markdownEditMode;

			if (markdownEditMode && textareaRef.current) {
				// Entering edit mode - focus textarea and sync scroll from preview
				if (!wasEditMode && contentRef.current) {
					// Calculate scroll percentage from preview mode
					const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
					const maxScroll = scrollHeight - clientHeight;
					const scrollPercent = maxScroll > 0 ? scrollTop / maxScroll : 0;

					// Apply scroll percentage to textarea after it renders
					requestAnimationFrame(() => {
						if (textareaRef.current) {
							const { scrollHeight: textareaScrollHeight, clientHeight: textareaClientHeight } =
								textareaRef.current;
							const textareaMaxScroll = textareaScrollHeight - textareaClientHeight;
							textareaRef.current.scrollTop = Math.round(scrollPercent * textareaMaxScroll);
						}
					});
				}
				textareaRef.current.focus();
			} else if (!markdownEditMode && wasEditMode && containerRef.current) {
				// Exiting edit mode - focus container and sync scroll from textarea
				if (textareaRef.current && contentRef.current) {
					// Calculate scroll percentage from edit mode
					const { scrollTop, scrollHeight, clientHeight } = textareaRef.current;
					const maxScroll = scrollHeight - clientHeight;
					const scrollPercent = maxScroll > 0 ? scrollTop / maxScroll : 0;

					// Apply scroll percentage to preview after it renders
					requestAnimationFrame(() => {
						if (contentRef.current) {
							const { scrollHeight: previewScrollHeight, clientHeight: previewClientHeight } =
								contentRef.current;
							const previewMaxScroll = previewScrollHeight - previewClientHeight;
							contentRef.current.scrollTop = Math.round(scrollPercent * previewMaxScroll);
						}
					});
				}
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
				showNotification('File Saved');
			} catch (err) {
				logger.error('Failed to save file:', undefined, err);
				showNotification('Save Failed');
			} finally {
				setIsSaving(false);
			}
		}, [file, onSave, hasChanges, isSaving, editContent, sshRemoteId, showNotification]);

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

		const copyPathToClipboard = async () => {
			if (!file) return;
			try {
				const ok = await safeClipboardWrite(file.path);
				showNotification(ok ? 'File Path Copied to Clipboard' : 'Failed to Copy Path');
			} catch (err) {
				captureException(err);
				showNotification('Failed to Copy Path');
			}
		};

		const copyContentToClipboard = async () => {
			if (!file) return;
			if (isImage) {
				try {
					const response = await fetch(file.content);
					const blob = await response.blob();
					const ok = await safeClipboardWriteBlob([new ClipboardItem({ [blob.type]: blob })]);
					if (ok) {
						showNotification('Image Copied to Clipboard');
					} else {
						const fallbackOk = await safeClipboardWrite(file.content);
						showNotification(fallbackOk ? 'Image URL Copied to Clipboard' : 'Failed to Copy Image');
					}
				} catch (err) {
					captureException(err);
					const fallbackOk = await safeClipboardWrite(file.content);
					showNotification(fallbackOk ? 'Image URL Copied to Clipboard' : 'Failed to Copy Image');
				}
			} else {
				const ok = await safeClipboardWrite(file.content);
				showNotification(ok ? 'Content Copied to Clipboard' : 'Failed to Copy Content');
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

			if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				e.stopPropagation();
				setSearchOpen(true);
				setTimeout(() => searchInputRef.current?.focus(), 0);
			} else if (e.key === 's' && (e.metaKey || e.ctrlKey) && isEditableText && markdownEditMode) {
				// Cmd+S to save in edit mode
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
			} else if (e.key === 'ArrowUp') {
				// In edit mode, let the textarea handle arrow keys for cursor movement
				// Only intercept when NOT in edit mode (preview/code view)
				if (isEditableText && markdownEditMode) return;

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
					sshRemoteId={sshRemoteId}
					copyContentToClipboard={copyContentToClipboard}
					copyPathToClipboard={copyPathToClipboard}
					headerBtnClass={headerBtnClass}
					headerIconClass={headerIconClass}
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
											} else if (searchMode === 'text') {
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
									{/* Text search: match count + prev/next navigation */}
									{searchMode === 'text' && searchQuery.trim() && (
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
								<button
									onClick={() => window.maestro.shell.openPath(file.path)}
									className="mt-4 px-4 py-2 rounded text-sm hover:opacity-80 transition-opacity"
									style={{
										backgroundColor: theme.colors.accent,
										color: theme.colors.accentForeground,
									}}
								>
									Open in Default App
								</button>
							</div>
						</div>
					) : isEditableText && markdownEditMode ? (
						// Edit mode - syntax-highlighted editor for any text file
						<HighlightedCodeEditor
							ref={textareaRef}
							value={editContent}
							onChange={setEditContent}
							language={language}
							theme={theme}
							spellCheck={false}
							onKeyDown={(e) => {
								// Handle Cmd+S for save
								if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									e.stopPropagation();
									handleSave();
								}
								// Handle Escape to exit edit mode (without save)
								else if (e.key === 'Escape') {
									e.preventDefault();
									e.stopPropagation();
									setMarkdownEditMode(false);
								}
								// Handle Cmd+Up: Move cursor to beginning (Shift: select to beginning)
								else if (e.key === 'ArrowUp' && (e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									const textarea = e.currentTarget;
									if (e.shiftKey) {
										const anchor =
											textarea.selectionDirection === 'backward'
												? textarea.selectionEnd
												: textarea.selectionStart;
										textarea.setSelectionRange(0, anchor, 'backward');
									} else {
										textarea.setSelectionRange(0, 0);
									}
									textarea.scrollTop = 0;
								}
								// Handle Cmd+Down: Move cursor to end (Shift: select to end)
								else if (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									const textarea = e.currentTarget;
									const len = textarea.value.length;
									if (e.shiftKey) {
										const anchor =
											textarea.selectionDirection === 'forward'
												? textarea.selectionStart
												: textarea.selectionEnd;
										textarea.setSelectionRange(anchor, len, 'forward');
									} else {
										textarea.setSelectionRange(len, len);
									}
									textarea.scrollTop = textarea.scrollHeight;
								}
								// Handle Opt+Up: Page up (move cursor up by roughly a page)
								else if (e.key === 'ArrowUp' && e.altKey) {
									e.preventDefault();
									const textarea = e.currentTarget;
									const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 24;
									const linesPerPage = Math.floor(textarea.clientHeight / lineHeight);
									const lines = textarea.value.substring(0, textarea.selectionStart).split('\n');
									const currentLine = lines.length - 1;
									const targetLine = Math.max(0, currentLine - linesPerPage);
									// Calculate new cursor position
									let newPos = 0;
									for (let i = 0; i < targetLine; i++) {
										newPos += lines[i].length + 1; // +1 for newline
									}
									// Preserve column position if possible
									const currentCol =
										lines[currentLine].length -
										(lines[currentLine].length -
											(textarea.selectionStart - (newPos - (currentLine > 0 ? 1 : 0))));
									const targetLineText = textarea.value.split('\n')[targetLine] || '';
									newPos =
										textarea.value.split('\n').slice(0, targetLine).join('\n').length +
										(targetLine > 0 ? 1 : 0);
									newPos += Math.min(currentCol, targetLineText.length);
									textarea.setSelectionRange(newPos, newPos);
									// Scroll to show the cursor
									textarea.scrollTop -= textarea.clientHeight;
								}
								// Handle Opt+Down: Page down (move cursor down by roughly a page)
								else if (e.key === 'ArrowDown' && e.altKey) {
									e.preventDefault();
									const textarea = e.currentTarget;
									const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 24;
									const linesPerPage = Math.floor(textarea.clientHeight / lineHeight);
									const allLines = textarea.value.split('\n');
									const textBeforeCursor = textarea.value.substring(0, textarea.selectionStart);
									const currentLine = textBeforeCursor.split('\n').length - 1;
									const targetLine = Math.min(allLines.length - 1, currentLine + linesPerPage);
									// Calculate column position in current line
									const linesBeforeCurrent = textBeforeCursor.split('\n');
									const currentCol = linesBeforeCurrent[linesBeforeCurrent.length - 1].length;
									// Calculate new cursor position
									let newPos =
										allLines.slice(0, targetLine).join('\n').length + (targetLine > 0 ? 1 : 0);
									newPos += Math.min(currentCol, allLines[targetLine].length);
									textarea.setSelectionRange(newPos, newPos);
									// Scroll to show the cursor
									textarea.scrollTop += textarea.clientHeight;
								}
							}}
						/>
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
								components={markdownComponents}
							>
								{file.content}
							</ReactMarkdown>
						</div>
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
					/>
				</div>

				{/* Copy Notification Toast */}
				{showCopyNotification && (
					<div
						className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 px-6 py-4 rounded-lg shadow-2xl text-base font-bold animate-in fade-in zoom-in-95 duration-200 z-50"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
							textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
						}}
					>
						{copyNotificationMessage}
					</div>
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
			</div>
		);
	})
);
