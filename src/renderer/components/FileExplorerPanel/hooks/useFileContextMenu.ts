import { useCallback, useRef, useState } from 'react';
import type { Session, Theme } from '../../../types';
import type { FileNode } from '../../../types/fileTree';
import { useClickOutside } from '../../../hooks/ui/useClickOutside';
import { useContextMenuPosition } from '../../../hooks/ui/useContextMenuPosition';
import { useEventListener } from '../../../hooks/utils/useEventListener';
import { useModalStore } from '../../../stores/modalStore';
import { safeClipboardWrite } from '../../../utils/clipboard';
import { captureException } from '../../../utils/sentry';
import { shouldOpenExternally } from '../../../utils/fileExplorer';
import type { ContextMenuState, MultiDeleteModalState } from '../types';
import { PREVIEW_ALL_CONFIRM_THRESHOLD } from '../types';
import { collectPreviewableFiles, findNodeAtPath } from '../utils/pathHelpers';
import type { FileTreeChanges } from '../../../utils/fileExplorer';

interface UseFileContextMenuArgs {
	session: Session;
	theme: Theme;
	onShowFlash?: (msg: string) => void;
	onFocusFileInGraph?: (relativePath: string) => void;
	onOpenBrowserTabAt?: (url: string, options?: { title?: string }) => void;
	handleFileClick: (node: FileNode, path: string, activeSession: Session) => Promise<void>;
	openRenameModal: (node: FileNode, path: string) => void;
	openDeleteModal: (node: FileNode, path: string) => Promise<void>;
	openNewFileModal: (parentFolderPath: string, parentFolderAbsolutePath: string) => void;
	openNewFolderModal: (parentFolderPath: string, parentFolderAbsolutePath: string) => void;
	setSelectedFileIndex: (n: number) => void;
	selectedPathsRef: React.MutableRefObject<Set<string>>;
	setSelectedPaths: React.Dispatch<React.SetStateAction<Set<string>>>;
	refreshFileTree: (
		sessionId: string,
		options?: { maxEntriesOverride?: number }
	) => Promise<FileTreeChanges | undefined>;
	sshRemoteId: string | undefined;
}

interface UseFileContextMenuResult {
	contextMenu: ContextMenuState | null;
	multiDeleteModal: MultiDeleteModalState | null;
	isMultiDeleting: boolean;
	contextMenuRef: React.RefObject<HTMLDivElement>;
	contextMenuPos: { top: number; left: number; ready?: boolean };
	openContextMenuAt: (
		x: number,
		y: number,
		node: FileNode,
		path: string,
		globalIndex: number
	) => void;
	openContextMenu: (e: React.MouseEvent, node: FileNode, path: string, globalIndex: number) => void;
	openRootContextMenu: (e: React.MouseEvent) => void;
	closeContextMenu: () => void;
	handleCopyPath: () => void;
	handleCopyFileName: () => void;
	handleDownloadFile: () => Promise<void>;
	handleOpenInDefaultApp: () => void;
	handleOpenInMaestroBrowser: () => void;
	handleOpenInExplorer: () => void;
	handleOpenNewFile: () => void;
	handleOpenNewFolder: () => void;
	handleOpenRename: () => void;
	handleOpenDelete: () => Promise<void>;
	handleFocusInGraph: () => void;
	handlePreviewFile: () => Promise<void>;
	handlePreviewAllInFolder: () => void;
	handlePreviewMulti: () => Promise<void>;
	handleOpenInDefaultAppMulti: () => void;
	handleOpenDeleteMulti: () => void;
	handleDeleteMulti: () => Promise<void>;
	closeMultiDeleteModal: () => void;
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === 'ENOENT'
	);
}

