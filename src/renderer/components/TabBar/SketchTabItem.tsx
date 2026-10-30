import React, { useCallback, memo, useMemo } from 'react';
import { PenTool, X, ChevronsLeft, Clock, ChevronsRight, Pencil } from 'lucide-react';
import type { Theme } from '../../types';
import type { SketchTab } from '../../../shared/sketch/types';
import { useTabHoverOverlay } from '../../hooks/tabs/useTabHoverOverlay';
import { LongPressable } from '../shared/LongPressable';
import { TabOverlayPortal } from './TabOverlayPortal';
import { getTabKindColor } from './tabBarUtils';
import { getSketchTabLabel } from '../../utils/tabHelpers';
import { useSettingsStore } from '../../stores/settingsStore';
import { ShortcutHint, shortcutSuffix } from '../ui/ShortcutHint';
import { sketchAgentWorkLabel, useSketchAgentWork } from '../SketchBook/useSketchAgentWork';

export interface SketchTabItemProps {
	tab: SketchTab;
	isActive: boolean;
	theme: Theme;
	onSelect: (tabId: string) => void;
	onClose: (tabId: string) => void;
	/** Open the rename dialog for this tab. */
	onRename?: (tabId: string) => void;
	onDragStart: (tabId: string, e: React.DragEvent) => void;
	onDragOver: (tabId: string, e: React.DragEvent) => void;
	onDragEnd: () => void;
	onDrop: (tabId: string, e: React.DragEvent) => void;
	isDragging: boolean;
	isDragOver: boolean;
	registerRef?: (el: HTMLDivElement | null) => void;
	/** Park this tab until a chosen moment. Omitted when snoozing is unavailable. */
	onSnooze?: (tabId: string) => void;
	onMoveToFirst?: (tabId: string) => void;
	onMoveToLast?: (tabId: string) => void;
	isFirstTab?: boolean;
	isLastTab?: boolean;
	onCloseOtherTabs?: (tabId: string) => void;
	onCloseTabsLeft?: (tabId: string) => void;
	onCloseTabsRight?: (tabId: string) => void;
	totalTabs?: number;
	tabIndex?: number;
	shortcutHint?: number | null;
}

const MENU_ITEM_CLASS =
	'w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors';
const MENU_ITEM_HOVER = 'hover:bg-white/10';

/**
 * A Sketch Book tab chip. Same shell as {@link BrowserTabItem} (hover or
 * long-press overlay, drag to reorder, middle-click close) without the
 * page-content actions a sketch does not have. While an agent works on the
 * sketch it shows the AI tab's pulsing busy dot (`useSketchAgentWork()`).
 */
