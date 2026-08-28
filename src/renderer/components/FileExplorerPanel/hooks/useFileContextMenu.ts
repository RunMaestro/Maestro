import { useCallback, useMemo, useRef, useState } from 'react';
import type { Session, Theme } from '../../../types';
import type { FileNode } from '../../../types/fileTree';
import type { FileClickOptions } from '../../../hooks/ui/useAppHandlers';
import { isMediaFile } from '../../../../shared/mediaTypes';
import { useClickOutside } from '../../../hooks/ui/useClickOutside';
import { useContextMenuPosition } from '../../../hooks/ui/useContextMenuPosition';
import { useEventListener } from '../../../hooks/utils/useEventListener';
import { getModalActions, useModalStore } from '../../../stores/modalStore';
import { useBatchStore } from '../../../stores/batchStore';
import { useFileExplorerStore } from '../../../stores/fileExplorerStore';
import { notifyToast } from '../../../stores/notificationStore';
import { safeClipboardWrite } from '../../../utils/clipboard';
import {
	autoRunDocIdForFile,
	collectAutoRunDocsInFolder,
	relativeToAutoRunFolder,
} from '../../../utils/autoRunStaging';
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
	handleFileClick: (node: FileNode, path: string, options?: FileClickOptions) => Promise<void>;
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
	handleCompressFolder: () => Promise<void>;
	handleOpenRename: () => void;
	handleOpenDelete: () => Promise<void>;
	handleFocusInGraph: () => void;
	handleGraphFolder: () => void;
	handleGraphSelection: () => void;
	/**
	 * Auto Run documents the current menu context resolves to - a folder's whole
	 * subtree, one markdown file, or a multi-selection. Empty when nothing under
	 * the cursor lives in the agent's Auto Run folder.
	 */
	autoRunStagedDocs: string[];
	handleStageForAutoRun: () => void;
	handlePreviewFile: () => Promise<void>;
	handlePreviewAllInFolder: () => void;
	handlePreviewMulti: () => Promise<void>;
	handleQueueMedia: () => Promise<void>;
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