export function useFileContextMenu({
	session,
	onShowFlash,
	onFocusFileInGraph,
	onOpenBrowserTabAt,
	handleFileClick,
	openRenameModal,
	openDeleteModal,
	openNewFileModal,
	openNewFolderModal,
	setSelectedFileIndex,
	selectedPathsRef,
	setSelectedPaths,
	refreshFileTree,
	sshRemoteId,
}: UseFileContextMenuArgs): UseFileContextMenuResult {
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	const [multiDeleteModal, setMultiDeleteModal] = useState<MultiDeleteModalState | null>(null);
	const [isMultiDeleting, setIsMultiDeleting] = useState(false);
	const contextMenuRef = useRef<HTMLDivElement>(null);
	const contextMenuPos = useContextMenuPosition(
		contextMenuRef,
		contextMenu?.x ?? 0,
		contextMenu?.y ?? 0
	);

	useClickOutside(
		contextMenuRef,
		() => {
			setContextMenu(null);
		},
		contextMenu !== null
	);

	// Close context menu on Escape key (only attached while the menu is open).
	useEventListener(
		'keydown',
		(e) => {
			if ((e as KeyboardEvent).key === 'Escape') {
				setContextMenu(null);
			}
		},
		{ enabled: contextMenu !== null }
	);

	const openContextMenuAt = useCallback(
		(x: number, y: number, node: FileNode, path: string, globalIndex: number) => {
			setSelectedFileIndex(globalIndex);
			if (selectedPathsRef.current.size > 0 && !selectedPathsRef.current.has(path)) {
				setSelectedPaths(new Set());
			}
			setContextMenu({ x, y, node, path });
		},
		[setSelectedFileIndex, selectedPathsRef, setSelectedPaths]
	);

	const openContextMenu = useCallback(
		(e: React.MouseEvent, node: FileNode, path: string, globalIndex: number) => {
			e.preventDefault();
			e.stopPropagation();
			openContextMenuAt(e.clientX, e.clientY, node, path, globalIndex);
		},
		[openContextMenuAt]
	);

	// Right-click on the panel's empty space (no row under the cursor). Opens a
	// minimal root menu (node === null, path === '') whose only action creates a
	// folder in the workspace root.
	const openRootContextMenu = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (selectedPathsRef.current.size > 0) {
				setSelectedPaths(new Set());
			}
			setContextMenu({ x: e.clientX, y: e.clientY, node: null, path: '' });
		},
		[selectedPathsRef, setSelectedPaths]
	);

	const closeContextMenu = useCallback(() => setContextMenu(null), []);

	const handleFocusInGraph = useCallback(() => {
		if (contextMenu && onFocusFileInGraph) {
			onFocusFileInGraph(contextMenu.path);
		}
		setContextMenu(null);
	}, [contextMenu, onFocusFileInGraph]);

	const handlePreviewFile = useCallback(async () => {
		const menu = contextMenu;
		try {
			if (menu && menu.node && menu.node.type === 'file') {
				await handleFileClick(menu.node, menu.path, session);
			}
		} catch (error) {
			if (isMissingFileError(error)) {
				onShowFlash?.(`File not found: "${menu?.node?.name ?? 'Unknown file'}"`);
				return;
			}
			captureException(error, {
				extra: {
					action: 'preview',
					path: menu?.path,
					nodeName: menu?.node?.name,
					nodeType: menu?.node?.type,
					sessionId: session.id,
				},
			});
			throw error;
		} finally {
			setContextMenu(null);
		}
	}, [contextMenu, handleFileClick, session, onShowFlash]);

	const handlePreviewAllInFolder = useCallback(() => {
		const menu = contextMenu;
		try {
			if (!menu || !menu.node || menu.node.type !== 'folder') {
				return;
			}
			const folderNode = menu.node;
			const folderPath = menu.path;

			const files = collectPreviewableFiles(folderNode, folderPath);
			if (files.length === 0) {
				onShowFlash?.(`No previewable files in "${folderNode.name}"`);
				return;
			}

			const openAll = async () => {
				try {
					for (const file of files) {
						await handleFileClick(file.node, file.path, session);
					}
					onShowFlash?.(
						`Opened ${files.length} file${files.length !== 1 ? 's' : ''} from "${folderNode.name}"`
					);
				} catch (error) {
					if (isMissingFileError(error)) {
						onShowFlash?.(`A file in "${folderNode.name}" was no longer available`);
						return;
					}
					captureException(error, {
						extra: {
							action: 'preview-all',
							path: folderPath,
							nodeName: folderNode.name,
							nodeType: folderNode.type,
							sessionId: session.id,
						},
					});
					throw error;
				}
			};

			if (files.length > PREVIEW_ALL_CONFIRM_THRESHOLD) {
				useModalStore.getState().openModal('confirm', {
					message: `Preview all ${files.length} files under "${folderNode.name}"? This opens a tab for each file.`,
					onConfirm: () => void openAll(),
				});
				return;
			}
			void openAll();
		} finally {
			setContextMenu(null);
		}
	}, [contextMenu, handleFileClick, session, onShowFlash]);

	const resolveSelectedNodes = useCallback((): { node: FileNode; path: string }[] => {
		const result: { node: FileNode; path: string }[] = [];
		for (const path of selectedPathsRef.current) {
			const node = findNodeAtPath(session.fileTree, path);
			if (node) result.push({ node, path });
		}
		return result;
	}, [selectedPathsRef, session.fileTree]);

	const handlePreviewMulti = useCallback(async () => {
		const selectedNodes = resolveSelectedNodes();
		setContextMenu(null);

		const previewable = selectedNodes.filter(
			({ node }) => node.type === 'file' && !shouldOpenExternally(node.name)
		);
		if (previewable.length === 0) {
			onShowFlash?.('No previewable files in selection');
			return;
		}

		const openAll = async () => {
			try {
				for (const file of previewable) {
					await handleFileClick(file.node, file.path, session);
				}
				onShowFlash?.(`Opened ${previewable.length} file${previewable.length !== 1 ? 's' : ''}`);
			} catch (error) {
				if (isMissingFileError(error)) {
					onShowFlash?.('A selected file was no longer available');
					return;
				}
				captureException(error, {
					extra: {
						action: 'preview-multi',
						paths: previewable.map((file) => file.path),
						sessionId: session.id,
					},
				});
				throw error;
			}
		};

		if (previewable.length > PREVIEW_ALL_CONFIRM_THRESHOLD) {
			useModalStore.getState().openModal('confirm', {
				message: `Preview all ${previewable.length} selected files? This opens a tab for each file.`,
				onConfirm: () => void openAll(),
			});
			return;
		}
		await openAll();
	}, [resolveSelectedNodes, handleFileClick, session, onShowFlash]);

	const handleOpenInDefaultAppMulti = useCallback(() => {
		const selectedNodes = resolveSelectedNodes();
		setContextMenu(null);

		const files = selectedNodes.filter(({ node }) => node.type === 'file');
		if (files.length === 0) {
			onShowFlash?.('No files in selection');
			return;
		}

		const openAll = () => {
			for (const file of files) {
				const absolutePath = `${session.fullPath}/${file.path}`;
				void window.maestro?.shell?.openPath(absolutePath);
			}
			onShowFlash?.(`Opened ${files.length} file${files.length !== 1 ? 's' : ''}`);
		};

		if (files.length > PREVIEW_ALL_CONFIRM_THRESHOLD) {
			useModalStore.getState().openModal('confirm', {
				message: `Open all ${files.length} selected files in their default apps?`,
				onConfirm: () => openAll(),
			});
			return;
		}
		openAll();
	}, [resolveSelectedNodes, session.fullPath, onShowFlash]);

	const handleOpenDeleteMulti = useCallback(() => {
		const nodes = resolveSelectedNodes();
		setContextMenu(null);
		if (nodes.length === 0) return;
		setMultiDeleteModal({ nodes });
	}, [resolveSelectedNodes]);

	const closeMultiDeleteModal = useCallback(() => {
		if (isMultiDeleting) return;
		setMultiDeleteModal(null);
	}, [isMultiDeleting]);

	const handleDeleteMulti = useCallback(async () => {
		if (!multiDeleteModal) return;

		setIsMultiDeleting(true);
		let succeeded = 0;
		let failed = 0;
		let lastError: unknown = null;

		try {
			for (const item of multiDeleteModal.nodes) {
				const absolutePath = `${session.fullPath}/${item.path}`;
				try {
					await window.maestro.fs.delete(absolutePath, { sshRemoteId });
					succeeded++;
				} catch (error) {
					failed++;
					lastError = error;
					captureException(error, {
						extra: {
							action: 'delete-multi',
							path: item.path,
							absolutePath,
							nodeName: item.node.name,
							nodeType: item.node.type,
							sessionId: session.id,
							sshRemoteId,
						},
					});
				}
			}

			await refreshFileTree(session.id);
			if (succeeded > 0 && failed === 0) {
				onShowFlash?.(`Deleted ${succeeded} item${succeeded !== 1 ? 's' : ''}`);
			} else if (succeeded > 0 && failed > 0) {
				onShowFlash?.(`Deleted ${succeeded}, ${failed} failed`);
			} else if (failed > 0) {
				const msg = lastError instanceof Error ? lastError.message : 'Unknown error';
				onShowFlash?.(`Delete failed: ${msg}`);
			}
		} catch (error) {
			captureException(error, {
				extra: {
					action: 'delete-multi-refresh',
					sessionId: session.id,
				},
			});
			onShowFlash?.(
				`Delete refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
			throw error;
		} finally {
			setSelectedPaths(new Set());
			setMultiDeleteModal(null);
			setIsMultiDeleting(false);
		}
	}, [
		multiDeleteModal,
		session.fullPath,
		session.id,
		sshRemoteId,
		refreshFileTree,
		setSelectedPaths,
		onShowFlash,
	]);

	const handleCopyPath = useCallback(() => {
		if (contextMenu) {
			const absolutePath = `${session.fullPath}/${contextMenu.path}`;
			safeClipboardWrite(absolutePath);
		}
		setContextMenu(null);
	}, [contextMenu, session.fullPath]);

	const handleCopyFileName = useCallback(() => {
		if (contextMenu) {
			// `node.name` is the leaf for both files and folders; fall back to the
			// path's basename for the rare case node is absent.
			const name = contextMenu.node?.name ?? contextMenu.path.split('/').pop() ?? '';
			if (name) safeClipboardWrite(name);
		}
		setContextMenu(null);
	}, [contextMenu]);

	// Download a remote SSH file to a user-chosen local location. Only wired up
	// for remote sessions (the menu item is hidden when sshRemoteId is undefined);
	// local files are already on disk and use "Reveal in Finder" instead.
	const handleDownloadFile = useCallback(async () => {
		const menu = contextMenu;
		setContextMenu(null);
		if (!menu || !menu.node || menu.node.type !== 'file' || !sshRemoteId) return;

		const remotePath = `${session.fullPath}/${menu.path}`;
		const fileName = menu.node.name;
		try {
			const destPath = await window.maestro.dialog.saveFile({
				defaultPath: fileName,
				title: 'Download File',
			});
			// User cancelled the save dialog.
			if (!destPath) return;

			await window.maestro.fs.downloadRemoteFile(remotePath, sshRemoteId, destPath);
			onShowFlash?.(`Downloaded "${fileName}"`);
		} catch (error) {
			captureException(error, {
				extra: {
					action: 'download-remote-file',
					path: menu.path,
					remotePath,
					nodeName: fileName,
					sessionId: session.id,
					sshRemoteId,
				},
			});
			onShowFlash?.(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}, [contextMenu, session.fullPath, session.id, sshRemoteId, onShowFlash]);

	const handleOpenInDefaultApp = useCallback(() => {
		if (contextMenu) {
			const absolutePath = `${session.fullPath}/${contextMenu.path}`;
			window.maestro?.shell?.openPath(absolutePath);
		}
		setContextMenu(null);
	}, [contextMenu, session.fullPath]);

	const handleOpenInMaestroBrowser = useCallback(() => {
		if (contextMenu && contextMenu.node && contextMenu.node.type === 'file' && onOpenBrowserTabAt) {
			const absolutePath = `${session.fullPath}/${contextMenu.path}`;
			const normalizedPath = absolutePath.replace(/\\/g, '/');
			const isWindowsDrivePath = /^[A-Za-z]:/.test(normalizedPath);
			const pathForUrl = isWindowsDrivePath ? `/${normalizedPath}` : normalizedPath;
			const encodedPath = pathForUrl
				.split('/')
				.map((seg, index) => (isWindowsDrivePath && index === 1 ? seg : encodeURIComponent(seg)))
				.join('/');
			const url = pathForUrl.startsWith('/') ? `file://${encodedPath}` : `file:///${encodedPath}`;
			onOpenBrowserTabAt(url, { title: contextMenu.node.name });
		}
		setContextMenu(null);
	}, [contextMenu, onOpenBrowserTabAt, session.fullPath]);

	const handleOpenInExplorer = useCallback(() => {
		if (contextMenu) {
			const absolutePath = `${session.fullPath}/${contextMenu.path}`;
			window.maestro?.shell?.showItemInFolder(absolutePath);
		}
		setContextMenu(null);
	}, [contextMenu, session.fullPath]);

	// Resolve the folder that a "New File"/"New Folder" action should target from
	// the current menu context. A folder row creates inside that folder; a file
	// row or the empty-space root menu creates alongside it (the parent dir, which
	// is '' / the workspace root for top-level files and empty space).
	const resolveCreateParent = useCallback((): {
		parentPath: string;
		parentAbsolutePath: string;
	} | null => {
		if (!contextMenu) return null;
		const { node, path } = contextMenu;
		const parentPath =
			node && node.type === 'folder'
				? path
				: path.includes('/')
					? path.slice(0, path.lastIndexOf('/'))
					: '';
		const parentAbsolutePath = parentPath ? `${session.fullPath}/${parentPath}` : session.fullPath;
		return { parentPath, parentAbsolutePath };
	}, [contextMenu, session.fullPath]);

	const handleOpenNewFile = useCallback(() => {
		const target = resolveCreateParent();
		if (target) {
			openNewFileModal(target.parentPath, target.parentAbsolutePath);
		}
		setContextMenu(null);
	}, [resolveCreateParent, openNewFileModal]);

	const handleOpenNewFolder = useCallback(() => {
		const target = resolveCreateParent();
		if (target) {
			openNewFolderModal(target.parentPath, target.parentAbsolutePath);
		}
		setContextMenu(null);
	}, [resolveCreateParent, openNewFolderModal]);

	const handleOpenRename = useCallback(() => {
		if (contextMenu && contextMenu.node) {
			openRenameModal(contextMenu.node, contextMenu.path);
		}
		setContextMenu(null);
	}, [contextMenu, openRenameModal]);

	const handleOpenDelete = useCallback(async () => {
		if (contextMenu && contextMenu.node) {
			await openDeleteModal(contextMenu.node, contextMenu.path);
		}
		setContextMenu(null);
	}, [contextMenu, openDeleteModal]);

	return {
		contextMenu,
		multiDeleteModal,
		isMultiDeleting,
		contextMenuRef,
		contextMenuPos,
		openContextMenuAt,
		openContextMenu,
		openRootContextMenu,
		closeContextMenu,
		handleCopyPath,
		handleCopyFileName,
		handleDownloadFile,
		handleOpenInDefaultApp,
		handleOpenInMaestroBrowser,
		handleOpenInExplorer,
		handleOpenNewFile,
		handleOpenNewFolder,
		handleOpenRename,
		handleOpenDelete,
		handleFocusInGraph,
		handlePreviewFile,
		handlePreviewAllInFolder,
		handlePreviewMulti,
		handleOpenInDefaultAppMulti,
		handleOpenDeleteMulti,
		handleDeleteMulti,
		closeMultiDeleteModal,
	};
}
