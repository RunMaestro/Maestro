import React, { memo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { getExplorerFileIcon, getExplorerFolderIcon } from '../../../utils/theme';
import { COLORBLIND_STATUS_COLORS } from '../../../constants/colorblindPalettes';
import type { Session, Theme, FocusArea, FileChangeType } from '../../../types';
import type { FileNode } from '../../../types/fileTree';
import type { FileExplorerIconTheme } from '../../../utils/fileExplorerIcons/shared';
import type { FlattenedNode } from '../types';
import { FILE_TREE_SINGLE_MIME, FILE_TREE_MULTI_MIME } from '../types';

interface VirtualRow {
	index: number;
	start: number;
	size: number;
}

interface FileTreeRowProps {
	item: FlattenedNode;
	virtualRow: VirtualRow;
	session: Session;
	theme: Theme;
	activeFocus: FocusArea;
	activeRightTab: string;
	selectedFileIndex: number;
	changeMap: Map<string, FileChangeType>;
	changedAncestors: Set<string>;
	colorBlindMode: boolean;
	dragOverFolder: string | null;
	selectedPaths: Set<string>;
	selectedPathsRef: React.MutableRefObject<Set<string>>;
	setSelectedPaths: React.Dispatch<React.SetStateAction<Set<string>>>;
	fileExplorerIconTheme: FileExplorerIconTheme;
	fileTreeFilter: string;
	htmlDoubleClickOpensInBrowser: boolean;
	sshRemoteId: string | undefined;
	lastClickedUnderFilterRef: React.MutableRefObject<string | null>;
	setActiveFocus: (focus: FocusArea) => void;
	handleRowSelectionClick: (e: React.MouseEvent, globalIndex: number, fullPath: string) => void;
	handleContextMenu: (
		e: React.MouseEvent,
		node: FileNode,
		path: string,
		globalIndex: number
	) => void;
	handleFolderDragEnter: (e: React.DragEvent, destFolderRelative: string) => void;
	handleFolderDragOver: (e: React.DragEvent, destFolderRelative: string) => void;
	handleFolderDragLeave: (e: React.DragEvent) => void;
	handleFolderDrop: (e: React.DragEvent, destFolderRelative: string) => void;
	toggleFolder: (
		path: string,
		activeSessionId: string,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => void;
	toggleFolderRecursive: (
		path: string,
		activeSessionId: string,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => void;
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	handleFileClick: (node: FileNode, path: string, activeSession: Session) => Promise<void>;
	onOpenBrowserTabAt?: (url: string, options?: { title?: string }) => void;
}

export const FileTreeRow = memo(function FileTreeRow({
	item,
	virtualRow,
	session,
	theme,
	activeFocus,
	activeRightTab,
	selectedFileIndex,
	changeMap,
	changedAncestors,
	colorBlindMode,
	dragOverFolder,
	selectedPaths,
	selectedPathsRef,
	setSelectedPaths,
	fileExplorerIconTheme,
	fileTreeFilter,
	htmlDoubleClickOpensInBrowser,
	sshRemoteId,
	lastClickedUnderFilterRef,
	setActiveFocus,
	handleRowSelectionClick,
	handleContextMenu,
	handleFolderDragEnter,
	handleFolderDragOver,
	handleFolderDragLeave,
	handleFolderDrop,
	toggleFolder,
	toggleFolderRecursive,
	setSessions,
	handleFileClick,
	onOpenBrowserTabAt,
}: FileTreeRowProps) {
	const { node, path: fullPath, depth, globalIndex } = item;
	const absolutePath = `${session.fullPath}/${fullPath}`;
	const isFolder = node.type === 'folder';
	// Match against the full relative path — `path.includes(node.name)` used
	// to false-match files with identical leaf names. (#611)
	const changeType: FileChangeType | undefined = isFolder ? undefined : changeMap.get(fullPath);
	// Folders highlight when any descendant is changed (VSCode-style walk).
	const folderHasChange = isFolder && changedAncestors.has(fullPath);
	const hasChange = !!changeType || folderHasChange;
	// Use the colorblind-safe status palette (teal/orange/vermillion) when
	// the user has enabled colorBlindMode, mirroring how the default file
	// icon already swaps its tint via the same palette. Keeps the dot
	// distinguishable for protanopia/deuteranopia/tritanopia.
	const successColor = colorBlindMode ? COLORBLIND_STATUS_COLORS.success : theme.colors.success;
	const warningColor = colorBlindMode ? COLORBLIND_STATUS_COLORS.warning : theme.colors.warning;
	const errorColor = colorBlindMode ? COLORBLIND_STATUS_COLORS.error : theme.colors.error;
	const changeColor =
		changeType === 'added'
			? successColor
			: changeType === 'deleted'
				? errorColor
				: changeType === 'modified'
					? warningColor
					: undefined;
	const expandedSet = new Set(session.fileExplorerExpanded || []);
	const isExpanded = expandedSet.has(fullPath);
	// Check active file tab for selection highlighting
	const activeFileTabPath = session.activeFileTabId
		? session.filePreviewTabs?.find((t) => t.id === session.activeFileTabId)?.path
		: undefined;
	const isSelected = activeFileTabPath === absolutePath;
	const isKeyboardSelected =
		activeFocus === 'right' && activeRightTab === 'files' && globalIndex === selectedFileIndex;
	const isMultiSelected = selectedPaths.has(fullPath);

	// Generate indent guides for each depth level
	const indentGuides = [];
	for (let i = 0; i < depth; i++) {
		indentGuides.push(
			<div
				key={i}
				className="absolute top-0 bottom-0 w-px"
				style={{
					left: `${12 + i * 20}px`,
					backgroundColor: theme.colors.border,
				}}
			/>
		);
	}

	const isDropTarget = isFolder && dragOverFolder === fullPath;

	return (
		<div
			key={fullPath}
			data-file-index={globalIndex}
			title={isFolder ? 'Alt/Option+click to expand or collapse all subfolders' : undefined}
			className={`absolute top-0 left-0 w-full flex items-center gap-2 py-1 text-xs cursor-pointer hover:bg-white/5 px-2 rounded transition-colors border-l-2 select-none min-w-0 ${isSelected ? 'bg-white/10' : ''}`}
			style={{
				height: `${virtualRow.size}px`,
				transform: `translateY(${virtualRow.start}px)`,
				paddingLeft: `${8 + depth * 20}px`,
				color: hasChange ? theme.colors.textMain : theme.colors.textDim,
				borderLeftColor: isDropTarget
					? theme.colors.accent
					: isKeyboardSelected
						? theme.colors.accent
						: isMultiSelected
							? theme.colors.accent
							: 'transparent',
				backgroundColor: isDropTarget
					? `${theme.colors.accent}33`
					: isMultiSelected
						? `${theme.colors.accent}22`
						: isKeyboardSelected
							? theme.colors.bgActivity
							: isSelected
								? 'rgba(255,255,255,0.1)'
								: undefined,
				outline: isDropTarget ? `1px dashed ${theme.colors.accent}` : undefined,
				outlineOffset: isDropTarget ? '-2px' : undefined,
			}}
			draggable
			onDragStart={(e) => {
				// If this row is part of an active multi-selection, drag the whole
				// group; otherwise drag just this row (and collapse selection so
				// it visually matches what's being dragged).
				const currentSelection = selectedPathsRef.current;
				const isPartOfMultiSelection = currentSelection.size > 1 && currentSelection.has(fullPath);
				if (isPartOfMultiSelection) {
					const paths = Array.from(currentSelection);
					// Single-path MIME stays populated for the receivers (AI input,
					// existing drop handlers) that don't yet understand the multi MIME.
					e.dataTransfer.setData(FILE_TREE_SINGLE_MIME, fullPath);
					e.dataTransfer.setData(FILE_TREE_MULTI_MIME, JSON.stringify(paths));
				} else {
					if (currentSelection.size > 0) setSelectedPaths(new Set());
					e.dataTransfer.setData(FILE_TREE_SINGLE_MIME, fullPath);
				}
				// 'copyMove' so folder-row drop targets can choose 'move' (in-tree
				// reorganisation) while drops on the AI input still default to copy
				// (insert @mention without moving the source file).
				e.dataTransfer.effectAllowed = 'copyMove';
			}}
			onDragEnter={isFolder ? (e) => handleFolderDragEnter(e, fullPath) : undefined}
			onDragOver={isFolder ? (e) => handleFolderDragOver(e, fullPath) : undefined}
			onDragLeave={isFolder ? handleFolderDragLeave : undefined}
			onDrop={isFolder ? (e) => handleFolderDrop(e, fullPath) : undefined}
			onMouseDown={(e) => {
				if (fileTreeFilter.length > 0) {
					e.preventDefault();
				}
			}}
			onClick={(e) => {
				if (fileTreeFilter.length > 0) {
					lastClickedUnderFilterRef.current = fullPath;
				}
				if (fileTreeFilter.length === 0) {
					setActiveFocus('right');
				}
				const isSelectionModifier = e.shiftKey || e.metaKey || e.ctrlKey;
				if (isSelectionModifier) {
					handleRowSelectionClick(e, globalIndex, fullPath);
					return;
				}
				handleRowSelectionClick(e, globalIndex, fullPath);
				if (isFolder) {
					if (e.altKey) {
						toggleFolderRecursive(fullPath, session.id, setSessions);
					} else {
						toggleFolder(fullPath, session.id, setSessions);
					}
				}
			}}
			onDoubleClick={() => {
				if (isFolder) return;
				// Optional shortcut: HTML files can default to opening in the
				// Maestro browser instead of the preview. SSH skips this (file://
				// can't reach the remote host); the right-click menu still offers
				// both paths regardless of the setting.
				const isHtml = /\.html?$/i.test(node.name);
				if (htmlDoubleClickOpensInBrowser && isHtml && !sshRemoteId && onOpenBrowserTabAt) {
					const encodedPath = absolutePath
						.split('/')
						.map((seg) => encodeURIComponent(seg))
						.join('/');
					onOpenBrowserTabAt(`file://${encodedPath}`, { title: node.name });
					return;
				}
				handleFileClick(node, fullPath, session);
			}}
			onContextMenu={(e) => handleContextMenu(e, node, fullPath, globalIndex)}
		>
			{indentGuides}
			{isFolder &&
				(isExpanded ? (
					<ChevronDown className="w-3 h-3 flex-shrink-0" />
				) : (
					<ChevronRight className="w-3 h-3 flex-shrink-0" />
				))}
			<span className="flex-shrink-0">
				{isFolder
					? getExplorerFolderIcon(node.name, isExpanded, theme, fileExplorerIconTheme)
					: getExplorerFileIcon(
							node.name,
							theme,
							// Per #611 follow-up: don't tint the icon based on change
							// state — let the dot + filename color carry that signal so
							// the icon set stays visually consistent across themes.
							undefined,
							fileExplorerIconTheme,
							colorBlindMode
						)}
			</span>
			<span
				className={`truncate min-w-0 flex-1 ${changeType ? 'font-medium' : ''}`}
				title={node.name}
				style={changeColor ? { color: changeColor } : undefined}
			>
				{node.name}
			</span>
			{hasChange && (
				<span
					data-testid="git-change-indicator"
					data-change-type={changeType ?? 'descendant'}
					aria-label={changeType ? `${changeType} file` : 'contains changed files'}
					title={changeType ?? 'contains changed files'}
					className="flex-shrink-0 inline-block w-2 h-2 rounded-full"
					style={{
						backgroundColor: changeColor ?? theme.colors.textDim,
						opacity: changeType ? 1 : 0.55,
					}}
				/>
			)}
		</div>
	);
});
