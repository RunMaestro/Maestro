/**
 * TerminalTabBar - Tab bar for managing multiple terminal tabs
 *
 * Similar to TabBar.tsx but simplified for terminal needs:
 * - No star/unread functionality
 * - Simpler display names (Terminal 1, Terminal 2, or custom name)
 * - Shows shell type indicator
 * - Shows exit code if terminal exited
 */

import React, { useState, useRef, useCallback, useEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Loader2, Terminal as TerminalIcon } from 'lucide-react';
import type { TerminalTab, Theme } from '../types';
import { getTerminalTabDisplayName } from '../utils/terminalTabHelpers';

interface TerminalTabBarProps {
	tabs: TerminalTab[];
	activeTabId: string;
	theme: Theme;
	onTabSelect: (tabId: string) => void;
	onTabClose: (tabId: string) => void;
	onNewTab: () => void;
	onRequestRename?: (tabId: string) => void;
	onTabReorder?: (fromIndex: number, toIndex: number) => void;
	onCloseOtherTabs?: (tabId: string) => void;
	onCloseTabsRight?: (tabId: string) => void;
}

interface TerminalTabProps {
	tab: TerminalTab;
	index: number;
	isActive: boolean;
	theme: Theme;
	canClose: boolean;
	onSelect: () => void;
	onClose: () => void;
	onMiddleClick: () => void;
	onDragStart: (e: React.DragEvent) => void;
	onDragOver: (e: React.DragEvent) => void;
	onDragEnd: () => void;
	onDrop: (e: React.DragEvent) => void;
	isDragging: boolean;
	isDragOver: boolean;
	onRename: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
}

const TerminalTabComponent = memo(function TerminalTabComponent({
	tab,
	index,
	isActive,
	theme,
	canClose,
	onSelect,
	onClose,
	onMiddleClick,
	onDragStart,
	onDragOver,
	onDragEnd,
	onDrop,
	isDragging,
	isDragOver,
	onRename,
	onContextMenu,
}: TerminalTabProps) {
	const displayName = getTerminalTabDisplayName(tab, index);
	const isExited = tab.state === 'exited';
	const isBusy = tab.state === 'busy';
	const isSpawning = tab.pid === 0 && tab.state === 'idle';
	const tabHoverTitle = `${tab.shellType} - ${tab.cwd}`;

	return (
		<div
			title={tabHoverTitle}
			draggable
			onDragStart={onDragStart}
			onDragOver={onDragOver}
			onDragEnd={onDragEnd}
			onDrop={onDrop}
			onClick={onSelect}
			onContextMenu={onContextMenu}
			onMouseDown={(e) => {
				if (e.button === 1) {
					e.preventDefault();
					onMiddleClick();
				}
			}}
			onDoubleClick={onRename}
			className={`
				flex items-center gap-1.5 px-3 py-1.5 text-sm cursor-pointer
				border-r transition-colors select-none shrink-0
				${isDragging ? 'opacity-50' : ''}
				${isDragOver ? 'ring-1 ring-inset' : ''}
			`}
			style={{
				backgroundColor: isActive ? theme.colors.bgMain : 'transparent',
				color: isActive ? theme.colors.textMain : theme.colors.textDim,
				borderColor: theme.colors.border,
				boxShadow: isDragOver ? `inset 0 0 0 1px ${theme.colors.accent}` : 'none',
			}}
		>
			<TerminalIcon
				className="w-3.5 h-3.5 flex-shrink-0"
				style={{
					color: isExited
						? tab.exitCode === 0
							? theme.colors.success
							: theme.colors.error
						: isBusy
							? theme.colors.warning
							: 'inherit',
				}}
			/>

			<span className="truncate max-w-[150px]">{displayName}</span>

			<span className="text-[10px] uppercase opacity-70">{tab.shellType}</span>

			{isSpawning && (
				<span title="Starting terminal">
					<Loader2
						className="h-3 w-3 flex-shrink-0 animate-spin"
						style={{ color: theme.colors.warning }}
					/>
				</span>
			)}

			{isExited && tab.exitCode !== undefined && tab.exitCode !== 0 && (
				<span className="text-xs opacity-70" title={`Exit code: ${tab.exitCode}`}>
					({tab.exitCode})
				</span>
			)}

			{canClose && (
				<button
					onClick={(e) => {
						e.stopPropagation();
						onClose();
					}}
					className="ml-1 p-0.5 rounded opacity-60 hover:opacity-100 transition-opacity"
					style={{ color: theme.colors.textDim }}
					title="Close terminal"
				>
					<X className="w-3 h-3" />
				</button>
			)}
		</div>
	);
});

