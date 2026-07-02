import React, { useCallback, useRef, useState, memo } from 'react';
import { createPortal } from 'react-dom';
import { LayoutGrid, Pencil, Ungroup } from 'lucide-react';
import type { TabGroup, Theme } from '../../types';
import { useTabHoverOverlay } from '../../hooks/tabs/useTabHoverOverlay';
import { useFocusAfterRender } from '../../hooks/utils/useFocusAfterRender';
import { useModalStore } from '../../stores/modalStore';

export interface GroupTabChipProps {
	group: TabGroup;
	isActive: boolean;
	theme: Theme;
	/** Activate the group (renders its tiled layout in the panel). */
	onSelect: (groupId: string) => void;
	/** Commit a new name for the group (raw input; upstream trims + auto-name fallback). */
	onRename?: (groupId: string, name: string) => void;
	/** Break the group apart into standalone tabs (gated by this chip's confirm dialog). */
	onBreakApart?: (groupId: string) => void;
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
	onBreakApart,
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
	} = useTabHoverOverlay();

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

	const hoverBgColor = theme.mode === 'light' ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.08)';

	return (
		<div
			ref={setTabRef}
			data-tab-id={group.id}
			className="flex items-center gap-1.5 shrink-0 px-2 py-1 mb-1 rounded-t text-xs font-medium max-w-[180px] transition-colors cursor-pointer select-none outline-none"
			style={{
				color: isActive ? theme.colors.accentForeground : theme.colors.textMain,
				backgroundColor: isActive ? theme.colors.accent : isHovered ? hoverBgColor : 'transparent',
			}}
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
		>
			<LayoutGrid className="w-3.5 h-3.5 shrink-0" />
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
				<span className="truncate">{group.name}</span>
			)}

			{/* Hover overlay menu (Rename group / Break apart) */}
			{overlayOpen &&
				overlayPosition &&
				(onRename || onBreakApart) &&
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
							</div>
						</div>
					</div>,
					document.body
				)}
		</div>
	);
});
