import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Session } from '../../../types';
import type { FileNode } from '../../../types/fileTree';
import type { FileTreeChanges } from '../../../utils/fileExplorer';
import {
	removeNodeFromTree,
	renameNodeInTree,
	findNodeInTree,
	countNodesInTree,
} from '../../../utils/fileExplorer';
import { captureException } from '../../../utils/sentry';
import type { RenameModalState, DeleteModalState, NewFileModalState } from '../types';

interface UseFileOperationsArgs {
	session: Session;
	sshRemoteId: string | undefined;
	setSessions: Dispatch<SetStateAction<Session[]>>;
	refreshFileTree: (
		sessionId: string,
		options?: { maxEntriesOverride?: number }
	) => Promise<FileTreeChanges | undefined>;
	expandFolder: (relativePath: string) => void;
	onShowFlash?: (msg: string) => void;
}

interface UseFileOperationsResult {
	renameModal: RenameModalState | null;
	renameValue: string;
	renameError: string | null;
	newFileModal: NewFileModalState | null;
	newFileValue: string;
	newFileError: string | null;
	isCreatingFile: boolean;
	deleteModal: DeleteModalState | null;
	isDeleting: boolean;
	openRenameModal: (node: FileNode, path: string) => void;
	closeRenameModal: () => void;
	setRenameValue: (v: string) => void;
	handleRename: () => Promise<void>;
	openNewFileModal: (parentFolderPath: string, parentFolderAbsolutePath: string) => void;
	closeNewFileModal: () => void;
	setNewFileValue: (v: string) => void;
	handleCreateNewFile: () => Promise<void>;
	openDeleteModal: (node: FileNode, path: string) => Promise<void>;
	closeDeleteModal: () => void;
	handleDelete: () => Promise<void>;
}

