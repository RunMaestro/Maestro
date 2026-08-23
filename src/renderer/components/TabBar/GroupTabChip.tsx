import React, { useCallback, useRef, useState, memo } from 'react';
import { createPortal } from 'react-dom';
import {
	ChevronsLeft,
	ChevronsRight,
	Clock,
	LayoutGrid,
	Pencil,
	Smile,
	Ungroup,
} from 'lucide-react';
import type { TabGroup, Theme } from '../../types';
import { useTabHoverOverlay } from '../../hooks/tabs/useTabHoverOverlay';
import { useFocusAfterRender } from '../../hooks/utils/useFocusAfterRender';
import { useModalStore } from '../../stores/modalStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { EmojiPickerOverlay } from '../ui';
import { ShortcutHint } from './ShortcutHint';

export interface GroupTabChipProps {
	group: TabGroup;
	isActive: boolean;
	theme: Theme;
	/** Activate the group (renders its tiled layout in the panel). */
	onSelect: (groupId: string) => void;
	/** Commit a new name for the group (raw input; upstream trims + auto-name fallback). */
	onRename?: (groupId: string, name: string) => void;
	/** Park the whole group until later. Omitted where snooze does not apply. */
	onSnooze?: (groupId: string) => void;
	/** Set the group's chip emoji (empty string clears it back to the grid glyph). */
	onSetEmoji?: (groupId: string, emoji: string) => void;
	/** Break the group apart into standalone tabs (gated by this chip's confirm dialog). */
	onBreakApart?: (groupId: string) => void;
	// --- Drag-to-reorder (identical contract to the other tab items) ---
	onDragStart?: (tabId: string, e: React.DragEvent) => void;
	onDragOver?: (tabId: string, e: React.DragEvent) => void;
	onDragEnd?: () => void;
	onDrop?: (tabId: string, e: React.DragEvent) => void;
	isDragging?: boolean;
	isDragOver?: boolean;
	registerRef?: (el: HTMLDivElement | null) => void;
	/** Stable callback - receives the group id */
	onMoveToFirst?: (tabId: string) => void;
	/** Stable callback - receives the group id */
	onMoveToLast?: (tabId: string) => void;
	isFirstTab?: boolean;
	isLastTab?: boolean;
}

/**
 * A tiled tab group rendered as a single chip in the tab strip. Mirrors the other
 * tab items: a split/grid glyph, the group's (truncated) name, a hover overlay
 * menu (Rename group / Break apart), and double-click-to-rename inline editing.
 *
 * Rename reuses the existing tab-rename interaction shape (double-click the chip,
 * or the "Rename group" overlay item) and is backed by the group-rename action.
 * "Break apart" is gated behind the shared modal-store `confirm` dialog (the same
 * one tab-close confirmations use) so a group is only dissolved on explicit
 * confirmation, keeping it distinct from the silent auto-dissolve that fires when a
 * group drops below two panes.
 */
