import React, { useState, useCallback, useEffect, useRef, memo, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
	X,
	Pencil,
	Copy,
	Clipboard,
	ExternalLink,
	FolderOpen,
	ChevronsLeft,
	ChevronsRight,
} from 'lucide-react';
import type { FilePreviewTab, Theme } from '../../types';
import { getExtensionColor } from '../../utils/extensionColors';
import { getRevealLabel } from '../../utils/platformUtils';
import { safeClipboardWrite } from '../../utils/clipboard';
import { useTabHoverOverlay } from '../../hooks/tabs/useTabHoverOverlay';
import { useSettingsStore } from '../../stores/settingsStore';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

/**
 * Props for the FileTab component.
 * Similar to TabProps but tailored for file preview tabs.
 */
export interface FileTabProps {
	tab: FilePreviewTab;
	isActive: boolean;
	theme: Theme;
	/** Stable callback - receives tabId as first argument */
	onSelect: (tabId: string) => void;
	/** Stable callback - receives tabId as first argument */
	onClose: (tabId: string) => void;
	/** Stable callback - receives tabId and event */
	onDragStart: (tabId: string, e: React.DragEvent) => void;
	/** Stable callback - receives tabId and event */
	onDragOver: (tabId: string, e: React.DragEvent) => void;
	onDragEnd: () => void;
	/** Stable callback - receives tabId and event */
	onDrop: (tabId: string, e: React.DragEvent) => void;
	isDragging: boolean;
	isDragOver: boolean;
	registerRef?: (el: HTMLDivElement | null) => void;
	/** Stable callback - receives tabId */
	onMoveToFirst?: (tabId: string) => void;
	/** Stable callback - receives tabId */
	onMoveToLast?: (tabId: string) => void;
	/** Is this the first tab? */
	isFirstTab?: boolean;
	/** Is this the last tab? */
	isLastTab?: boolean;
	/** Stable callback - receives tabId - closes all tabs except this one */
	onCloseOtherTabs?: (tabId: string) => void;
	/** Stable callback - receives tabId - closes tabs to the left */
	onCloseTabsLeft?: (tabId: string) => void;
	/** Stable callback - receives tabId - closes tabs to the right */
	onCloseTabsRight?: (tabId: string) => void;
	/** Total number of unified tabs */
	totalTabs?: number;
	/** Tab index in the full unified list (0-based) */
	tabIndex?: number;
	/** Whether colorblind-friendly colors should be used for extension badges */
	colorBlindMode?: boolean;
	/** Shortcut hint badge number (1-9 for Cmd+1-9, 0 for Cmd+0/last tab) */
	shortcutHint?: number | null;
}

/**
 * Individual file tab component for file preview tabs.
 * Similar to AI Tab but with file-specific rendering:
 * - Shows filename without extension as label
 * - Displays extension as a colored badge
 * - Shows pencil icon when tab has unsaved edits
 * - Includes hover overlay with file-specific actions
 *
 * Wrapped with React.memo to prevent unnecessary re-renders when sibling tabs change.
 */
