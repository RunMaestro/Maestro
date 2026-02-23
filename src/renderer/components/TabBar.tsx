import React, { useState, useRef, useCallback, useEffect, memo, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
	X,
	Plus,
	Star,
	Copy,
	Edit2,
	Mail,
	Pencil,
	Search,
	GitMerge,
	ArrowRightCircle,
	Minimize2,
	Download,
	Clipboard,
	Share2,
	ChevronsLeft,
	ChevronsRight,
	Loader2,
	ExternalLink,
	FolderOpen,
} from 'lucide-react';
import type { AITab, Theme, FilePreviewTab, UnifiedTab } from '../types';
import { hasDraft } from '../utils/tabHelpers';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { getExtensionColor } from '../utils/extensionColors';
import { getRevealLabel } from '../utils/platformUtils';

interface TabBarProps {
	tabs: AITab[];
	activeTabId: string;
	theme: Theme;
	onTabSelect: (tabId: string) => void;
	onTabClose: (tabId: string) => void;
	onNewTab: () => void;
	onRequestRename?: (tabId: string) => void;
	onTabReorder?: (fromIndex: number, toIndex: number) => void;
	/** Handler to reorder tabs in unified tab order (AI + file tabs) */
	onUnifiedTabReorder?: (fromIndex: number, toIndex: number) => void;
	onTabStar?: (tabId: string, starred: boolean) => void;
	onTabMarkUnread?: (tabId: string) => void;
	/** Handler to open merge session modal with this tab as source */
	onMergeWith?: (tabId: string) => void;
	/** Handler to open send to agent modal with this tab as source */
	onSendToAgent?: (tabId: string) => void;
	/** Handler to summarize and continue in a new tab */
	onSummarizeAndContinue?: (tabId: string) => void;
	/** Handler to copy conversation context to clipboard */
	onCopyContext?: (tabId: string) => void;
	/** Handler to export tab as HTML */
	onExportHtml?: (tabId: string) => void;
	/** Handler to publish tab context as GitHub Gist */
	onPublishGist?: (tabId: string) => void;
	/** Whether GitHub CLI is available for gist publishing */
	ghCliAvailable?: boolean;
	showUnreadOnly?: boolean;
	onToggleUnreadFilter?: () => void;
	onOpenTabSearch?: () => void;
	/** Handler to close all tabs */
	onCloseAllTabs?: () => void;
	/** Handler to close all tabs except active */
	onCloseOtherTabs?: () => void;
	/** Handler to close tabs to the left of active tab */
	onCloseTabsLeft?: () => void;
	/** Handler to close tabs to the right of active tab */
	onCloseTabsRight?: () => void;

	// === Unified Tab System Props (Phase 3) ===
	/** Merged ordered list of AI and file preview tabs for unified rendering */
	unifiedTabs?: UnifiedTab[];
	/** Currently active file tab ID (null if an AI tab is active) */
	activeFileTabId?: string | null;
	/** Handler to select a file preview tab */
	onFileTabSelect?: (tabId: string) => void;
	/** Handler to close a file preview tab */
	onFileTabClose?: (tabId: string) => void;

	// === Accessibility ===
	/** Whether colorblind-friendly colors should be used for extension badges */
	colorBlindMode?: boolean;
}

interface TabProps {
	tab: AITab;
	tabId: string;
	isActive: boolean;
	theme: Theme;
	canClose: boolean;
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
	/** Stable callback - receives tabId */
	onRename: (tabId: string) => void;
	/** Stable callback - receives tabId and starred boolean */
	onStar?: (tabId: string, starred: boolean) => void;
	/** Stable callback - receives tabId */
	onMarkUnread?: (tabId: string) => void;
	/** Stable callback - receives tabId */
	onMergeWith?: (tabId: string) => void;
	/** Stable callback - receives tabId */
	onSendToAgent?: (tabId: string) => void;
	/** Stable callback - receives tabId */
	onSummarizeAndContinue?: (tabId: string) => void;
	/** Stable callback - receives tabId */
	onCopyContext?: (tabId: string) => void;
	/** Stable callback - receives tabId */
	onExportHtml?: (tabId: string) => void;
	/** Stable callback - receives tabId */
	onPublishGist?: (tabId: string) => void;
	/** Stable callback - receives tabId */
	onMoveToFirst?: (tabId: string) => void;
	/** Stable callback - receives tabId */
	onMoveToLast?: (tabId: string) => void;
	/** Is this the first tab? */
	isFirstTab?: boolean;
	/** Is this the last tab? */
	isLastTab?: boolean;
	shortcutHint?: number | null;
	registerRef?: (el: HTMLDivElement | null) => void;
	hasDraft?: boolean;
	/** Stable callback - closes all tabs */
	onCloseAllTabs?: () => void;
	/** Stable callback - receives tabId */
	onCloseOtherTabs?: (tabId: string) => void;
	/** Stable callback - receives tabId */
	onCloseTabsLeft?: (tabId: string) => void;
	/** Stable callback - receives tabId */
	onCloseTabsRight?: (tabId: string) => void;
	/** Total number of tabs */
	totalTabs?: number;
	/** Tab index in the full list (0-based) */
	tabIndex?: number;
}

/**
 * Get the display name for a tab.
 * Priority: name > truncated session ID > "New"
 *
 * Handles different agent session ID formats:
 * - Claude UUID: "abc123-def456-ghi789" → "ABC123" (first octet)
 * - OpenCode: "SES_4BCDFE8C5FFE4KC1UV9NSMYEDB" → "SES_4BCD" (prefix + 4 chars)
 * - Codex: "thread_abc123..." → "THR_ABC1" (prefix + 4 chars)
 *
 * Memoized per-tab via useMemo in the Tab component to avoid recalculation on every render.
 */