export const GroupTabChip = memo(function GroupTabChip({
	group,
	isActive,
	theme,
	onSelect,
	onRename,
	onSnooze,
	onSetEmoji,
	onBreakApart,
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
}: GroupTabChipProps) {
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

	// Inline rename editing (double-click the chip or the overlay item). Seeded
	// with the current name; committing an empty value falls back to the auto name
	// upstream (the group-rename action handles the fallback).
	const [isRenaming, setIsRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(group.name);
	const inputRef = useRef<HTMLInputElement>(null);
	useFocusAfterRender(inputRef, isRenaming);

	const startRename = useCallback(() => {
		if (!onRename) return;
		setRenameValue(group.name);
		setIsRenaming(true);
		setOverlayOpen(false);
	}, [onRename, group.name, setOverlayOpen]);

	// Change-icon flow: opens the shared emoji selector (the same emoji-mart picker
	// agent-list groups use). Selecting an emoji sets it on the group chip; the
	// picker's own close button / Escape / backdrop dismiss without changing it.
	const [isPickingEmoji, setIsPickingEmoji] = useState(false);

	const startPickEmoji = useCallback(() => {
		if (!onSetEmoji) return;
		setOverlayOpen(false);
		setIsPickingEmoji(true);
	}, [onSetEmoji, setOverlayOpen]);

	const handleEmojiSelect = useCallback(
		(emoji: string) => {
			onSetEmoji?.(group.id, emoji);
		},
		[onSetEmoji, group.id]
	);

	const commitRename = useCallback(() => {
		if (!isRenaming) return;
		setIsRenaming(false);
		onRename?.(group.id, renameValue);
	}, [isRenaming, onRename, group.id, renameValue]);

	const cancelRename = useCallback(() => {
		setIsRenaming(false);
		setRenameValue(group.name);
	}, [group.name]);

	const handleRenameKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				commitRename();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				cancelRename();
			}
		},
		[commitRename, cancelRename]
	);

	// Break apart: gate behind the shared modal-store confirm dialog (no em/en-dashes
	// in the copy). On confirm, the group splits back into standalone tabs. Reuses
	// the same programmatic confirm path as tab-close confirmations.
	const requestBreakApart = useCallback(() => {
		if (!onBreakApart) return;
		setOverlayOpen(false);
		useModalStore.getState().openModal('confirm', {
			title: 'Break apart group?',
			message: `Break apart "${group.name}"? Its panes return to the tab bar as individual tabs. The tabs are not closed, and you can tile them again later.`,
			destructive: false,
			onConfirm: () => onBreakApart(group.id),
		});
	}, [onBreakApart, group.id, group.name, setOverlayOpen]);

	const handleBreakApartClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			requestBreakApart();
		},
		[requestBreakApart]
	);

	const handleSnoozeClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSnooze?.(group.id);
			setOverlayOpen(false);
		},
		[onSnooze, group.id, setOverlayOpen]
	);

	const handleMoveToFirstClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMoveToFirst?.(group.id);
			setOverlayOpen(false);
		},
		[onMoveToFirst, group.id, setOverlayOpen]
	);

	const handleMoveToLastClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMoveToLast?.(group.id);
			setOverlayOpen(false);
		},
		[onMoveToLast, group.id, setOverlayOpen]
	);

	// Drag-to-reorder. The group is ONE unified tab, so it moves as a single unit
	// exactly like an AI / file / terminal / browser chip: the handlers below just
	// forward the group id, and TabBar reorders `unifiedTabOrder` by index. The
	// group's panes are referenced by the layout tree, not by the order array, so
	// moving the chip never disturbs the tiling.
	const handleChipDragStart = useCallback(
		(e: React.DragEvent) => {
			onDragStart?.(group.id, e);
		},
		[onDragStart, group.id]
	);

	const handleChipDragOver = useCallback(
		(e: React.DragEvent) => {
			onDragOver?.(group.id, e);
		},
		[onDragOver, group.id]
	);

	const handleChipDrop = useCallback(
		(e: React.DragEvent) => {
			onDrop?.(group.id, e);
		},
		[onDrop, group.id]
	);

	const hoverBgColor = theme.mode === 'light' ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.08)';

	return (
		<div
			ref={setTabRef}
			data-tab-id={group.id}
			className={`flex items-center gap-1.5 shrink-0 px-2 py-1 mb-1 rounded-t text-xs font-medium transition-colors cursor-pointer select-none outline-none ${
				isActive ? '' : 'max-w-[180px]'
			} ${isDragging ? 'opacity-50' : ''} ${isDragOver ? 'ring-2 ring-inset' : ''}`}
			style={
				{
					color: isActive ? theme.colors.accentForeground : theme.colors.textMain,
					backgroundColor: isActive
						? theme.colors.accent
						: isHovered
							? hoverBgColor
							: 'transparent',
					'--tw-ring-color': isDragOver ? theme.colors.accent : 'transparent',
				} as React.CSSProperties
			}
			title={group.name}
			onClick={() => {
				if (isRenaming) return;
				onSelect(group.id);
			}}
			onDoubleClick={startRename}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={() => {
				if (isOverOverlayRef.current) return;
				handleMouseLeave();
			}}
			// Suppressed while the inline rename input is open: a native drag on the
			// chip would otherwise hijack text selection inside that input.
			draggable={!isRenaming}
			onDragStart={handleChipDragStart}
			onDragOver={handleChipDragOver}
			onDragEnd={onDragEnd}
			onDrop={handleChipDrop}
		>
			{group.emoji ? (
				<span className="text-sm leading-none shrink-0" aria-hidden="true">
					{group.emoji}
				</span>
			) : (
				<LayoutGrid className="w-3.5 h-3.5 shrink-0" />
			)}
			{isRenaming ? (
				<input
					ref={inputRef}
					value={renameValue}
					onChange={(e) => setRenameValue(e.target.value)}
					onKeyDown={handleRenameKeyDown}
					onBlur={commitRename}
					onClick={(e) => e.stopPropagation()}
					onDoubleClick={(e) => e.stopPropagation()}
					className="bg-transparent outline-none border-b w-24 text-xs"
					style={{
						color: isActive ? theme.colors.accentForeground : theme.colors.textMain,
						borderColor: theme.colors.accent,
					}}
				/>
			) : (
				<span className={isActive ? 'whitespace-nowrap' : 'truncate'}>{group.name}</span>
			)}

			{/* Hover overlay menu (Rename group / Change icon / Break apart) */}
			{overlayOpen &&
				overlayPosition &&
				(onRename || onSetEmoji || onBreakApart || onSnooze) &&
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
							className="shadow-xl overflow-hidden whitespace-nowrap"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								borderLeft: `1px solid ${theme.colors.border}`,
								borderRight: `1px solid ${theme.colors.border}`,
								borderBottom: `1px solid ${theme.colors.border}`,
								borderBottomLeftRadius: '8px',
								borderBottomRightRadius: '8px',
								minWidth: '12.5rem',
							}}
						>
							<div className="p-1">
								{onRename && (
									<button
										onClick={(e) => {
											e.stopPropagation();
											startRename();
										}}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Pencil className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Rename group
									</button>
								)}
								{onSetEmoji && (
									<button
										onClick={(e) => {
											e.stopPropagation();
											startPickEmoji();
										}}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Smile className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Change icon
									</button>
								)}
								{onSnooze && (
									<button
										onClick={handleSnoozeClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Clock className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Snooze group
									</button>
								)}
								{onBreakApart && (
									<button
										onClick={handleBreakApartClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Ungroup className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Break apart
									</button>
								)}

								{/* Move to First/Last - the keyboard/menu counterpart to dragging the
								    chip, matching the other tab items' overlay menus. */}
								{((onMoveToFirst && !isFirstTab) || (onMoveToLast && !isLastTab)) && (
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
										{tabShortcuts.moveTabToStart && (
											<ShortcutHint keys={tabShortcuts.moveTabToStart.keys} theme={theme} />
										)}
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
										{tabShortcuts.moveTabToEnd && (
											<ShortcutHint keys={tabShortcuts.moveTabToEnd.keys} theme={theme} />
										)}
									</button>
								)}
							</div>
						</div>
					</div>,
					document.body
				)}

			{/* Change-icon emoji selector (shared with agent-list groups). Portaled to
			    the body so its backdrop clicks don't bubble into the chip's activate
			    handler. */}
			{isPickingEmoji &&
				onSetEmoji &&
				createPortal(
					<EmojiPickerOverlay
						theme={theme}
						onSelect={handleEmojiSelect}
						onClose={() => setIsPickingEmoji(false)}
					/>,
					document.body
				)}
		</div>
	);
});
