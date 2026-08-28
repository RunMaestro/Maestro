import React, { useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
	Copy,
	ExternalLink,
	FileText,
	Target,
	Globe,
	Edit2,
	Trash2,
	FilePlus,
	FolderPlus,
	FolderOpen,
	Files,
	Download,
	Bot,
	ListPlus,
	Play,
	PlayCircle,
	FileArchive,
} from 'lucide-react';
import { getRevealLabel } from '../../../utils/platformUtils';
import { isMediaFile } from '../../../../shared/mediaTypes';
import { collectPreviewableFiles } from '../utils/pathHelpers';
import type { Theme } from '../../../types';
import type { ContextMenuState } from '../types';

interface FileTreeContextMenuProps {
	theme: Theme;
	contextMenu: ContextMenuState;
	contextMenuRef: React.RefObject<HTMLDivElement>;
	contextMenuPos: { top: number; left: number; ready?: boolean };
	sshRemoteId: string | undefined;
	onFocusFileInGraph?: (relativePath: string) => void;
	onOpenBrowserTabAt?: (url: string, options?: { title?: string }) => void;
	isMultiSelectionContext?: boolean;
	selectedCount?: number;
	/**
	 * How many Auto Run documents the current menu context resolves to - a
	 * folder's subtree, one markdown file, or the whole selection. Zero for
	 * anything outside the agent's Auto Run folder, which hides the staging entry.
	 */
	autoRunStagedCount?: number;
	/** How many of the selected files are playable audio/video. */
	selectedMediaCount?: number;
	onCopyPath: () => void;
	onCopyFileName: () => void;
	onDownloadFile: () => void;
	onOpenInDefaultApp: () => void;
	onOpenInMaestroBrowser: () => void;
	onOpenInExplorer: () => void;
	onOpenNewFile: () => void;
	onOpenNewFolder: () => void;
	onNewAgentHere: () => void;
	onPreviewFile: () => void;
	onPreviewAllInFolder: () => void;
	onStageForAutoRun: () => void;
	onCompressFolder: () => void;
	onPreviewMulti: () => void;
	onQueueMedia: () => void;
	onOpenInDefaultAppMulti: () => void;
	onOpenDeleteMulti: () => void;
	onFocusInGraph: () => void;
	onOpenRename: () => void;
	onOpenDelete: () => void;
}

