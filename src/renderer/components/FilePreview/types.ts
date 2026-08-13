import type { FileNode } from '../../types/fileTree';

export interface FileStats {
	size: number;
	createdAt: string;
	modifiedAt: string;
}

export interface FilePreviewProps {
	file: { name: string; content: string; path: string } | null;
	onClose: () => void;
	theme: any;
	markdownEditMode: boolean;
	setMarkdownEditMode: (value: boolean) => void;
	onSave?: (path: string, content: string) => Promise<boolean | void>;
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
	/**
	 * Callback to open the current file in a new Maestro browser tab. Wired only
	 * for HTML files - the sandboxed preview iframe can't run JS-heavy local
	 * dashboards, but the full webview can.
	 */
	onOpenInBrowser?: () => void;
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
	/** Timestamp (ms) when file was last modified on disk - used for change detection polling */
	lastModified?: number;
	/** Callback to reload file content from disk (called when user clicks Reload in the change banner) */
	onReloadFile?: () => void;
	/**
	 * Per-tab preview tier override. When set, the FilePreview forces this
	 * tier regardless of file size. When undefined, the auto-picker decides.
	 */
	previewTierOverride?: 'rich' | 'fast' | 'giant';
	/**
	 * Callback fired when the user picks a tier in the override chip.
	 * Passing `undefined` returns the file to auto-tier mode.
	 */
	onPreviewTierChange?: (tier: 'rich' | 'fast' | 'giant' | undefined) => void;
	/**
	 * For HTML files only: when true, FilePreview swaps the source view for an
	 * embedded iframe rendering of the HTML. Defaults to false (source view).
	 */
	htmlRenderMode?: boolean;
	/** Setter for the HTML render toggle. Persisted per-tab via the tab store. */
	onHtmlRenderModeChange?: (value: boolean) => void;
	/** 1-based line that the editor should jump to on next render. Set by
	 *  maestro://file/...#L<n> deep links and consumed exactly once. */
	pendingScrollToLine?: number;
	/** Called after FilePreview has scrolled to pendingScrollToLine so the
	 *  caller can clear it (otherwise we'd re-jump every render). */
	onPendingScrollToLineConsumed?: () => void;
}

export interface FilePreviewHandle {
	focus: () => void;
}

export interface TocEntry {
	level: number; // 1-6 for h1-h6
	text: string;
	slug: string;
}