function getTabDisplayName(tab: AITab): string {
	if (tab.name) {
		return tab.name;
	}
	if (tab.agentSessionId) {
		const id = tab.agentSessionId;

		// OpenCode format: ses_XXXX... or SES_XXXX...
		if (id.toLowerCase().startsWith('ses_')) {
			// Return "SES_" + first 4 chars of the ID portion
			return `SES_${id.slice(4, 8).toUpperCase()}`;
		}

		// Codex format: thread_XXXX...
		if (id.toLowerCase().startsWith('thread_')) {
			// Return "THR_" + first 4 chars of the ID portion
			return `THR_${id.slice(7, 11).toUpperCase()}`;
		}

		// Claude UUID format: has dashes, return first octet
		if (id.includes('-')) {
			return id.split('-')[0].toUpperCase();
		}

		// Generic fallback: first 8 chars uppercase
		return id.slice(0, 8).toUpperCase();
	}
	return 'New Session';
}

/**
 * Individual tab component styled like browser tabs (Safari/Chrome).
 * All tabs have visible borders; active tab connects to content area.
 * Includes hover overlay with session info and actions.
 *
 * Wrapped with React.memo to prevent unnecessary re-renders when sibling tabs change.
 */
const Tab = memo(function Tab({
	tab,
	tabId,
	isActive,
	theme,
	canClose,
	onSelect,
	onClose,
	onDragStart,
	onDragOver,
	onDragEnd,
	onDrop,
	isDragging,
	isDragOver,
	onRename,
	onStar,
	onMarkUnread,
	onMergeWith,
	onSendToAgent,
	onSummarizeAndContinue,
	onCopyContext,
	onExportHtml,
	onPublishGist,
	onMoveToFirst,
	onMoveToLast,
	isFirstTab,
	isLastTab,
	shortcutHint,
	registerRef,
	hasDraft,
	onCloseAllTabs: _onCloseAllTabs,
	onCloseOtherTabs,
	onCloseTabsLeft,
	onCloseTabsRight,
	totalTabs,
	tabIndex,
}: TabProps) {
	const [isHovered, setIsHovered] = useState(false);
	const [overlayOpen, setOverlayOpen] = useState(false);
	const [showCopied, setShowCopied] = useState(false);
	const [overlayPosition, setOverlayPosition] = useState<{
		top: number;
		left: number;
		tabWidth?: number;
	} | null>(null);
	const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const tabRef = useRef<HTMLDivElement>(null);

	// Register ref with parent for scroll-into-view functionality
	const setTabRef = useCallback(
		(el: HTMLDivElement | null) => {
			(tabRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
			registerRef?.(el);
		},
		[registerRef]
	);

	const handleMouseEnter = () => {
		setIsHovered(true);
		// Only show overlay if there's something meaningful to show:
		// - Tabs with sessions or logs: always show (for session/context actions)
		// - Tabs without sessions or logs: show if there are move actions available
		if (!tab.agentSessionId && !tab.logs?.length && isFirstTab && isLastTab) return;

		// Open overlay after delay
		hoverTimeoutRef.current = setTimeout(() => {
			// Calculate position for fixed overlay - connect directly to tab bottom
			if (tabRef.current) {
				const rect = tabRef.current.getBoundingClientRect();
				// Position overlay directly at tab bottom (no gap) for connected appearance
				// Store tab width for connector sizing
				setOverlayPosition({ top: rect.bottom, left: rect.left, tabWidth: rect.width });
			}
			setOverlayOpen(true);
		}, 400);
	};

	// Ref to track if mouse is over the overlay
	const isOverOverlayRef = useRef(false);

	const handleMouseLeave = () => {
		setIsHovered(false);
		if (hoverTimeoutRef.current) {
			clearTimeout(hoverTimeoutRef.current);
			hoverTimeoutRef.current = null;
		}
		// Delay closing overlay to allow mouse to reach it (there's a gap between tab and overlay)
		hoverTimeoutRef.current = setTimeout(() => {
			if (!isOverOverlayRef.current) {
				setOverlayOpen(false);
			}
		}, 100);
	};

	// Event handlers using stable tabId to avoid inline closure captures
	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			// Middle-click to close
			if (e.button === 1 && canClose) {
				e.preventDefault();
				onClose(tabId);
			}
		},
		[canClose, onClose, tabId]
	);

	const handleCloseClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onClose(tabId);
		},
		[onClose, tabId]
	);

	const handleCopySessionId = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			if (tab.agentSessionId) {
				navigator.clipboard.writeText(tab.agentSessionId);
				setShowCopied(true);
				setTimeout(() => setShowCopied(false), 1500);
			}
		},
		[tab.agentSessionId]
	);

	const handleStarClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onStar?.(tabId, !tab.starred);
		},
		[onStar, tabId, tab.starred]
	);

	const handleRenameClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			// Call rename immediately (before closing overlay) to ensure prompt isn't blocked
			// Browsers block window.prompt() when called from setTimeout since it's not a direct user action
			onRename(tabId);
			setOverlayOpen(false);
		},
		[onRename, tabId]
	);

	const handleMarkUnreadClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMarkUnread?.(tabId);
			setOverlayOpen(false);
		},
		[onMarkUnread, tabId]
	);

	const handleMergeWithClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMergeWith?.(tabId);
			setOverlayOpen(false);
		},
		[onMergeWith, tabId]
	);

	const handleSendToAgentClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSendToAgent?.(tabId);
			setOverlayOpen(false);
		},
		[onSendToAgent, tabId]
	);

	const handleSummarizeAndContinueClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSummarizeAndContinue?.(tabId);
			setOverlayOpen(false);
		},
		[onSummarizeAndContinue, tabId]
	);

	const handleMoveToFirstClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMoveToFirst?.(tabId);
			setOverlayOpen(false);
		},
		[onMoveToFirst, tabId]
	);

	const handleMoveToLastClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMoveToLast?.(tabId);
			setOverlayOpen(false);
		},
		[onMoveToLast, tabId]
	);

	const handleCopyContextClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onCopyContext?.(tabId);
			setOverlayOpen(false);
		},
		[onCopyContext, tabId]
	);

	const handleExportHtmlClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onExportHtml?.(tabId);
			setOverlayOpen(false);
		},
		[onExportHtml, tabId]
	);

	const handlePublishGistClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onPublishGist?.(tabId);
			setOverlayOpen(false);
		},
		[onPublishGist, tabId]
	);

	const handleCloseTabClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onClose(tabId);
			setOverlayOpen(false);
		},
		[onClose, tabId]
	);

	const handleCloseOtherTabsClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onCloseOtherTabs?.(tabId);
			setOverlayOpen(false);
		},
		[onCloseOtherTabs, tabId]
	);

	const handleCloseTabsLeftClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onCloseTabsLeft?.(tabId);
			setOverlayOpen(false);
		},
		[onCloseTabsLeft, tabId]
	);

	const handleCloseTabsRightClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onCloseTabsRight?.(tabId);
			setOverlayOpen(false);
		},
		[onCloseTabsRight, tabId]
	);

	// Handlers for drag events using stable tabId
	const handleTabSelect = useCallback(() => {
		onSelect(tabId);
	}, [onSelect, tabId]);

	const handleTabDragStart = useCallback(
		(e: React.DragEvent) => {
			onDragStart(tabId, e);
		},
		[onDragStart, tabId]
	);

	const handleTabDragOver = useCallback(
		(e: React.DragEvent) => {
			onDragOver(tabId, e);
		},
		[onDragOver, tabId]
	);

	const handleTabDrop = useCallback(
		(e: React.DragEvent) => {
			onDrop(tabId, e);
		},
		[onDrop, tabId]
	);

	// Memoize display name to avoid recalculation on every render
	const displayName = useMemo(() => getTabDisplayName(tab), [tab.name, tab.agentSessionId]);

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

	// Browser-style tab: all tabs have borders, active tab "connects" to content
	// Active tab is bright and obvious, inactive tabs are more muted
	return (
		<div
			ref={setTabRef}
			data-tab-id={tab.id}
			className={`
        relative flex items-center gap-1.5 px-3 py-1.5 cursor-pointer
        transition-all duration-150 select-none shrink-0
        ${isDragging ? 'opacity-50' : ''}
        ${isDragOver ? 'ring-2 ring-inset' : ''}
      `}
			style={tabStyle}
			onClick={handleTabSelect}
			onMouseDown={handleMouseDown}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
			draggable
			onDragStart={handleTabDragStart}
			onDragOver={handleTabDragOver}
			onDragEnd={onDragEnd}
			onDrop={handleTabDrop}
		>
			{/* Busy indicator - pulsing dot for tabs in write mode */}
			{tab.state === 'busy' && (
				<div
					className="w-2 h-2 rounded-full shrink-0 animate-pulse"
					style={{ backgroundColor: theme.colors.warning }}
				/>
			)}

			{/* Generating name indicator - spinning loader while tab name is being generated */}
			{/* Show regardless of busy state since tab naming runs in parallel with the main request */}
			{tab.isGeneratingName && (
				<span title="Generating tab name...">
					<Loader2
						className="w-3 h-3 shrink-0 animate-spin"
						style={{ color: theme.colors.textDim }}
					/>
				</span>
			)}

			{/* Unread indicator - solid dot for tabs with unread messages (not shown when busy) */}
			{tab.state !== 'busy' && tab.hasUnread && (
				<div
					className="w-2 h-2 rounded-full shrink-0"
					style={{ backgroundColor: theme.colors.accent }}
					title="New messages"
				/>
			)}

			{/* Star indicator for starred sessions - only show if tab has a session ID */}
			{tab.starred && tab.agentSessionId && (
				<Star className="w-3 h-3 fill-current shrink-0" style={{ color: theme.colors.warning }} />
			)}

			{/* Draft indicator - pencil icon for tabs with unsent input or staged images */}
			{hasDraft && (
				<span title="Has draft message">
					<Pencil className="w-3 h-3 shrink-0" style={{ color: theme.colors.warning }} />
				</span>
			)}

			{/* Shortcut hint badge - shows tab number for Cmd+1-9 navigation */}
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

			{/* Tab name - show full name for active tab, truncate inactive tabs */}
			<span
				className={`text-xs font-medium ${isActive ? 'whitespace-nowrap' : 'truncate max-w-[120px]'}`}
				style={{ color: isActive ? theme.colors.textMain : theme.colors.textDim }}
			>
				{displayName}
			</span>

			{/* Close button - visible on hover or when active, takes space of busy indicator when not busy */}
			{canClose && (isHovered || isActive) && (
				<button
					onClick={handleCloseClick}
					className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
					title="Close tab"
				>
					<X className="w-3 h-3" style={{ color: theme.colors.textDim }} />
				</button>
			)}

			{/* Hover overlay with session info and actions - rendered via portal to escape stacking context */}
			{overlayOpen &&
				overlayPosition &&
				createPortal(
					<div
						className="fixed z-[100]"
						style={{
							top: overlayPosition.top,
							left: overlayPosition.left,
						}}
						onClick={(e) => e.stopPropagation()}
						onMouseEnter={() => {
							// Keep overlay open when mouse enters it
							isOverOverlayRef.current = true;
							if (hoverTimeoutRef.current) {
								clearTimeout(hoverTimeoutRef.current);
								hoverTimeoutRef.current = null;
							}
						}}
						onMouseLeave={() => {
							// Close overlay when mouse leaves it
							isOverOverlayRef.current = false;
							setOverlayOpen(false);
							setIsHovered(false);
						}}
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
							{/* Header with session name and ID - only show for tabs with sessions */}
							{tab.agentSessionId && (
								<div
									className="border-b"
									style={{
										backgroundColor: theme.colors.bgActivity,
										borderColor: theme.colors.border,
									}}
								>
									{/* Session name display */}
									{tab.name && (
										<div
											className="px-3 py-2 text-sm font-medium"
											style={{ color: theme.colors.textMain }}
										>
											{tab.name}
										</div>
									)}

									{/* Session ID display */}
									<div
										className="px-3 py-2 text-[10px] font-mono"
										style={{ color: theme.colors.textDim }}
									>
										{tab.agentSessionId}
									</div>
								</div>
							)}

							{/* Actions */}
							<div className="p-1">
								{tab.agentSessionId && (
									<button
										onClick={handleCopySessionId}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
										title={`Full ID: ${tab.agentSessionId}`}
									>
										<Copy className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										{showCopied ? 'Copied!' : 'Copy Session ID'}
									</button>
								)}

								{/* Star button - only show for tabs with established session */}
								{tab.agentSessionId && (
									<button
										onClick={handleStarClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Star
											className={`w-3.5 h-3.5 ${tab.starred ? 'fill-current' : ''}`}
											style={{ color: tab.starred ? theme.colors.warning : theme.colors.textDim }}
										/>
										{tab.starred ? 'Unstar Session' : 'Star Session'}
									</button>
								)}

								{/* Rename button - only show for tabs with established session */}
								{tab.agentSessionId && (
									<button
										onClick={handleRenameClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Edit2 className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Rename Tab
									</button>
								)}

								{/* Mark as Unread button - only show for tabs with established session */}
								{tab.agentSessionId && (
									<button
										onClick={handleMarkUnreadClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Mail className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Mark as Unread
									</button>
								)}

								{/* Export as HTML - only show if tab has logs */}
								{(tab.logs?.length ?? 0) >= 1 && onExportHtml && (
									<button
										onClick={handleExportHtmlClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Download className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Export as HTML
									</button>
								)}

								{/* Context Management Section - divider and grouped options */}
								{(tab.agentSessionId || (tab.logs?.length ?? 0) >= 1) &&
									(onMergeWith || onSendToAgent || onSummarizeAndContinue || onCopyContext) && (
										<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
									)}

								{/* Context: Copy to Clipboard */}
								{(tab.logs?.length ?? 0) >= 1 && onCopyContext && (
									<button
										onClick={handleCopyContextClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Clipboard className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Context: Copy to Clipboard
									</button>
								)}

								{/* Context: Compact */}
								{(tab.logs?.length ?? 0) >= 5 && onSummarizeAndContinue && (
									<button
										onClick={handleSummarizeAndContinueClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Minimize2 className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Context: Compact
									</button>
								)}

								{/* Context: Merge Into */}
								{(tab.logs?.length ?? 0) >= 1 && onMergeWith && (
									<button
										onClick={handleMergeWithClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<GitMerge className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Context: Merge Into
									</button>
								)}

								{/* Context: Send to Agent */}
								{(tab.logs?.length ?? 0) >= 1 && onSendToAgent && (
									<button
										onClick={handleSendToAgentClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<ArrowRightCircle
											className="w-3.5 h-3.5"
											style={{ color: theme.colors.textDim }}
										/>
										Context: Send to Agent
									</button>
								)}

								{/* Context: Publish as GitHub Gist - only show if tab has logs and gh CLI is available */}
								{(tab.logs?.length ?? 0) >= 1 && onPublishGist && (
									<button
										onClick={handlePublishGistClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Share2 className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Context: Publish as GitHub Gist
									</button>
								)}

								{/* Tab Move Actions Section - divider and move options */}
								{(onMoveToFirst || onMoveToLast) && (
									<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
								)}

								{/* Move to First Position - suppressed if already first tab or no handler */}
								{onMoveToFirst && (
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
								{onMoveToLast && (
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
									className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
										totalTabs === 1 ? 'opacity-40 cursor-default' : 'hover:bg-white/10'
									}`}
									style={{ color: theme.colors.textMain }}
									disabled={totalTabs === 1}
								>
									<X className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									Close Tab
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

/**
 * Props for the FileTab component.
 * Similar to TabProps but tailored for file preview tabs.
 */
interface FileTabProps {
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
const FileTab = memo(function FileTab({
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
}: FileTabProps) {
	const [isHovered, setIsHovered] = useState(false);
	const [overlayOpen, setOverlayOpen] = useState(false);
	const [showCopied, setShowCopied] = useState<'path' | 'name' | null>(null);
	const [overlayPosition, setOverlayPosition] = useState<{
		top: number;
		left: number;
		tabWidth?: number;
	} | null>(null);
	const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const tabRef = useRef<HTMLDivElement>(null);

	// Register ref with parent for scroll-into-view functionality
	const setTabRef = useCallback(
		(el: HTMLDivElement | null) => {
			(tabRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
			registerRef?.(el);
		},
		[registerRef]
	);

	const handleMouseEnter = () => {
		setIsHovered(true);
		// Open overlay after delay
		hoverTimeoutRef.current = setTimeout(() => {
			// Calculate position for fixed overlay - connect directly to tab bottom
			if (tabRef.current) {
				const rect = tabRef.current.getBoundingClientRect();
				// Position overlay directly at tab bottom (no gap) for connected appearance
				// Store tab width for connector sizing
				setOverlayPosition({ top: rect.bottom, left: rect.left, tabWidth: rect.width });
			}
			setOverlayOpen(true);
		}, 400);
	};

	// Ref to track if mouse is over the overlay
	const isOverOverlayRef = useRef(false);

	const handleMouseLeave = () => {
		setIsHovered(false);
		if (hoverTimeoutRef.current) {
			clearTimeout(hoverTimeoutRef.current);
			hoverTimeoutRef.current = null;
		}
		// Delay closing overlay to allow mouse to reach it (there's a gap between tab and overlay)
		hoverTimeoutRef.current = setTimeout(() => {
			if (!isOverOverlayRef.current) {
				setOverlayOpen(false);
			}
		}, 100);
	};

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
			navigator.clipboard.writeText(tab.path);
			setShowCopied('path');
			setTimeout(() => setShowCopied(null), 1500);
		},
		[tab.path]
	);

	const handleCopyFileName = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			// Copy filename with extension
			const fullName = tab.name + tab.extension;
			navigator.clipboard.writeText(fullName);
			setShowCopied('name');
			setTimeout(() => setShowCopied(null), 1500);
		},
		[tab.name, tab.extension]
	);

	const handleOpenInDefaultApp = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			window.maestro?.shell?.openExternal(`file://${tab.path}`);
			setOverlayOpen(false);
		},
		[tab.path]
	);

	const handleRevealInFinder = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			window.maestro?.shell?.showItemInFolder(tab.path);
			setOverlayOpen(false);
		},
		[tab.path]
	);

	const handleMoveToFirstClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMoveToFirst?.(tab.id);
			setOverlayOpen(false);
		},
		[onMoveToFirst, tab.id]
	);

	const handleMoveToLastClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMoveToLast?.(tab.id);
			setOverlayOpen(false);
		},
		[onMoveToLast, tab.id]
	);

	const handleCloseTabClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onClose(tab.id);
			setOverlayOpen(false);
		},
		[onClose, tab.id]
	);

	const handleCloseOtherTabsClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onCloseOtherTabs?.(tab.id);
			setOverlayOpen(false);
		},
		[onCloseOtherTabs, tab.id]
	);

	const handleCloseTabsLeftClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onCloseTabsLeft?.(tab.id);
			setOverlayOpen(false);
		},
		[onCloseTabsLeft, tab.id]
	);

	const handleCloseTabsRightClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onCloseTabsRight?.(tab.id);
			setOverlayOpen(false);
		},
		[onCloseTabsRight, tab.id]
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
			className={`
        relative flex items-center gap-1.5 px-3 py-1.5 cursor-pointer
        transition-all duration-150 select-none shrink-0
        ${isDragging ? 'opacity-50' : ''}
        ${isDragOver ? 'ring-2 ring-inset' : ''}
      `}
			style={tabStyle}
			onClick={handleTabSelect}
			onMouseDown={handleMouseDown}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
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
						className="fixed z-[100]"
						style={{
							top: overlayPosition.top,
							left: overlayPosition.left,
						}}
						onClick={(e) => e.stopPropagation()}
						onMouseEnter={() => {
							// Keep overlay open when mouse enters it
							isOverOverlayRef.current = true;
							if (hoverTimeoutRef.current) {
								clearTimeout(hoverTimeoutRef.current);
								hoverTimeoutRef.current = null;
							}
						}}
						onMouseLeave={() => {
							// Close overlay when mouse leaves it
							isOverOverlayRef.current = false;
							setOverlayOpen(false);
							setIsHovered(false);
						}}
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

