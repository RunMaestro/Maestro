import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
	FileCode,
	Eye,
	ChevronLeft,
	ChevronRight,
	Clipboard,
	Copy,
	Globe,
	AppWindow,
	Image as ImageIcon,
	Save,
	Edit,
	Share2,
	GitGraph,
	ExternalLink,
	WrapText,
} from 'lucide-react';
import type { FilePreviewToolbarVisibility } from '../../stores/settingsStore';
import { Spinner } from '../ui/Spinner';
import { HoverTooltip } from '../ui/HoverTooltip';
import { captureException } from '../../utils/sentry';
import { isWebDesktop } from '../../utils/runtimeContext';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { formatFileSize, formatDateTime, countLines } from './filePreviewUtils';
import { formatNumber } from '../../../shared/formatters';
import type { PreviewTier } from './filePreviewUtils';
import { formatTokenCount } from '../../utils/tokenCounter';
import { PreviewTierChip } from './PreviewTierChip';

interface FilePreviewHeaderProps {
	file: { name: string; content: string; path: string };
	theme: any;
	isMarkdown: boolean;
	isImage: boolean;
	isEditableText: boolean;
	markdownEditMode: boolean;
	showRemoteImages: boolean;
	setShowRemoteImages: (v: boolean) => void;
	setMarkdownEditMode: (v: boolean) => void;
	onSave?: () => void;
	hasChanges: boolean;
	isSaving: boolean;
	fileStats: { size: number; modifiedAt: string; createdAt: string } | null;
	tokenCount: number | null;
	taskCounts: { open: number; closed: number } | null;
	showStatsBar: boolean;
	directoryPath: string;
	showPath: boolean;
	shortcuts: Record<string, any>;
	canGoBack?: boolean;
	canGoForward?: boolean;
	onNavigateBack?: () => void;
	onNavigateForward?: () => void;
	backHistory?: { name: string; path: string }[];
	forwardHistory?: { name: string; path: string }[];
	onNavigateToIndex?: (index: number) => void;
	currentHistoryIndex?: number;
	ghCliAvailable?: boolean;
	onPublishGist?: () => void;
	hasGist?: boolean;
	onOpenInGraph?: () => void;
	/** Open this file as a new tab in the embedded Maestro browser. */
	onOpenInBrowser?: () => void;
	sshRemoteId?: string;
	copyContentToClipboard: () => Promise<void>;
	copyPathToClipboard: () => void;
	/** Open the image annotator to edit the previewed image. Images only. */
	onEditImage?: () => void;
	headerBtnClass: string;
	headerIconClass: string;
	/** Whether the previewed file is HTML (.html / .htm). */
	isHtml: boolean;
	/** When true, FilePreview renders the HTML via webview instead of source. */
	htmlRenderMode: boolean;
	/** Flip between rendered HTML and source view. */
	setHtmlRenderMode: (v: boolean) => void;
	/** Show the preview-tier chip in the toolbar. Hidden in edit mode, on
	 *  binary/image files, and when HTML render mode is active. */
	showTierChip: boolean;
	autoTier: PreviewTier;
	previewTierOverride: PreviewTier | undefined;
	onPreviewTierChange?: (tier: PreviewTier | undefined) => void;
	/** Editor word-wrap state + toggle. Shown in edit mode as a toolbar button. */
	wordWrap: boolean;
	setWordWrap: (v: boolean) => void;
	/** Per-button visibility map. When a key is false, the corresponding
	 *  toolbar button is hidden (functionality stays reachable via shortcut). */
	toolbarVisibility: FilePreviewToolbarVisibility;
}

