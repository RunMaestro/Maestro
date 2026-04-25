import React, { useState, useRef, useEffect } from 'react';
import {
	FileCode,
	Eye,
	ChevronLeft,
	ChevronRight,
	Clipboard,
	Copy,
	Globe,
	Save,
	Edit,
	Share2,
	GitGraph,
	ExternalLink,
} from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import { captureException } from '../../utils/sentry';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { formatFileSize, formatDateTime } from './filePreviewUtils';
import { formatTokenCount } from '../../utils/tokenCounter';

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
	sshRemoteId?: string;
	copyContentToClipboard: () => Promise<void>;
	copyPathToClipboard: () => void;
	headerBtnClass: string;
	headerIconClass: string;
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
	sshRemoteId,
	copyContentToClipboard,
	copyPathToClipboard,
	headerBtnClass,
	headerIconClass,
}: FilePreviewHeaderProps) {
	const [showBackPopup, setShowBackPopup] = useState(false);
	const [showForwardPopup, setShowForwardPopup] = useState(false);
	const backPopupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const forwardPopupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
						{/* Save button - shown in edit mode with changes for any editable text file */}
						{isEditableText && markdownEditMode && onSave && (
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
								title={
									hasChanges
										? `Save changes (${formatShortcutKeys(['Meta', 's'])})`
										: 'No changes to save'
								}
							>
								{isSaving ? <Spinner size={14} /> : <Save className="w-3.5 h-3.5" />}
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
					<div className="text-xs opacity-50 truncate mt-1" style={{ color: theme.colors.textDim }}>
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