/** Files the Document Graph can actually parse. */
function isMarkdownPath(pathOrName: string): boolean {
	const lower = pathOrName.toLowerCase();
	return lower.endsWith('.md') || lower.endsWith('.markdown');
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

	const openContextMenu = useCallback(
		(e: React.MouseEvent, node: FileNode, path: string, globalIndex: number) => {
			e.preventDefault();
			e.stopPropagation();
			setSelectedFileIndex(globalIndex);
			if (selectedPathsRef.current.size > 0 && !selectedPathsRef.current.has(path)) {
				setSelectedPaths(new Set());
			}
			setContextMenu({ x: e.clientX, y: e.clientY, node, path });
		},
		[setSelectedFileIndex, selectedPathsRef, setSelectedPaths]
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

	/**
	 * Graph every markdown file under the right-clicked folder.
	 *
	 * The folder path is handed to the builder rather than a file list, so the
	 * scope does not depend on the folder being expanded in the tree - a
	 * collapsed folder has no loaded children, and enumerating from the tree
	 * would silently graph nothing.
	 *
	 * These two handlers write to the store directly instead of taking a prop.
	 * `onFocusFileInGraph` is itself just `focusFileInGraph` handed down through
	 * four files, and `FileContextMenu.tsx` already calls the store this way.
	 */
	const handleGraphFolder = useCallback(() => {
		if (contextMenu?.node?.type === 'folder') {
			useFileExplorerStore.getState().openGraphScope({ directory: contextMenu.path });
		}
		setContextMenu(null);
	}, [contextMenu]);

	/**
	 * Open a run of files, playing the first media file and queueing the rest.
	 *
	 * Media never becomes a tab, so without this every audio or video file in a
	 * multi-file open would take the player over from the one before it and only
	 * the last would survive. Media-ness is judged by extension here purely to
	 * decide ordering; whether a file is really playable is still settled inside
	 * the open path, which is the only place that knows if it can be streamed.
	 */
	const openFilesInOrder = useCallback(
		async (files: { node: FileNode; path: string }[]) => {
			let playedMedia = false;
			for (const file of files) {
				const media = isMediaFile(file.node.name);
				await handleFileClick(file.node, file.path, {
					mediaMode: media && playedMedia ? 'queue' : 'play',
				});
				if (media) playedMedia = true;
			}
		},
		[handleFileClick]
	);

	const handlePreviewFile = useCallback(async () => {
		const menu = contextMenu;
		try {
			if (menu && menu.node && menu.node.type === 'file') {
				await handleFileClick(menu.node, menu.path);
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
					await openFilesInOrder(files);
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
	}, [contextMenu, openFilesInOrder, session.id, onShowFlash]);

	const resolveSelectedNodes = useCallback((): { node: FileNode; path: string }[] => {
		const result: { node: FileNode; path: string }[] = [];
		for (const path of selectedPathsRef.current) {
			const node = findNodeAtPath(session.fileTree, path);
			if (node) result.push({ node, path });
		}
		return result;
	}, [selectedPathsRef, session.fileTree]);

	/**
	 * Graph exactly the selected markdown files.
	 *
	 * The right-clicked row becomes the center when it is itself markdown;
	 * otherwise the builder picks the most-connected file, which beats
	 * centering on whichever file happened to be selected first.
	 */
	const handleGraphSelection = useCallback(() => {
		const files = resolveSelectedNodes()
			.filter(({ node }) => node.type === 'file' && isMarkdownPath(node.name))
			.map(({ path }) => path);
		if (files.length > 0) {
			const clicked = contextMenu?.path;
			useFileExplorerStore.getState().openGraphScope({
				files,
				focusPath: clicked && files.includes(clicked) ? clicked : undefined,
			});
		}
		setContextMenu(null);
	}, [contextMenu, resolveSelectedNodes]);

	// Auto Run staging. A folder contributes every document beneath it, a
	// markdown file contributes itself, and anything outside the agent's Auto Run
	// folder contributes nothing. Ids are reconciled against the loader's list so
	// the run list only ever receives documents it can resolve, and the result is
	// emitted in that list's order so a staged run reads the same way the Auto Run
	// panel does.
	const autoRunDocumentList = useBatchStore((s) => s.documentList);
	const autoRunStagedDocs = useMemo(() => {
		const menu = contextMenu;
		if (!menu?.node) return [];
		const autoRunFolderPath = session.autoRunFolderPath;
		if (!autoRunFolderPath) return [];

		const docsForNode = (node: FileNode, path: string): string[] => {
			const absolutePath = `${session.fullPath}/${path}`;
			if (node.type === 'folder') {
				const relativeFolder = relativeToAutoRunFolder(absolutePath, autoRunFolderPath);
				return relativeFolder === null
					? []
					: collectAutoRunDocsInFolder(relativeFolder, autoRunDocumentList);
			}
			const docId = autoRunDocIdForFile(absolutePath, autoRunFolderPath);
			return docId ? [docId] : [];
		};

		// Right-clicking one row inside a multi-selection stages the selection;
		// right-clicking outside one stages just that row. Same rule the media
		// queue action uses, so the two menus never disagree about what "this"
		// means.
		const selected = resolveSelectedNodes();
		const targets =
			selected.length > 1 && selected.some((entry) => entry.path === menu.path)
				? selected
				: [{ node: menu.node, path: menu.path }];

		const wanted = new Set(targets.flatMap(({ node, path }) => docsForNode(node, path)));
		if (wanted.size === 0) return [];
		return autoRunDocumentList.filter((doc) => wanted.has(doc));
	}, [
		contextMenu,
		resolveSelectedNodes,
		session.fullPath,
		session.autoRunFolderPath,
		autoRunDocumentList,
	]);

	const handleStageForAutoRun = useCallback(() => {
		const docs = autoRunStagedDocs;
		setContextMenu(null);
		if (docs.length === 0) return;
		getModalActions().openBatchRunnerWithPresets(docs);
	}, [autoRunStagedDocs]);

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
				await openFilesInOrder(previewable);
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
	}, [resolveSelectedNodes, openFilesInOrder, session.id, onShowFlash]);

	/**
	 * Line media up behind whatever is playing, without taking the player over.
	 *
	 * Routed through the same open path as playing a file rather than talking to
	 * the playback store directly: that path is what resolves the stream URL and
	 * rejects a file it cannot serve, so a remote or unreadable file cannot end
	 * up as a queue entry that only fails when it reaches the front.
	 */
	const handleQueueMedia = useCallback(async () => {
		const menu = contextMenu;
		setContextMenu(null);
		const selected = resolveSelectedNodes();
		// Right-clicking one row inside a multi-selection queues the selection;
		// right-clicking outside one queues just that row.
		const candidates =
			selected.length > 1 && menu && selected.some((entry) => entry.path === menu.path)
				? selected
				: menu?.node && menu.node.type === 'file'
					? [{ node: menu.node, path: menu.path }]
					: [];

		const media = candidates.filter(({ node }) => isMediaFile(node.name));
		if (media.length === 0) {
			onShowFlash?.('No playable media in selection');
			return;
		}

		try {
			for (const file of media) {
				await handleFileClick(file.node, file.path, { mediaMode: 'queue' });
			}
			onShowFlash?.(`Queued ${media.length} file${media.length !== 1 ? 's' : ''}`);
		} catch (error) {
			if (isMissingFileError(error)) {
				onShowFlash?.('A selected file was no longer available');
				return;
			}
			captureException(error, {
				extra: {
					action: 'queue-media',
					paths: media.map((file) => file.path),
					sessionId: session.id,
				},
			});
			throw error;
		}
	}, [contextMenu, resolveSelectedNodes, handleFileClick, session.id, onShowFlash]);

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
		let lastError: string | null = null;
		// The batch reports per-path failures in its result, so a THROW out of it
		// means the whole call failed (an unresolvable SSH remote, a dead IPC
		// bridge) and nothing was deleted. That is a different message from the
		// refresh failing after the files are already gone.
		let batchCompleted = false;

		try {
			// ONE IPC call for the whole selection. Deleting these one at a time
			// put a full round trip (and an SSH handshake, when remote) in front
			// of every file, so the cost scaled with the slowest volume rather
			// than with the work: 125 files took over 30 seconds (issue #1423).
			const nodesByAbsolutePath = new Map(
				multiDeleteModal.nodes.map((item) => [`${session.fullPath}/${item.path}`, item])
			);
			const { results } = await window.maestro.fs.deleteMany([...nodesByAbsolutePath.keys()], {
				sshRemoteId,
			});
			batchCompleted = true;

			for (const result of results) {
				if (result.success) {
					succeeded++;
					continue;
				}
				failed++;
				lastError = result.error ?? 'Unknown error';
				// The batch resolves with per-path outcomes instead of throwing,
				// so report each failure here to keep the Sentry breadcrumb the
				// per-file loop used to produce.
				const item = nodesByAbsolutePath.get(result.path);
				captureException(new Error(lastError), {
					extra: {
						action: 'delete-multi',
						path: item?.path,
						absolutePath: result.path,
						nodeName: item?.node.name,
						nodeType: item?.node.type,
						sessionId: session.id,
						sshRemoteId,
					},
				});
			}

			await refreshFileTree(session.id);
			if (succeeded > 0 && failed === 0) {
				onShowFlash?.(`Deleted ${succeeded} item${succeeded !== 1 ? 's' : ''}`);
			} else if (succeeded > 0 && failed > 0) {
				onShowFlash?.(`Deleted ${succeeded}, ${failed} failed`);
			} else if (failed > 0) {
				onShowFlash?.(`Delete failed: ${lastError ?? 'Unknown error'}`);
			}
		} catch (error) {
			captureException(error, {
				extra: {
					action: batchCompleted ? 'delete-multi-refresh' : 'delete-multi-batch',
					sessionId: session.id,
					sshRemoteId,
				},
			});
			const msg = error instanceof Error ? error.message : 'Unknown error';
			onShowFlash?.(batchCompleted ? `Delete refresh failed: ${msg}` : `Delete failed: ${msg}`);
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

	// Zip a folder into `<name>.zip` beside it in the parent directory. The main
	// process picks the archive name (auto-suffixing `-1`, `-2`, ... when taken)
	// and reports back what it wrote, so the toast names the real file.
	const handleCompressFolder = useCallback(async () => {
		const menu = contextMenu;
		setContextMenu(null);
		if (!menu || !menu.node || menu.node.type !== 'folder') return;

		const folderName = menu.node.name;
		const absolutePath = `${session.fullPath}/${menu.path}`;
		try {
			const result = await window.maestro.fs.compressFolder(absolutePath, { sshRemoteId });
			notifyToast({
				color: 'green',
				title: 'Folder compressed',
				message: `"${folderName}" -> ${result.name}`,
			});
			// The archive lands in the parent directory, which is usually on screen -
			// refresh so it shows up without the auto-refresh interval's delay.
			await refreshFileTree(session.id);
		} catch (error) {
			captureException(error, {
				extra: {
					action: 'compress-folder',
					path: menu.path,
					nodeName: folderName,
					sessionId: session.id,
					sshRemoteId,
				},
			});
			notifyToast({
				color: 'red',
				title: 'Compress failed',
				message: `Could not compress "${folderName}": ${error instanceof Error ? error.message : 'Unknown error'}`,
			});
		}
	}, [contextMenu, session.fullPath, session.id, sshRemoteId, refreshFileTree]);

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
		handleCompressFolder,
		handleOpenRename,
		handleOpenDelete,
		handleFocusInGraph,
		handleGraphFolder,
		handleGraphSelection,
		autoRunStagedDocs,
		handleStageForAutoRun,
		handlePreviewFile,
		handlePreviewAllInFolder,
		handlePreviewMulti,
		handleQueueMedia,
		handleOpenInDefaultAppMulti,
		handleOpenDeleteMulti,
		handleDeleteMulti,
		closeMultiDeleteModal,
	};
}
