import React, { useState, useRef, useCallback, useEffect, memo, useMemo } from 'react';
import { Bell } from 'lucide-react';
import type { AITab } from '../../types';
import { hasDraft } from '../../utils/tabHelpers';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { useSettingsStore } from '../../stores/settingsStore';
import { useStuckTabSignature } from '../../stores/retryStore';
import { AITab as AITabComponent } from './AITab';
import { BrowserTabItem } from './BrowserTabItem';
import { FileTab } from './FileTab';
import { TerminalTabItem } from './TerminalTabItem';
import { NewTabPopover } from './NewTabPopover';
import { SearchPopover } from './SearchPopover';
import { isUnifiedTabActive, getShortcutHint } from './tabBarUtils';
import { buildFileTabDisplayNames } from '../../hooks/tabs/internal/filePreviewTabHelpers';
import type { TabBarProps } from './types';
import { logger } from '../../utils/logger';
import type { WindowBounds } from '../../../shared/types/window';

/** Approximate width of the sticky right "+" button area (px) */
const STICKY_RIGHT_WIDTH = 48;

const isPointOutsideBounds = (screenX: number, screenY: number, bounds: WindowBounds): boolean =>
	screenX < bounds.x ||
	screenX > bounds.x + bounds.width ||
	screenY < bounds.y ||
	screenY > bounds.y + bounds.height;

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
	colorBlindMode,
	sshRemote,
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
	const [draggingOutsideWindow, setDraggingOutsideWindow] = useState(false);
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

	const tabBarRef = useRef<HTMLDivElement>(null);
	const stickyLeftRef = useRef<HTMLDivElement>(null);
	const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
	const windowBoundsRef = useRef<WindowBounds | null>(null);
	const dragTargetWindowIdRef = useRef<string | null>(null);
	const lastWindowPointLookupRef = useRef<string | null>(null);
	const [isOverflowing, setIsOverflowing] = useState(false);

	const activeTab = tabs.find((t) => t.id === activeTabId);
	const activeTabName = activeTab?.name ?? null;

	// Scroll active tab into view
	useEffect(() => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const container = tabBarRef.current;
				const targetTabId =
					inputMode === 'terminal'
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
		inputMode,
		activeTabName,
		showUnreadOnly,
	]);

	// Filter tabs for display. Memoized so the filter only re-runs when the
	// inputs actually change — without this, every TabBar render (e.g. on input
	// keystrokes or unrelated session updates) re-walks the tabs array.
	const displayedTabs = useMemo(
		() =>
			showUnreadOnly
				? tabs.filter(
						(t) =>
							t.hasUnread ||
							t.state === 'busy' ||
							stuckTabIds.has(t.id) ||
							(inputMode === 'ai' && t.id === activeTabId) ||
							hasDraft(t) ||
							(showStarredInUnreadFilter && t.starred)
					)
				: tabs,
		[tabs, showUnreadOnly, inputMode, activeTabId, showStarredInUnreadFilter, stuckTabIds]
	);

	const displayedUnifiedTabs = useMemo(() => {
		if (!unifiedTabs) return null;
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
			// enabled — but the currently active file tab is always visible so the user
			// never loses sight of what they're looking at.
			if (ut.type === 'file') {
				return showFilePreviewsInUnreadFilter || ut.id === activeFileTabId;
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
		stuckTabIds,
	]);

	// Drag handlers
	const lookupDragTargetWindow = useCallback((screenX: number, screenY: number) => {
		const findWindowAtPoint = window.maestro?.windows?.findWindowAtPoint;
		if (!findWindowAtPoint || (screenX === 0 && screenY === 0)) {
			dragTargetWindowIdRef.current = null;
			return;
		}

		const lookupKey = `${screenX}:${screenY}`;
		if (lastWindowPointLookupRef.current === lookupKey) {
			return;
		}
		lastWindowPointLookupRef.current = lookupKey;

		void findWindowAtPoint(screenX, screenY)
			.then((windowInfo) => {
				if (lastWindowPointLookupRef.current === lookupKey) {
					dragTargetWindowIdRef.current = windowInfo?.id ?? null;
				}
			})
			.catch((error) => {
				logger.warn('[TabBar] Failed to look up drag target window', { error });
				if (lastWindowPointLookupRef.current === lookupKey) {
					dragTargetWindowIdRef.current = null;
				}
			});
	}, []);

	const updateDragWindowExitState = useCallback(
		(screenX: number, screenY: number) => {
			const bounds = windowBoundsRef.current;
			if (!bounds || (screenX === 0 && screenY === 0)) {
				return;
			}

			const isOutsideWindow = isPointOutsideBounds(screenX, screenY, bounds);
			setDraggingOutsideWindow(isOutsideWindow);
			if (isOutsideWindow) {
				lookupDragTargetWindow(screenX, screenY);
			} else {
				dragTargetWindowIdRef.current = null;
				lastWindowPointLookupRef.current = null;
			}
		},
		[lookupDragTargetWindow]
	);

	const handleDragStart = useCallback(
		(tabId: string, e: React.DragEvent) => {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', tabId);
			setDraggingTabId(tabId);
			setDraggingOutsideWindow(false);
			windowBoundsRef.current = null;
			dragTargetWindowIdRef.current = null;
			lastWindowPointLookupRef.current = null;

			window.maestro?.windows
				?.getWindowBounds?.()
				.then((bounds) => {
					windowBoundsRef.current = bounds;
					updateDragWindowExitState(e.screenX, e.screenY);
				})
				.catch((error) => {
					logger.warn('[TabBar] Failed to read window bounds during tab drag', { error });
				});
		},
		[updateDragWindowExitState]
	);

	const handleDrag = useCallback(
		(_tabId: string, e: React.DragEvent) => {
			updateDragWindowExitState(e.screenX, e.screenY);
		},
		[updateDragWindowExitState]
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
		setDraggingOutsideWindow(false);
		windowBoundsRef.current = null;
		dragTargetWindowIdRef.current = null;
		lastWindowPointLookupRef.current = null;
	}, []);

	const handleDrop = useCallback(
		(targetTabId: string, e: React.DragEvent) => {
			e.preventDefault();
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
			setDraggingOutsideWindow(false);
			windowBoundsRef.current = null;
			dragTargetWindowIdRef.current = null;
			lastWindowPointLookupRef.current = null;
		},
		[tabs, onTabReorder, unifiedTabs, onUnifiedTabReorder]
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

	// Close wrappers — forward the clicked tab id as the pivot so the operation
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
	// "Terminal N" label reflects the order the user opened them — not the
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
		onDrag: handleDrag,
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
			className="flex items-end gap-0.5 pt-2 border-b overflow-x-auto overflow-y-hidden no-scrollbar"
			data-tour="tab-bar"
			data-drag-outside-window={draggingOutsideWindow ? 'true' : undefined}
			style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
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
			</div>

			{/* Empty state when filter is on but no unread tabs */}
			{showUnreadOnly &&
				(displayedUnifiedTabs ? displayedUnifiedTabs.length === 0 : displayedTabs.length === 0) && (
					<div
						className="flex items-center px-3 py-1.5 text-xs italic shrink-0 self-center mb-1"
						style={{ color: theme.colors.textDim }}
					>
						No unread or draft tabs
					</div>
				)}

			{/* Tab rendering — unified mode (AI + file + terminal tabs) */}
			{displayedUnifiedTabs
				? displayedUnifiedTabs.map((unifiedTab, index) => {
						const isActive = isUnifiedTabActive(
							unifiedTab,
							activeTabId,
							activeFileTabId,
							activeBrowserTabId,
							activeTerminalTabId,
							inputMode
						);
						const prevTab = index > 0 ? displayedUnifiedTabs[index - 1] : null;
						const isPrevActive = prevTab
							? isUnifiedTabActive(
									prevTab,
									activeTabId,
									activeFileTabId,
									activeBrowserTabId,
									activeTerminalTabId,
									inputMode
								)
							: false;

						const originalIndex = allTabs.findIndex((ut) => ut.id === unifiedTab.id);
						const showSeparator = index > 0 && !isActive && !isPrevActive;
						const isFirstTab = originalIndex === 0;
						const isLastTab = originalIndex === allTabs.length - 1;
						// When the unread filter is active, jump shortcuts (Cmd+N / Cmd+0) operate on
						// the filtered list — so hints must reflect the displayed position, not the
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
										onDrag={handleDrag}
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
						} else {
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
						}
					})
				: /* Legacy mode — AI tabs only */
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