export const FileTab = memo(function FileTab({
	tab,
	isActive,
	theme,
	onSelect,
	onClose,
	onDragStart,
	onDragOver,
	onDragEnd,
	onDrop,
	isDragging,
	isDragOver,
	registerRef,
	onMoveToFirst,
	onMoveToLast,
	isFirstTab,
	isLastTab,
	onCloseOtherTabs,
	onCloseTabsLeft,
	onCloseTabsRight,
	totalTabs,
	tabIndex,
	colorBlindMode,
	shortcutHint,
}: FileTabProps) {
	const [showCopied, setShowCopied] = useState<'path' | 'name' | null>(null);
	const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Clear copy feedback timeout on unmount
	useEffect(() => {
		return () => {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
		};
	}, []);

	const {
		isHovered,
		overlayOpen,
		setOverlayOpen,
		overlayPosition,
		setOverlayRef,
		positionReady,
		setTabRef,
		handleMouseEnter,
		handleMouseLeave,
		overlayMouseEnter,
		overlayMouseLeave,
	} = useTabHoverOverlay({ registerRef });

	const tabShortcuts = useSettingsStore((s) => s.tabShortcuts);

	const ShortcutHint = ({ keys }: { keys: string[] }) => (
		<span
			className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded"
			style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
		>
			{formatShortcutKeys(keys)}
		</span>
	);

	// Event handlers using stable tabId to avoid inline closure captures
	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			// Middle-click to close
			if (e.button === 1) {
				e.preventDefault();
				onClose(tab.id);
			}
		},
		[onClose, tab.id]
	);

	const handleCloseClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onClose(tab.id);
		},
		[onClose, tab.id]
	);

	// File-specific action handlers
	const handleCopyFilePath = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			safeClipboardWrite(tab.path);
			setShowCopied('path');
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
			copyTimeoutRef.current = setTimeout(() => setShowCopied(null), 1500);
		},
		[tab.path]
	);

	const handleCopyFileName = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			// Copy filename with extension
			const fullName = tab.name + tab.extension;
			safeClipboardWrite(fullName);
			setShowCopied('name');
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
			copyTimeoutRef.current = setTimeout(() => setShowCopied(null), 1500);
		},
		[tab.name, tab.extension]
	);

	const handleOpenInDefaultApp = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			window.maestro?.shell?.openPath(tab.path);
			setOverlayOpen(false);
		},
		[tab.path, setOverlayOpen]
	);

	const handleRevealInFinder = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			window.maestro?.shell?.showItemInFolder(tab.path);
			setOverlayOpen(false);
		},
		[tab.path, setOverlayOpen]
	);

	const handleMoveToFirstClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMoveToFirst?.(tab.id);
			setOverlayOpen(false);
		},
		[onMoveToFirst, tab.id, setOverlayOpen]
	);

	const handleMoveToLastClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMoveToLast?.(tab.id);
			setOverlayOpen(false);
		},
		[onMoveToLast, tab.id, setOverlayOpen]
	);

	const handleCloseTabClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onClose(tab.id);
			setOverlayOpen(false);
		},
		[onClose, tab.id, setOverlayOpen]
	);

	const handleCloseOtherTabsClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSelect(tab.id);
			onCloseOtherTabs?.(tab.id);
			setOverlayOpen(false);
		},
		[onSelect, onCloseOtherTabs, tab.id, setOverlayOpen]
	);

	const handleCloseTabsLeftClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSelect(tab.id);
			onCloseTabsLeft?.(tab.id);
			setOverlayOpen(false);
		},
		[onSelect, onCloseTabsLeft, tab.id, setOverlayOpen]
	);

	const handleCloseTabsRightClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSelect(tab.id);
			onCloseTabsRight?.(tab.id);
			setOverlayOpen(false);
		},
		[onSelect, onCloseTabsRight, tab.id, setOverlayOpen]
	);

	// Handlers for drag events using stable tabId
	const handleTabSelect = useCallback(() => {
		onSelect(tab.id);
	}, [onSelect, tab.id]);

	const handleTabDragStart = useCallback(
		(e: React.DragEvent) => {
			onDragStart(tab.id, e);
		},
		[onDragStart, tab.id]
	);

	const handleTabDragOver = useCallback(
		(e: React.DragEvent) => {
			onDragOver(tab.id, e);
		},
		[onDragOver, tab.id]
	);

	const handleTabDrop = useCallback(
		(e: React.DragEvent) => {
			onDrop(tab.id, e);
		},
		[onDrop, tab.id]
	);

	// Get extension badge colors
	const extensionColors = useMemo(
		() => getExtensionColor(tab.extension, theme, colorBlindMode),
		[tab.extension, theme, colorBlindMode]
	);

	// Hover background varies by theme mode for proper contrast
	const hoverBgColor = theme.mode === 'light' ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.08)';

	// Memoize tab styles to avoid creating new object references on every render
	const tabStyle = useMemo(
		() =>
			({
				// All tabs have rounded top corners
				borderTopLeftRadius: '6px',
				borderTopRightRadius: '6px',
				// Active tab: bright background matching content area
				// Inactive tabs: transparent with subtle hover
				backgroundColor: isActive ? theme.colors.bgMain : isHovered ? hoverBgColor : 'transparent',
				// Active tab has visible borders, inactive tabs have no borders (cleaner look)
				borderTop: isActive ? `1px solid ${theme.colors.border}` : '1px solid transparent',
				borderLeft: isActive ? `1px solid ${theme.colors.border}` : '1px solid transparent',
				borderRight: isActive ? `1px solid ${theme.colors.border}` : '1px solid transparent',
				// Active tab has no bottom border (connects to content)
				borderBottom: isActive ? `1px solid ${theme.colors.bgMain}` : '1px solid transparent',
				// Active tab sits on top of the tab bar's bottom border
				marginBottom: isActive ? '-1px' : '0',
				// Slight z-index for active tab to cover border properly
				zIndex: isActive ? 1 : 0,
				'--tw-ring-color': isDragOver ? theme.colors.accent : 'transparent',
			}) as React.CSSProperties,
		[
			isActive,
			isHovered,
			isDragOver,
			theme.colors.bgMain,
			theme.colors.border,
			theme.colors.accent,
			hoverBgColor,
		]
	);

	// Check if tab has unsaved edits
	const hasUnsavedEdits = tab.editContent !== undefined;

	return (
		<div
			ref={setTabRef}
			data-tab-id={tab.id}
			tabIndex={0}
			role="tab"
			aria-selected={isActive}
			className={`
        relative flex items-center gap-1.5 px-3 py-1.5 cursor-pointer
        transition-all duration-150 select-none shrink-0 outline-none
        ${isDragging ? 'opacity-50' : ''}
        ${isDragOver ? 'ring-2 ring-inset' : ''}
      `}
			style={tabStyle}
			onClick={handleTabSelect}
			onMouseDown={handleMouseDown}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					handleTabSelect();
				}
			}}
			draggable
			onDragStart={handleTabDragStart}
			onDragOver={handleTabDragOver}
			onDragEnd={onDragEnd}
			onDrop={handleTabDrop}
		>
			{/* Unsaved edits indicator - pencil icon */}
			{hasUnsavedEdits && (
				<span title="Has unsaved changes">
					<Pencil className="w-3 h-3 shrink-0" style={{ color: theme.colors.warning }} />
				</span>
			)}

			{/* Shortcut hint badge - shows tab number for Cmd+1-9 or Cmd+0 navigation */}
			{shortcutHint !== null && shortcutHint !== undefined && (
				<span
					className="w-4 h-4 flex items-center justify-center rounded text-[10px] font-medium shrink-0 opacity-50"
					style={{
						backgroundColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				>
					{shortcutHint}
				</span>
			)}

			{/* Tab name - filename without extension */}
			<span
				className={`text-xs font-medium ${isActive ? 'whitespace-nowrap' : 'truncate max-w-[120px]'}`}
				style={{ color: isActive ? theme.colors.textMain : theme.colors.textDim }}
			>
				{tab.name}
			</span>

			{/* Extension badge - small rounded pill, uppercase without leading dot */}
			<span
				className="px-1 rounded text-[9px] font-semibold uppercase leading-none shrink-0"
				style={{
					backgroundColor: extensionColors.bg,
					color: extensionColors.text,
					paddingTop: '2px',
					paddingBottom: '2px',
				}}
			>
				{tab.extension.replace(/^\./, '').toUpperCase()}
			</span>

			{/* Close button - visible on hover or when active */}
			{(isHovered || isActive) && (
				<button
					onClick={handleCloseClick}
					className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
					title="Close tab"
				>
					<X className="w-3 h-3" style={{ color: theme.colors.textDim }} />
				</button>
			)}

			{/* Hover overlay with file info and actions - rendered via portal to escape stacking context */}
			{overlayOpen &&
				overlayPosition &&
				createPortal(
					<div
						ref={setOverlayRef}
						className="fixed z-[100]"
						style={{
							top: overlayPosition.top,
							left: overlayPosition.left,
							opacity: positionReady ? 1 : 0,
						}}
						onClick={(e) => e.stopPropagation()}
						onMouseEnter={overlayMouseEnter}
						onMouseLeave={overlayMouseLeave}
					>
						{/* Main overlay content - connects directly to tab like an open folder */}
						<div
							className="shadow-xl overflow-hidden"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								borderLeft: `1px solid ${theme.colors.border}`,
								borderRight: `1px solid ${theme.colors.border}`,
								borderBottom: `1px solid ${theme.colors.border}`,
								borderBottomLeftRadius: '8px',
								borderBottomRightRadius: '8px',
								minWidth: '220px',
							}}
						>
							{/* Actions */}
							<div className="p-1">
								{/* Copy File Path */}
								<button
									onClick={handleCopyFilePath}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
									title={tab.path}
								>
									<Copy className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									{showCopied === 'path' ? 'Copied!' : 'Copy File Path'}
								</button>

								{/* Copy File Name */}
								<button
									onClick={handleCopyFileName}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									<Clipboard className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									{showCopied === 'name' ? 'Copied!' : 'Copy File Name'}
								</button>

								{/* Open in Default App */}
								<button
									onClick={handleOpenInDefaultApp}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									<ExternalLink className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									Open in Default App
								</button>

								{/* Reveal in Finder / Explorer */}
								<button
									onClick={handleRevealInFinder}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									<FolderOpen className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									{getRevealLabel(window.maestro.platform)}
								</button>

								{/* Tab Move Actions Section - divider and move options */}
								{(onMoveToFirst || onMoveToLast) && (
									<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
								)}

								{/* Move to First Position - suppressed if already first tab or no handler */}
								{onMoveToFirst && !isFirstTab && (
									<button
										onClick={handleMoveToFirstClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors hover:bg-white/10"
										style={{ color: theme.colors.textMain }}
									>
										<ChevronsLeft className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Move to First Position
									</button>
								)}

								{/* Move to Last Position - suppressed if already last tab or no handler */}
								{onMoveToLast && !isLastTab && (
									<button
										onClick={handleMoveToLastClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors hover:bg-white/10"
										style={{ color: theme.colors.textMain }}
									>
										<ChevronsRight
											className="w-3.5 h-3.5"
											style={{ color: theme.colors.textDim }}
										/>
										Move to Last Position
									</button>
								)}

								{/* Tab Close Actions Section - divider and close options */}
								<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />

								{/* Close Tab */}
								<button
									onClick={handleCloseTabClick}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors hover:bg-white/10"
									style={{ color: theme.colors.textMain }}
								>
									<X className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									Close Tab
									{tabShortcuts.closeTab && <ShortcutHint keys={tabShortcuts.closeTab.keys} />}
								</button>

								{/* Close Other Tabs */}
								{onCloseOtherTabs && (
									<button
										onClick={handleCloseOtherTabsClick}
										className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
											totalTabs === 1 ? 'opacity-40 cursor-default' : 'hover:bg-white/10'
										}`}
										style={{ color: theme.colors.textMain }}
										disabled={totalTabs === 1}
									>
										<X className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Close Other Tabs
										{tabShortcuts.closeOtherTabs && (
											<ShortcutHint keys={tabShortcuts.closeOtherTabs.keys} />
										)}
									</button>
								)}

								{/* Close Tabs to Left */}
								{onCloseTabsLeft && (
									<button
										onClick={handleCloseTabsLeftClick}
										className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
											tabIndex === 0 ? 'opacity-40 cursor-default' : 'hover:bg-white/10'
										}`}
										style={{ color: theme.colors.textMain }}
										disabled={tabIndex === 0}
									>
										<ChevronsLeft className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Close Tabs to Left
										{tabShortcuts.closeTabsLeft && (
											<ShortcutHint keys={tabShortcuts.closeTabsLeft.keys} />
										)}
									</button>
								)}

								{/* Close Tabs to Right */}
								{onCloseTabsRight && (
									<button
										onClick={handleCloseTabsRightClick}
										className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
											tabIndex === (totalTabs ?? 1) - 1
												? 'opacity-40 cursor-default'
												: 'hover:bg-white/10'
										}`}
										style={{ color: theme.colors.textMain }}
										disabled={tabIndex === (totalTabs ?? 1) - 1}
									>
										<ChevronsRight
											className="w-3.5 h-3.5"
											style={{ color: theme.colors.textDim }}
										/>
										Close Tabs to Right
										{tabShortcuts.closeTabsRight && (
											<ShortcutHint keys={tabShortcuts.closeTabsRight.keys} />
										)}
									</button>
								)}
							</div>
						</div>
					</div>,
					document.body
				)}
		</div>
	);
});