export const TerminalTabBar = memo(function TerminalTabBar({
	tabs,
	activeTabId,
	theme,
	onTabSelect,
	onTabClose,
	onNewTab,
	onRequestRename,
	onTabReorder,
	onCloseOtherTabs,
	onCloseTabsRight,
}: TerminalTabBarProps) {
	const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
	const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(
		null
	);
	const containerRef = useRef<HTMLDivElement>(null);
	const contextMenuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!contextMenu) {
			return;
		}

		const handleOutsideMouseDown = (event: MouseEvent) => {
			if (
				contextMenuRef.current &&
				event.target instanceof Node &&
				contextMenuRef.current.contains(event.target)
			) {
				return;
			}

			setContextMenu(null);
		};

		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setContextMenu(null);
			}
		};

		const handleWindowBlur = () => {
			setContextMenu(null);
		};

		window.addEventListener('mousedown', handleOutsideMouseDown);
		window.addEventListener('keydown', handleEscape);
		window.addEventListener('blur', handleWindowBlur);

		return () => {
			window.removeEventListener('mousedown', handleOutsideMouseDown);
			window.removeEventListener('keydown', handleEscape);
			window.removeEventListener('blur', handleWindowBlur);
		};
	}, [contextMenu]);

	const handleDragStart = useCallback(
		(index: number) => (e: React.DragEvent) => {
			setDraggingIndex(index);
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', String(index));
		},
		[]
	);

	const handleDragOver = useCallback(
		(index: number) => (e: React.DragEvent) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			setDragOverIndex(index);
		},
		[]
	);

	const handleDragEnd = useCallback(() => {
		setDraggingIndex(null);
		setDragOverIndex(null);
	}, []);

	const handleDrop = useCallback(
		(toIndex: number) => (e: React.DragEvent) => {
			e.preventDefault();
			const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
			if (!isNaN(fromIndex) && fromIndex !== toIndex && onTabReorder) {
				onTabReorder(fromIndex, toIndex);
			}
			setDraggingIndex(null);
			setDragOverIndex(null);
		},
		[onTabReorder]
	);

	const handleContextMenu = useCallback(
		(tabId: string) => (e: React.MouseEvent) => {
			e.preventDefault();
			onTabSelect(tabId);

			const maxX = Math.max(8, window.innerWidth - 220);
			const maxY = Math.max(8, window.innerHeight - 180);
			setContextMenu({
				x: Math.min(e.clientX, maxX),
				y: Math.min(e.clientY, maxY),
				tabId,
			});
		},
		[onTabSelect]
	);

	const handleMenuAction = useCallback(
		(action: () => void) => (event: React.MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			action();
			setContextMenu(null);
		},
		[]
	);

	const canClose = tabs.length > 1;
	const newTabTitle = `New terminal (${process.platform === 'darwin' ? 'Ctrl+Shift+`' : 'Ctrl+Shift+`'})`;
	const contextTabIndex = contextMenu ? tabs.findIndex((tab) => tab.id === contextMenu.tabId) : -1;
	const canCloseTabsRight = contextTabIndex > -1 && contextTabIndex < tabs.length - 1;

	return (
		<>
			<div
				ref={containerRef}
				className="flex items-center border-b overflow-x-auto scrollbar-thin"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					scrollbarWidth: 'thin',
				}}
			>
				{tabs.map((tab, index) => (
					<TerminalTabComponent
						key={tab.id}
						tab={tab}
						index={index}
						isActive={tab.id === activeTabId}
						theme={theme}
						canClose={canClose}
						onSelect={() => onTabSelect(tab.id)}
						onClose={() => onTabClose(tab.id)}
						onMiddleClick={() => canClose && onTabClose(tab.id)}
						onDragStart={handleDragStart(index)}
						onDragOver={handleDragOver(index)}
						onDragEnd={handleDragEnd}
						onDrop={handleDrop(index)}
						isDragging={draggingIndex === index}
						isDragOver={dragOverIndex === index}
						onRename={() => onRequestRename?.(tab.id)}
						onContextMenu={handleContextMenu(tab.id)}
					/>
				))}

				<button
					onClick={onNewTab}
					className="flex items-center justify-center w-8 h-8 opacity-60 hover:opacity-100 transition-opacity shrink-0"
					style={{ color: theme.colors.textDim }}
					title={newTabTitle}
				>
					<Plus className="w-4 h-4" />
				</button>
			</div>

			{contextMenu &&
				createPortal(
					<div
						className="fixed z-[120]"
						style={{ top: contextMenu.y, left: contextMenu.x }}
						onClick={(event) => {
							event.stopPropagation();
						}}
					>
						<div
							ref={contextMenuRef}
							className="min-w-[200px] rounded-md border p-1 shadow-xl"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								borderColor: theme.colors.border,
							}}
						>
							<button
								type="button"
								onClick={handleMenuAction(() => onRequestRename?.(contextMenu.tabId))}
								className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors ${
									onRequestRename ? 'hover:bg-white/10' : 'cursor-default opacity-40'
								}`}
								style={{ color: theme.colors.textMain }}
								disabled={!onRequestRename}
							>
								Rename
							</button>
							<button
								type="button"
								onClick={handleMenuAction(() => onTabClose(contextMenu.tabId))}
								className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors ${
									canClose ? 'hover:bg-white/10' : 'cursor-default opacity-40'
								}`}
								style={{ color: theme.colors.textMain }}
								disabled={!canClose}
							>
								Close
							</button>
							<button
								type="button"
								onClick={handleMenuAction(() => onCloseOtherTabs?.(contextMenu.tabId))}
								className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors ${
									onCloseOtherTabs && canClose ? 'hover:bg-white/10' : 'cursor-default opacity-40'
								}`}
								style={{ color: theme.colors.textMain }}
								disabled={!onCloseOtherTabs || !canClose}
							>
								Close Others
							</button>
							<button
								type="button"
								onClick={handleMenuAction(() => onCloseTabsRight?.(contextMenu.tabId))}
								className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors ${
									onCloseTabsRight && canCloseTabsRight
										? 'hover:bg-white/10'
										: 'cursor-default opacity-40'
								}`}
								style={{ color: theme.colors.textMain }}
								disabled={!onCloseTabsRight || !canCloseTabsRight}
							>
								Close to the Right
							</button>
						</div>
					</div>,
					document.body
				)}
		</>
	);
});
