import React, { useState, useRef, useCallback, useEffect, memo, useMemo } from 'react';
import { Bell } from 'lucide-react';
import type { AITab, UnifiedTabRef } from '../../types';
import { hasDraft } from '../../utils/tabHelpers';
import { updateSessionWith } from '../../stores/sessionStore';
import { promotePaneToStandalone } from '../../utils/panelLayout';
import {
	writeTabTilePayload,
	readTabTilePayload,
	dragHasTabTilePayload,
} from '../../utils/tabDragPayload';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { useSettingsStore } from '../../stores/settingsStore';
import { useStuckTabSignature } from '../../stores/retryStore';
import { AITab as AITabComponent } from './AITab';
import { BrowserTabItem } from './BrowserTabItem';
import { FileTab } from './FileTab';
import { TerminalTabItem } from './TerminalTabItem';
import { GroupTabChip } from './GroupTabChip';
import { NewTabPopover } from './NewTabPopover';
import { SearchPopover } from './SearchPopover';
import { isUnifiedTabActive, getShortcutHint } from './tabBarUtils';
import { buildFileTabDisplayNames } from '../../hooks/tabs/internal/filePreviewTabHelpers';
import { useWindowOwnsSession } from '../../contexts/WindowContext';
import type { TabBarProps } from './types';
import { logger } from '../../utils/logger';

/** Approximate width of the sticky right "+" button area (px) */
const STICKY_RIGHT_WIDTH = 48;

/**
 * TabBar component for displaying the unified tab strip.
 * Shows AI, file, browser, and terminal tabs within a Maestro session.
 */