export const FilePreviewHeader = React.memo(function FilePreviewHeader({
	file,
	theme,
	isMarkdown,
	isImage,
	isEditableText,
	markdownEditMode,
	showRemoteImages,
	setShowRemoteImages,
	setMarkdownEditMode,
	onSave,
	hasChanges,
	isSaving,
	fileStats,
	tokenCount,
	taskCounts,
	showStatsBar,
	directoryPath,
	showPath,
	shortcuts,
	canGoBack,
	canGoForward,
	onNavigateBack,
	onNavigateForward,
	backHistory,
	forwardHistory,
	onNavigateToIndex,
	currentHistoryIndex,
	ghCliAvailable,
	onPublishGist,
	hasGist,
	onOpenInGraph,
	onOpenInBrowser,
	sshRemoteId,
	copyContentToClipboard,
	copyPathToClipboard,
	onEditImage,
	headerBtnClass,
	headerIconClass,
	isHtml,
	htmlRenderMode,
	setHtmlRenderMode,
	showTierChip,
	autoTier,
	previewTierOverride,
	onPreviewTierChange,
	wordWrap,
	setWordWrap,
	toolbarVisibility,
}: FilePreviewHeaderProps) {
	const [showBackPopup, setShowBackPopup] = useState(false);
	const [showForwardPopup, setShowForwardPopup] = useState(false);
	const backPopupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const forwardPopupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Line count for plain-text files (not images/binaries). Cheap O(n) newline
	// scan, memoized on content so it doesn't re-run on every header re-render.
	const lineCount = useMemo(
		() => (isEditableText ? countLines(file.content) : null),
		[isEditableText, file.content]
	);

	// Clear pending popup timeouts on unmount
	useEffect(() => {
		return () => {
			if (backPopupTimeoutRef.current) clearTimeout(backPopupTimeoutRef.current);
			if (forwardPopupTimeoutRef.current) clearTimeout(forwardPopupTimeoutRef.current);
		};
	}, []);

	const formatShortcut = (shortcutId: string): string => {
		const shortcut = shortcuts[shortcutId];
		if (!shortcut) return '';
		return formatShortcutKeys(shortcut.keys);
	};

	return (
		<div className="shrink-0" style={{ backgroundColor: theme.colors.bgSidebar }}>
			{/* Main header row */}
			<div className="border-b px-6 py-3" style={{ borderColor: theme.colors.border }}>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3 min-w-0">
						<FileCode className="w-5 h-5 shrink-0" style={{ color: theme.colors.accent }} />
						<div className="text-sm font-medium truncate" style={{ color: theme.colors.textMain }}>
							{file.name}
						</div>
					</div>
					<div className="flex items-center gap-2 shrink-0">
						{/* Save button - shown in edit mode, or in preview when unsaved edits remain
						    (the user can flip to preview while dirty and still needs Save). */}
						{toolbarVisibility.save &&
							isEditableText &&
							(markdownEditMode || hasChanges) &&
							onSave && (
								<HoverTooltip
									theme={theme}
									label={hasChanges ? 'Save changes' : 'No changes to save'}
									shortcut={hasChanges ? formatShortcutKeys(['Meta', 's']) : undefined}
								>
									<button
										onClick={onSave}
										disabled={!hasChanges || isSaving}
										className="px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5"
										style={{
											backgroundColor: hasChanges ? theme.colors.accent : theme.colors.bgActivity,
											color: hasChanges ? theme.colors.accentForeground : theme.colors.textDim,
											opacity: hasChanges && !isSaving ? 1 : 0.5,
											cursor: hasChanges && !isSaving ? 'pointer' : 'default',
										}}
									>
										{isSaving ? <Spinner size={14} /> : <Save className="w-3.5 h-3.5" />}
										{isSaving ? 'Saving...' : 'Save'}
									</button>
								</HoverTooltip>
							)}
						{/* Word-wrap toggle — edit mode only. Switches between soft-wrap
						    (default; long lines wrap at whitespace) and no-wrap
						    (horizontal scroll). */}
						{toolbarVisibility.wordWrap && isEditableText && markdownEditMode && (
							<HoverTooltip
								theme={theme}
								label={wordWrap ? 'Disable word wrap' : 'Enable word wrap'}
							>
								<button
									onClick={() => setWordWrap(!wordWrap)}
									className={headerBtnClass}
									style={{ color: wordWrap ? theme.colors.accent : theme.colors.textDim }}
									data-testid="editor-wrap-toggle"
								>
									<WrapText className={headerIconClass} />
								</button>
							</HoverTooltip>
						)}
						{/* Show remote images toggle - only for markdown in preview mode */}
						{toolbarVisibility.remoteImages && isMarkdown && !markdownEditMode && (
							<HoverTooltip
								theme={theme}
								label={showRemoteImages ? 'Hide remote images' : 'Show remote images'}
							>
								<button
									onClick={() => setShowRemoteImages(!showRemoteImages)}
									className={headerBtnClass}
									style={{ color: showRemoteImages ? theme.colors.accent : theme.colors.textDim }}
								>
									<ImageIcon className={headerIconClass} />
								</button>
							</HoverTooltip>
						)}
						{/* HTML render toggle - swap between rendered HTML and source view */}
						{toolbarVisibility.htmlRender && isHtml && !markdownEditMode && (
							<HoverTooltip
								theme={theme}
								label={htmlRenderMode ? 'Show HTML source' : 'Render HTML in browser'}
							>
								<button
									onClick={() => setHtmlRenderMode(!htmlRenderMode)}
									className={headerBtnClass}
									style={{ color: htmlRenderMode ? theme.colors.accent : theme.colors.textDim }}
									data-testid="html-render-toggle"
								>
									<Globe className={headerIconClass} />
								</button>
							</HoverTooltip>
						)}
						{/* Preview tier chip - compact icon-only mode inside the toolbar */}
						{toolbarVisibility.previewTier && showTierChip && (
							<PreviewTierChip
								theme={theme}
								autoTier={autoTier}
								override={previewTierOverride}
								onSelect={(tier) => onPreviewTierChange?.(tier)}
								iconOnly
								headerBtnClass={headerBtnClass}
								headerIconClass={headerIconClass}
							/>
						)}
						{/* Toggle between edit and preview/view mode - for any editable text file */}
						{toolbarVisibility.editToggle && isEditableText && (
							<HoverTooltip
								theme={theme}
								label={markdownEditMode ? (isMarkdown ? 'Show preview' : 'View file') : 'Edit file'}
								shortcut={formatShortcut('toggleMarkdownMode')}
							>
								<button
									onClick={() => setMarkdownEditMode(!markdownEditMode)}
									className={headerBtnClass}
									style={{ color: markdownEditMode ? theme.colors.accent : theme.colors.textDim }}
									data-testid="edit-text-toggle"
								>
									{markdownEditMode ? (
										<Eye className={headerIconClass} />
									) : (
										<Edit className={headerIconClass} />
									)}
								</button>
							</HoverTooltip>
						)}
						{/* Edit image - opens the image annotator. Images only. */}
						{toolbarVisibility.editImage && isImage && onEditImage && (
							<HoverTooltip
								theme={theme}
								label="Edit image"
								shortcut={formatShortcut('toggleMarkdownMode')}
							>
								<button
									onClick={onEditImage}
									className={headerBtnClass}
									style={{ color: theme.colors.textDim }}
									data-testid="edit-image-button"
								>
									<Edit className={headerIconClass} />
								</button>
							</HoverTooltip>
						)}
						{toolbarVisibility.copyContent && (
							<HoverTooltip
								theme={theme}
								label={isImage ? 'Copy image to clipboard' : 'Copy content to clipboard'}
								shortcut={isImage ? formatShortcutKeys(['Meta', 'c']) : undefined}
							>
								<button
									onClick={() => copyContentToClipboard().catch(captureException)}
									className={headerBtnClass}
									style={{ color: theme.colors.textDim }}
								>
									<Clipboard className={headerIconClass} />
								</button>
							</HoverTooltip>
						)}
						{/* Publish as Gist button - only show if gh CLI is available and not in edit mode */}
						{toolbarVisibility.publishGist &&
							ghCliAvailable &&
							!markdownEditMode &&
							onPublishGist &&
							!isImage && (
								<HoverTooltip
									theme={theme}
									label={hasGist ? 'View published gist' : 'Publish as GitHub Gist'}
								>
									<button
										onClick={onPublishGist}
										className={headerBtnClass}
										style={{ color: hasGist ? theme.colors.accent : theme.colors.textDim }}
									>
										<Share2 className={headerIconClass} />
									</button>
								</HoverTooltip>
							)}
						{/* Document Graph button - show for markdown files when callback is available */}
						{toolbarVisibility.documentGraph && isMarkdown && onOpenInGraph && (
							<HoverTooltip
								theme={theme}
								label="View in Document Graph"
								shortcut={formatShortcutKeys(['Meta', 'Shift', 'g'])}
							>
								<button
									onClick={onOpenInGraph}
									className={headerBtnClass}
									style={{ color: theme.colors.textDim }}
								>
									<GitGraph className={headerIconClass} />
								</button>
							</HoverTooltip>
						)}
						{/* Open in Maestro Browser — HTML files only, not over SSH
						    (file:// can't reach the remote host). Mirrors the file-tree
						    right-click action so JS-heavy local HTML renders in the full
						    webview instead of the sandboxed preview iframe. */}
						{toolbarVisibility.openInBrowser && isHtml && !sshRemoteId && onOpenInBrowser && (
							<HoverTooltip theme={theme} label="Open in Maestro Browser">
								<button
									onClick={onOpenInBrowser}
									className={headerBtnClass}
									style={{ color: theme.colors.textDim }}
									data-testid="open-in-maestro-browser"
								>
									<AppWindow className={headerIconClass} />
								</button>
							</HoverTooltip>
						)}
						{/* "Open in Default App" hands the file to the HOST machine's OS
						    opener via the shell bridge. In the web-desktop build the host is
						    not the browser user's device, so hide it there (as we already do
						    over SSH, where file:// can't reach the remote host). */}
						{toolbarVisibility.openInDefault && !sshRemoteId && !isWebDesktop() && (
							<HoverTooltip theme={theme} label="Open in Default App">
								<button
									onClick={() => window.maestro?.shell?.openPath(file.path)}
									className={headerBtnClass}
									style={{ color: theme.colors.textDim }}
								>
									<ExternalLink className={headerIconClass} />
								</button>
							</HoverTooltip>
						)}
						{toolbarVisibility.copyPath && (
							<HoverTooltip theme={theme} label="Copy full path to clipboard">
								<button
									onClick={copyPathToClipboard}
									className={headerBtnClass}
									style={{ color: theme.colors.textDim }}
								>
									<Copy className={headerIconClass} />
								</button>
							</HoverTooltip>
						)}
					</div>
				</div>
				{showPath && (
					<div className="text-xs opacity-50 truncate mt-1" style={{ color: theme.colors.textDim }}>
						{directoryPath}
					</div>
				)}
			</div>
			{/* File Stats subbar - hidden on scroll */}
			{((fileStats || lineCount !== null || tokenCount !== null || taskCounts) && showStatsBar) ||
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
						{lineCount !== null && (
							<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
								<span className="opacity-60">Lines:</span>{' '}
								<span style={{ color: theme.colors.textMain }}>{formatNumber(lineCount)}</span>
							</div>
						)}
						{tokenCount !== null && (
							<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
								<span className="opacity-60">Tokens:</span>{' '}
								<span style={{ color: theme.colors.accent }}>{formatTokenCount(tokenCount)}</span>
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
	);
});
