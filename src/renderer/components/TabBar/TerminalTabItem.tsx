import React, { useCallback, memo, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Pencil, Terminal, ChevronsLeft, ChevronsRight } from 'lucide-react';
import type { TerminalTab, Theme } from '../../types';
import { getTerminalTabDisplayName } from '../../utils/terminalTabHelpers';
import { useTabHoverOverlay } from '../../hooks/tabs/useTabHoverOverlay';
import { useSettingsStore } from '../../stores/settingsStore';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

/**
 * Props for the TerminalTabItem component.
 * Similar to FileTabProps but tailored for terminal tab rendering.
 */
export interface TerminalTabItemProps {
	tab: TerminalTab;
	/** Zero-based index among terminal tabs only (for display name generation) */
	terminalIndex: number;
	isActive: boolean;
	theme: Theme;
	onSelect: (tabId: string) => void;
	onClose: (tabId: string) => void;
	onRename?: (tabId: string) => void;
	onDragStart: (tabId: string, e: React.DragEvent) => void;
	onDragOver: (tabId: string, e: React.DragEvent) => void;
	onDragEnd: () => void;
	onDrop: (tabId: string, e: React.DragEvent) => void;
	isDragging: boolean;
	isDragOver: boolean;
	registerRef?: (el: HTMLDivElement | null) => void;
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

/**
 * Individual terminal tab component.
 * Shows a Terminal icon with state-color indicator, the tab display name,
 * an optional exit-code badge, and a hover overlay with tab management actions.
 */
export const TerminalTabItem = memo(function TerminalTabItem({
	tab,
	terminalIndex,
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
}: TerminalTabItemProps) {
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
		isOverOverlayRef,
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

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if (e.button === 1) {
				e.preventDefault();
				onClose(tab.id);
			}
		},
		[onClose, tab.id]
	);

	const handleDoubleClick = useCallback(() => {
		onRename?.(tab.id);
	}, [onRename, tab.id]);

	const handleCloseClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onClose(tab.id);
		},
		[onClose, tab.id]
	);

	const handleTabSelect = useCallback(() => onSelect(tab.id), [onSelect, tab.id]);

	const handleTabDragStart = useCallback(
		(e: React.DragEvent) => onDragStart(tab.id, e),
		[onDragStart, tab.id]
	);
	const handleTabDragOver = useCallback(
		(e: React.DragEvent) => onDragOver(tab.id, e),
		[onDragOver, tab.id]
	);
	const handleTabDrop = useCallback((e: React.DragEvent) => onDrop(tab.id, e), [onDrop, tab.id]);

	// Overlay action handlers
	const handleRenameClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onRename?.(tab.id);
			setOverlayOpen(false);
		},
		[onRename, tab.id, setOverlayOpen]
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

	// Determine icon state color
	const iconColor = useMemo(() => {
		if (tab.state === 'idle') return theme.colors.success;
		if (tab.state === 'busy') return theme.colors.warning;
		if (tab.state === 'exited') {
			return (tab.exitCode ?? 0) !== 0 ? theme.colors.error : theme.colors.textDim;
		}
		return theme.colors.textDim;
	}, [tab.state, tab.exitCode, theme.colors]);

	const displayName = useMemo(
		() => getTerminalTabDisplayName(tab, terminalIndex),
		[tab, terminalIndex]
	);

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
			title={tab.cwd ? `${tab.shellType} — ${tab.cwd}` : tab.shellType}
			onClick={handleTabSelect}
			onFocus={handleMouseEnter}
			onBlur={() => {
				// Don't close overlay if user is interacting with it (e.g. clicking a button)
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
			onDoubleClick={handleDoubleClick}
			onMouseDown={handleMouseDown}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
			draggable
			onDragStart={handleTabDragStart}
			onDragOver={handleTabDragOver}
			onDragEnd={onDragEnd}
			onDrop={handleTabDrop}
		>
			{/* Shortcut hint badge */}
			{shortcutHint !== null && shortcutHint !== undefined && (
				<span
					className="w-4 h-4 flex items-center justify-center rounded text-[10px] font-medium shrink-0 opacity-50"
					style={{ backgroundColor: theme.colors.border, color: theme.colors.textMain }}
				>
					{shortcutHint}
				</span>
			)}

			{/* Terminal icon with state color */}
			<Terminal className="w-3.5 h-3.5 shrink-0" style={{ color: iconColor }} />

			{/* Tab display name */}
			<span
				className={`text-xs font-medium ${isActive ? 'whitespace-nowrap' : 'truncate max-w-[150px]'}`}
				style={{ color: isActive ? theme.colors.textMain : theme.colors.textDim }}
			>
				{displayName}
			</span>

			{/* Exit code badge — only when exited with non-zero code */}
			{tab.state === 'exited' && (tab.exitCode ?? 0) !== 0 && (
				<span
					className="px-1 rounded text-[9px] font-semibold shrink-0"
					style={{
						backgroundColor: theme.colors.error + '30',
						color: theme.colors.error,
						paddingTop: '2px',
						paddingBottom: '2px',
					}}
				>
					{tab.exitCode}
				</span>
			)}

			{/* Close button — visible on hover or active */}
			{(isHovered || isActive) && (
				<button
					onClick={handleCloseClick}
					className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
					title="Close tab"
				>
					<X className="w-3 h-3" style={{ color: theme.colors.textDim }} />
				</button>
			)}

			{/* Hover overlay with tab actions */}
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
						<div
							className="shadow-xl overflow-hidden"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								borderLeft: `1px solid ${theme.colors.border}`,
								borderRight: `1px solid ${theme.colors.border}`,
								borderBottom: `1px solid ${theme.colors.border}`,
								borderBottomLeftRadius: '8px',
								borderBottomRightRadius: '8px',
								minWidth: '200px',
							}}
						>
							<div className="p-1">
								{/* Rename */}
								{onRename && (
									<button
										onClick={handleRenameClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Pencil className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Rename
									</button>
								)}

								{/* Move to First/Last */}
								{(onMoveToFirst || onMoveToLast) && (
									<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
								)}
								{onMoveToFirst && !isFirstTab && (
									<button
										onClick={handleMoveToFirstClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<ChevronsLeft className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Move to First Position
									</button>
								)}
								{onMoveToLast && !isLastTab && (
									<button
										onClick={handleMoveToLastClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<ChevronsRight
											className="w-3.5 h-3.5"
											style={{ color: theme.colors.textDim }}
										/>
										Move to Last Position
									</button>
								)}

								{/* Close actions */}
								<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />

								<button
									onClick={handleCloseTabClick}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									<X className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									Close Tab
									{tabShortcuts.closeTab && <ShortcutHint keys={tabShortcuts.closeTab.keys} />}
								</button>

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
