import React, { useState, useRef, useCallback, useEffect, memo, useMemo } from 'react';
import { Search, Mail } from 'lucide-react';
import type { AITab } from '../../types';
import { hasDraft } from '../../utils/tabHelpers';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { useSettingsStore } from '../../stores/settingsStore';
import { AITab as AITabComponent } from './AITab';
import { FileTab } from './FileTab';
import { TerminalTabItem } from './TerminalTabItem';
import { NewTabPopover } from './NewTabPopover';
import { isUnifiedTabActive, getShortcutHint } from './tabBarUtils';
import type { TabBarProps } from './types';

/** Approximate width of the sticky right "+" button area (px) */
const STICKY_RIGHT_WIDTH = 48;

/**
 * TabBar component for displaying AI session tabs.
 * Shows tabs for each Claude Code conversation within a Maestro session.
 * Appears only in AI mode (hidden in terminal mode).
 */
function TabBarInner({
	tabs,
	activeTabId,
	theme,
	sessionId,
	onTabSelect,
	onTabClose,
	onNewTab,
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
	onCloseAllTabs,
	onCloseOtherTabs,
	onCloseTabsLeft,
	onCloseTabsRight,
	unifiedTabs,
	activeFileTabId,
	onFileTabSelect,
	onFileTabClose,
	onUnifiedTabReorder,
	activeTerminalTabId,
	inputMode,
	onTerminalTabSelect,
	onTerminalTabClose,
	onTerminalTabRename,
	colorBlindMode,
}: TabBarProps) {
	// Dev-time warnings for missing handlers when unified tabs are provided
	if (process.env.NODE_ENV !== 'production' && unifiedTabs) {
		if (!onFileTabSelect || !onFileTabClose) {
			console.warn('[TabBar] unifiedTabs provided but onFileTabSelect/onFileTabClose missing');
		}
		if (!onTerminalTabSelect || !onTerminalTabClose) {
			console.warn(
				'[TabBar] unifiedTabs provided but onTerminalTabSelect/onTerminalTabClose missing'
			);
		}
	}

	const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
	const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
	const [showUnreadOnlyLocal, setShowUnreadOnlyLocal] = useState(false);
	const showUnreadOnly = showUnreadOnlyProp ?? showUnreadOnlyLocal;
	const toggleUnreadFilter =
		onToggleUnreadFilter ?? (() => setShowUnreadOnlyLocal((prev) => !prev));

	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const tabShortcuts = useSettingsStore((s) => s.tabShortcuts);
	const showStarredInUnreadFilter = useSettingsStore((s) => s.showStarredInUnreadFilter);
	const showFilePreviewsInUnreadFilter = useSettingsStore((s) => s.showFilePreviewsInUnreadFilter);

	const tabBarRef = useRef<HTMLDivElement>(null);
	const stickyLeftRef = useRef<HTMLDivElement>(null);
	const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
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
						: activeFileTabId || activeTabId;
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
	}, [activeTabId, activeFileTabId, activeTerminalTabId, inputMode, activeTabName, showUnreadOnly]);

	// Filter tabs for display
	const displayedTabs = showUnreadOnly
		? tabs.filter(
				(t) =>
					t.hasUnread ||
					t.state === 'busy' ||
					t.id === activeTabId ||
					hasDraft(t) ||
					(showStarredInUnreadFilter && t.starred)
			)
		: tabs;

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
					ut.id === activeTabId ||
					hasDraft(ut.data) ||
					(showStarredInUnreadFilter && ut.data.starred)
				);
			}
			// File preview tabs: hidden by default in unread filter, shown if setting enabled
			if (ut.type === 'file') {
				return showFilePreviewsInUnreadFilter;
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
	]);

	// Drag handlers
	const handleDragStart = useCallback((tabId: string, e: React.DragEvent) => {
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', tabId);
		setDraggingTabId(tabId);
	}, []);

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

	// Close wrappers — adapt (tabId: string) => () signature for TabBar's parameterless close handlers
	const handleTabCloseOther = useCallback(
		(_tabId: string) => onCloseOtherTabs?.(),
		[onCloseOtherTabs]
	);
	const handleTabCloseLeft = useCallback(
		(_tabId: string) => onCloseTabsLeft?.(),
		[onCloseTabsLeft]
	);
	const handleTabCloseRight = useCallback(
		(_tabId: string) => onCloseTabsRight?.(),
		[onCloseTabsRight]
	);

	const registerTabRef = useCallback((tabId: string, el: HTMLDivElement | null) => {
		if (el) tabRefs.current.set(tabId, el);
		else tabRefs.current.delete(tabId);
	}, []);

	// Shared props computed once for the rendering loop
	const allTabs = unifiedTabs ?? [];

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
			className="flex items-end gap-0.5 pt-2 border-b overflow-x-auto overflow-y-hidden no-scrollbar"
			data-tour="tab-bar"
			style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
		>
			{/* Sticky left: search + unread filter */}
			<div
				ref={stickyLeftRef}
				className="sticky left-0 flex items-center shrink-0 pl-2 pr-1 gap-1 self-stretch"
				style={{ backgroundColor: theme.colors.bgSidebar, zIndex: 5 }}
			>
				{onOpenTabSearch && (
					<button
						onClick={onOpenTabSearch}
						className="flex items-center justify-center w-6 h-6 rounded hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textDim }}
						title={`Search tabs (${formatShortcutKeys(tabShortcuts.tabSwitcher?.keys ?? ['Alt', 'Meta', 't'])})`}
					>
						<Search className="w-4 h-4" />
					</button>
				)}
				<button
					onClick={toggleUnreadFilter}
					className="relative flex items-center justify-center w-6 h-6 rounded transition-colors"
					style={{
						color: showUnreadOnly ? theme.colors.accent : theme.colors.textDim,
						opacity: showUnreadOnly ? 1 : 0.5,
					}}
					title={
						showUnreadOnly
							? `Showing unread only (${formatShortcutKeys(tabShortcuts.filterUnreadTabs?.keys ?? ['Meta', 'u'])})`
							: `Filter unread tabs (${formatShortcutKeys(tabShortcuts.filterUnreadTabs?.keys ?? ['Meta', 'u'])})`
					}
				>
					<Mail className="w-4 h-4" />
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

			{/* Tab rendering — unified mode (AI + file + terminal tabs) */}
			{displayedUnifiedTabs
				? displayedUnifiedTabs.map((unifiedTab, index) => {
						const isActive = isUnifiedTabActive(
							unifiedTab,
							activeTabId,
							activeFileTabId,
							activeTerminalTabId,
							inputMode
						);
						const prevTab = index > 0 ? displayedUnifiedTabs[index - 1] : null;
						const isPrevActive = prevTab
							? isUnifiedTabActive(
									prevTab,
									activeTabId,
									activeFileTabId,
									activeTerminalTabId,
									inputMode
								)
							: false;

						const originalIndex = allTabs.findIndex((ut) => ut.id === unifiedTab.id);
						const showSeparator = index > 0 && !isActive && !isPrevActive;
						const isFirstTab = originalIndex === 0;
						const isLastTab = originalIndex === allTabs.length - 1;
						const shortcutHint = getShortcutHint(originalIndex, isLastTab, showUnreadOnly);

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
									/>
								</React.Fragment>
							);
						} else {
							const terminalTab = unifiedTab.data;
							const terminalIndex = allTabs
								.filter((ut) => ut.type === 'terminal')
								.findIndex((ut) => ut.id === unifiedTab.id);
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
						const shortcutHint = getShortcutHint(originalIndex, isLastTab, showUnreadOnly);

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
				onNewTerminalTab={onNewTerminalTab}
				newTabKeys={tabShortcuts.newTab?.keys ?? ['Meta', 't']}
				terminalKeys={shortcuts.toggleMode?.keys ?? ['Meta', 'j']}
				isOverflowing={isOverflowing}
			/>
		</div>
	);
}

export const TabBar = memo(TabBarInner);
