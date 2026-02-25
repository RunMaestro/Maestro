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
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import GithubSlugger from 'github-slugger';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import {
	FileCode,
	Eye,
	ChevronUp,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Clipboard,
	Copy,
	Loader2,
	Image,
	Globe,
	Save,
	Edit,
	AlertTriangle,
	Share2,
	GitGraph,
	List,
	ExternalLink,
	RefreshCw,
	X,
} from 'lucide-react';
import { visit } from 'unist-util-visit';
import { captureException } from '../utils/sentry';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useClickOutside } from '../hooks/ui/useClickOutside';
import { Modal, ModalFooter } from './ui/Modal';
import { MermaidRenderer } from './MermaidRenderer';
import { CsvTableRenderer } from './CsvTableRenderer';
import { getEncoder, formatTokenCount } from '../utils/tokenCounter';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { remarkFileLinks, buildFileTreeIndices } from '../utils/remarkFileLinks';
import remarkFrontmatter from 'remark-frontmatter';
import { remarkFrontmatterTable } from '../utils/remarkFrontmatterTable';
import type { FileNode } from '../types/fileTree';
import { isImageFile } from '../../shared/gitUtils';

// Global cache for loaded images to prevent re-fetching and flickering
// Maps resolved path -> { dataUrl, dimensions }
const imageCache = new Map<
	string,
	{ dataUrl: string; width?: number; height?: number; loadedAt: number }
>();

// Cache cleanup interval (clear entries older than 10 minutes)
const IMAGE_CACHE_TTL = 10 * 60 * 1000;

// Clean up old cache entries periodically
setInterval(() => {
	const now = Date.now();
	for (const [key, value] of imageCache.entries()) {
		if (now - value.loadedAt > IMAGE_CACHE_TTL) {
			imageCache.delete(key);
		}
	}
}, IMAGE_CACHE_TTL);

interface FileStats {
	size: number;
	createdAt: string;
	modifiedAt: string;
}

interface FilePreviewProps {
	file: { name: string; content: string; path: string } | null;
	onClose: () => void;
	theme: any;
	markdownEditMode: boolean;
	setMarkdownEditMode: (value: boolean) => void;
	onSave?: (path: string, content: string) => Promise<void>;
	shortcuts: Record<string, any>;
	/** File tree for linking file references */
	fileTree?: FileNode[];
	/** Current working directory for proximity-based matching */
	cwd?: string;
	/** Callback when a file link is clicked
	 * @param path - The file path to open
	 * @param options - Options for how to open the file
	 * @param options.openInNewTab - If true, open in a new tab adjacent to current; if false, replace current tab content
	 */
	onFileClick?: (path: string, options?: { openInNewTab?: boolean }) => void;
	/** Whether back navigation is available */
	canGoBack?: boolean;
	/** Whether forward navigation is available */
	canGoForward?: boolean;
	/** Navigate back in history */
	onNavigateBack?: () => void;
	/** Navigate forward in history */
	onNavigateForward?: () => void;
	/** Navigation history for back breadcrumbs (items before current) */
	backHistory?: { name: string; path: string; scrollTop?: number }[];
	/** Navigation history for forward breadcrumbs (items after current) */
	forwardHistory?: { name: string; path: string; scrollTop?: number }[];
	/** Navigate to a specific index in history */
	onNavigateToIndex?: (index: number) => void;
	/** Current index in history */
	currentHistoryIndex?: number;
	/** Callback to open fuzzy file search (available in preview mode, not edit mode) */
	onOpenFuzzySearch?: () => void;
	/** Callback to track shortcut usage for keyboard mastery */
	onShortcutUsed?: (shortcutId: string) => void;
	/** Whether GitHub CLI is available for gist publishing */
	ghCliAvailable?: boolean;
	/** Callback to open gist publish modal */
	onPublishGist?: () => void;
	/** Whether this file has been published as a gist */
	hasGist?: boolean;
	/** Callback to open Document Graph focused on this file */
	onOpenInGraph?: () => void;
	/** SSH remote ID for remote file operations */
	sshRemoteId?: string;
	/** Current edit content (used for file tab persistence) - if provided, overrides internal state */
	externalEditContent?: string;
	/** Callback when edit content changes (used for file tab persistence) */
	onEditContentChange?: (content: string) => void;
	/** Initial scroll position to restore (used for file tab persistence) */
	initialScrollTop?: number;
	/** Callback when scroll position changes (used for file tab persistence) */
	onScrollPositionChange?: (scrollTop: number) => void;
	/** Initial search query to restore (used for file tab persistence) */
	initialSearchQuery?: string;
	/** Callback when search query changes (used for file tab persistence) */
	onSearchQueryChange?: (query: string) => void;
	/** When true, disables click-outside-to-close and layer registration (for tab-based rendering) */
	isTabMode?: boolean;
	/** Timestamp (ms) when file was last modified on disk — used for change detection polling */
	lastModified?: number;
	/** Callback to reload file content from disk (called when user clicks Reload in the change banner) */
	onReloadFile?: () => void;
}

export interface FilePreviewHandle {
	focus: () => void;
}

// Get language from filename extension
const getLanguageFromFilename = (filename: string): string => {
	const ext = filename.split('.').pop()?.toLowerCase();
	const languageMap: Record<string, string> = {
		ts: 'typescript',
		tsx: 'tsx',
		js: 'javascript',
		jsx: 'jsx',
		json: 'json',
		md: 'markdown',
		py: 'python',
		rb: 'ruby',
		go: 'go',
		rs: 'rust',
		java: 'java',
		c: 'c',
		cpp: 'cpp',
		cs: 'csharp',
		php: 'php',
		html: 'html',
		css: 'css',
		scss: 'scss',
		sql: 'sql',
		sh: 'bash',
		yaml: 'yaml',
		yml: 'yaml',
		toml: 'toml',
		xml: 'xml',
		csv: 'csv',
		tsv: 'csv',
	};
	return languageMap[ext || ''] || 'text';
};

// Check if content appears to be binary (contains null bytes or high concentration of non-printable chars)
const isBinaryContent = (content: string): boolean => {
	// Check for null bytes (definitive binary indicator)
	if (content.includes('\0')) return true;

	// Sample the first 8KB for performance (binary files are usually obvious early)
	const sample = content.slice(0, 8192);
	if (sample.length === 0) return false;

	// Count non-printable characters (excluding common whitespace)
	let nonPrintableCount = 0;
	for (let i = 0; i < sample.length; i++) {
		const code = sample.charCodeAt(i);
		// Allow: tab (9), newline (10), carriage return (13), and printable ASCII (32-126)
		// Also allow common extended ASCII and Unicode
		if (code < 9 || (code > 13 && code < 32) || (code >= 127 && code < 160)) {
			nonPrintableCount++;
		}
	}

	// If more than 10% of characters are non-printable, treat as binary
	return nonPrintableCount / sample.length > 0.1;
};

