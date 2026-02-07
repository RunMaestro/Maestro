/**
 * TerminalTabBar - Tab bar for managing multiple terminal tabs
 *
 * Similar to TabBar.tsx but simplified for terminal needs:
 * - No star/unread functionality
 * - No context menu (merge, send to agent, etc.)
 * - Simpler display names (Terminal 1, Terminal 2, or custom name)
 * - Shows shell type indicator
 * - Shows exit code if terminal exited
 */

import React, { useState, useRef, useCallback, memo } from 'react';
import { X, Plus, Terminal as TerminalIcon } from 'lucide-react';
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
}: TerminalTabProps) {
	const displayName = getTerminalTabDisplayName(tab, index);
	const isExited = tab.state === 'exited';
	const isBusy = tab.state === 'busy';

	return (
		<div
			draggable
			onDragStart={onDragStart}
			onDragOver={onDragOver}
			onDragEnd={onDragEnd}
			onDrop={onDrop}
			onClick={onSelect}
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

			<span className="truncate max-w-[120px]">{displayName}</span>

			<span className="text-[10px] uppercase opacity-70">{tab.shellType}</span>

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
}: TerminalTabBarProps) {
	const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
	const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

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

	const canClose = tabs.length > 1;
	const newTabTitle = `New terminal (${process.platform === 'darwin' ? 'Ctrl+Shift+`' : 'Ctrl+Shift+`'})`;

	return (
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
	);
});
