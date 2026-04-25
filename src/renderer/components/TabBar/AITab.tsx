import React, { useState, useCallback, useEffect, useRef, memo, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Star, Pencil, Loader2, AlertCircle } from 'lucide-react';
import type { AITab as AITabType, Theme } from '../../types';
import { safeClipboardWrite } from '../../utils/clipboard';
import { buildSessionDeepLink } from '../../../shared/deep-link-urls';
import { useTabHoverOverlay } from '../../hooks/tabs/useTabHoverOverlay';
import { AITabOverlayMenu } from './AITabOverlayMenu';

export interface AITabProps {
	tab: AITabType;
	tabId: string;
	isActive: boolean;
	theme: Theme;
	/** The Maestro session/agent ID that owns these tabs */
	sessionId?: string;
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

import { getTabDisplayName } from '../../utils/tabHelpers';
// Re-export for consumers that import from here
export { getTabDisplayName };

/**
 * Individual tab component styled like browser tabs (Safari/Chrome).
 * All tabs have visible borders; active tab connects to content area.
 * Includes hover overlay with session info and actions.
 *
 * Wrapped with React.memo to prevent unnecessary re-renders when sibling tabs change.
 */
export const AITab = memo(function AITab({
	tab,
	tabId,
	isActive,
	theme,
	sessionId,
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
}: AITabProps) {
	const [showCopied, setShowCopied] = useState<'sessionId' | 'deepLink' | false>(false);
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
	} = useTabHoverOverlay({
		registerRef,
		shouldOpen: () => {
			// Only show overlay if there's something meaningful to show:
			// - Tabs with sessions or logs: always show (for session/context actions)
			// - Tabs without sessions or logs: show if there are move actions available
			if (!tab.agentSessionId && !tab.logs?.length && isFirstTab && isLastTab) return false;
			return true;
		},
	});

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
				safeClipboardWrite(tab.agentSessionId);
				setShowCopied('sessionId');
				if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
				copyTimeoutRef.current = setTimeout(() => setShowCopied(false), 1500);
			}
		},
		[tab.agentSessionId]
	);

	const handleCopyDeepLink = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			if (sessionId) {
				safeClipboardWrite(buildSessionDeepLink(sessionId, tabId));
				setShowCopied('deepLink');
				if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
				copyTimeoutRef.current = setTimeout(() => setShowCopied(false), 1500);
			}
		},
		[sessionId, tabId]
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
		[onRename, tabId, setOverlayOpen]
	);

	const handleMarkUnreadClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMarkUnread?.(tabId);
			setOverlayOpen(false);
		},
		[onMarkUnread, tabId, setOverlayOpen]
	);

	const handleMergeWithClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMergeWith?.(tabId);
			setOverlayOpen(false);
		},
		[onMergeWith, tabId, setOverlayOpen]
	);

	const handleSendToAgentClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSendToAgent?.(tabId);
			setOverlayOpen(false);
		},
		[onSendToAgent, tabId, setOverlayOpen]
	);

	const handleSummarizeAndContinueClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSummarizeAndContinue?.(tabId);
			setOverlayOpen(false);
		},
		[onSummarizeAndContinue, tabId, setOverlayOpen]
	);

	const handleMoveToFirstClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMoveToFirst?.(tabId);
			setOverlayOpen(false);
		},
		[onMoveToFirst, tabId, setOverlayOpen]
	);

	const handleMoveToLastClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMoveToLast?.(tabId);
			setOverlayOpen(false);
		},
		[onMoveToLast, tabId, setOverlayOpen]
	);

	const handleCopyContextClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onCopyContext?.(tabId);
			setOverlayOpen(false);
		},
		[onCopyContext, tabId, setOverlayOpen]
	);

	const handleExportHtmlClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onExportHtml?.(tabId);
			setOverlayOpen(false);
		},
		[onExportHtml, tabId, setOverlayOpen]
	);

	const handlePublishGistClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onPublishGist?.(tabId);
			setOverlayOpen(false);
		},
		[onPublishGist, tabId, setOverlayOpen]
	);

	const handleCloseTabClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onClose(tabId);
			setOverlayOpen(false);
		},
		[onClose, tabId, setOverlayOpen]
	);

	const handleCloseOtherTabsClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSelect(tabId);
			onCloseOtherTabs?.(tabId);
			setOverlayOpen(false);
		},
		[onSelect, onCloseOtherTabs, tabId, setOverlayOpen]
	);

	const handleCloseTabsLeftClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSelect(tabId);
			onCloseTabsLeft?.(tabId);
			setOverlayOpen(false);
		},
		[onSelect, onCloseTabsLeft, tabId, setOverlayOpen]
	);

	const handleCloseTabsRightClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSelect(tabId);
			onCloseTabsRight?.(tabId);
			setOverlayOpen(false);
		},
		[onSelect, onCloseTabsRight, tabId, setOverlayOpen]
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

	// Memoize display name to avoid recalculation on every render.
	// Deps are the specific fields getTabDisplayName reads (name, agentSessionId) —
	// using [tab] would invalidate on every logs/state change which is too aggressive.
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
			{/* Agent error pill - highlights tabs that have an active error for quick triage */}
			{tab.agentError && (
				<div
					className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-bold uppercase shrink-0"
					style={{ backgroundColor: theme.colors.error + '30', color: theme.colors.error }}
					title={`Error: ${tab.agentError.message}`}
				>
					<AlertCircle className="w-2.5 h-2.5" />
					ERR
				</div>
			)}

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
					style={{ backgroundColor: theme.colors.error }}
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
						<AITabOverlayMenu
							tab={tab}
							tabId={tabId}
							sessionId={sessionId}
							theme={theme}
							showCopied={showCopied}
							totalTabs={totalTabs}
							tabIndex={tabIndex}
							onCopySessionId={handleCopySessionId}
							onCopyDeepLink={handleCopyDeepLink}
							onStarClick={handleStarClick}
							onRenameClick={handleRenameClick}
							onMarkUnreadClick={handleMarkUnreadClick}
							onExportHtmlClick={handleExportHtmlClick}
							onCopyContextClick={handleCopyContextClick}
							onSummarizeAndContinueClick={handleSummarizeAndContinueClick}
							onMergeWithClick={handleMergeWithClick}
							onSendToAgentClick={handleSendToAgentClick}
							onPublishGistClick={handlePublishGistClick}
							onMoveToFirstClick={handleMoveToFirstClick}
							onMoveToLastClick={handleMoveToLastClick}
							onCloseTabClick={handleCloseTabClick}
							onCloseOtherTabsClick={handleCloseOtherTabsClick}
							onCloseTabsLeftClick={handleCloseTabsLeftClick}
							onCloseTabsRightClick={handleCloseTabsRightClick}
							onMergeWith={onMergeWith}
							onSendToAgent={onSendToAgent}
							onSummarizeAndContinue={onSummarizeAndContinue}
							onCopyContext={onCopyContext}
							onExportHtml={onExportHtml}
							onPublishGist={onPublishGist}
							onMoveToFirst={onMoveToFirst}
							onMoveToLast={onMoveToLast}
							onCloseOtherTabs={onCloseOtherTabs}
							onCloseTabsLeft={onCloseTabsLeft}
							onCloseTabsRight={onCloseTabsRight}
						/>
					</div>,
					document.body
				)}
		</div>
	);
});