/**
 * TabBar component for displaying AI session tabs.
 * Shows tabs for each Claude Code conversation within a Maestro session.
 * Appears only in AI mode (hidden in terminal mode).
 */
function TabBarInner({
	tabs,
	activeTabId,
	theme,
	onTabSelect,
	onTabClose,
	onNewTab,
	onRequestRename,
	onTabReorder,
	onTabStar,
	onTabMarkUnread,
	onMergeWith,
	onSendToAgent,
	onSummarizeAndContinue,
	onCopyContext,
	onExportHtml,
	onPublishGist,
	ghCliAvailable,
	showUnreadOnly: showUnreadOnlyProp,
	onToggleUnreadFilter,
	onOpenTabSearch,
	onCloseAllTabs,
	onCloseOtherTabs,
	onCloseTabsLeft,
	onCloseTabsRight,
	// Unified tab system props (Phase 3)
	unifiedTabs,
	activeFileTabId,
	onFileTabSelect,
	onFileTabClose,
	onUnifiedTabReorder,
	// Accessibility
	colorBlindMode,
}: TabBarProps) {
	const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
	const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
	// Use prop if provided (controlled), otherwise use local state (uncontrolled)
	const [showUnreadOnlyLocal, setShowUnreadOnlyLocal] = useState(false);
	const showUnreadOnly = showUnreadOnlyProp ?? showUnreadOnlyLocal;
	const toggleUnreadFilter =
		onToggleUnreadFilter ?? (() => setShowUnreadOnlyLocal((prev) => !prev));

	const tabBarRef = useRef<HTMLDivElement>(null);
	const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
	const [isOverflowing, setIsOverflowing] = useState(false);

	// Get active tab's name to trigger scroll when it changes (e.g., after auto-generated name)
	const activeTab = tabs.find((t) => t.id === activeTabId);
	const activeTabName = activeTab?.name ?? null;

	// Ensure the active tab is fully visible (including close button) when:
	// - activeTabId or activeFileTabId changes (new tab selected)
	// - activeTabName changes (tab renamed, so width may have changed)
	// - filter is toggled
	useEffect(() => {
		// Double requestAnimationFrame ensures the DOM has fully updated after React's state changes
		// First rAF: React has committed changes but browser hasn't painted yet
		// Second rAF: Browser has painted, all elements (including close button) are rendered
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const container = tabBarRef.current;
				// When a file tab is active, scroll to it; otherwise scroll to the active AI tab
				const targetTabId = activeFileTabId || activeTabId;
				const tabElement = container?.querySelector(
					`[data-tab-id="${targetTabId}"]`
				) as HTMLElement | null;
				if (container && tabElement) {
					// Calculate scroll position manually to ensure FULL tab is visible
					// scrollIntoView with 'nearest' doesn't always work when tab expands on activation
					const containerRect = container.getBoundingClientRect();
					const tabRect = tabElement.getBoundingClientRect();

					// Check if right edge is clipped (most common issue with close button)
					const rightOverflow = tabRect.right - containerRect.right;
					if (rightOverflow > 0) {
						// Scroll right to reveal the full tab including close button
						container.scrollLeft += rightOverflow + 8; // +8px padding for breathing room
					}

					// Check if left edge is clipped
					const leftOverflow = containerRect.left - tabRect.left;
					if (leftOverflow > 0) {
						// Scroll left to reveal the tab
						container.scrollLeft -= leftOverflow + 8;
					}
				}
			});
		});
	}, [activeTabId, activeFileTabId, activeTabName, showUnreadOnly]);

	// Can always close tabs - closing the last one creates a fresh new tab
	const canClose = true;

	// Filter tabs based on unread filter state
	// When filter is on, show: unread tabs + active tab + tabs with drafts
	// The active tab disappears from the filtered list when user navigates away from it
	const displayedTabs = showUnreadOnly
		? tabs.filter((t) => t.hasUnread || t.id === activeTabId || hasDraft(t))
		: tabs;

	// When unifiedTabs is provided, filter it similarly for display
	// File tabs don't have "unread" state, so they only show in filtered mode if active
	const displayedUnifiedTabs = useMemo(() => {
		if (!unifiedTabs) return null;
		if (!showUnreadOnly) return unifiedTabs;
		// In filter mode: show AI tabs that are unread/active/have drafts, plus file tabs that are active
		return unifiedTabs.filter((ut) => {
			if (ut.type === 'ai') {
				return ut.data.hasUnread || ut.id === activeTabId || hasDraft(ut.data);
			}
			// File tabs: only show if active
			return ut.id === activeFileTabId;
		});
	}, [unifiedTabs, showUnreadOnly, activeTabId, activeFileTabId]);

	const handleDragStart = useCallback((tabId: string, e: React.DragEvent) => {
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', tabId);
		setDraggingTabId(tabId);
	}, []);

	const handleDragOver = useCallback(
		(tabId: string, e: React.DragEvent) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			if (tabId !== draggingTabId) {
				setDragOverTabId(tabId);
			}
		},
		[draggingTabId]
	);

	const handleDragEnd = useCallback(() => {
		setDraggingTabId(null);
		setDragOverTabId(null);
	}, []);

	const handleDrop = useCallback(
		(targetTabId: string, e: React.DragEvent) => {
			e.preventDefault();
			const sourceTabId = e.dataTransfer.getData('text/plain');

			if (sourceTabId && sourceTabId !== targetTabId) {
				// When unified tabs are used, prefer onUnifiedTabReorder
				if (unifiedTabs && onUnifiedTabReorder) {
					const sourceIndex = unifiedTabs.findIndex((ut) => ut.id === sourceTabId);
					const targetIndex = unifiedTabs.findIndex((ut) => ut.id === targetTabId);

					if (sourceIndex !== -1 && targetIndex !== -1) {
						onUnifiedTabReorder(sourceIndex, targetIndex);
					}
				} else if (onTabReorder) {
					// Fallback to legacy AI-tab-only reorder
					const sourceIndex = tabs.findIndex((t) => t.id === sourceTabId);
					const targetIndex = tabs.findIndex((t) => t.id === targetTabId);

					if (sourceIndex !== -1 && targetIndex !== -1) {
						onTabReorder(sourceIndex, targetIndex);
					}
				}
			}

			setDraggingTabId(null);
			setDragOverTabId(null);
		},
		[tabs, onTabReorder, unifiedTabs, onUnifiedTabReorder]
	);

	const handleRenameRequest = useCallback(
		(tabId: string) => {
			// Request rename via modal (window.prompt doesn't work in Electron)
			if (onRequestRename) {
				onRequestRename(tabId);
			}
		},
		[onRequestRename]
	);

	// Check if tabs overflow the container (need sticky + button)
	useEffect(() => {
		const checkOverflow = () => {
			if (tabBarRef.current) {
				// scrollWidth > clientWidth means content overflows
				setIsOverflowing(tabBarRef.current.scrollWidth > tabBarRef.current.clientWidth);
			}
		};

		// Check after DOM renders
		const timeoutId = setTimeout(checkOverflow, 0);

		// Re-check on window resize
		window.addEventListener('resize', checkOverflow);
		return () => {
			clearTimeout(timeoutId);
			window.removeEventListener('resize', checkOverflow);
		};
	}, [tabs.length, displayedTabs.length, unifiedTabs?.length, displayedUnifiedTabs?.length]);

	const handleMoveToFirst = useCallback(
		(tabId: string) => {
			// When unified tabs are used, prefer onUnifiedTabReorder
			if (unifiedTabs && onUnifiedTabReorder) {
				const currentIndex = unifiedTabs.findIndex((ut) => ut.id === tabId);
				if (currentIndex > 0) {
					onUnifiedTabReorder(currentIndex, 0);
				}
			} else if (onTabReorder) {
				// Fallback to legacy AI-tab-only reorder
				const currentIndex = tabs.findIndex((t) => t.id === tabId);
				if (currentIndex > 0) {
					onTabReorder(currentIndex, 0);
				}
			}
		},
		[tabs, onTabReorder, unifiedTabs, onUnifiedTabReorder]
	);

	const handleMoveToLast = useCallback(
		(tabId: string) => {
			// When unified tabs are used, prefer onUnifiedTabReorder
			if (unifiedTabs && onUnifiedTabReorder) {
				const currentIndex = unifiedTabs.findIndex((ut) => ut.id === tabId);
				if (currentIndex < unifiedTabs.length - 1) {
					onUnifiedTabReorder(currentIndex, unifiedTabs.length - 1);
				}
			} else if (onTabReorder) {
				// Fallback to legacy AI-tab-only reorder
				const currentIndex = tabs.findIndex((t) => t.id === tabId);
				if (currentIndex < tabs.length - 1) {
					onTabReorder(currentIndex, tabs.length - 1);
				}
			}
		},
		[tabs, onTabReorder, unifiedTabs, onUnifiedTabReorder]
	);

	// Stable callback wrappers that receive tabId from the Tab component
	// These avoid creating new function references on each render
	const handleTabStar = useCallback(
		(tabId: string, starred: boolean) => {
			onTabStar?.(tabId, starred);
		},
		[onTabStar]
	);

	const handleTabMarkUnread = useCallback(
		(tabId: string) => {
			onTabMarkUnread?.(tabId);
		},
		[onTabMarkUnread]
	);

	const handleTabMergeWith = useCallback(
		(tabId: string) => {
			onMergeWith?.(tabId);
		},
		[onMergeWith]
	);

	const handleTabSendToAgent = useCallback(
		(tabId: string) => {
			onSendToAgent?.(tabId);
		},
		[onSendToAgent]
	);

	const handleTabSummarizeAndContinue = useCallback(
		(tabId: string) => {
			onSummarizeAndContinue?.(tabId);
		},
		[onSummarizeAndContinue]
	);

	const handleTabCopyContext = useCallback(
		(tabId: string) => {
			onCopyContext?.(tabId);
		},
		[onCopyContext]
	);

	const handleTabExportHtml = useCallback(
		(tabId: string) => {
			onExportHtml?.(tabId);
		},
		[onExportHtml]
	);

	const handleTabPublishGist = useCallback(
		(tabId: string) => {
			onPublishGist?.(tabId);
		},
		[onPublishGist]
	);

	const handleTabCloseOther = useCallback(
		(_tabId: string) => {
			// Close all tabs except the one with this tabId
			onCloseOtherTabs?.();
		},
		[onCloseOtherTabs]
	);

	const handleTabCloseLeft = useCallback(
		(_tabId: string) => {
			// Close all tabs to the left of this tabId
			onCloseTabsLeft?.();
		},
		[onCloseTabsLeft]
	);

	const handleTabCloseRight = useCallback(
		(_tabId: string) => {
			// Close all tabs to the right of this tabId
			onCloseTabsRight?.();
		},
		[onCloseTabsRight]
	);

	// Stable registerRef callback that manages tab refs
	const registerTabRef = useCallback((tabId: string, el: HTMLDivElement | null) => {
		if (el) {
			tabRefs.current.set(tabId, el);
		} else {
			tabRefs.current.delete(tabId);
		}
	}, []);

	return (
		<div
			ref={tabBarRef}
			className="flex items-end gap-0.5 pt-2 border-b overflow-x-auto overflow-y-hidden no-scrollbar"
			data-tour="tab-bar"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
		>
			{/* Tab search and unread filter - sticky at the beginning with full-height opaque background */}
			<div
				className="sticky left-0 flex items-center shrink-0 pl-2 pr-1 gap-1 self-stretch"
				style={{ backgroundColor: theme.colors.bgSidebar, zIndex: 5 }}
			>
				{/* Tab search button */}
				{onOpenTabSearch && (
					<button
						onClick={onOpenTabSearch}
						className="flex items-center justify-center w-6 h-6 rounded hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textDim }}
						title={`Search tabs (${formatShortcutKeys(['Meta', 'Shift', 'o'])})`}
					>
						<Search className="w-4 h-4" />
					</button>
				)}
				{/* Unread filter toggle */}
				<button
					onClick={toggleUnreadFilter}
					className="relative flex items-center justify-center w-6 h-6 rounded transition-colors"
					style={{
						color: showUnreadOnly ? theme.colors.accent : theme.colors.textDim,
						opacity: showUnreadOnly ? 1 : 0.5,
					}}
					title={
						showUnreadOnly
							? `Showing unread only (${formatShortcutKeys(['Meta', 'u'])})`
							: `Filter unread tabs (${formatShortcutKeys(['Meta', 'u'])})`
					}
				>
					<Mail className="w-4 h-4" />
					{/* Notification dot */}
					<div
						className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
						style={{ backgroundColor: theme.colors.accent }}
					/>
				</button>
			</div>

			{/* Empty state when filter is on but no unread tabs */}
			{showUnreadOnly &&
				(displayedUnifiedTabs ? displayedUnifiedTabs.length === 0 : displayedTabs.length === 0) && (
					<div
						className="flex items-center px-3 py-1.5 text-xs italic shrink-0 self-center mb-1"
						style={{ color: theme.colors.textDim }}
					>
						No unread tabs
					</div>
				)}

			{/* Tabs with separators between inactive tabs */}
			{/* When unifiedTabs is provided, render both AI and file tabs from unified list */}
			{displayedUnifiedTabs
				? displayedUnifiedTabs.map((unifiedTab, index) => {
						// Determine if this tab is active (based on type)
						// AI tabs are active when: they match activeTabId AND no file tab is selected
						// File tabs are active when: they match activeFileTabId
						const isActive =
							unifiedTab.type === 'ai'
								? unifiedTab.id === activeTabId && !activeFileTabId
								: unifiedTab.id === activeFileTabId;

						// Check previous tab's active state for separator logic
						const prevUnifiedTab = index > 0 ? displayedUnifiedTabs[index - 1] : null;
						const isPrevActive = prevUnifiedTab
							? prevUnifiedTab.type === 'ai'
								? prevUnifiedTab.id === activeTabId && !activeFileTabId
								: prevUnifiedTab.id === activeFileTabId
							: false;

						// Get original index in the FULL unified list (not filtered)
						const allTabs = unifiedTabs ?? [];
						const originalIndex = allTabs.findIndex((ut) => ut.id === unifiedTab.id);

						// Show separator between inactive tabs
						const showSeparator = index > 0 && !isActive && !isPrevActive;

						// Position info for move actions
						const isFirstTab = originalIndex === 0;
						const isLastTab = originalIndex === allTabs.length - 1;

						if (unifiedTab.type === 'ai') {
							const tab = unifiedTab.data;
							return (
								<React.Fragment key={unifiedTab.id}>
									{showSeparator && (
										<div
											className="w-px h-4 self-center shrink-0"
											style={{ backgroundColor: theme.colors.border }}
										/>
									)}
									<Tab
										tab={tab}
										tabId={tab.id}
										isActive={isActive}
										theme={theme}
										canClose={canClose}
										onSelect={onTabSelect}
										onClose={onTabClose}
										onDragStart={handleDragStart}
										onDragOver={handleDragOver}
										onDragEnd={handleDragEnd}
										onDrop={handleDrop}
										isDragging={draggingTabId === tab.id}
										isDragOver={dragOverTabId === tab.id}
										onRename={handleRenameRequest}
										onStar={onTabStar && tab.agentSessionId ? handleTabStar : undefined}
										onMarkUnread={onTabMarkUnread ? handleTabMarkUnread : undefined}
										onMergeWith={onMergeWith ? handleTabMergeWith : undefined}
										onSendToAgent={onSendToAgent ? handleTabSendToAgent : undefined}
										onSummarizeAndContinue={
											onSummarizeAndContinue && (tab.logs?.length ?? 0) >= 5
												? handleTabSummarizeAndContinue
												: undefined
										}
										onCopyContext={
											onCopyContext && (tab.logs?.length ?? 0) >= 1
												? handleTabCopyContext
												: undefined
										}
										onExportHtml={onExportHtml ? handleTabExportHtml : undefined}
										onPublishGist={
											onPublishGist && ghCliAvailable && (tab.logs?.length ?? 0) >= 1
												? handleTabPublishGist
												: undefined
										}
										onMoveToFirst={
											!isFirstTab && onUnifiedTabReorder ? handleMoveToFirst : undefined
										}
										onMoveToLast={!isLastTab && onUnifiedTabReorder ? handleMoveToLast : undefined}
										isFirstTab={isFirstTab}
										isLastTab={isLastTab}
										shortcutHint={!showUnreadOnly && originalIndex < 9 ? originalIndex + 1 : null}
										hasDraft={hasDraft(tab)}
										registerRef={(el) => registerTabRef(tab.id, el)}
										onCloseAllTabs={onCloseAllTabs}
										onCloseOtherTabs={onCloseOtherTabs ? handleTabCloseOther : undefined}
										onCloseTabsLeft={onCloseTabsLeft ? handleTabCloseLeft : undefined}
										onCloseTabsRight={onCloseTabsRight ? handleTabCloseRight : undefined}
										totalTabs={allTabs.length}
										tabIndex={originalIndex}
									/>
								</React.Fragment>
							);
						} else {
							// File tab
							const fileTab = unifiedTab.data;
							return (
								<React.Fragment key={unifiedTab.id}>
									{showSeparator && (
										<div
											className="w-px h-4 self-center shrink-0"
											style={{ backgroundColor: theme.colors.border }}
										/>
									)}
									<FileTab
										tab={fileTab}
										isActive={isActive}
										theme={theme}
										onSelect={onFileTabSelect || (() => {})}
										onClose={onFileTabClose || (() => {})}
										onDragStart={handleDragStart}
										onDragOver={handleDragOver}
										onDragEnd={handleDragEnd}
										onDrop={handleDrop}
										isDragging={draggingTabId === fileTab.id}
										isDragOver={dragOverTabId === fileTab.id}
										registerRef={(el) => registerTabRef(fileTab.id, el)}
										onMoveToFirst={
											!isFirstTab && onUnifiedTabReorder ? handleMoveToFirst : undefined
										}
										onMoveToLast={!isLastTab && onUnifiedTabReorder ? handleMoveToLast : undefined}
										isFirstTab={isFirstTab}
										isLastTab={isLastTab}
										onCloseOtherTabs={onCloseOtherTabs ? handleTabCloseOther : undefined}
										onCloseTabsLeft={onCloseTabsLeft ? handleTabCloseLeft : undefined}
										onCloseTabsRight={onCloseTabsRight ? handleTabCloseRight : undefined}
										totalTabs={allTabs.length}
										tabIndex={originalIndex}
										colorBlindMode={colorBlindMode}
									/>
								</React.Fragment>
							);
						}
					})
				: // Fallback: render AI tabs only (legacy mode when unifiedTabs not provided)
					displayedTabs.map((tab, index) => {
						// AI tabs are active when: they match activeTabId AND no file tab is selected
						const isActive = tab.id === activeTabId && !activeFileTabId;
						const prevTab = index > 0 ? displayedTabs[index - 1] : null;
						const isPrevActive = prevTab?.id === activeTabId && !activeFileTabId;
						// Get original index for shortcut hints (Cmd+1-9)
						const originalIndex = tabs.findIndex((t) => t.id === tab.id);

						// Show separator between inactive tabs (not adjacent to active tab)
						const showSeparator = index > 0 && !isActive && !isPrevActive;

						// Calculate position info for move actions (within FULL tabs array, not filtered)
						const isFirstTab = originalIndex === 0;
						const isLastTab = originalIndex === tabs.length - 1;

						return (
							<React.Fragment key={tab.id}>
								{showSeparator && (
									<div
										className="w-px h-4 self-center shrink-0"
										style={{ backgroundColor: theme.colors.border }}
									/>
								)}
								<Tab
									tab={tab}
									tabId={tab.id}
									isActive={isActive}
									theme={theme}
									canClose={canClose}
									onSelect={onTabSelect}
									onClose={onTabClose}
									onDragStart={handleDragStart}
									onDragOver={handleDragOver}
									onDragEnd={handleDragEnd}
									onDrop={handleDrop}
									isDragging={draggingTabId === tab.id}
									isDragOver={dragOverTabId === tab.id}
									onRename={handleRenameRequest}
									onStar={onTabStar && tab.agentSessionId ? handleTabStar : undefined}
									onMarkUnread={onTabMarkUnread ? handleTabMarkUnread : undefined}
									onMergeWith={onMergeWith ? handleTabMergeWith : undefined}
									onSendToAgent={onSendToAgent ? handleTabSendToAgent : undefined}
									onSummarizeAndContinue={
										onSummarizeAndContinue && (tab.logs?.length ?? 0) >= 5
											? handleTabSummarizeAndContinue
											: undefined
									}
									onCopyContext={
										onCopyContext && (tab.logs?.length ?? 0) >= 1 ? handleTabCopyContext : undefined
									}
									onExportHtml={onExportHtml ? handleTabExportHtml : undefined}
									onPublishGist={
										onPublishGist && ghCliAvailable && (tab.logs?.length ?? 0) >= 1
											? handleTabPublishGist
											: undefined
									}
									onMoveToFirst={!isFirstTab && onTabReorder ? handleMoveToFirst : undefined}
									onMoveToLast={!isLastTab && onTabReorder ? handleMoveToLast : undefined}
									isFirstTab={isFirstTab}
									isLastTab={isLastTab}
									shortcutHint={!showUnreadOnly && originalIndex < 9 ? originalIndex + 1 : null}
									hasDraft={hasDraft(tab)}
									registerRef={(el) => registerTabRef(tab.id, el)}
									onCloseAllTabs={onCloseAllTabs}
									onCloseOtherTabs={onCloseOtherTabs ? handleTabCloseOther : undefined}
									onCloseTabsLeft={onCloseTabsLeft ? handleTabCloseLeft : undefined}
									onCloseTabsRight={onCloseTabsRight ? handleTabCloseRight : undefined}
									totalTabs={tabs.length}
									tabIndex={originalIndex}
								/>
							</React.Fragment>
						);
					})}

			{/* New Tab Button - sticky on right when tabs overflow, with full-height opaque background */}
			<div
				className={`flex items-center shrink-0 pl-2 pr-2 self-stretch ${isOverflowing ? 'sticky right-0' : ''}`}
				style={{
					backgroundColor: theme.colors.bgSidebar,
					zIndex: 5,
				}}
			>
				<button
					onClick={onNewTab}
					className="flex items-center justify-center w-6 h-6 rounded hover:bg-white/10 transition-colors"
					style={{ color: theme.colors.textDim }}
					title={`New tab (${formatShortcutKeys(['Meta', 't'])})`}
				>
					<Plus className="w-4 h-4" />
				</button>
			</div>
		</div>
	);
}

export const TabBar = memo(TabBarInner);