// Check if file extension indicates a known binary format
const isBinaryExtension = (filename: string): boolean => {
	const ext = filename.split('.').pop()?.toLowerCase();
	const binaryExtensions = [
		// macOS/iOS specific
		'icns',
		'car',
		'actool',
		// Design files
		'psd',
		'ai',
		'sketch',
		'fig',
		'xd',
		// Compiled/object files
		'o',
		'a',
		'so',
		'dylib',
		'dll',
		'class',
		'pyc',
		'pyo',
		'wasm',
		// Database files
		'db',
		'sqlite',
		'sqlite3',
		// Fonts
		'ttf',
		'otf',
		'woff',
		'woff2',
		'eot',
		// Archives (if somehow not opened externally)
		'zip',
		'tar',
		'gz',
		'7z',
		'rar',
		'bz2',
		'xz',
		'tgz',
		// Other binary
		'exe',
		'bin',
		'dat',
		'pak',
	];
	return binaryExtensions.includes(ext || '');
};

// Format file size in human-readable format
const formatFileSize = (bytes: number): string => {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

// Large file thresholds to prevent UI freezes
// Files larger than this will skip token counting (expensive operation)
const LARGE_FILE_TOKEN_SKIP_THRESHOLD = 1024 * 1024; // 1MB
// Files larger than this will have content truncated for syntax highlighting
const LARGE_FILE_PREVIEW_LIMIT = 100 * 1024; // 100KB for syntax highlighting

// Format date/time for display
const formatDateTime = (isoString: string): string => {
	const date = new Date(isoString);
	return date.toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
};

// Count markdown tasks (checkboxes)
const countMarkdownTasks = (content: string): { open: number; closed: number } => {
	// Match markdown checkboxes: - [ ] or - [x] (also * [ ] and * [x])
	const openMatches = content.match(/^[\s]*[-*]\s*\[\s*\]/gm);
	const closedMatches = content.match(/^[\s]*[-*]\s*\[[xX]\]/gm);
	return {
		open: openMatches?.length || 0,
		closed: closedMatches?.length || 0,
	};
};

// Interface for table of contents entries
interface TocEntry {
	level: number; // 1-6 for h1-h6
	text: string;
	slug: string;
}

// Extract headings from markdown content for table of contents
const extractHeadings = (content: string): TocEntry[] => {
	const headings: TocEntry[] = [];
	const lines = content.split('\n');
	let inCodeFence = false;
	const slugger = new GithubSlugger();

	for (const line of lines) {
		// Track code fence boundaries (``` or ~~~, optionally with language specifier)
		if (/^(`{3,}|~{3,})/.test(line)) {
			inCodeFence = !inCodeFence;
			continue;
		}

		// Skip headings inside code fences
		if (inCodeFence) {
			continue;
		}

		// Match ATX-style headings (# H1, ## H2, etc.)
		const match = line.match(/^(#{1,6})\s+(.+)$/);
		if (match) {
			const level = match[1].length;
			const text = match[2].trim();
			// Use github-slugger to match rehype-slug's ID generation exactly
			const slug = slugger.slug(text);
			headings.push({ level, text, slug });
		}
	}

	return headings;
};

// Helper to resolve image path relative to markdown file directory
const resolveImagePath = (src: string, markdownFilePath: string): string => {
	// If it's already a data URL or http(s) URL, return as-is
	if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
		return src;
	}

	// Get the directory containing the markdown file
	const markdownDir = markdownFilePath.substring(0, markdownFilePath.lastIndexOf('/'));

	// If the path is absolute, return as-is
	if (src.startsWith('/')) {
		return src;
	}

	// Resolve relative path
	// Handle ./ prefix
	let relativePath = src;
	if (relativePath.startsWith('./')) {
		relativePath = relativePath.substring(2);
	}

	// Simple path resolution (handles ../ by just concatenating - the file system will resolve it)
	return `${markdownDir}/${relativePath}`;
};

// Custom image component for markdown that loads images from file paths
// Uses a global cache to prevent re-fetching and flickering on re-renders
// Wrapped in React.memo to prevent re-renders when parent updates but image props haven't changed
const MarkdownImage = React.memo(function MarkdownImage({
	src,
	alt,
	markdownFilePath,
	theme,
	showRemoteImages = false,
	isFromFileTree = false,
	projectRoot,
	sshRemoteId,
}: {
	src?: string;
	alt?: string;
	markdownFilePath: string;
	theme: any;
	showRemoteImages?: boolean;
	isFromFileTree?: boolean; // If true, src is a path relative to project root, not markdown file
	projectRoot?: string; // Project root path for resolving file tree paths
	sshRemoteId?: string; // SSH remote ID for remote file operations
}) {
	const [dataUrl, setDataUrl] = useState<string | null>(null);
	const [dimensions, setDimensions] = useState<{ width?: number; height?: number }>({});
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const isRemoteUrl = src?.startsWith('http://') || src?.startsWith('https://');

	// Compute the cache key based on resolved path
	const cacheKey = useMemo(() => {
		if (!src) return null;
		if (src.startsWith('data:')) return src; // Use data URL itself as key
		if (isRemoteUrl) return src; // Use URL as key for remote images

		let decodedSrc = src;
		try {
			decodedSrc = decodeURIComponent(src);
		} catch {
			// Use original if decode fails
		}

		if (isFromFileTree && projectRoot) {
			return `${projectRoot}/${decodedSrc}`;
		}
		return resolveImagePath(decodedSrc, markdownFilePath);
	}, [src, markdownFilePath, isFromFileTree, projectRoot, isRemoteUrl]);

	useEffect(() => {
		setError(null);

		if (!src || !cacheKey) {
			setDataUrl(null);
			setLoading(false);
			return;
		}

		// Check cache first
		const cached = imageCache.get(cacheKey);
		if (cached) {
			setDataUrl(cached.dataUrl);
			setDimensions({ width: cached.width, height: cached.height });
			setLoading(false);
			return;
		}

		// If it's already a data URL, use it directly and cache
		if (src.startsWith('data:')) {
			setDataUrl(src);
			setLoading(false);
			// Cache with current time (dimensions will be set on load)
			imageCache.set(cacheKey, { dataUrl: src, loadedAt: Date.now() });
			return;
		}

		// If it's an HTTP(S) URL, handle based on showRemoteImages setting
		if (isRemoteUrl) {
			if (showRemoteImages) {
				setDataUrl(src);
				imageCache.set(cacheKey, { dataUrl: src, loadedAt: Date.now() });
			} else {
				setDataUrl(null);
			}
			setLoading(false);
			return;
		}

		// For local files, we need to load them
		setLoading(true);

		// Load the image via IPC (supports SSH remote)
		window.maestro.fs
			.readFile(cacheKey, sshRemoteId)
			.then((result) => {
				// readFile returns a data URL for images
				if (result.startsWith('data:')) {
					setDataUrl(result);
					// Cache the result
					imageCache.set(cacheKey, { dataUrl: result, loadedAt: Date.now() });
				} else {
					setError('Invalid image data');
				}
				setLoading(false);
			})
			.catch((err) => {
				setError(`Failed to load image: ${err.message || 'Unknown error'}`);
				setLoading(false);
			});
	}, [src, cacheKey, showRemoteImages, isRemoteUrl, sshRemoteId]);

	// Handle image load to get dimensions and update cache
	const handleImageLoad = useCallback(
		(e: React.SyntheticEvent<HTMLImageElement>) => {
			const img = e.currentTarget;
			const width = img.naturalWidth;
			const height = img.naturalHeight;
			setDimensions({ width, height });

			// Update cache with dimensions
			if (cacheKey && dataUrl) {
				const cached = imageCache.get(cacheKey);
				if (cached) {
					imageCache.set(cacheKey, { ...cached, width, height });
				}
			}
		},
		[cacheKey, dataUrl]
	);

	if (loading) {
		return (
			<span
				className="inline-flex items-center gap-2 px-3 py-2 rounded my-2"
				style={{
					backgroundColor: theme.colors.bgActivity,
					// Reserve some space to reduce layout shift
					minHeight: '100px',
					minWidth: '200px',
				}}
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
				className="inline-flex items-center gap-2 px-3 py-2 rounded my-2"
				style={{
					backgroundColor: theme.colors.bgActivity,
					border: `1px solid ${theme.colors.error}`,
				}}
			>
				<Image className="w-4 h-4" style={{ color: theme.colors.error }} />
				<span className="text-xs" style={{ color: theme.colors.error }}>
					{error}
				</span>
			</span>
		);
	}

	// Show placeholder for blocked remote images
	if (!dataUrl && isRemoteUrl && !showRemoteImages) {
		return (
			<span
				className="inline-flex items-center gap-2 px-3 py-2 rounded my-2"
				style={{
					backgroundColor: theme.colors.bgActivity,
					border: `1px dashed ${theme.colors.border}`,
				}}
			>
				<Image className="w-4 h-4" style={{ color: theme.colors.textDim }} />
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Remote image blocked
				</span>
			</span>
		);
	}

	if (!dataUrl) {
		return null;
	}

	return (
		<img
			src={dataUrl}
			alt={alt || ''}
			className="max-w-full rounded my-2 block"
			style={{
				border: `1px solid ${theme.colors.border}`,
				// Use cached dimensions if available to prevent layout shift
				...(dimensions.width && dimensions.height
					? { aspectRatio: `${dimensions.width} / ${dimensions.height}` }
					: {}),
			}}
			onLoad={handleImageLoad}
		/>
	);
});

// Remark plugin to support ==highlighted text== syntax
function remarkHighlight() {
	return (tree: any) => {
		visit(tree, 'text', (node: any, index: number | null | undefined, parent: any) => {
			const text = node.value;
			const regex = /==([^=]+)==/g;

			if (!regex.test(text)) return;
			if (index === null || index === undefined || !parent) return;

			const parts: any[] = [];
			let lastIndex = 0;
			const matches = text.matchAll(/==([^=]+)==/g);

			for (const match of matches) {
				const matchIndex = match.index!;

				// Add text before match
				if (matchIndex > lastIndex) {
					parts.push({
						type: 'text',
						value: text.slice(lastIndex, matchIndex),
					});
				}

				// Add highlighted text
				parts.push({
					type: 'html',
					value: `<mark style="background-color: #ffd700; color: #000; padding: 0 4px; border-radius: 2px;">${match[1]}</mark>`,
				});

				lastIndex = matchIndex + match[0].length;
			}

			// Add remaining text
			if (lastIndex < text.length) {
				parts.push({
					type: 'text',
					value: text.slice(lastIndex),
				});
			}

			// Replace the text node with the parts
			if (parts.length > 0) {
				parent.children.splice(index, 1, ...parts);
			}
		});
	};
}

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
		// Search state - use initialSearchQuery if provided, and notify parent of changes
		const [internalSearchQuery, setInternalSearchQuery] = useState(initialSearchQuery ?? '');
		// Wrapper to update state and notify parent
		const setSearchQuery = useCallback(
			(query: string) => {
				setInternalSearchQuery(query);
				onSearchQueryChange?.(query);
			},
			[onSearchQueryChange]
		);
		// Expose the current search query value
		const searchQuery = internalSearchQuery;
		// If initialSearchQuery is provided and non-empty, auto-open search
		const [searchOpen, setSearchOpen] = useState(Boolean(initialSearchQuery));
		const [showCopyNotification, setShowCopyNotification] = useState(false);
		const [showBackPopup, setShowBackPopup] = useState(false);
		const [showForwardPopup, setShowForwardPopup] = useState(false);
		const [showTocOverlay, setShowTocOverlay] = useState(false);
		const backPopupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const forwardPopupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
		const [totalMatches, setTotalMatches] = useState(0);
		const [fileStats, setFileStats] = useState<FileStats | null>(null);
		const [showStatsBar, setShowStatsBar] = useState(true);
		const [tokenCount, setTokenCount] = useState<number | null>(null);
		const [showRemoteImages, setShowRemoteImages] = useState(false);
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
		const searchInputRef = useRef<HTMLInputElement>(null);
		const codeContainerRef = useRef<HTMLDivElement>(null);
		const contentRef = useRef<HTMLDivElement>(null);
		const containerRef = useRef<HTMLDivElement>(null);
		const textareaRef = useRef<HTMLTextAreaElement>(null);
		const markdownContainerRef = useRef<HTMLDivElement>(null);
		const layerIdRef = useRef<string>();
		const matchElementsRef = useRef<HTMLElement[]>([]);
		const cancelButtonRef = useRef<HTMLButtonElement>(null);
		const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		const tocButtonRef = useRef<HTMLButtonElement>(null);
		const tocOverlayRef = useRef<HTMLDivElement>(null);

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
		const isCsv = language === 'csv';
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
		// Use content length as primary check since fileStats may not be loaded yet
		const isLargeFile = useMemo(() => {
			if (!file?.content) return false;
			return file.content.length > LARGE_FILE_TOKEN_SKIP_THRESHOLD;
		}, [file?.content]);

		// For very large files, truncate content for syntax highlighting to prevent freezes
		const displayContent = useMemo(() => {
			if (!file?.content) return '';
			if (!isMarkdown && !isImage && !isBinary && file.content.length > LARGE_FILE_PREVIEW_LIMIT) {
				return file.content.substring(0, LARGE_FILE_PREVIEW_LIMIT);
			}
			return file.content;
		}, [file?.content, isMarkdown, isImage, isBinary]);

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

		// Memoize remarkPlugins to prevent infinite render loops
		// Creating new arrays/objects on each render causes ReactMarkdown to re-render children
		const remarkPlugins = useMemo(
			() => [
				remarkGfm,
				remarkFrontmatter,
				remarkFrontmatterTable,
				remarkHighlight,
				...(fileTree && fileTree.length > 0 && cwd !== undefined
					? [[remarkFileLinks, { indices: fileTreeIndices || undefined, cwd }] as any]
					: []),
			],
			[fileTree, fileTreeIndices, cwd]
		);

		// Memoize rehypePlugins array to prevent unnecessary re-renders
		const rehypePlugins = useMemo(() => [rehypeRaw, rehypeSlug], []);

		// Memoize ReactMarkdown components to prevent infinite render loops
		// The img component was causing loops because MarkdownImage useEffect sets state,
		// which triggers parent re-render, creating new components object, remounting MarkdownImage
		const markdownComponents = useMemo(
			() => ({
				a: ({ node: _node, href, children, ...props }: any) => {
					// Check for maestro-file:// protocol OR data-maestro-file attribute
					// (data attribute is fallback when rehype strips custom protocols)
					const dataFilePath = (props as any)['data-maestro-file'];
					const isMaestroFile = href?.startsWith('maestro-file://') || !!dataFilePath;
					const filePath =
						dataFilePath ||
						(href?.startsWith('maestro-file://') ? href.replace('maestro-file://', '') : null);

					// Check for anchor links (same-page navigation)
					const isAnchorLink = href?.startsWith('#') ?? false;
					const anchorId = isAnchorLink && href ? href.slice(1) : null;

					return (
						<a
							href={href}
							{...props}
							onClick={(e) => {
								e.preventDefault();
								if (isMaestroFile && filePath && onFileClick) {
									// Cmd/Ctrl+Click opens in new tab, regular click replaces current tab
									const openInNewTab = e.metaKey || e.ctrlKey;
									onFileClick(filePath, { openInNewTab });
								} else if (isAnchorLink && anchorId) {
									// Handle anchor links - scroll to the target element
									const targetElement = markdownContainerRef.current
										? markdownContainerRef.current.querySelector(`#${CSS.escape(anchorId)}`)
										: document.getElementById(anchorId);
									if (targetElement) {
										targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
									}
								} else if (href) {
									if (/^file:\/\//.test(href)) {
										window.maestro.shell.openPath(href.replace(/^file:\/\//, ''));
									} else {
										window.maestro.shell.openExternal(href);
									}
								}
							}}
							style={{ color: theme.colors.accent, textDecoration: 'underline', cursor: 'pointer' }}
						>
							{children}
						</a>
					);
				},
				pre: ({ children }: any) => {
					// In react-markdown v10, block code is <pre><code>...</code></pre>
					// Extract the code element and render with SyntaxHighlighter
					const codeElement = React.Children.toArray(children).find(
						(child: any) => child?.type === 'code' || child?.props?.node?.tagName === 'code'
					) as React.ReactElement<any> | undefined;

					if (codeElement?.props) {
						const { className, children: codeChildren } = codeElement.props;
						const match = (className || '').match(/language-(\w+)/);
						const lang = match ? match[1] : 'text';
						const codeContent = String(codeChildren).replace(/\n$/, '');

						// Handle mermaid code blocks
						if (lang === 'mermaid') {
							return <MermaidRenderer chart={codeContent} theme={theme} />;
						}

						return (
							<SyntaxHighlighter
								language={lang}
								style={vscDarkPlus}
								customStyle={{
									margin: '0.5em 0',
									padding: '1em',
									background: theme.colors.bgActivity,
									fontSize: '0.9em',
									borderRadius: '6px',
								}}
								PreTag="div"
							>
								{codeContent}
							</SyntaxHighlighter>
						);
					}

					// Fallback: render as-is
					return <pre>{children}</pre>;
				},
				code: ({ node: _node, className, children, ...props }: any) => {
					// Inline code only — block code is handled by the pre component above
					return (
						<code className={className} {...props}>
							{children}
						</code>
					);
				},
				img: ({ node: _node, src, alt, ...props }: any) => {
					// Check if this image came from file tree (set by remarkFileLinks)
					const isFromTree = (props as any)['data-maestro-from-tree'] === 'true';
					// Get the project root from the markdown file path (directory containing the file tree root)
					// For FilePreview, the file.path is absolute, so we extract the root from it
					// If image is from file tree, we need the project root to resolve correctly
					// The project root would be the common ancestor - we'll derive it from the file path
					// For now, use the directory where the first folder in cwd would be located
					let projectRootForImage: string | undefined;
					if (isFromTree && cwd && file) {
						// cwd is relative path like "People" or "OPSWAT/Meetings"
						// We need to find where in file.path the cwd starts
						const cwdIndex = file.path.indexOf(`/${cwd}/`);
						if (cwdIndex !== -1) {
							projectRootForImage = file.path.substring(0, cwdIndex);
						} else {
							// Try to find just the first segment of cwd
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
			}),
			[onFileClick, theme, cwd, file, showRemoteImages, sshRemoteId]
		);

		// Extract directory path without filename
		const directoryPath = file ? file.path.substring(0, file.path.lastIndexOf('/')) : '';

		const showPath = showStatsBar && !!directoryPath;
		const headerIconClass = 'w-4 h-4';
		const headerBtnClass =
			'p-2 rounded hover:bg-white/10 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-white/30';

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
						console.error('Failed to get file stats:', err);
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
					console.error('Failed to count tokens:', err);
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
				await onSave(file.path, editContent);
				setCopyNotificationMessage('File Saved');
				setShowCopyNotification(true);
				setTimeout(() => setShowCopyNotification(false), 2000);
			} catch (err) {
				console.error('Failed to save file:', err);
				setCopyNotificationMessage('Save Failed');
				setShowCopyNotification(true);
				setTimeout(() => setShowCopyNotification(false), 2000);
			} finally {
				setIsSaving(false);
			}
		}, [file, onSave, hasChanges, isSaving, editContent]);

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

		// Keep search input focused when search is open
		useEffect(() => {
			if (searchOpen && searchInputRef.current) {
				searchInputRef.current.focus();
			}
		}, [searchOpen, searchQuery]);

		// Highlight search matches in syntax-highlighted code
		useEffect(() => {
			if (!searchQuery.trim() || !codeContainerRef.current || isMarkdown || isImage || isCsv) {
				setTotalMatches(0);
				setCurrentMatchIndex(0);
				matchElementsRef.current = [];
				return;
			}

			const container = codeContainerRef.current;
			const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
			const textNodes: Text[] = [];

			// Collect all text nodes
			let node;
			while ((node = walker.nextNode())) {
				textNodes.push(node as Text);
			}

			// Escape regex special characters
			const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const regex = new RegExp(escapedQuery, 'gi');
			const matchElements: HTMLElement[] = [];

			// Highlight matches using safe DOM methods
			textNodes.forEach((textNode) => {
				const text = textNode.textContent || '';
				const matches = text.match(regex);

				if (matches) {
					const fragment = document.createDocumentFragment();
					let lastIndex = 0;

					text.replace(regex, (match, offset) => {
						// Add text before match
						if (offset > lastIndex) {
							fragment.appendChild(document.createTextNode(text.substring(lastIndex, offset)));
						}

						// Add highlighted match
						const mark = document.createElement('mark');
						mark.style.backgroundColor = '#ffd700';
						mark.style.color = '#000';
						mark.style.padding = '0 2px';
						mark.style.borderRadius = '2px';
						mark.className = 'search-match';
						mark.textContent = match;
						fragment.appendChild(mark);
						matchElements.push(mark);

						lastIndex = offset + match.length;
						return match;
					});

					// Add remaining text
					if (lastIndex < text.length) {
						fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
					}

					textNode.parentNode?.replaceChild(fragment, textNode);
				}
			});

			// Store match elements and update count
			matchElementsRef.current = matchElements;
			setTotalMatches(matchElements.length);
			setCurrentMatchIndex(matchElements.length > 0 ? 0 : -1);

			// Highlight first match with different color and scroll to it
			if (matchElements.length > 0) {
				matchElements[0].style.backgroundColor = theme.colors.accent;
				matchElements[0].style.color = '#fff';
				matchElements[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
			}

			// Cleanup function to remove highlights
			return () => {
				container.querySelectorAll('mark.search-match').forEach((mark) => {
					const parent = mark.parentNode;
					if (parent) {
						parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
						parent.normalize();
					}
				});
				matchElementsRef.current = [];
			};
		}, [searchQuery, file?.content, isMarkdown, isImage, isCsv, theme.colors.accent]);

		// Search matches in markdown preview mode - use CSS Custom Highlight API
		useEffect(() => {
			if (!isMarkdown || markdownEditMode || !searchQuery.trim() || !markdownContainerRef.current) {
				if (isMarkdown && !markdownEditMode) {
					setTotalMatches(0);
					setCurrentMatchIndex(0);
					matchElementsRef.current = [];
					// Clear any existing highlights
					if ('highlights' in CSS) {
						(CSS as any).highlights.delete('search-results');
						(CSS as any).highlights.delete('search-current');
					}
				}
				return;
			}

			const container = markdownContainerRef.current;
			const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const searchRegex = new RegExp(escapedQuery, 'gi');

			// Check if CSS Custom Highlight API is available
			if ('highlights' in CSS) {
				const allRanges: Range[] = [];
				const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);

				// Find all text nodes and create ranges for matches
				let textNode;
				while ((textNode = walker.nextNode())) {
					const text = textNode.textContent || '';
					let match;
					const localRegex = new RegExp(escapedQuery, 'gi');
					while ((match = localRegex.exec(text)) !== null) {
						const range = document.createRange();
						range.setStart(textNode, match.index);
						range.setEnd(textNode, match.index + match[0].length);
						allRanges.push(range);
					}
				}

				// Update match count
				setTotalMatches(allRanges.length);

				// Create highlights
				if (allRanges.length > 0) {
					const targetIndex = Math.max(0, Math.min(currentMatchIndex, allRanges.length - 1));

					// Create highlight for all matches (yellow)
					const allHighlight = new (window as any).Highlight(...allRanges);
					(CSS as any).highlights.set('search-results', allHighlight);

					// Create highlight for current match (accent color)
					const currentHighlight = new (window as any).Highlight(allRanges[targetIndex]);
					(CSS as any).highlights.set('search-current', currentHighlight);

					// Scroll to current match
					const currentRange = allRanges[targetIndex];
					const rect = currentRange.getBoundingClientRect();
					const scrollParent = contentRef.current;

					if (scrollParent && rect) {
						// Calculate position of the match relative to the scroll container's top
						// rect.top is viewport-relative, so we need to account for current scroll
						// and the scroll container's viewport position
						const scrollContainerRect = scrollParent.getBoundingClientRect();
						const matchOffsetInScrollContainer =
							rect.top - scrollContainerRect.top + scrollParent.scrollTop;
						// Calculate scroll position to center the match vertically
						const scrollTop =
							matchOffsetInScrollContainer - scrollParent.clientHeight / 2 + rect.height / 2;
						scrollParent.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' });
					}
				} else {
					(CSS as any).highlights.delete('search-results');
					(CSS as any).highlights.delete('search-current');
				}

				// Cleanup function
				return () => {
					(CSS as any).highlights.delete('search-results');
					(CSS as any).highlights.delete('search-current');
				};
			} else {
				// Fallback: count matches and scroll to location (no highlighting)
				const matches = file?.content?.match(searchRegex);
				const count = matches ? matches.length : 0;
				setTotalMatches(count);

				if (count > 0) {
					const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
					let matchCount = 0;
					const targetIndex = Math.max(0, Math.min(currentMatchIndex, count - 1));

					let textNode;
					while ((textNode = walker.nextNode())) {
						const text = textNode.textContent || '';
						const nodeMatches = text.match(searchRegex);
						if (nodeMatches) {
							for (const _ of nodeMatches) {
								if (matchCount === targetIndex) {
									const parentElement = (textNode as Text).parentElement;
									if (parentElement) {
										parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
									}
									return;
								}
								matchCount++;
							}
						}
					}
				}
			}

			matchElementsRef.current = [];
		}, [
			searchQuery,
			file?.content,
			isMarkdown,
			markdownEditMode,
			currentMatchIndex,
			theme.colors.accent,
		]);

		const copyPathToClipboard = async () => {
			if (!file) return;
			try {
				await navigator.clipboard.writeText(file.path);
				setCopyNotificationMessage('File Path Copied to Clipboard');
			} catch (err) {
				captureException(err);
				setCopyNotificationMessage('Failed to Copy Path');
			}
			setShowCopyNotification(true);
			setTimeout(() => setShowCopyNotification(false), 2000);
		};

		const copyContentToClipboard = async () => {
			if (!file) return;
			if (isImage) {
				// For images, copy the image to clipboard
				try {
					const response = await fetch(file.content);
					const blob = await response.blob();
					await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
					setCopyNotificationMessage('Image Copied to Clipboard');
				} catch (err) {
					captureException(err);
					// Fallback: copy the data URL if image copy fails
					try {
						await navigator.clipboard.writeText(file.content);
						setCopyNotificationMessage('Image URL Copied to Clipboard');
					} catch (fallbackErr) {
						captureException(fallbackErr);
						setCopyNotificationMessage('Failed to Copy Image');
					}
				}
			} else {
				// For text files, copy the content
				await navigator.clipboard.writeText(file.content);
				setCopyNotificationMessage('Content Copied to Clipboard');
			}
			setShowCopyNotification(true);
			setTimeout(() => setShowCopyNotification(false), 2000);
		};

		// Navigate to next search match
		const goToNextMatch = () => {
			if (totalMatches === 0) return;

			// Move to next match (wrap around)
			const nextIndex = (currentMatchIndex + 1) % totalMatches;
			setCurrentMatchIndex(nextIndex);

			// For code files, handle DOM-based highlighting
			const matches = matchElementsRef.current;
			if (matches.length > 0) {
				// Reset previous highlight
				if (matches[currentMatchIndex]) {
					matches[currentMatchIndex].style.backgroundColor = '#ffd700';
					matches[currentMatchIndex].style.color = '#000';
				}
				// Highlight new current match and scroll to it
				if (matches[nextIndex]) {
					matches[nextIndex].style.backgroundColor = theme.colors.accent;
					matches[nextIndex].style.color = '#fff';
					matches[nextIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
				}
			}
			// For markdown edit mode, the effect will handle selecting text
		};

		// Navigate to previous search match
		const goToPrevMatch = () => {
			if (totalMatches === 0) return;

			// Move to previous match (wrap around)
			const prevIndex = (currentMatchIndex - 1 + totalMatches) % totalMatches;
			setCurrentMatchIndex(prevIndex);

			// For code files, handle DOM-based highlighting
			const matches = matchElementsRef.current;
			if (matches.length > 0) {
				// Reset previous highlight
				if (matches[currentMatchIndex]) {
					matches[currentMatchIndex].style.backgroundColor = '#ffd700';
					matches[currentMatchIndex].style.color = '#000';
				}
				// Highlight new current match and scroll to it
				if (matches[prevIndex]) {
					matches[prevIndex].style.backgroundColor = theme.colors.accent;
					matches[prevIndex].style.color = '#fff';
					matches[prevIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
				}
			}
			// For markdown edit mode, the effect will handle selecting text
		};

		// Format shortcut keys for display
		const formatShortcut = (shortcutId: string): string => {
			const shortcut = shortcuts[shortcutId];
			if (!shortcut) return '';
			return formatShortcutKeys(shortcut.keys);
		};

		// Track previous search query and match index for edit mode navigation
		const prevSearchQueryRef = useRef<string>('');
		const prevMatchIndexRef = useRef<number>(0);

		// Handle search in edit mode - count matches and update state
		// Note: We separate counting from selection to avoid stealing focus while typing
		useEffect(() => {
			if (!isEditableText || !markdownEditMode || !searchQuery.trim() || !textareaRef.current) {
				if (isEditableText && markdownEditMode) {
					setTotalMatches(0);
					setCurrentMatchIndex(0);
				}
				return;
			}

			const content = editContent;
			const escapedQuery = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const regex = new RegExp(escapedQuery, 'gi');

			// Find all matches and their positions
			const matches: { start: number; end: number }[] = [];
			let matchResult;
			while ((matchResult = regex.exec(content)) !== null) {
				matches.push({ start: matchResult.index, end: matchResult.index + matchResult[0].length });
			}

			setTotalMatches(matches.length);
			if (matches.length === 0) {
				setCurrentMatchIndex(0);
				return;
			}

			// Clamp current match index
			const validIndex = Math.min(currentMatchIndex, matches.length - 1);
			if (validIndex !== currentMatchIndex) {
				setCurrentMatchIndex(validIndex);
				return;
			}

			// Only scroll and select when navigating between matches (Enter/Shift+Enter)
			// or when search query is complete (user stopped typing)
			// We detect navigation by checking if currentMatchIndex changed without searchQuery changing
			const isNavigating =
				prevSearchQueryRef.current === searchQuery &&
				prevMatchIndexRef.current !== currentMatchIndex;
			prevSearchQueryRef.current = searchQuery;
			prevMatchIndexRef.current = currentMatchIndex;

			// Select the current match in the textarea only when navigating
			if (isNavigating) {
				const currentMatch = matches[validIndex];
				if (currentMatch) {
					const textarea = textareaRef.current;
					textarea.focus();
					textarea.setSelectionRange(currentMatch.start, currentMatch.end);

					// Scroll to make the selection visible
					// Calculate approximate line number and scroll to it
					const textBeforeMatch = content.substring(0, currentMatch.start);
					const lineNumber = textBeforeMatch.split('\n').length;
					const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 24;
					const targetScroll = (lineNumber - 5) * lineHeight; // Leave some lines above
					textarea.scrollTop = Math.max(0, targetScroll);
				}
			}
		}, [searchQuery, currentMatchIndex, isEditableText, markdownEditMode, editContent]);

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
			} else if (e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey)) {
				// Cmd+Left: Navigate back in history (disabled in edit mode)
				if (isEditableText && markdownEditMode) return;
				e.preventDefault();
				e.stopPropagation();
				if (canGoBack && onNavigateBack) {
					onNavigateBack();
					onShortcutUsed?.('filePreviewBack');
				}
			} else if (e.key === 'ArrowRight' && (e.metaKey || e.ctrlKey)) {
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
				<div className="shrink-0" style={{ backgroundColor: theme.colors.bgSidebar }}>
					{/* Main header row */}
					<div className="border-b px-6 py-3" style={{ borderColor: theme.colors.border }}>
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-3 min-w-0">
								<FileCode className="w-5 h-5 shrink-0" style={{ color: theme.colors.accent }} />
								<div
									className="text-sm font-medium truncate"
									style={{ color: theme.colors.textMain }}
								>
									{file.name}
								</div>
							</div>
							<div className="flex items-center gap-2 shrink-0">
								{/* Save button - shown in edit mode with changes for any editable text file */}
								{isEditableText && markdownEditMode && onSave && (
									<button
										onClick={handleSave}
										disabled={!hasChanges || isSaving}
										className="px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5"
										style={{
											backgroundColor: hasChanges ? theme.colors.accent : theme.colors.bgActivity,
											color: hasChanges ? theme.colors.accentForeground : theme.colors.textDim,
											opacity: hasChanges && !isSaving ? 1 : 0.5,
											cursor: hasChanges && !isSaving ? 'pointer' : 'default',
										}}
										title={
											hasChanges
												? `Save changes (${formatShortcutKeys(['Meta', 's'])})`
												: 'No changes to save'
										}
									>
										{isSaving ? (
											<Loader2 className="w-3.5 h-3.5 animate-spin" />
										) : (
											<Save className="w-3.5 h-3.5" />
										)}
										{isSaving ? 'Saving...' : 'Save'}
									</button>
								)}
								{/* Show remote images toggle - only for markdown in preview mode */}
								{isMarkdown && !markdownEditMode && (
									<button
										onClick={() => setShowRemoteImages(!showRemoteImages)}
										className={headerBtnClass}
										style={{ color: showRemoteImages ? theme.colors.accent : theme.colors.textDim }}
										title={showRemoteImages ? 'Hide remote images' : 'Show remote images'}
									>
										<Globe className={headerIconClass} />
									</button>
								)}
								{/* Toggle between edit and preview/view mode - for any editable text file */}
								{isEditableText && (
									<button
										onClick={() => setMarkdownEditMode(!markdownEditMode)}
										className={headerBtnClass}
										style={{ color: markdownEditMode ? theme.colors.accent : theme.colors.textDim }}
										title={`${markdownEditMode ? (isMarkdown ? 'Show preview' : 'View file') : 'Edit file'} (${formatShortcut('toggleMarkdownMode')})`}
									>
										{markdownEditMode ? (
											<Eye className={headerIconClass} />
										) : (
											<Edit className={headerIconClass} />
										)}
									</button>
								)}
								<button
									onClick={() => copyContentToClipboard().catch(captureException)}
									className={headerBtnClass}
									style={{ color: theme.colors.textDim }}
									title={
										isImage
											? `Copy image to clipboard (${formatShortcutKeys(['Meta', 'c'])})`
											: 'Copy content to clipboard'
									}
								>
									<Clipboard className={headerIconClass} />
								</button>
								{/* Publish as Gist button - only show if gh CLI is available and not in edit mode */}
								{ghCliAvailable && !markdownEditMode && onPublishGist && !isImage && (
									<button
										onClick={onPublishGist}
										className={headerBtnClass}
										style={{ color: hasGist ? theme.colors.accent : theme.colors.textDim }}
										title={hasGist ? 'View published gist' : 'Publish as GitHub Gist'}
									>
										<Share2 className={headerIconClass} />
									</button>
								)}
								{/* Document Graph button - show for markdown files when callback is available */}
								{isMarkdown && onOpenInGraph && (
									<button
										onClick={onOpenInGraph}
										className={headerBtnClass}
										style={{ color: theme.colors.textDim }}
										title={`View in Document Graph (${formatShortcutKeys(['Meta', 'Shift', 'g'])})`}
									>
										<GitGraph className={headerIconClass} />
									</button>
								)}
								{!sshRemoteId && (
									<button
										onClick={() => window.maestro?.shell?.openPath(file.path)}
										className={headerBtnClass}
										style={{ color: theme.colors.textDim }}
										title="Open in Default App"
									>
										<ExternalLink className={headerIconClass} />
									</button>
								)}
								<button
									onClick={copyPathToClipboard}
									className={headerBtnClass}
									style={{ color: theme.colors.textDim }}
									title="Copy full path to clipboard"
								>
									<Copy className={headerIconClass} />
								</button>
							</div>
						</div>
						{showPath && (
							<div
								className="text-xs opacity-50 truncate mt-1"
								style={{ color: theme.colors.textDim }}
							>
								{directoryPath}
							</div>
						)}
					</div>
					{/* File Stats subbar - hidden on scroll */}
					{((fileStats || tokenCount !== null || taskCounts) && showStatsBar) ||
					canGoBack ||
					canGoForward ? (
						<div
							className="flex items-center justify-between px-6 py-1.5 border-b transition-all duration-200"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
						>
							<div className="flex items-center gap-4">
								{fileStats && (
									<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
										<span className="opacity-60">Size:</span>{' '}
										<span style={{ color: theme.colors.textMain }}>
											{formatFileSize(fileStats.size)}
										</span>
									</div>
								)}
								{tokenCount !== null && (
									<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
										<span className="opacity-60">Tokens:</span>{' '}
										<span style={{ color: theme.colors.accent }}>
											{formatTokenCount(tokenCount)}
										</span>
									</div>
								)}
								{fileStats && (
									<>
										<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
											<span className="opacity-60">Modified:</span>{' '}
											<span style={{ color: theme.colors.textMain }}>
												{formatDateTime(fileStats.modifiedAt)}
											</span>
										</div>
										<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
											<span className="opacity-60">Created:</span>{' '}
											<span style={{ color: theme.colors.textMain }}>
												{formatDateTime(fileStats.createdAt)}
											</span>
										</div>
									</>
								)}
								{taskCounts && (
									<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
										<span className="opacity-60">Tasks:</span>{' '}
										<span style={{ color: theme.colors.success }}>{taskCounts.closed}</span>
										<span style={{ color: theme.colors.textMain }}>
											{' '}
											of {taskCounts.open + taskCounts.closed}
										</span>
									</div>
								)}
							</div>
							{/* Navigation buttons - show when either direction is available, disabled in edit mode */}
							{(canGoBack || canGoForward) && !markdownEditMode && (
								<div className="flex items-center gap-1">
									{/* Back button with popup */}
									<div
										className="relative"
										onMouseEnter={() => {
											if (backPopupTimeoutRef.current) {
												clearTimeout(backPopupTimeoutRef.current);
												backPopupTimeoutRef.current = null;
											}
											if (canGoBack) setShowBackPopup(true);
										}}
										onMouseLeave={() => {
											backPopupTimeoutRef.current = setTimeout(() => {
												setShowBackPopup(false);
											}, 150);
										}}
									>
										<button
											onClick={onNavigateBack}
											disabled={!canGoBack}
											className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-default"
											style={{ color: canGoBack ? theme.colors.textMain : theme.colors.textDim }}
											title={`Go back (${formatShortcutKeys(['Meta', 'ArrowLeft'])})`}
										>
											<ChevronLeft className="w-4 h-4" />
										</button>
										{/* Back history popup */}
										{showBackPopup && backHistory && backHistory.length > 0 && (
											<div
												className="absolute right-0 top-full py-1 rounded shadow-lg z-50 min-w-[200px] max-w-[300px] max-h-[300px] overflow-y-auto"
												style={{
													backgroundColor: theme.colors.bgSidebar,
													border: `1px solid ${theme.colors.border}`,
												}}
											>
												{backHistory
													.slice()
													.reverse()
													.map((item, idx) => {
														const actualIndex = backHistory.length - 1 - idx;
														return (
															<button
																key={`back-${actualIndex}`}
																className="w-full px-3 py-1.5 text-left text-xs hover:bg-white/10 truncate flex items-center gap-2"
																style={{ color: theme.colors.textMain }}
																onClick={() => {
																	onNavigateToIndex?.(actualIndex);
																	setShowBackPopup(false);
																}}
															>
																<span className="opacity-50 shrink-0">{actualIndex + 1}.</span>
																<span className="truncate">{item.name}</span>
															</button>
														);
													})}
											</div>
										)}
									</div>
									{/* Forward button with popup */}
									<div
										className="relative"
										onMouseEnter={() => {
											if (forwardPopupTimeoutRef.current) {
												clearTimeout(forwardPopupTimeoutRef.current);
												forwardPopupTimeoutRef.current = null;
											}
											if (canGoForward) setShowForwardPopup(true);
										}}
										onMouseLeave={() => {
											forwardPopupTimeoutRef.current = setTimeout(() => {
												setShowForwardPopup(false);
											}, 150);
										}}
									>
										<button
											onClick={onNavigateForward}
											disabled={!canGoForward}
											className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-default"
											style={{ color: canGoForward ? theme.colors.textMain : theme.colors.textDim }}
											title={`Go forward (${formatShortcutKeys(['Meta', 'ArrowRight'])})`}
										>
											<ChevronRight className="w-4 h-4" />
										</button>
										{/* Forward history popup */}
										{showForwardPopup && forwardHistory && forwardHistory.length > 0 && (
											<div
												className="absolute right-0 top-full py-1 rounded shadow-lg z-50 min-w-[200px] max-w-[300px] max-h-[300px] overflow-y-auto"
												style={{
													backgroundColor: theme.colors.bgSidebar,
													border: `1px solid ${theme.colors.border}`,
												}}
											>
												{forwardHistory.map((item, idx) => {
													const actualIndex = (currentHistoryIndex ?? 0) + 1 + idx;
													return (
														<button
															key={`forward-${actualIndex}`}
															className="w-full px-3 py-1.5 text-left text-xs hover:bg-white/10 truncate flex items-center gap-2"
															style={{ color: theme.colors.textMain }}
															onClick={() => {
																onNavigateToIndex?.(actualIndex);
																setShowForwardPopup(false);
															}}
														>
															<span className="opacity-50 shrink-0">{actualIndex + 1}.</span>
															<span className="truncate">{item.name}</span>
														</button>
													);
												})}
											</div>
										)}
									</div>
								</div>
							)}
						</div>
					) : null}
				</div>

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
							<button
								onClick={() => setFileChangedOnDisk(false)}
								className="p-1 rounded hover:bg-white/10 transition-colors"
								title="Dismiss"
							>
								<X className="w-3 h-3" style={{ color: theme.colors.textDim }} />
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
						<div className="sticky top-0 z-10 pb-4">
							<div className="flex items-center gap-2">
								<input
									ref={searchInputRef}
									type="text"
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === 'Escape') {
											e.preventDefault();
											e.stopPropagation();
											setSearchOpen(false);
											setSearchQuery('');
											// Refocus container so keyboard navigation still works
											containerRef.current?.focus();
										} else if (e.key === 'Enter' && !e.shiftKey) {
											e.preventDefault();
											goToNextMatch();
										} else if (e.key === 'Enter' && e.shiftKey) {
											e.preventDefault();
											goToPrevMatch();
										}
									}}
									placeholder="Search in file... (Enter: next, Shift+Enter: prev)"
									className="flex-1 px-3 py-2 rounded border bg-transparent outline-none text-sm"
									style={{
										borderColor: theme.colors.accent,
										color: theme.colors.textMain,
										backgroundColor: theme.colors.bgSidebar,
									}}
									autoFocus
								/>
								{searchQuery.trim() && (
									<>
										<span
											className="text-xs whitespace-nowrap"
											style={{ color: theme.colors.textDim }}
										>
											{totalMatches > 0 ? `${currentMatchIndex + 1}/${totalMatches}` : 'No matches'}
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
							</div>
						</div>
					)}
					{isImage ? (
						<div className="flex items-center justify-center h-full">
							<img
								src={file.content}
								alt={file.name}
								className="max-w-full max-h-full object-contain"
								style={{ imageRendering: 'crisp-edges' }}
							/>
						</div>
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
						// Edit mode - show editable textarea for any text file
						<textarea
							ref={textareaRef}
							value={editContent}
							onChange={(e) => setEditContent(e.target.value)}
							className="w-full h-full font-mono text-sm resize-none outline-none bg-transparent"
							style={{
								color: theme.colors.textMain,
								caretColor: theme.colors.accent,
								lineHeight: '1.6',
							}}
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
							onMatchCount={(count) => {
								setTotalMatches(count);
								setCurrentMatchIndex(count > 0 ? 0 : -1);
							}}
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
										{formatFileSize(file.content.length)}. Use an external editor for the full file.
									</span>
								</div>
							)}
							<SyntaxHighlighter
								language={language}
								style={vscDarkPlus}
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

					{/* Table of Contents Floating Button and Overlay - Only for markdown in preview mode */}
					{isMarkdown && !markdownEditMode && tocEntries.length > 0 && (
						<>
							{/* Floating TOC Button */}
							<button
								ref={tocButtonRef}
								onClick={() => setShowTocOverlay(!showTocOverlay)}
								className="absolute bottom-4 right-4 p-2.5 rounded-full shadow-lg transition-all duration-200 hover:scale-105 z-10"
								style={{
									backgroundColor: showTocOverlay ? theme.colors.accent : theme.colors.bgSidebar,
									color: showTocOverlay ? theme.colors.accentForeground : theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
								title="Table of Contents"
							>
								<List className="w-5 h-5" />
							</button>

							{/* TOC Overlay - click outside handled by useClickOutside hook */}
							{showTocOverlay && (
								<div
									ref={tocOverlayRef}
									className="absolute bottom-16 right-4 rounded-lg shadow-xl overflow-hidden z-20 animate-in fade-in slide-in-from-bottom-2 duration-200 flex flex-col"
									style={{
										backgroundColor: theme.colors.bgSidebar,
										border: `1px solid ${theme.colors.border}`,
										maxHeight: 'calc(70vh - 80px)',
										minWidth: '200px',
										maxWidth: '350px',
									}}
									onWheel={(e) => e.stopPropagation()}
								>
									{/* TOC Header */}
									<div
										className="px-3 py-2 border-b flex items-center justify-between flex-shrink-0"
										style={{ borderColor: theme.colors.border }}
									>
										<span
											className="text-xs font-medium uppercase tracking-wide"
											style={{ color: theme.colors.textDim }}
										>
											Contents
										</span>
										<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
											{tocEntries.length} headings
										</span>
									</div>
									{/* Top Navigation Sash */}
									<button
										data-testid="toc-top-button"
										onClick={() => {
											scrollMarkdownToBoundary('top');
										}}
										className="w-full px-3 py-2 text-left text-xs border-b transition-colors flex items-center gap-2 hover:brightness-110 flex-shrink-0"
										style={{
											backgroundColor: `${theme.colors.accent}15`,
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
										}}
										title="Jump to top"
									>
										<ChevronUp className="w-3 h-3" style={{ color: theme.colors.accent }} />
										<span>Top</span>
									</button>

									{/* TOC Entries - scrollable middle section */}
									<div
										className="overflow-y-auto px-1 py-1 flex-1 min-h-0"
										style={{ overscrollBehavior: 'contain' }}
										onWheel={(e) => e.stopPropagation()}
									>
										{tocEntries.map((entry, index) => {
											// Get color based on heading level (match the prose styles)
											const levelColors: Record<number, string> = {
												1: theme.colors.accent,
												2: theme.colors.success,
												3: theme.colors.warning,
												4: theme.colors.textMain,
												5: theme.colors.textMain,
												6: theme.colors.textDim,
											};
											const headingColor = levelColors[entry.level] || theme.colors.textMain;

											return (
												<button
													key={`${entry.slug}-${index}`}
													onClick={() => {
														// Find and scroll to the heading
														const targetElement = markdownContainerRef.current?.querySelector(
															`#${CSS.escape(entry.slug)}`
														);
														if (targetElement) {
															targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
														}
														// ToC stays open so user can click multiple items
														// Dismiss with click outside or Escape key
													}}
													className="w-full px-2 py-1.5 text-left text-sm rounded hover:bg-white/10 transition-colors truncate flex items-center gap-1"
													style={{
														color: headingColor,
														paddingLeft: `${(entry.level - 1) * 12 + 8}px`,
														opacity: entry.level > 3 ? 0.85 : 1,
														fontSize:
															entry.level === 1
																? '0.875rem'
																: entry.level === 2
																	? '0.8125rem'
																	: '0.75rem',
													}}
													title={entry.text}
												>
													<span className="truncate">{entry.text}</span>
												</button>
											);
										})}
									</div>

									{/* Bottom Navigation Sash */}
									<button
										data-testid="toc-bottom-button"
										onClick={() => {
											scrollMarkdownToBoundary('bottom');
										}}
										className="w-full px-3 py-2 text-left text-xs border-t transition-colors flex items-center gap-2 hover:brightness-110 flex-shrink-0"
										style={{
											backgroundColor: `${theme.colors.accent}15`,
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
										}}
										title="Jump to bottom"
									>
										<ChevronDown className="w-3 h-3" style={{ color: theme.colors.accent }} />
										<span>Bottom</span>
									</button>
								</div>
							)}
						</>
					)}
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
