import React, { memo, useCallback, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { getExplorerFileIcon, getExplorerFolderIcon } from '../../../utils/theme';
import { COLORBLIND_STATUS_COLORS } from '../../../constants/colorblindPalettes';
import type { Session, Theme, FocusArea, FileChangeType } from '../../../types';
import type { FileNode } from '../../../types/fileTree';
import type { FileExplorerIconTheme } from '../../../utils/fileExplorerIcons/shared';
import type { FlattenedNode } from '../types';
import { FILE_TREE_SINGLE_MIME, FILE_TREE_MULTI_MIME } from '../types';
import { parentDirOf } from '../utils/pathHelpers';

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
	isTouchPointer: boolean;
	longPressTimerRef: React.MutableRefObject<number | null>;
	longPressFiredRef: React.MutableRefObject<boolean>;
	lastClickedUnderFilterRef: React.MutableRefObject<string | null>;
	setActiveFocus: (focus: FocusArea) => void;
	handleRowSelectionClick: (e: React.MouseEvent, globalIndex: number, fullPath: string) => void;
	openContextMenuAt: (
		x: number,
		y: number,
		node: FileNode,
		path: string,
		globalIndex: number
	) => void;
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
	onInternalDragStart: (showRootReceptacle: boolean) => void;
	onInternalDragEnd: () => void;
	/**
	 * Option/Alt-drag hook: hand the real file(s) to the OS (Finder/Explorer).
	 * Returns true when it took over the gesture, in which case the row skips its
	 * own HTML5 drag setup.
	 */
	onOsDragOut: (e: React.DragEvent, relSources: string[]) => boolean;
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
	isTouchPointer,
	longPressTimerRef,
	longPressFiredRef,
	lastClickedUnderFilterRef,
	setActiveFocus,
	handleRowSelectionClick,
	openContextMenuAt,
	handleContextMenu,
	handleFolderDragEnter,
	handleFolderDragOver,
	handleFolderDragLeave,
	handleFolderDrop,
	onInternalDragStart,
	onInternalDragEnd,
	onOsDragOut,
	toggleFolder,
	toggleFolderRecursive,
	setSessions,
	handleFileClick,
	onOpenBrowserTabAt,
}: FileTreeRowProps) {
	const longPressSuppressionTimerRef = useRef<number | null>(null);
	const longPressSuppressionCleanupRef = useRef<(() => void) | null>(null);
	const clearLongPressSuppression = useCallback(() => {
		longPressSuppressionCleanupRef.current?.();
		longPressSuppressionCleanupRef.current = null;
	}, []);

	useEffect(() => clearLongPressSuppression, [clearLongPressSuppression]);
	const { node, path: fullPath, depth, globalIndex } = item;
	const absolutePath = `${session.fullPath}/${fullPath}`;
	const isFolder = node.type === 'folder';
	// Match against the full relative path - `path.includes(node.name)` used
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

	const openFile = () => {
		if (isFolder) return;
		const isHtml = /\.html?$/i.test(node.name);
		if (htmlDoubleClickOpensInBrowser && isHtml && !sshRemoteId && onOpenBrowserTabAt) {
			const encodedPath = absolutePath
				.split('/')
				.map((seg) => encodeURIComponent(seg))
				.join('/');
			onOpenBrowserTabAt(`file://${encodedPath}`, { title: node.name });
			return;
		}
		void handleFileClick(node, fullPath, session);
	};

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

	// A row's drop destination: folders accept the move INTO themselves; files
	// route the move into their own parent folder. That makes the whole expanded
	// list of files under a folder a valid drop zone for landing items in that
	// folder, not just the folder header row itself.
	const dropDestRelative = isFolder ? fullPath : parentDirOf(fullPath);
	// Every row whose drop destination is the hovered folder lights up, so the
	// folder header and its child rows read as one contiguous drop area. The
	// header gets the extra dashed outline as the primary target.
	const isInDropGroup = dragOverFolder !== null && dragOverFolder === dropDestRelative;
	const isDropTargetHeader = isInDropGroup && isFolder;

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
				borderLeftColor: isInDropGroup
					? theme.colors.accent
					: isKeyboardSelected
						? theme.colors.accent
						: isMultiSelected
							? theme.colors.accent
							: 'transparent',
				backgroundColor: isInDropGroup
					? `${theme.colors.accent}33`
					: isMultiSelected
						? `${theme.colors.accent}22`
						: isKeyboardSelected
							? theme.colors.bgActivity
							: isSelected
								? 'rgba(255,255,255,0.1)'
								: undefined,
				outline: isDropTargetHeader ? `1px dashed ${theme.colors.accent}` : undefined,
				outlineOffset: isDropTargetHeader ? '-2px' : undefined,
			}}
			draggable
			onDragStart={(e) => {
				// If this row is part of an active multi-selection, drag the whole
				// group; otherwise drag just this row (and collapse selection so
				// it visually matches what's being dragged).
				const currentSelection = selectedPathsRef.current;
				const isPartOfMultiSelection = currentSelection.size > 1 && currentSelection.has(fullPath);
				const sources = isPartOfMultiSelection ? Array.from(currentSelection) : [fullPath];

				// Option/Alt-drag: hand the real file(s) to the OS (Finder/Explorer)
				// via startDrag, which replaces the HTML5 drag. If it takes over, skip
				// all the in-app drag wiring below so move/@mention stays untouched for
				// a plain drag.
				if (onOsDragOut(e, sources)) return;

				if (isPartOfMultiSelection) {
					// Single-path MIME stays populated for the receivers (AI input,
					// existing drop handlers) that don't yet understand the multi MIME.
					e.dataTransfer.setData(FILE_TREE_SINGLE_MIME, fullPath);
					e.dataTransfer.setData(FILE_TREE_MULTI_MIME, JSON.stringify(sources));
				} else {
					if (currentSelection.size > 0) setSelectedPaths(new Set());
					e.dataTransfer.setData(FILE_TREE_SINGLE_MIME, fullPath);
				}
				// Reveal the "move to root" receptacle for the duration of the drag -
				// but only when at least one dragged item lives in a subfolder. Items
				// already at the root have nowhere to go, so the receptacle would be a
				// dead target; suppress it so we don't offer a no-op drop.
				const allSourcesAtRoot = sources.every((p) => parentDirOf(p) === '');
				onInternalDragStart(!allSourcesAtRoot);
				// 'copyMove' so folder-row drop targets can choose 'move' (in-tree
				// reorganisation) while drops on the AI input still default to copy
				// (insert @mention without moving the source file).
				e.dataTransfer.effectAllowed = 'copyMove';
			}}
			onDragEnd={onInternalDragEnd}
			onDragEnter={(e) => handleFolderDragEnter(e, dropDestRelative)}
			onDragOver={(e) => handleFolderDragOver(e, dropDestRelative)}
			onDragLeave={handleFolderDragLeave}
			onDrop={(e) => handleFolderDrop(e, dropDestRelative)}
			onMouseDown={(e) => {
				if (fileTreeFilter.length > 0) {
					e.preventDefault();
				}
			}}
			onTouchStart={(e) => {
				longPressFiredRef.current = false;
				if (longPressTimerRef.current) {
					window.clearTimeout(longPressTimerRef.current);
				}
				const touch = e.touches[0];
				const x = touch.clientX;
				const y = touch.clientY;
				longPressTimerRef.current = window.setTimeout(() => {
					longPressTimerRef.current = null;
					longPressFiredRef.current = true;
					openContextMenuAt(x, y, node, fullPath, globalIndex);
					clearLongPressSuppression();
					const swallow = (ev: Event) => {
						ev.stopPropagation();
						clearLongPressSuppression();
					};
					const removeCaptureListeners = () => {
						document.removeEventListener('mousedown', swallow, true);
						document.removeEventListener('click', swallow, true);
						if (longPressSuppressionTimerRef.current !== null) {
							window.clearTimeout(longPressSuppressionTimerRef.current);
							longPressSuppressionTimerRef.current = null;
						}
					};
					longPressSuppressionCleanupRef.current = removeCaptureListeners;
					document.addEventListener('mousedown', swallow, true);
					document.addEventListener('click', swallow, true);
					longPressSuppressionTimerRef.current = window.setTimeout(clearLongPressSuppression, 1000);
				}, 500);
			}}
			onTouchMove={() => {
				if (longPressTimerRef.current) {
					window.clearTimeout(longPressTimerRef.current);
					longPressTimerRef.current = null;
				}
			}}
			onTouchEnd={() => {
				if (longPressTimerRef.current) {
					window.clearTimeout(longPressTimerRef.current);
					longPressTimerRef.current = null;
				}
			}}
			onTouchCancel={() => {
				if (longPressTimerRef.current) {
					window.clearTimeout(longPressTimerRef.current);
					longPressTimerRef.current = null;
				}
			}}
			onClick={(e) => {
				if (longPressFiredRef.current) {
					longPressFiredRef.current = false;
					return;
				}
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
				} else if (isTouchPointer) {
					openFile();
				}
			}}
			onDoubleClick={() => {
				if (isTouchPointer) return;
				openFile();
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
							// state - let the dot + filename color carry that signal so
							// the icon set stays visually consistent across themes.
							undefined,
							fileExplorerIconTheme,
							colorBlindMode
						)}
			</span>
			{/* Filename. The HoverTooltip reveals the full name on hover, but only
			    when the label is actually clipped by the ellipsis - replaces the
			    native `title=`, which is slow and clipped by the panel's overflow.
			    The trigger span carries the truncation classes so it's the measured
			    element. */}
			<HoverTooltip
				label={node.name}
				theme={theme}
				onlyWhenTruncated
				triggerClassName={`truncate min-w-0 flex-1 ${changeType ? 'font-medium' : ''}`}
				triggerStyle={changeColor ? { color: changeColor } : undefined}
			>
				{node.name}
			</HoverTooltip>
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