function TabBarInner({
	tabs,
	activeTabId,
	theme,
	sessionId,
	sessionAgentSessionId,
	onTabSelect,
	onTabClose,
	onNewTab,
	onNewFileTab,
	onNewBrowserTab,
	onNewTerminalTab,
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
	onOpenOutputSearch,
	onCloseAllTabs,
	onCloseOtherTabs,
	onCloseTabsLeft,
	onCloseTabsRight,
	unifiedTabs,
	activeFileTabId,
	onFileTabSelect,
	onFileTabClose,
	activeBrowserTabId,
	onBrowserTabSelect,
	onBrowserTabClose,
	onBrowserTabRename,
	onBrowserTabResetName,
	onUnifiedTabReorder,
	activeTerminalTabId,
	inputMode = 'ai',
	onTerminalTabSelect,
	onTerminalTabClose,
	onTerminalTabRename,
	onCopyTerminalBuffer,
	onPublishTerminalBufferGist,
	onSendTerminalBufferToAgent,
	onTerminalTabConfigureStartupCommand,
	onCopyBrowserContent,
	onSendBrowserContentToAgent,
	activeGroupId,
	unreadGroupIds,
	onGroupSelect,
	onGroupRename,
	onGroupBreakApart,
	colorBlindMode,
	sshRemote,
	leadingSlot,
}: TabBarProps) {
	// Dev-time warnings for missing handlers when unified tabs are provided
	if (process.env.NODE_ENV !== 'production' && unifiedTabs) {
		if (!onFileTabSelect || !onFileTabClose) {
			logger.warn('[TabBar] unifiedTabs provided but onFileTabSelect/onFileTabClose missing');
		}
		if (!onTerminalTabSelect || !onTerminalTabClose) {
			logger.warn(
				'[TabBar] unifiedTabs provided but onTerminalTabSelect/onTerminalTabClose missing'
			);
		}
	}

	const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
	const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
	const [showUnreadOnlyLocal, setShowUnreadOnlyLocal] = useState(false);
	const showUnreadOnly = showUnreadOnlyProp ?? showUnreadOnlyLocal;
	// Agent Resilience: tabs stuck auto-retrying an outage surface in the unread
	// filter (needs attention). Stable Set keyed on a primitive store signature.
	const stuckTabSignature = useStuckTabSignature(sessionId ?? '');
	const stuckTabIds = useMemo(
		() => new Set(stuckTabSignature ? stuckTabSignature.split(',') : []),
		[stuckTabSignature]
	);
	const toggleUnreadFilter =
		onToggleUnreadFilter ?? (() => setShowUnreadOnlyLocal((prev) => !prev));

	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const tabShortcuts = useSettingsStore((s) => s.tabShortcuts);
	const showStarredInUnreadFilter = useSettingsStore((s) => s.showStarredInUnreadFilter);
	const showFilePreviewsInUnreadFilter = useSettingsStore((s) => s.showFilePreviewsInUnreadFilter);
	const useCmd0AsLastTab = useSettingsStore((s) => s.useCmd0AsLastTab);
	const tabBarWheelScroll = useSettingsStore((s) => s.tabBarWheelScroll);

	const tabBarRef = useRef<HTMLDivElement>(null);
	const stickyLeftRef = useRef<HTMLDivElement>(null);
	const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
	const [isOverflowing, setIsOverflowing] = useState(false);

	const activeTab = tabs.find((t) => t.id === activeTabId);
	const activeTabName = activeTab?.name ?? null;

	// Multi-window scoping: a window only renders the tab strip of an agent it
	// owns. The primary window is the catch-all owner; a secondary window owns
	// only its scoped agents, so it shows an empty tab area for any agent it
	// doesn't own. Outside a WindowProvider (isolation tests) or without a
	// sessionId, this resolves to true - single-window behaviour is unchanged.
	const ownsActiveAgent = useWindowOwnsSession(sessionId);

	// Scroll active tab into view
	useEffect(() => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const container = tabBarRef.current;
				// A tiled group takes over the panel and IS the current tab, so it must
				// win here too - its chip carries data-tab-id={group.id}, while the
				// standalone active ids are cleared (and activeTabId is synced to a leaf
				// pane that has no standalone chip). Without this, jumping to a group
				// (e.g. Cmd+0 to a rightmost group) never scrolls the group chip into view.
				const targetTabId = activeGroupId
					? activeGroupId
					: inputMode === 'terminal'
						? activeTerminalTabId || activeTabId
						: activeFileTabId || activeBrowserTabId || activeTabId;
				const tabElement = container?.querySelector(
					`[data-tab-id="${targetTabId}"]`
				) as HTMLElement | null;
				if (container && tabElement) {
					const containerRect = container.getBoundingClientRect();
					const tabRect = tabElement.getBoundingClientRect();
					const stickyLeftWidth = stickyLeftRef.current?.offsetWidth ?? 0;

					const visibleRight = containerRect.right - STICKY_RIGHT_WIDTH;
					const rightOverflow = tabRect.right - visibleRight;
					if (rightOverflow > 0) {
						container.scrollLeft += rightOverflow + 8;
					}

					const visibleLeft = containerRect.left + stickyLeftWidth;
					const leftOverflow = visibleLeft - tabRect.left;
					if (leftOverflow > 0) {
						container.scrollLeft -= leftOverflow + 8;
					}
				}
			});
		});
	}, [
		activeTabId,
		activeFileTabId,
		activeBrowserTabId,
		activeTerminalTabId,
		activeGroupId,
		inputMode,
		activeTabName,
		showUnreadOnly,
	]);

	// Pan the horizontally-overflowing tab strip with the mouse wheel. A plain
	// vertical wheel (deltaY) is translated into horizontal scroll, matching the
	// VS Code convention; trackpads and Shift+wheel emit deltaX, so we follow
	// whichever axis the device reports. Attached as a native, non-passive
	// listener because React's synthetic onWheel runs passively and cannot call
	// preventDefault — without it the wheel would also scroll an outer container.
	useEffect(() => {
		const el = tabBarRef.current;
		if (!el || !tabBarWheelScroll) return;
		const handleWheel = (e: WheelEvent) => {
			if (el.scrollWidth <= el.clientWidth) return; // nothing to pan
			const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
			if (delta === 0) return;
			el.scrollLeft += delta;
			e.preventDefault();
		};
		el.addEventListener('wheel', handleWheel, { passive: false });
		return () => el.removeEventListener('wheel', handleWheel);
	}, [tabBarWheelScroll]);

	// Filter tabs for display. Memoized so the filter only re-runs when the
	// inputs actually change - without this, every TabBar render (e.g. on input
	// keystrokes or unrelated session updates) re-walks the tabs array.
	const displayedTabs = useMemo(() => {
		// Window doesn't own this agent: render an empty tab strip (scoped window).
		if (!ownsActiveAgent) return [];
		return showUnreadOnly
			? tabs.filter(
					(t) =>
						t.hasUnread ||
						t.state === 'busy' ||
						stuckTabIds.has(t.id) ||
						(inputMode === 'ai' && t.id === activeTabId) ||
						hasDraft(t) ||
						(showStarredInUnreadFilter && t.starred)
				)
			: tabs;
	}, [
		tabs,
		showUnreadOnly,
		inputMode,
		activeTabId,
		showStarredInUnreadFilter,
		stuckTabIds,
		ownsActiveAgent,
	]);

	const displayedUnifiedTabs = useMemo(() => {
		if (!unifiedTabs) return null;
		// Window doesn't own this agent: render an empty tab strip (scoped window).
		if (!ownsActiveAgent) return [];
		if (!showUnreadOnly) return unifiedTabs;
		// In filter mode: AI tabs filtered by unread/busy/active/draft;
		// file and terminal tabs always shown (they have no unread state,
		// and hiding them causes navigation/display mismatch).
		return unifiedTabs.filter((ut) => {
			if (ut.type === 'ai') {
				return (
					ut.data.hasUnread ||
					ut.data.state === 'busy' ||
					stuckTabIds.has(ut.id) ||
					(inputMode === 'ai' && ut.id === activeTabId) ||
					hasDraft(ut.data) ||
					(showStarredInUnreadFilter && ut.data.starred)
				);
			}
			// File preview tabs: hidden by default in unread filter, shown if setting
			// enabled - but the currently active file tab is always visible so the user
			// never loses sight of what they're looking at.
			if (ut.type === 'file') {
				return showFilePreviewsInUnreadFilter || ut.id === activeFileTabId;
			}
			// A tiled group is shown iff any of its collapsed members is unread. The set
			// is precomputed from the full session (see computeUnreadGroupIds). When it's
			// absent (not provided), fall back to showing the group.
			if (ut.type === 'group') {
				return unreadGroupIds ? unreadGroupIds.has(ut.id) : true;
			}
			// Terminal tabs are always visible
			return true;
		});
	}, [
		unifiedTabs,
		showUnreadOnly,
		activeTabId,
		activeFileTabId,
		activeTerminalTabId,
		inputMode,
		showStarredInUnreadFilter,
		showFilePreviewsInUnreadFilter,
		ownsActiveAgent,
		unreadGroupIds,
		stuckTabIds,
	]);

	// Drag handlers
	const handleDragStart = useCallback(
		(tabId: string, e: React.DragEvent) => {
			e.dataTransfer.effectAllowed = 'move';
			// text/plain (the tab id) drives BOTH the in-bar reorder (onDrop against a
			// sibling chip) and the multi-window drag-out/dock gesture. Untouched here.
			e.dataTransfer.setData('text/plain', tabId);
			// ADD (never replace) the tiling payload so a drop onto the tiled panel can
			// identify this tab. Resolve the tab's type from the unified list (legacy
			// mode is AI-only). Group chips aren't draggable, so this is a leaf tab.
			const unifiedType = unifiedTabs?.find((ut) => ut.id === tabId)?.type;
			const ref: UnifiedTabRef | null =
				unifiedType && unifiedType !== 'group'
					? { type: unifiedType, id: tabId }
					: unifiedTabs
						? null
						: { type: 'ai', id: tabId };
			if (ref) writeTabTilePayload(e.dataTransfer, { ref, source: 'tab-bar' });
			setDraggingTabId(tabId);
		},
		[unifiedTabs]
	);

	const handleDragOver = useCallback(
		(tabId: string, e: React.DragEvent) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			if (tabId !== draggingTabId) setDragOverTabId(tabId);
		},
		[draggingTabId]
	);

	const handleDragEnd = useCallback(() => {
		setDraggingTabId(null);
		setDragOverTabId(null);
	}, []);

	// Defensive cleanup for a stuck drag highlight. When a chip is dragged out of
	// the strip and into a tiled group, its ref is pulled from unifiedTabOrder and
	// the chip unmounts the instant the group takes over - often before the browser
	// fires `dragend` on the source node, so handleDragEnd never runs and
	// draggingTabId stays pinned to that id. It then rides along as `opacity-50`
	// when the tab is later promoted back out (break-apart), leaving the chip
	// visibly dimmed. Once the dragged tab is no longer in the strip, drop the stale
	// id so a normal re-render restores full opacity.
	useEffect(() => {
		if (!draggingTabId) return;
		const stillPresent = unifiedTabs
			? unifiedTabs.some((ut) => ut.id === draggingTabId)
			: tabs.some((t) => t.id === draggingTabId);
		if (!stillPresent) {
			setDraggingTabId(null);
			setDragOverTabId(null);
		}
	}, [draggingTabId, unifiedTabs, tabs]);

	// Promote a tiled pane back to a standalone tab when its title bar is dropped
	// onto the tab bar. `insertIndex` is the target position in unifiedTabOrder
	// (append when null). Reuses the pure promote helper (removes the leaf, re-adds
	// the ref, auto-dissolves the group below two panes). No-op when the payload is
	// not a pane drag or lacks the group/leaf ids.
	const promotePaneFromDrag = useCallback(
		(e: React.DragEvent, insertIndex: number | null): boolean => {
			const payload = readTabTilePayload(e.dataTransfer);
			if (!payload || payload.source !== 'pane' || !payload.groupId || !payload.leafId) {
				return false;
			}
			if (!sessionId) return false;
			const groupId = payload.groupId;
			const leafId = payload.leafId;
			updateSessionWith(sessionId, (s) =>
				promotePaneToStandalone(s, groupId, leafId, insertIndex ?? s.unifiedTabOrder.length)
			);
			return true;
		},
		[sessionId]
	);

	const handleDrop = useCallback(
		(targetTabId: string, e: React.DragEvent) => {
			e.preventDefault();
			// A tiled pane dropped onto a chip promotes out at that chip's position.
			const targetIndex = (unifiedTabs ?? []).findIndex((ut) => ut.id === targetTabId);
			if (promotePaneFromDrag(e, targetIndex === -1 ? null : targetIndex)) {
				setDraggingTabId(null);
				setDragOverTabId(null);
				return;
			}
			const sourceTabId = e.dataTransfer.getData('text/plain');
			if (sourceTabId && sourceTabId !== targetTabId) {
				if (unifiedTabs && onUnifiedTabReorder) {
					const si = unifiedTabs.findIndex((ut) => ut.id === sourceTabId);
					const ti = unifiedTabs.findIndex((ut) => ut.id === targetTabId);
					if (si !== -1 && ti !== -1) onUnifiedTabReorder(si, ti);
				} else if (onTabReorder) {
					const si = tabs.findIndex((t) => t.id === sourceTabId);
					const ti = tabs.findIndex((t) => t.id === targetTabId);
					if (si !== -1 && ti !== -1) onTabReorder(si, ti);
				}
			}
			setDraggingTabId(null);
			setDragOverTabId(null);
		},
		[tabs, onTabReorder, unifiedTabs, onUnifiedTabReorder, promotePaneFromDrag]
	);

	// Drop onto the empty area of the tab bar (not a chip): only reacts to a pane
	// promote-out (appended to the end of the strip). A plain tab-chip reorder or a
	// multi-window drag-out is unaffected - those never target the bar background.
	const handleBarDragOver = useCallback((e: React.DragEvent) => {
		if (dragHasTabTilePayload(e.dataTransfer)) {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
		}
	}, []);

	const handleBarDrop = useCallback(
		(e: React.DragEvent) => {
			// Only handle drops that land on the bar background, not bubbling from a
			// chip (chips call handleDrop and stop there).
			if (e.defaultPrevented) return;
			if (promotePaneFromDrag(e, null)) {
				e.preventDefault();
				setDraggingTabId(null);
				setDragOverTabId(null);
			}
		},
		[promotePaneFromDrag]
	);

	const handleRenameRequest = useCallback(
		(tabId: string) => onRequestRename?.(tabId),
		[onRequestRename]
	);

	// Overflow detection
	useEffect(() => {
		const checkOverflow = () => {
			if (tabBarRef.current) {
				setIsOverflowing(tabBarRef.current.scrollWidth > tabBarRef.current.clientWidth);
			}
		};
		const timeoutId = setTimeout(checkOverflow, 0);
		window.addEventListener('resize', checkOverflow);
		return () => {
			clearTimeout(timeoutId);
			window.removeEventListener('resize', checkOverflow);
		};
	}, [tabs.length, displayedTabs.length, unifiedTabs?.length, displayedUnifiedTabs?.length]);

	// Move-to-first/last handlers
	const handleMoveToFirst = useCallback(
		(tabId: string) => {
			if (unifiedTabs && onUnifiedTabReorder) {
				const i = unifiedTabs.findIndex((ut) => ut.id === tabId);
				if (i > 0) onUnifiedTabReorder(i, 0);
			} else if (onTabReorder) {
				const i = tabs.findIndex((t) => t.id === tabId);
				if (i > 0) onTabReorder(i, 0);
			}
		},
		[tabs, onTabReorder, unifiedTabs, onUnifiedTabReorder]
	);

	const handleMoveToLast = useCallback(
		(tabId: string) => {
			if (unifiedTabs && onUnifiedTabReorder) {
				const i = unifiedTabs.findIndex((ut) => ut.id === tabId);
				if (i >= 0 && i < unifiedTabs.length - 1) onUnifiedTabReorder(i, unifiedTabs.length - 1);
			} else if (onTabReorder) {
				const i = tabs.findIndex((t) => t.id === tabId);
				if (i < tabs.length - 1) onTabReorder(i, tabs.length - 1);
			}
		},
		[tabs, onTabReorder, unifiedTabs, onUnifiedTabReorder]
	);

	// Close wrappers - forward the clicked tab id as the pivot so the operation
	// closes relative to the tab whose menu was used, not whatever happens to be
	// the active tab. Dropping the id here was the cause of catastrophic
	// wrong-set closes (e.g. "close tabs to right" closing every other tab).
	const handleTabCloseOther = useCallback(
		(tabId: string) => onCloseOtherTabs?.(tabId),
		[onCloseOtherTabs]
	);
	const handleTabCloseLeft = useCallback(
		(tabId: string) => onCloseTabsLeft?.(tabId),
		[onCloseTabsLeft]
	);
	const handleTabCloseRight = useCallback(
		(tabId: string) => onCloseTabsRight?.(tabId),
		[onCloseTabsRight]
	);

	const registerTabRef = useCallback((tabId: string, el: HTMLDivElement | null) => {
		if (el) tabRefs.current.set(tabId, el);
		else tabRefs.current.delete(tabId);
	}, []);

	// Shared props computed once for the rendering loop
	const allTabs = unifiedTabs ?? [];

	// Map of terminal-tab id → display index, ordered by creation time so the
	// "Terminal N" label reflects the order the user opened them - not the
	// position in the visual tab strip. Without this, opening a 2nd terminal
	// while an AI tab is active inserts the new terminal to the LEFT of the
	// existing one (insertAfterActiveInUnifiedTabOrder), which would otherwise
	// make the new tab "Terminal 1" and rename the original to "Terminal 2".
	const terminalIndexById = useMemo(() => {
		const terminals = allTabs.flatMap((ut) =>
			ut.type === 'terminal' ? [{ id: ut.id, createdAt: ut.data.createdAt }] : []
		);
		terminals.sort((a, b) => a.createdAt - b.createdAt);
		const map = new Map<string, number>();
		terminals.forEach((t, idx) => map.set(t.id, idx));
		return map;
	}, [allTabs]);

	// Folder-disambiguated display names for file tabs that share a filename.
	// Computed over all file tabs (not just displayed) so labels stay stable when
	// the unread filter hides siblings.
	const fileTabDisplayNames = useMemo(
		() => buildFileTabDisplayNames(allTabs.flatMap((ut) => (ut.type === 'file' ? [ut.data] : []))),
		[allTabs]
	);

	/** Render a separator bar between inactive tabs */
	const separator = (
		<div
			className="w-px h-4 self-center shrink-0"
			style={{ backgroundColor: theme.colors.border }}
		/>
	);

	/** Build shared props that are common across AI tab instances (unified and legacy) */
	const buildAITabProps = (
		tab: AITab,
		isActive: boolean,
		isFirstTab: boolean,
		isLastTab: boolean,
		shortcutHint: number | null,
		originalIndex: number,
		totalTabs: number,
		useUnifiedReorder: boolean
	) => ({
		tab,
		tabId: tab.id,
		isActive,
		theme,
		sessionId,
		sessionAgentSessionId,
		canClose: true,
		onSelect: onTabSelect,
		onClose: onTabClose,
		onDragStart: handleDragStart,
		onDragOver: handleDragOver,
		onDragEnd: handleDragEnd,
		onDrop: handleDrop,
		isDragging: draggingTabId === tab.id,
		isDragOver: dragOverTabId === tab.id,
		onRename: handleRenameRequest,
		onStar: onTabStar && tab.agentSessionId ? onTabStar : undefined,
		onMarkUnread: onTabMarkUnread || undefined,
		onMergeWith: onMergeWith || undefined,
		onSendToAgent: onSendToAgent || undefined,
		onSummarizeAndContinue:
			onSummarizeAndContinue && (tab.logs?.length ?? 0) >= 5 ? onSummarizeAndContinue : undefined,
		onCopyContext: onCopyContext && (tab.logs?.length ?? 0) >= 1 ? onCopyContext : undefined,
		onExportHtml: onExportHtml || undefined,
		onPublishGist:
			onPublishGist && ghCliAvailable && (tab.logs?.length ?? 0) >= 1 ? onPublishGist : undefined,
		onMoveToFirst:
			!isFirstTab && (useUnifiedReorder ? onUnifiedTabReorder : onTabReorder)
				? handleMoveToFirst
				: undefined,
		onMoveToLast:
			!isLastTab && (useUnifiedReorder ? onUnifiedTabReorder : onTabReorder)
				? handleMoveToLast
				: undefined,
		isFirstTab,
		isLastTab,
		shortcutHint,
		hasDraft: hasDraft(tab),
		registerRef: (el: HTMLDivElement | null) => registerTabRef(tab.id, el),
		onCloseAllTabs,
		onCloseOtherTabs: onCloseOtherTabs ? handleTabCloseOther : undefined,
		onCloseTabsLeft: onCloseTabsLeft ? handleTabCloseLeft : undefined,
		onCloseTabsRight: onCloseTabsRight ? handleTabCloseRight : undefined,
		totalTabs,
		tabIndex: originalIndex,
	});

	return (
		<div
			ref={tabBarRef}
			className="flex items-end gap-0.5 pt-2 border-b overflow-x-auto overflow-y-hidden no-scrollbar transition-shadow duration-150"
			data-tour="tab-bar"
			// Accept a tiled pane's title-bar drag dropped onto the bar background to
			// promote it back to a standalone tab. Chip reorder is unaffected (it
			// targets sibling chips).
			onDragOver={handleBarDragOver}
			onDrop={handleBarDrop}
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
		>
			{/* Sticky left: search + unread filter */}
			<div
				ref={stickyLeftRef}
				className="sticky left-0 flex items-center shrink-0 pl-2 pr-1 gap-1 self-stretch"
				style={{ backgroundColor: theme.colors.bgSidebar, zIndex: 5 }}
			>
				{onOpenTabSearch && (
					<SearchPopover
						theme={theme}
						onSearchTabs={onOpenTabSearch}
						onSearchMessages={onOpenOutputSearch ?? onOpenTabSearch}
						tabSwitcherKeys={tabShortcuts.tabSwitcher?.keys ?? ['Alt', 'Meta', 't']}
						searchOutputKeys={shortcuts.searchOutput?.keys ?? ['Meta', 'f']}
						openTabCount={unifiedTabs?.length ?? tabs.length}
					/>
				)}
				<button
					onClick={toggleUnreadFilter}
					className="relative flex items-center justify-center w-6 h-6 rounded transition-colors"
					style={{
						color: showUnreadOnly ? theme.colors.accentForeground : theme.colors.textDim,
						backgroundColor: showUnreadOnly ? theme.colors.accent : undefined,
					}}
					title={
						showUnreadOnly
							? `Showing unread only (${formatShortcutKeys(tabShortcuts.filterUnreadTabs?.keys ?? ['Meta', 'u'])})`
							: `Filter unread tabs (${formatShortcutKeys(tabShortcuts.filterUnreadTabs?.keys ?? ['Meta', 'u'])})`
					}
				>
					<Bell className="w-4 h-4" />
					{tabs.some((t) => t.hasUnread) && (
						<div
							className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
							style={{ backgroundColor: theme.colors.error }}
						/>
					)}
				</button>
				{leadingSlot && (
					<span
						aria-hidden="true"
						className="mx-0.5 h-4 w-px shrink-0"
						style={{ backgroundColor: theme.colors.border }}
					/>
				)}
				{leadingSlot}
			</div>

			{/* Empty state when filter is on but no unread tabs (only for an owned agent;
				a scoped window with no owned agent renders a plain empty tab area) */}
			{showUnreadOnly &&
				ownsActiveAgent &&
				(displayedUnifiedTabs ? displayedUnifiedTabs.length === 0 : displayedTabs.length === 0) && (
					<div
						className="flex items-center px-3 py-1.5 text-xs italic shrink-0 self-center mb-1"
						style={{ color: theme.colors.textDim }}
					>
						No unread or draft tabs
					</div>
				)}

			{/* Tab rendering - unified mode (AI + file + terminal tabs) */}
			{displayedUnifiedTabs
				? displayedUnifiedTabs.map((unifiedTab, index) => {
						const isActive = isUnifiedTabActive(
							unifiedTab,
							activeTabId,
							activeFileTabId,
							activeBrowserTabId,
							activeTerminalTabId,
							inputMode,
							activeGroupId
						);
						const prevTab = index > 0 ? displayedUnifiedTabs[index - 1] : null;
						const isPrevActive = prevTab
							? isUnifiedTabActive(
									prevTab,
									activeTabId,
									activeFileTabId,
									activeBrowserTabId,
									activeTerminalTabId,
									inputMode,
									activeGroupId
								)
							: false;

						const originalIndex = allTabs.findIndex((ut) => ut.id === unifiedTab.id);
						const showSeparator = index > 0 && !isActive && !isPrevActive;
						const isFirstTab = originalIndex === 0;
						const isLastTab = originalIndex === allTabs.length - 1;
						// When the unread filter is active, jump shortcuts (Cmd+N / Cmd+0) operate on
						// the filtered list - so hints must reflect the displayed position, not the
						// underlying unifiedTabs index.
						const isLastDisplayed = index === displayedUnifiedTabs.length - 1;
						const shortcutHint = showUnreadOnly
							? getShortcutHint(index, isLastDisplayed, useCmd0AsLastTab)
							: getShortcutHint(originalIndex, isLastTab, useCmd0AsLastTab);

						if (unifiedTab.type === 'ai') {
							return (
								<React.Fragment key={unifiedTab.id}>
									{showSeparator && separator}
									<AITabComponent
										{...buildAITabProps(
											unifiedTab.data,
											isActive,
											isFirstTab,
											isLastTab,
											shortcutHint,
											originalIndex,
											allTabs.length,
											true
										)}
									/>
								</React.Fragment>
							);
						} else if (unifiedTab.type === 'file') {
							const fileTab = unifiedTab.data;
							return (
								<React.Fragment key={unifiedTab.id}>
									{showSeparator && separator}
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
										shortcutHint={shortcutHint}
										sshRemote={sshRemote}
										displayName={fileTabDisplayNames.get(fileTab.id)}
									/>
								</React.Fragment>
							);
						} else if (unifiedTab.type === 'terminal') {
							const terminalTab = unifiedTab.data;
							const terminalIndex = terminalIndexById.get(unifiedTab.id) ?? 0;
							return (
								<React.Fragment key={unifiedTab.id}>
									{showSeparator && separator}
									<TerminalTabItem
										tab={terminalTab}
										terminalIndex={terminalIndex >= 0 ? terminalIndex : 0}
										isActive={isActive}
										theme={theme}
										onSelect={onTerminalTabSelect || (() => {})}
										onClose={onTerminalTabClose || (() => {})}
										onRename={onTerminalTabRename}
										onDragStart={handleDragStart}
										onDragOver={handleDragOver}
										onDragEnd={handleDragEnd}
										onDrop={handleDrop}
										isDragging={draggingTabId === terminalTab.id}
										isDragOver={dragOverTabId === terminalTab.id}
										registerRef={(el) => registerTabRef(terminalTab.id, el)}
										onMoveToFirst={
											!isFirstTab && onUnifiedTabReorder ? handleMoveToFirst : undefined
										}
										onMoveToLast={!isLastTab && onUnifiedTabReorder ? handleMoveToLast : undefined}
										isFirstTab={isFirstTab}
										isLastTab={isLastTab}
										onCloseOtherTabs={onCloseOtherTabs ? handleTabCloseOther : undefined}
										onCloseTabsLeft={onCloseTabsLeft ? handleTabCloseLeft : undefined}
										onCloseTabsRight={onCloseTabsRight ? handleTabCloseRight : undefined}
										onCopyBuffer={onCopyTerminalBuffer}
										onPublishBufferGist={ghCliAvailable ? onPublishTerminalBufferGist : undefined}
										onSendBufferToAgent={onSendTerminalBufferToAgent}
										onConfigureStartupCommand={onTerminalTabConfigureStartupCommand}
										totalTabs={allTabs.length}
										tabIndex={originalIndex}
										shortcutHint={shortcutHint}
									/>
								</React.Fragment>
							);
						} else if (unifiedTab.type === 'browser') {
							const browserTab = unifiedTab.data;
							return (
								<React.Fragment key={unifiedTab.id}>
									{showSeparator && separator}
									<BrowserTabItem
										tab={browserTab}
										isActive={isActive}
										theme={theme}
										onSelect={onBrowserTabSelect || (() => {})}
										onClose={onBrowserTabClose || (() => {})}
										onRename={onBrowserTabRename}
										onResetName={onBrowserTabResetName}
										onDragStart={handleDragStart}
										onDragOver={handleDragOver}
										onDragEnd={handleDragEnd}
										onDrop={handleDrop}
										isDragging={draggingTabId === browserTab.id}
										isDragOver={dragOverTabId === browserTab.id}
										registerRef={(el) => registerTabRef(browserTab.id, el)}
										onMoveToFirst={
											!isFirstTab && onUnifiedTabReorder ? handleMoveToFirst : undefined
										}
										onMoveToLast={!isLastTab && onUnifiedTabReorder ? handleMoveToLast : undefined}
										isFirstTab={isFirstTab}
										isLastTab={isLastTab}
										onCloseOtherTabs={onCloseOtherTabs ? handleTabCloseOther : undefined}
										onCloseTabsLeft={onCloseTabsLeft ? handleTabCloseLeft : undefined}
										onCloseTabsRight={onCloseTabsRight ? handleTabCloseRight : undefined}
										onCopyContent={onCopyBrowserContent}
										onSendContentToAgent={onSendBrowserContentToAgent}
										totalTabs={allTabs.length}
										tabIndex={originalIndex}
										shortcutHint={shortcutHint}
									/>
								</React.Fragment>
							);
						} else if (unifiedTab.type === 'group') {
							// A tiled group is one unified tab: render its chip inline at its order
							// position (so navigation, indexing, and display all agree). Only the
							// window that owns this agent shows the interactive chip.
							if (!ownsActiveAgent) return null;
							return (
								<React.Fragment key={unifiedTab.id}>
									{showSeparator && separator}
									<GroupTabChip
										group={unifiedTab.data}
										isActive={isActive}
										theme={theme}
										onSelect={(groupId) => onGroupSelect?.(groupId)}
										onRename={onGroupRename}
										onBreakApart={onGroupBreakApart}
									/>
								</React.Fragment>
							);
						}
						return null;
					})
				: /* Legacy mode - AI tabs only */
					displayedTabs.map((tab, index) => {
						const isActive = tab.id === activeTabId && !activeFileTabId;
						const prevTab = index > 0 ? displayedTabs[index - 1] : null;
						const isPrevActive = prevTab?.id === activeTabId && !activeFileTabId;
						const originalIndex = tabs.findIndex((t) => t.id === tab.id);
						const showSeparator = index > 0 && !isActive && !isPrevActive;
						const isFirstTab = originalIndex === 0;
						const isLastTab = originalIndex === tabs.length - 1;
						// Legacy mode: displayedTabs is the filtered list when unread filter is on.
						const isLastDisplayed = index === displayedTabs.length - 1;
						const shortcutHint = showUnreadOnly
							? getShortcutHint(index, isLastDisplayed, useCmd0AsLastTab)
							: getShortcutHint(originalIndex, isLastTab, useCmd0AsLastTab);

						return (
							<React.Fragment key={tab.id}>
								{showSeparator && separator}
								<AITabComponent
									{...buildAITabProps(
										tab,
										isActive,
										isFirstTab,
										isLastTab,
										shortcutHint,
										originalIndex,
										tabs.length,
										false
									)}
								/>
							</React.Fragment>
						);
					})}

			{/* Tab group chips render inline within the unified tab loop above (each
			    tiled group is a first-class `group` unified tab, ordered by its ref in
			    unifiedTabOrder), so no separate append here. */}

			{/* New tab button + popover */}
			<NewTabPopover
				theme={theme}
				onNewTab={onNewTab}
				onNewFileTab={onNewFileTab}
				onNewBrowserTab={onNewBrowserTab}
				onNewTerminalTab={onNewTerminalTab}
				newTabKeys={tabShortcuts.newTab?.keys ?? ['Meta', 't']}
				fileTabKeys={tabShortcuts.newFileTab?.keys ?? ['Alt', 'n']}
				browserTabKeys={tabShortcuts.newBrowserTab?.keys ?? ['Meta', 'b']}
				terminalKeys={shortcuts.toggleMode?.keys ?? ['Meta', 'j']}
				isOverflowing={isOverflowing}
			/>
		</div>
	);
}

export const TabBar = memo(TabBarInner);