export const SketchTabItem = memo(function SketchTabItem({
	tab,
	isActive,
	theme,
	onSelect,
	onClose,
	onRename,
	onDragStart,
	onDragOver,
	onDragEnd,
	onDrop,
	isDragging,
	isDragOver,
	registerRef,
	onSnooze,
	onMoveToFirst,
	onMoveToLast,
	isFirstTab,
	isLastTab,
	onCloseOtherTabs,
	onCloseTabsLeft,
	onCloseTabsRight,
	totalTabs,
	tabIndex,
	shortcutHint,
}: SketchTabItemProps) {
	const {
		isHovered,
		overlayOpen,
		setOverlayOpen,
		overlayPosition,
		setOverlayRef,
		positionReady,
		setTabRef,
		openOverlay,
		handleMouseEnter,
		handleMouseLeave,
		overlayMouseEnter,
		overlayMouseLeave,
		isOverOverlayRef,
	} = useTabHoverOverlay({ registerRef });

	const tabShortcuts = useSettingsStore((s) => s.tabShortcuts);
	// The same title the tiled pane bar shows, so the two never disagree.
	const label = getSketchTabLabel(tab);
	const agentWork = useSketchAgentWork(tab.sketchId);
	const working = agentWork ? sketchAgentWorkLabel(agentWork) : null;
	const hoverBgColor = theme.mode === 'light' ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.08)';

	const tabStyle = useMemo(
		() =>
			({
				borderTopLeftRadius: '6px',
				borderTopRightRadius: '6px',
				backgroundColor: isActive ? theme.colors.bgMain : isHovered ? hoverBgColor : 'transparent',
				borderTop: isActive ? `1px solid ${theme.colors.border}` : '1px solid transparent',
				borderLeft: isActive ? `1px solid ${theme.colors.border}` : '1px solid transparent',
				borderRight: isActive ? `1px solid ${theme.colors.border}` : '1px solid transparent',
				borderBottom: isActive ? `1px solid ${theme.colors.bgMain}` : '1px solid transparent',
				marginBottom: isActive ? '-1px' : '0',
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

	// Every overlay action runs, then shuts the overlay.
	const menuAction = useCallback(
		(action?: (tabId: string) => void, selectFirst = false) =>
			(e: React.MouseEvent) => {
				e.stopPropagation();
				if (selectFirst) onSelect(tab.id);
				action?.(tab.id);
				setOverlayOpen(false);
			},
		[onSelect, tab.id, setOverlayOpen]
	);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if (e.button === 1) {
				e.preventDefault();
				onClose(tab.id);
			}
		},
		[onClose, tab.id]
	);
	const handleTabSelect = useCallback(() => onSelect(tab.id), [onSelect, tab.id]);
	const handleCloseClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onClose(tab.id);
		},
		[onClose, tab.id]
	);

	return (
		<LongPressable
			innerRef={setTabRef}
			onLongPress={openOverlay}
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
			title={working ? `${label} (${working})` : label}
			onClick={handleTabSelect}
			onDoubleClick={() => onRename?.(tab.id)}
			onFocus={handleMouseEnter}
			onBlur={() => {
				if (isOverOverlayRef.current) return;
				handleMouseLeave();
				setOverlayOpen(false);
			}}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					handleTabSelect();
				}
			}}
			onMouseDown={handleMouseDown}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
			draggable
			onDragStart={(e) => onDragStart(tab.id, e)}
			onDragOver={(e) => onDragOver(tab.id, e)}
			onDragEnd={onDragEnd}
			onDrop={(e) => onDrop(tab.id, e)}
		>
			{shortcutHint !== null && shortcutHint !== undefined && (
				<span
					className="w-4 h-4 flex items-center justify-center rounded text-2xs font-medium shrink-0 opacity-50"
					style={{ backgroundColor: theme.colors.border, color: theme.colors.textMain }}
				>
					{shortcutHint}
				</span>
			)}

			<PenTool
				className="w-3.5 h-3.5 shrink-0"
				style={{ color: getTabKindColor('sketch', theme) }}
			/>

			<span
				data-tab-label
				className="text-xs font-medium whitespace-nowrap"
				style={{ color: isActive ? theme.colors.textMain : theme.colors.textDim }}
			>
				{label}
			</span>

			{working && (
				<div
					className="w-2 h-2 rounded-full shrink-0 animate-pulse"
					style={{ backgroundColor: theme.colors.warning }}
					role="status"
					aria-label={working}
					data-testid="sketch-tab-working"
				/>
			)}

			{(isHovered || isActive) && (
				<button
					onClick={handleCloseClick}
					data-tab-close
					className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
					title={`Close tab${shortcutSuffix(tabShortcuts.closeTab?.keys)}`}
				>
					<X className="w-3 h-3" style={{ color: theme.colors.textDim }} />
				</button>
			)}

			<TabOverlayPortal
				open={overlayOpen}
				position={overlayPosition}
				positionReady={positionReady}
				setOverlayRef={setOverlayRef}
				onMouseEnter={overlayMouseEnter}
				onMouseLeave={overlayMouseLeave}
				onClose={() => setOverlayOpen(false)}
				theme={theme}
			>
				<div
					className="shadow-xl overflow-hidden"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						borderLeft: `1px solid ${theme.colors.border}`,
						borderRight: `1px solid ${theme.colors.border}`,
						borderBottom: `1px solid ${theme.colors.border}`,
						borderBottomLeftRadius: '8px',
						borderBottomRightRadius: '8px',
						minWidth: '13.75rem',
						maxWidth: '20rem',
					}}
				>
					<div className="px-3 py-2 border-b" style={{ borderColor: theme.colors.border }}>
						<div className="text-xs font-medium truncate" style={{ color: theme.colors.textMain }}>
							{label}
						</div>
						<div className="text-xs-plus mt-0.5" style={{ color: theme.colors.textDim }}>
							Sketch Book
						</div>
					</div>

					<div className="p-1">
						{onRename && (
							<>
								<button
									onClick={menuAction(onRename)}
									className={`${MENU_ITEM_CLASS} ${MENU_ITEM_HOVER}`}
									style={{ color: theme.colors.textMain }}
								>
									<Pencil className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									Rename
								</button>
								<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
							</>
						)}

						{onSnooze && (
							<button
								onClick={menuAction(onSnooze)}
								className={`${MENU_ITEM_CLASS} ${MENU_ITEM_HOVER}`}
								style={{ color: theme.colors.textMain }}
							>
								<Clock className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								Snooze Tab
								{tabShortcuts.snoozeTab && (
									<ShortcutHint keys={tabShortcuts.snoozeTab.keys} theme={theme} />
								)}
							</button>
						)}

						{(onMoveToFirst || onMoveToLast) && (
							<>
								{onMoveToFirst && !isFirstTab && (
									<button
										onClick={menuAction(onMoveToFirst)}
										className={`${MENU_ITEM_CLASS} ${MENU_ITEM_HOVER}`}
										style={{ color: theme.colors.textMain }}
									>
										<ChevronsLeft className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Move to First Position
										{tabShortcuts.moveTabToStart && (
											<ShortcutHint keys={tabShortcuts.moveTabToStart.keys} theme={theme} />
										)}
									</button>
								)}
								{onMoveToLast && !isLastTab && (
									<button
										onClick={menuAction(onMoveToLast)}
										className={`${MENU_ITEM_CLASS} ${MENU_ITEM_HOVER}`}
										style={{ color: theme.colors.textMain }}
									>
										<ChevronsRight
											className="w-3.5 h-3.5"
											style={{ color: theme.colors.textDim }}
										/>
										Move to Last Position
										{tabShortcuts.moveTabToEnd && (
											<ShortcutHint keys={tabShortcuts.moveTabToEnd.keys} theme={theme} />
										)}
									</button>
								)}
								<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
							</>
						)}

						<button
							onClick={menuAction(onClose)}
							className={`${MENU_ITEM_CLASS} ${MENU_ITEM_HOVER}`}
							style={{ color: theme.colors.textMain }}
						>
							<X className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
							Close Tab
							{tabShortcuts.closeTab && (
								<ShortcutHint keys={tabShortcuts.closeTab.keys} theme={theme} />
							)}
						</button>

						{onCloseOtherTabs && (
							<button
								onClick={menuAction(onCloseOtherTabs, true)}
								className={`${MENU_ITEM_CLASS} ${totalTabs === 1 ? 'opacity-40 cursor-default' : MENU_ITEM_HOVER}`}
								style={{ color: theme.colors.textMain }}
								disabled={totalTabs === 1}
							>
								<X className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								Close Other Tabs
								{tabShortcuts.closeOtherTabs && (
									<ShortcutHint keys={tabShortcuts.closeOtherTabs.keys} theme={theme} />
								)}
							</button>
						)}

						{onCloseTabsLeft && (
							<button
								onClick={menuAction(onCloseTabsLeft, true)}
								className={`${MENU_ITEM_CLASS} ${tabIndex === 0 ? 'opacity-40 cursor-default' : MENU_ITEM_HOVER}`}
								style={{ color: theme.colors.textMain }}
								disabled={tabIndex === 0}
							>
								<ChevronsLeft className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								Close Tabs to Left
								{tabShortcuts.closeTabsLeft && (
									<ShortcutHint keys={tabShortcuts.closeTabsLeft.keys} theme={theme} />
								)}
							</button>
						)}

						{onCloseTabsRight && (
							<button
								onClick={menuAction(onCloseTabsRight, true)}
								className={`${MENU_ITEM_CLASS} ${
									tabIndex === (totalTabs ?? 1) - 1 ? 'opacity-40 cursor-default' : MENU_ITEM_HOVER
								}`}
								style={{ color: theme.colors.textMain }}
								disabled={tabIndex === (totalTabs ?? 1) - 1}
							>
								<ChevronsRight className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								Close Tabs to Right
								{tabShortcuts.closeTabsRight && (
									<ShortcutHint keys={tabShortcuts.closeTabsRight.keys} theme={theme} />
								)}
							</button>
						)}
					</div>
				</div>
			</TabOverlayPortal>
		</LongPressable>
	);
});