export function useFileOperations({
	session,
	sshRemoteId,
	setSessions,
	refreshFileTree,
	expandFolder,
	onShowFlash,
}: UseFileOperationsArgs): UseFileOperationsResult {
	// Rename modal state
	const [renameModal, setRenameModal] = useState<RenameModalState | null>(null);
	const [renameValue, setRenameValue] = useState('');
	const [renameError, setRenameError] = useState<string | null>(null);

	// Delete confirmation modal state
	const [deleteModal, setDeleteModal] = useState<DeleteModalState | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	// New-file modal state
	const [newFileModal, setNewFileModal] = useState<NewFileModalState | null>(null);
	const [newFileValue, setNewFileValue] = useState('');
	const [newFileError, setNewFileError] = useState<string | null>(null);
	const [isCreatingFile, setIsCreatingFile] = useState(false);

	const openRenameModal = useCallback(
		(node: FileNode, path: string) => {
			const absolutePath = `${session.fullPath}/${path}`;
			setRenameModal({ node, path, absolutePath });
			setRenameValue(node.name);
			setRenameError(null);
		},
		[session.fullPath]
	);

	const closeRenameModal = useCallback(() => setRenameModal(null), []);

	// Execute rename
	const handleRename = useCallback(async () => {
		if (!renameModal || !renameValue.trim()) return;

		const newName = renameValue.trim();
		if (newName === renameModal.node.name) {
			setRenameModal(null);
			return;
		}

		if (newName.includes('/') || newName.includes('\\')) {
			setRenameError('Name cannot contain slashes');
			return;
		}

		try {
			const parentDir = renameModal.absolutePath.substring(
				0,
				renameModal.absolutePath.lastIndexOf('/')
			);
			const newPath = `${parentDir}/${newName}`;
			await window.maestro.fs.rename(renameModal.absolutePath, newPath, sshRemoteId);

			const oldPath = renameModal.path;
			const pathParts = oldPath.split('/');
			pathParts[pathParts.length - 1] = newName;
			const newRelativePath = pathParts.join('/');

			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== session.id) return s;
					const currentTree = s.fileTree || [];
					const newTree = renameNodeInTree(currentTree, renameModal.path, newName);
					return {
						...s,
						fileTree: newTree,
						fileExplorerExpanded:
							renameModal.node.type === 'folder'
								? (s.fileExplorerExpanded || []).map((p) => {
										if (p === oldPath) return newRelativePath;
										if (p.startsWith(oldPath + '/'))
											return newRelativePath + p.slice(oldPath.length);
										return p;
									})
								: s.fileExplorerExpanded,
					};
				})
			);

			setRenameModal(null);
			onShowFlash?.(`Renamed to "${newName}"`);
		} catch (error) {
			setRenameError(error instanceof Error ? error.message : 'Rename failed');
		}
	}, [renameModal, renameValue, session.id, onShowFlash, sshRemoteId, setSessions]);

	const openNewFileModal = useCallback(
		(parentFolderPath: string, parentFolderAbsolutePath: string) => {
			setNewFileModal({ parentFolderPath, parentFolderAbsolutePath });
			setNewFileValue('');
			setNewFileError(null);
		},
		[]
	);

	const closeNewFileModal = useCallback(() => setNewFileModal(null), []);

	// Create an empty file inside the new-file modal's parent folder.
	const handleCreateNewFile = useCallback(async () => {
		if (!newFileModal || !newFileValue.trim()) return;

		const name = newFileValue.trim();
		if (name.includes('/') || name.includes('\\')) {
			setNewFileError('Name cannot contain slashes');
			return;
		}

		const parts = newFileModal.parentFolderPath.split('/').filter(Boolean);
		let children: FileNode[] | undefined = session.fileTree;
		for (const part of parts) {
			if (!children) break;
			children = children.find((c) => c.name === part)?.children;
		}
		if (children?.some((c) => c.name === name)) {
			setNewFileError(`"${name}" already exists in this folder`);
			return;
		}

		const absolutePath = `${newFileModal.parentFolderAbsolutePath}/${name}`;
		setIsCreatingFile(true);
		try {
			await window.maestro.fs.writeFile(absolutePath, '', sshRemoteId);
			await refreshFileTree(session.id);
			expandFolder(newFileModal.parentFolderPath);
			setNewFileModal(null);
			onShowFlash?.(`Created "${name}"`);
		} catch (error) {
			setNewFileError(error instanceof Error ? error.message : 'Create failed');
		} finally {
			setIsCreatingFile(false);
		}
	}, [
		newFileModal,
		newFileValue,
		session.fileTree,
		session.id,
		sshRemoteId,
		refreshFileTree,
		onShowFlash,
		expandFolder,
	]);

	// Open delete confirmation modal
	const openDeleteModal = useCallback(
		async (node: FileNode, path: string) => {
			const absolutePath = `${session.fullPath}/${path}`;
			const modalData: DeleteModalState = { node, path, absolutePath };

			if (node.type === 'folder') {
				try {
					const count = await window.maestro.fs.countItems(absolutePath, sshRemoteId);
					modalData.itemCount = count;
				} catch (error) {
					captureException(error, {
						extra: {
							absolutePath,
							sshRemoteId,
							operation: 'countItems',
							nodeName: modalData.node.name,
							nodeType: modalData.node.type,
							path: modalData.path,
						},
					});
					// If count fails, proceed without it
				}
			}

			setDeleteModal(modalData);
		},
		[session.fullPath, sshRemoteId]
	);

	const closeDeleteModal = useCallback(() => setDeleteModal(null), []);

	// Execute delete
	const handleDelete = useCallback(async () => {
		if (!deleteModal) return;

		setIsDeleting(true);
		try {
			await window.maestro.fs.delete(deleteModal.absolutePath, { sshRemoteId });

			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== session.id) return s;
					const currentTree = s.fileTree || [];
					const deletedNode = findNodeInTree(currentTree, deleteModal.path);
					let deletedFileCount = 0;
					let deletedFolderCount = 0;

					if (deletedNode) {
						if (deletedNode.type === 'folder') {
							deletedFolderCount = 1;
							if (deletedNode.children) {
								const childCounts = countNodesInTree(deletedNode.children);
								deletedFileCount = childCounts.fileCount;
								deletedFolderCount += childCounts.folderCount;
							}
						} else {
							deletedFileCount = 1;
						}
					}

					const newTree = removeNodeFromTree(currentTree, deleteModal.path);
					const isDeletedFolderPath = (p: string) =>
						p === deleteModal.path || p.startsWith(`${deleteModal.path}/`);
					return {
						...s,
						fileTree: newTree,
						fileTreeStats: s.fileTreeStats
							? {
									...s.fileTreeStats,
									fileCount: Math.max(0, s.fileTreeStats.fileCount - deletedFileCount),
									folderCount: Math.max(0, s.fileTreeStats.folderCount - deletedFolderCount),
								}
							: undefined,
						fileExplorerExpanded:
							deleteModal.node.type === 'folder'
								? (s.fileExplorerExpanded || []).filter((p) => !isDeletedFolderPath(p))
								: s.fileExplorerExpanded,
					};
				})
			);

			setDeleteModal(null);
			onShowFlash?.(`Deleted "${deleteModal.node.name}"`);
		} catch (error) {
			onShowFlash?.(`Delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		} finally {
			setIsDeleting(false);
		}
	}, [deleteModal, session.id, onShowFlash, sshRemoteId, setSessions]);

	return {
		renameModal,
		renameValue,
		renameError,
		newFileModal,
		newFileValue,
		newFileError,
		isCreatingFile,
		deleteModal,
		isDeleting,
		openRenameModal,
		closeRenameModal,
		setRenameValue: (v: string) => {
			setRenameValue(v);
			setRenameError(
				v.trim().includes('/') || v.trim().includes('\\') ? 'Name cannot contain slashes' : null
			);
		},
		handleRename,
		openNewFileModal,
		closeNewFileModal,
		setNewFileValue: (v: string) => {
			setNewFileValue(v);
			setNewFileError(null);
		},
		handleCreateNewFile,
		openDeleteModal,
		closeDeleteModal,
		handleDelete,
	};
}