export function FileTreeContextMenu({
	theme,
	contextMenu,
	contextMenuRef,
	contextMenuPos,
	sshRemoteId,
	onFocusFileInGraph,
	onOpenBrowserTabAt,
	isMultiSelectionContext = false,
	selectedCount = 0,
	selectedMediaCount = 0,
	autoRunStagedCount = 0,
	onCopyPath,
	onCopyFileName,
	onDownloadFile,
	onOpenInDefaultApp,
	onOpenInMaestroBrowser,
	onOpenInExplorer,
	onOpenNewFile,
	onOpenNewFolder,
	onNewAgentHere,
	onPreviewFile,
	onPreviewAllInFolder,
	onStageForAutoRun,
	onCompressFolder,
	onPreviewMulti,
	onQueueMedia,
	onOpenInDefaultAppMulti,
	onOpenDeleteMulti,
	onFocusInGraph,
	onOpenRename,
	onOpenDelete,
}: FileTreeContextMenuProps) {
	// node === null is the empty-space / workspace-root menu (no row under the
	// cursor). It only offers "New Folder", targeting the workspace root.
	const node = contextMenu.node;
	const isRoot = node === null;
	const isFolder = node?.type === 'folder';
	const isFile = node?.type === 'file';
	const nodeName = node?.name.toLowerCase() ?? '';
	// Count previewable files under this folder (recursively, excluding ones that
	// open externally). Drives the dynamic label and lets us hide the option when
	// there's nothing to preview. Reuses the same collector the action runs.
	const previewableCount = useMemo(
		() =>
			node && node.type === 'folder' ? collectPreviewableFiles(node, contextMenu.path).length : 0,
		[node, contextMenu.path]
	);
	const platform = window.maestro?.platform ?? 'unknown';
	const isHtml = isFile && (nodeName.endsWith('.html') || nodeName.endsWith('.htm'));
	const isMarkdown = isFile && (nodeName.endsWith('.md') || nodeName.endsWith('.markdown'));
	// Media plays in the floating player, which only serves local files - over
	// SSH there is nothing to stream, so the playback actions stay hidden.
	const isMedia = isFile && !sshRemoteId && isMediaFile(nodeName);
	const queueableCount = sshRemoteId ? 0 : selectedMediaCount;
	// Same entry in three branches (folder, file, multi-selection): the count is
	// already resolved per context, so the only thing that varies is the label.
	const stageForAutoRunButton =
		autoRunStagedCount > 0 ? (
			<button
				onClick={onStageForAutoRun}
				className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
				style={{ color: theme.colors.textMain }}
			>
				<PlayCircle className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				<span>
					{autoRunStagedCount === 1
						? 'Stage Document for Auto Run'
						: `Stage ${autoRunStagedCount} Documents for Auto Run`}
				</span>
			</button>
		) : null;

	return createPortal(
		<div
			ref={contextMenuRef}
			className="fixed z-[10000] rounded-lg shadow-xl border overflow-hidden whitespace-nowrap"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '180px',
				top: contextMenuPos.top,
				left: contextMenuPos.left,
				opacity: contextMenuPos.ready ? 1 : 0,
			}}
		>
			<div className="p-1">
				{isRoot ? (
					<>
						<button
							onClick={onOpenNewFile}
							className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textMain }}
						>
							<FilePlus className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
							<span>New File</span>
						</button>
						<button
							onClick={onOpenNewFolder}
							className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textMain }}
						>
							<FolderPlus className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
							<span>New Folder</span>
						</button>
					</>
				) : isMultiSelectionContext && selectedCount > 1 ? (
					<>
						<button
							onClick={onPreviewMulti}
							className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textMain }}
						>
							<FileText className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
							<span>Preview {selectedCount} items</span>
						</button>
						{/* Opening the selection already plays the first media file and
						    queues the rest. This is the other half: add everything to the
						    queue and leave what is playing alone. */}
						{queueableCount > 0 && (
							<button
								onClick={onQueueMedia}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								<ListPlus className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
								<span>Add {queueableCount} to Play Queue</span>
							</button>
						)}
						{!sshRemoteId && (
							<button
								onClick={onOpenInDefaultAppMulti}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								<ExternalLink className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
								<span>Open {selectedCount} in Default App</span>
							</button>
						)}
						{stageForAutoRunButton}
						<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
						<button
							onClick={onOpenDeleteMulti}
							className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.error }}
						>
							<Trash2 className="w-3.5 h-3.5" />
							<span>Delete {selectedCount} items</span>
						</button>
					</>
				) : (
					<>
						{/* New File + Preview all - for folders only, top of the menu */}
						{isFolder && (
							<>
								<button
									onClick={onOpenNewFile}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									<FilePlus className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
									<span>New File</span>
								</button>
								<button
									onClick={onOpenNewFolder}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									<FolderPlus className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
									<span>New Folder</span>
								</button>
								{/* New Agent Here - opens the New Agent modal with this folder
								    pre-filled as the working directory. Hidden over SSH: the
								    path is remote, and a fresh agent starts out local, so
								    seeding it would point the new agent at a local path that
								    doesn't exist. */}
								{!sshRemoteId && (
									<button
										onClick={onNewAgentHere}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Bot className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
										<span>New Agent Here</span>
									</button>
								)}
								{previewableCount > 0 && (
									<button
										onClick={onPreviewAllInFolder}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Files className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
										<span>
											Preview All {previewableCount} {previewableCount === 1 ? 'File' : 'Files'} in
											Folder
										</span>
									</button>
								)}
								{stageForAutoRunButton}
								<button
									onClick={onCompressFolder}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									<FileArchive className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
									<span>Compress</span>
								</button>
								<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
							</>
						)}

						{/* New File / New Folder - for files too, so a sibling can be
						    created alongside the file (in its parent dir, i.e. the
						    workspace root for top-level files). Without this there is no
						    way to create a top-level file when the root has no folder to
						    right-click. Mirrors the folder menu's creation actions. */}
						{isFile && (
							<>
								<button
									onClick={onOpenNewFile}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									<FilePlus className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
									<span>New File</span>
								</button>
								<button
									onClick={onOpenNewFolder}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									<FolderPlus className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
									<span>New Folder</span>
								</button>
								<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
							</>
						)}

						{/* Preview option - for files only. Media has no tab to preview, so
						    it says what it actually does: play now, or line up behind
						    whatever is already playing. */}
						{isFile && (
							<button
								onClick={onPreviewFile}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								{isMedia ? (
									<Play className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
								) : (
									<FileText className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
								)}
								<span>{isMedia ? 'Play' : 'Preview'}</span>
							</button>
						)}

						{isMedia && (
							<button
								onClick={onQueueMedia}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								<ListPlus className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
								<span>Add to Play Queue</span>
							</button>
						)}

						{isFile && stageForAutoRunButton}

						{/* Document Graph option - only for markdown files */}
						{isMarkdown && onFocusFileInGraph && (
							<button
								onClick={onFocusInGraph}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								<Target className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
								<span>Document Graph</span>
							</button>
						)}

						{/* Open in Maestro Browser - HTML files only, not over SSH */}
						{isHtml && !sshRemoteId && onOpenBrowserTabAt && (
							<button
								onClick={onOpenInMaestroBrowser}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								<Globe className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
								<span>Open in Maestro Browser</span>
							</button>
						)}

						{/* Open in Default App option - for files only, not available over SSH */}
						{isFile && !sshRemoteId && (
							<button
								onClick={onOpenInDefaultApp}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								<ExternalLink className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
								<span>Open in Default App</span>
							</button>
						)}

						{/* Download File option - remote files only; the local counterpart is
						    "Reveal in Finder" / "Open in Default App", which act on the file
						    already on disk. Remote files must be pulled down over SSH first. */}
						{isFile && sshRemoteId && (
							<button
								onClick={onDownloadFile}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								<Download className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
								<span>Download File</span>
							</button>
						)}

						{/* Divider after preview/graph options if any were shown */}
						{isFile && (
							<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
						)}

						{/* Copy Path option */}
						<button
							onClick={onCopyPath}
							className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textMain }}
						>
							<Copy className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
							<span>Copy Path</span>
						</button>

						{/* Copy File Name option - just the leaf name, no directory */}
						<button
							onClick={onCopyFileName}
							className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textMain }}
						>
							<FileText className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
							<span>Copy File Name</span>
						</button>

						{/* Reveal in Finder / Explorer - local-only, hidden over SSH */}
						{!sshRemoteId && (
							<button
								onClick={onOpenInExplorer}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								<FolderOpen className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								<span>{getRevealLabel(platform)}</span>
							</button>
						)}

						{/* Divider before destructive actions */}
						<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />

						{/* Rename option */}
						<button
							onClick={onOpenRename}
							className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textMain }}
						>
							<Edit2 className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
							<span>Rename</span>
						</button>

						{/* Delete option */}
						<button
							onClick={onOpenDelete}
							className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.error }}
						>
							<Trash2 className="w-3.5 h-3.5" />
							<span>Delete</span>
						</button>
					</>
				)}
			</div>
		</div>,
		document.body
	);
}
