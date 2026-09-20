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
	Mic,
	ExternalLink,
	FolderOpen,
	WrapText,
	Trash2,
	MoreHorizontal,
} from 'lucide-react';
import type { FilePreviewToolbarVisibility } from '../../stores/settingsStore';
import { Spinner } from '../ui/Spinner';
import { HoverTooltip } from '../ui/HoverTooltip';
import { captureException } from '../../utils/sentry';
import { isWebDesktop } from '../../utils/runtimeContext';
import { usePhoneLayout } from '../../hooks/ui/useViewportBreakpoint';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { getRevealLabel } from '../../utils/platformUtils';
import { formatFileSize, formatDateTime, countLines } from './filePreviewUtils';
import { formatNumber } from '../../../shared/formatters';
import type { PreviewTier } from './filePreviewUtils';
import { formatTokenCount } from '../../utils/tokenCounter';
import { PreviewTierChip } from './PreviewTierChip';
import { FilePreviewActionsSheet } from './FilePreviewActionsSheet';
import type { FilePreviewHeaderAction, FilePreviewHeaderStat } from './FilePreviewActionsSheet';

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
	/** Whether this file's contents can go up as a gist (plain text only) */
	canPublishGist?: boolean;
	hasGist?: boolean;
	onOpenInGraph?: () => void;
	/** Open this file as a new tab in the embedded Maestro browser. */
	onOpenInBrowser?: () => void;
	sshRemoteId?: string;
	copyContentToClipboard: () => Promise<void>;
	copyPathToClipboard: () => void;
	/** Open the image annotator to edit the previewed image. Images only. */
	onEditImage?: () => void;
	/**
	 * Start a voice session about this file. Omitted when A Cappella is off, which
	 * is the Encore rule: a feature nobody turned on adds no buttons anywhere.
	 */
	onTalkWithDocument?: () => void;
	/** True while the live voice session is already about THIS file. */
	isTalkingAboutDocument?: boolean;
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
	/** Open the delete confirmation for this file. Omitted when the preview is
	 *  not backed by a deletable on-disk file. */
	onDelete?: () => void;
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
	canPublishGist,
	hasGist,
	onOpenInGraph,
	onOpenInBrowser,
	sshRemoteId,
	copyContentToClipboard,
	copyPathToClipboard,
	onEditImage,
	onTalkWithDocument,
	isTalkingAboutDocument = false,
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
	onDelete,
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

	// Phone: the toolbar holds up to fourteen buttons, each on a 44px tap-target
	// floor, so at 390px it wrapped onto a second row and - with the path line and
	// the stats subbar under it - ate roughly 400px before a word of the file was
	// readable. There it collapses to one "..." that opens FilePreviewActionsSheet,
	// which carries the buttons, the path, and the stats.
	const phone = usePhoneLayout();
	const [actionsSheetOpen, setActionsSheetOpen] = useState(false);

	// ONE list of stats, rendered by the subbar on a desktop and by the sheet on a
	// phone. Built unconditionally: `showStatsBar` hides the subbar while the
	// reader scrolls, which says nothing about a sheet the user opened by hand.
	const stats: FilePreviewHeaderStat[] = [];
	if (fileStats) {
		stats.push({ key: 'size', label: 'Size', value: formatFileSize(fileStats.size) });
	}
	if (lineCount !== null) {
		stats.push({ key: 'lines', label: 'Lines', value: formatNumber(lineCount) });
	}
	if (tokenCount !== null) {
		stats.push({
			key: 'tokens',
			label: 'Tokens',
			value: formatTokenCount(tokenCount),
			valueColor: theme.colors.accent,
		});
	}
	if (fileStats) {
		stats.push({ key: 'modified', label: 'Modified', value: formatDateTime(fileStats.modifiedAt) });
		stats.push({ key: 'created', label: 'Created', value: formatDateTime(fileStats.createdAt) });
	}
	if (taskCounts) {
		stats.push({
			key: 'tasks',
			label: 'Tasks',
			value: (
				<>
					<span style={{ color: theme.colors.success }}>{taskCounts.closed}</span>
					{` of ${taskCounts.open + taskCounts.closed}`}
				</>
			),
		});
	}

	// ONE list of toolbar actions, in toolbar order, rendered as icon buttons on a
	// desktop and as labelled rows in the phone sheet. Every `toolbarVisibility`
	// gate is applied HERE, once, so a button the user hid in Settings cannot stay
	// reachable in the sheet - and a button added later cannot land in one surface
	// and be missing from the other. Save is deliberately absent: it is a labelled
	// primary control with a dirty state, and it stays inline on both.
	const actions: FilePreviewHeaderAction[] = [];
	// Word-wrap toggle - edit mode only. Switches between soft-wrap (default;
	// long lines wrap at whitespace) and no-wrap (horizontal scroll).
	if (toolbarVisibility.wordWrap && isEditableText && markdownEditMode) {
		actions.push({
			kind: 'button',
			key: 'wordWrap',
			icon: WrapText,
			label: wordWrap ? 'Disable word wrap' : 'Enable word wrap',
			onClick: () => setWordWrap(!wordWrap),
			active: wordWrap,
			testId: 'editor-wrap-toggle',
		});
	}
	// Show remote images toggle - only for markdown in preview mode.
	if (toolbarVisibility.remoteImages && isMarkdown && !markdownEditMode) {
		actions.push({
			kind: 'button',
			key: 'remoteImages',
			icon: ImageIcon,
			label: showRemoteImages ? 'Hide remote images' : 'Show remote images',
			onClick: () => setShowRemoteImages(!showRemoteImages),
			active: showRemoteImages,
		});
	}
	// HTML render toggle - swap between rendered HTML and source view.
	if (toolbarVisibility.htmlRender && isHtml && !markdownEditMode) {
		actions.push({
			kind: 'button',
			key: 'htmlRender',
			icon: Globe,
			label: htmlRenderMode ? 'Show HTML source' : 'Render HTML in browser',
			onClick: () => setHtmlRenderMode(!htmlRenderMode),
			active: htmlRenderMode,
			testId: 'html-render-toggle',
		});
	}
	// Open in Maestro Browser - HTML files only, not over SSH (file:// can't
	// reach the remote host). Mirrors the file-tree right-click action so
	// JS-heavy local HTML renders in the full webview instead of the sandboxed
	// preview iframe. Sits next to the HTML render toggle since both are
	// "view this in a browser" actions.
	if (toolbarVisibility.openInBrowser && isHtml && !sshRemoteId && onOpenInBrowser) {
		actions.push({
			kind: 'button',
			key: 'openInBrowser',
			icon: AppWindow,
			label: 'Open in Maestro Browser',
			onClick: onOpenInBrowser,
			testId: 'open-in-maestro-browser',
		});
	}
	// Preview tier - a chip with its own popover on a desktop, an accordion in
	// the sheet (an anchored popover would be clipped by the scrolling body).
	if (toolbarVisibility.previewTier && showTierChip) {
		actions.push({
			kind: 'tier',
			key: 'previewTier',
			autoTier,
			override: previewTierOverride,
			onSelect: (tier) => onPreviewTierChange?.(tier),
		});
	}
	// Toggle between edit and preview/view mode - for any editable text file.
	if (toolbarVisibility.editToggle && isEditableText) {
		actions.push({
			kind: 'button',
			key: 'editToggle',
			icon: markdownEditMode ? Eye : Edit,
			label: markdownEditMode ? (isMarkdown ? 'Show preview' : 'View file') : 'Edit file',
			onClick: () => setMarkdownEditMode(!markdownEditMode),
			active: markdownEditMode,
			shortcut: formatShortcut('toggleMarkdownMode'),
			testId: 'edit-text-toggle',
		});
	}
	// Edit image - opens the image annotator. Images only.
	if (toolbarVisibility.editImage && isImage && onEditImage) {
		actions.push({
			kind: 'button',
			key: 'editImage',
			icon: Edit,
			label: 'Edit image',
			onClick: onEditImage,
			shortcut: formatShortcut('toggleMarkdownMode'),
			testId: 'edit-image-button',
		});
	}
	if (toolbarVisibility.copyContent) {
		actions.push({
			kind: 'button',
			key: 'copyContent',
			icon: Clipboard,
			label: isImage ? 'Copy image to clipboard' : 'Copy content to clipboard',
			onClick: () => copyContentToClipboard().catch(captureException),
			shortcut: isImage ? formatShortcutKeys(['Meta', 'c']) : undefined,
		});
	}
	// Publish as Gist - gh CLI available, not editing, and the file is plain
	// text a gist can carry (see isGistPublishableFile).
	if (
		toolbarVisibility.publishGist &&
		ghCliAvailable &&
		!markdownEditMode &&
		onPublishGist &&
		canPublishGist
	) {
		actions.push({
			kind: 'button',
			key: 'publishGist',
			icon: Share2,
			label: hasGist ? 'View published gist' : 'Publish as GitHub Gist',
			onClick: onPublishGist,
			active: hasGist,
		});
	}
	// Talk with Document - opens a voice session with this file as the
	// conversation's subject. It doubles as the stop control while that session
	// is running, matching the composer microphone: one button that reads as
	// active is what stops a second session being opened on top of the first.
	if (toolbarVisibility.talkWithDocument && onTalkWithDocument) {
		actions.push({
			kind: 'button',
			key: 'talkWithDocument',
			icon: Mic,
			label: isTalkingAboutDocument
				? 'End the voice session about this document'
				: 'Talk with this document',
			onClick: onTalkWithDocument,
			active: isTalkingAboutDocument,
			pressed: isTalkingAboutDocument,
			testId: 'talk-with-document-button',
		});
	}
	// Document Graph - markdown files, when the callback is available.
	if (toolbarVisibility.documentGraph && isMarkdown && onOpenInGraph) {
		actions.push({
			kind: 'button',
			key: 'documentGraph',
			icon: GitGraph,
			label: 'View in Document Graph',
			onClick: onOpenInGraph,
		});
	}
	// "Open in Default App" hands the file to the HOST machine's OS opener via
	// the shell bridge. In the web-desktop build the host is not the browser
	// user's device, so hide it there (as we already do over SSH, where file://
	// can't reach the remote host).
	if (toolbarVisibility.openInDefault && !sshRemoteId && !isWebDesktop()) {
		actions.push({
			kind: 'button',
			key: 'openInDefault',
			icon: ExternalLink,
			label: 'Open in Default App',
			onClick: () => {
				window.maestro?.shell?.openPath(file.path);
			},
		});
	}
	// Reveal in Finder / Explorer / File Manager - local files only.
	if (toolbarVisibility.revealInFolder && !sshRemoteId) {
		actions.push({
			kind: 'button',
			key: 'revealInFolder',
			icon: FolderOpen,
			label: getRevealLabel(window.maestro?.platform ?? ''),
			onClick: () => {
				window.maestro?.shell?.showItemInFolder(file.path);
			},
			testId: 'reveal-in-folder-button',
		});
	}
	if (toolbarVisibility.copyPath) {
		actions.push({
			kind: 'button',
			key: 'copyPath',
			icon: Copy,
			label: 'Copy full path to clipboard',
			onClick: copyPathToClipboard,
		});
	}
	// Delete file - last in the row, and always behind a confirmation. Same flow
	// as the command palette's "File: Delete" entry.
	if (toolbarVisibility.delete && onDelete) {
		actions.push({
			kind: 'button',
			key: 'delete',
			icon: Trash2,
			label: 'Delete file',
			onClick: onDelete,
			testId: 'delete-file-button',
		});
	}

	// The phone's "..." is worth drawing only when it would open onto something.
	const hasSheetContent = actions.length > 0 || !!directoryPath || stats.length > 0;
	// Desktop only: on a phone these move into the sheet, which is the whole point.
	const showStatsGroup = stats.length > 0 && showStatsBar && !phone;

	return (
		<div className="shrink-0" style={{ backgroundColor: theme.colors.bgSidebar }}>
			{/* Main header row */}
			<div
				className={`border-b ${phone ? 'px-3 py-2' : 'px-6 py-3'}`}
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3 min-w-0">
						<FileCode className="w-5 h-5 shrink-0" style={{ color: theme.colors.accent }} />
						<div className="text-sm font-medium truncate" style={{ color: theme.colors.textMain }}>
							{file.name}
						</div>
					</div>
					<div className="flex items-center gap-2 shrink-0" data-testid="file-preview-toolbar">
						{/* Save button - shown in edit mode, or in preview when unsaved edits remain
						    (the user can flip to preview while dirty and still needs Save). It is
						    the one action that stays inline on a phone: it carries a dirty state the
						    user is watching for, and two taps to reach it is worse than its width. */}
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
						{phone
							? hasSheetContent && (
									<button
										onClick={() => setActionsSheetOpen(true)}
										className={headerBtnClass}
										style={{ color: theme.colors.textDim }}
										aria-haspopup="dialog"
										aria-expanded={actionsSheetOpen}
										aria-label="File actions"
										data-testid="file-preview-actions-button"
									>
										<MoreHorizontal className={headerIconClass} />
									</button>
								)
							: actions.map((action) => {
									if (action.kind === 'tier') {
										return (
											<PreviewTierChip
												key={action.key}
												theme={theme}
												autoTier={action.autoTier}
												override={action.override}
												onSelect={action.onSelect}
												iconOnly
												headerBtnClass={headerBtnClass}
												headerIconClass={headerIconClass}
											/>
										);
									}
									const Icon = action.icon;
									return (
										<HoverTooltip
											key={action.key}
											theme={theme}
											label={action.label}
											shortcut={action.shortcut}
										>
											<button
												onClick={action.onClick}
												className={headerBtnClass}
												style={{
													color: action.active ? theme.colors.accent : theme.colors.textDim,
												}}
												aria-pressed={action.pressed}
												data-testid={action.testId}
											>
												<Icon className={headerIconClass} />
											</button>
										</HoverTooltip>
									);
								})}
					</div>
				</div>
				{showPath && !phone && (
					<div className="text-xs opacity-50 truncate mt-1" style={{ color: theme.colors.textDim }}>
						{directoryPath}
					</div>
				)}
			</div>
			{/* File Stats subbar - hidden on scroll when overflow allows (see FilePreview).
			    One line that scrolls sideways when it must: on a phone the five stats
			    used to wrap into three-line columns. */}
			{showStatsGroup || canGoBack || canGoForward ? (
				<div
					className={`flex items-center justify-between ${phone ? 'px-3' : 'px-6'} py-1.5 border-b transition-all duration-200`}
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
				>
					<div className="flex items-center gap-4 min-w-0 overflow-x-auto no-scrollbar">
						{showStatsGroup &&
							stats.map((stat) => (
								<div
									key={stat.key}
									className="text-2xs whitespace-nowrap shrink-0"
									style={{ color: theme.colors.textDim }}
								>
									<span className="opacity-60">{stat.label}:</span>{' '}
									<span style={{ color: stat.valueColor ?? theme.colors.textMain }}>
										{stat.value}
									</span>
								</div>
							))}
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
			{phone && (
				<FilePreviewActionsSheet
					open={actionsSheetOpen}
					onClose={() => setActionsSheetOpen(false)}
					theme={theme}
					directoryPath={directoryPath}
					stats={stats}
					actions={actions}
				/>
			)}
		</div>
	);
});
