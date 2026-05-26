import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Session } from '../../../types';
import type { FileNode } from '../../../types/fileTree';
import type { FileTreeChanges } from '../../../utils/fileExplorer';
import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';
import type { MoveConflictState, PendingMove } from '../types';
import { FILE_TREE_SINGLE_MIME, FILE_TREE_MULTI_MIME } from '../types';
import {
	isSelfOrDescendant,
	parentDirOf,
	basenameOf,
	findNodeAtPath,
	computeAutoRenameName,
} from '../utils/pathHelpers';

interface UseDragToMoveArgs {
	session: Session;
	sshRemoteId: string | undefined;
	refreshFileTree: (
		sessionId: string,
		options?: { maxEntriesOverride?: number }
	) => Promise<FileTreeChanges | undefined>;
	expandFolder: (relativePath: string) => void;
	onShowFlash?: (msg: string) => void;
	setSelectedPaths: Dispatch<SetStateAction<Set<string>>>;
}

interface UseDragToMoveResult {
	dragOverFolder: string | null;
	moveConflict: MoveConflictState | null;
	isMoving: boolean;
	performMoves: (
		moves: Array<{
			sourceName: string;
			sourceAbsolutePath: string;
			destAbsolutePath: string;
			deleteDestFirst?: boolean;
		}>,
		destFolderRelative: string
	) => Promise<void>;
	handleFolderDrop: (e: React.DragEvent, destFolderRelative: string) => void;
	handleFolderDragOver: (e: React.DragEvent, destFolderRelative: string) => void;
	handleFolderDragEnter: (e: React.DragEvent, destFolderRelative: string) => void;
	handleFolderDragLeave: (e: React.DragEvent) => void;
	handleMoveOverwriteAll: () => void;
	handleMoveAutoRenameAll: () => void;
	handleMoveSkipConflicts: () => void;
	closeMoveConflict: () => void;
}

export function useDragToMove({
	session,
	sshRemoteId,
	refreshFileTree,
	expandFolder,
	onShowFlash,
	setSelectedPaths,
}: UseDragToMoveArgs): UseDragToMoveResult {
	const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
	const [moveConflict, setMoveConflict] = useState<MoveConflictState | null>(null);
	const [isMoving, setIsMoving] = useState(false);

	// Execute a batch of moves, optionally deleting an existing destination first
	// (used for overwrites). Refreshes the file tree once at the end and reports
	// aggregate success/failure via the flash banner.
	const performMoves = useCallback(
		async (
			moves: Array<{
				sourceName: string;
				sourceAbsolutePath: string;
				destAbsolutePath: string;
				deleteDestFirst?: boolean;
			}>,
			destFolderRelative: string
		) => {
			if (moves.length === 0) {
				setMoveConflict(null);
				return;
			}
			setIsMoving(true);
			let succeeded = 0;
			let failed = 0;
			let lastError: unknown = null;
			try {
				for (const m of moves) {
					try {
						if (m.deleteDestFirst) {
							// May not exist if the user picked overwrite for a phantom conflict;
							// swallow the error and let the rename surface the real failure.
							try {
								await window.maestro.fs.delete(m.destAbsolutePath, {
									recursive: true,
									sshRemoteId,
								});
							} catch (deleteErr) {
								logger.warn(
									`[FileExplorer] Pre-overwrite delete failed for "${m.sourceName}"`,
									undefined,
									deleteErr
								);
								captureException(deleteErr, {
									extra: {
										sourceName: m.sourceName,
										destAbsolutePath: m.destAbsolutePath,
										sshRemoteId,
										operation: 'move.preOverwriteDelete',
									},
								});
							}
						}
						await window.maestro.fs.rename(m.sourceAbsolutePath, m.destAbsolutePath, sshRemoteId);
						succeeded++;
					} catch (err) {
						failed++;
						lastError = err;
						logger.warn(`[FileExplorer] Move failed for "${m.sourceName}"`, undefined, err);
					}
				}

				// fs:rename mutates the tree's shape, so do a full refresh instead of in-place patching.
				await refreshFileTree(session.id);
				expandFolder(destFolderRelative);

				if (succeeded > 0 && failed === 0) {
					if (succeeded === 1) {
						onShowFlash?.(`Moved "${moves[0].sourceName}"`);
					} else {
						onShowFlash?.(`Moved ${succeeded} items`);
					}
				} else if (succeeded > 0 && failed > 0) {
					onShowFlash?.(`Moved ${succeeded}, ${failed} failed`);
				} else if (failed > 0) {
					const msg = lastError instanceof Error ? lastError.message : 'Unknown error';
					onShowFlash?.(`Move failed: ${msg}`);
				}
			} finally {
				// Clear multi-selection — attempted move paths may now be stale.
				setSelectedPaths(new Set());
				setIsMoving(false);
				setMoveConflict(null);
			}
		},
		[sshRemoteId, refreshFileTree, session.id, onShowFlash, expandFolder, setSelectedPaths]
	);

	const handleFolderDrop = useCallback(
		(e: React.DragEvent, destFolderRelative: string) => {
			const multi = e.dataTransfer.getData(FILE_TREE_MULTI_MIME);
			let sources: string[] = [];
			if (multi) {
				try {
					const parsed = JSON.parse(multi);
					if (Array.isArray(parsed)) sources = parsed.filter((s) => typeof s === 'string');
				} catch (err) {
					captureException(err, {
						extra: {
							multi,
							operation: 'fileTree.multiDragPayload.parse',
						},
					});
					// Fall through to single-path branch.
				}
			}
			if (sources.length === 0) {
				const single = e.dataTransfer.getData(FILE_TREE_SINGLE_MIME);
				if (single) sources = [single];
			}
			if (sources.length === 0) return;

			e.preventDefault();
			e.stopPropagation();
			setDragOverFolder(null);

			const destFolderAbsolute = `${session.fullPath}/${destFolderRelative}`;
			const destFolderNode = findNodeAtPath(session.fileTree, destFolderRelative);
			const existingNames = new Set(destFolderNode?.children?.map((c: FileNode) => c.name) ?? []);
			const noConflict: PendingMove[] = [];
			const conflicts: PendingMove[] = [];

			for (const sourceRelative of sources) {
				if (isSelfOrDescendant(sourceRelative, destFolderRelative)) continue;
				if (parentDirOf(sourceRelative) === destFolderRelative) continue;

				const sourceName = basenameOf(sourceRelative);
				const sourceAbsolute = `${session.fullPath}/${sourceRelative}`;
				const destRelative = `${destFolderRelative}/${sourceName}`;
				const destAbsolute = `${destFolderAbsolute}/${sourceName}`;
				const conflictNode = findNodeAtPath(session.fileTree, destRelative);
				if (conflictNode) {
					const autoRenameName = computeAutoRenameName(existingNames, sourceName);
					existingNames.add(autoRenameName);
					conflicts.push({
						sourceName,
						sourceRelativePath: sourceRelative,
						sourceAbsolutePath: sourceAbsolute,
						destAbsolutePath: destAbsolute,
						autoRenameName,
						autoRenameAbsolutePath: `${destFolderAbsolute}/${autoRenameName}`,
					});
				} else {
					existingNames.add(sourceName);
					noConflict.push({
						sourceName,
						sourceRelativePath: sourceRelative,
						sourceAbsolutePath: sourceAbsolute,
						destAbsolutePath: destAbsolute,
						autoRenameName: sourceName,
						autoRenameAbsolutePath: destAbsolute,
					});
				}
			}

			if (noConflict.length === 0 && conflicts.length === 0) return;

			if (conflicts.length === 0) {
				void performMoves(
					noConflict.map((m) => ({
						sourceName: m.sourceName,
						sourceAbsolutePath: m.sourceAbsolutePath,
						destAbsolutePath: m.destAbsolutePath,
					})),
					destFolderRelative
				);
				return;
			}

			setMoveConflict({
				destFolderRelativePath: destFolderRelative,
				destFolderAbsolutePath: destFolderAbsolute,
				conflicts,
				nonConflicting: noConflict,
			});
		},
		[session.fullPath, session.fileTree, performMoves]
	);

	const handleFolderDragOver = useCallback((e: React.DragEvent, destFolderRelative: string) => {
		const hasMaestroDrag =
			e.dataTransfer.types.includes(FILE_TREE_SINGLE_MIME) ||
			e.dataTransfer.types.includes(FILE_TREE_MULTI_MIME);
		if (!hasMaestroDrag) return;
		const sourceRelative = e.dataTransfer.getData(FILE_TREE_SINGLE_MIME);
		const isMulti = e.dataTransfer.types.includes(FILE_TREE_MULTI_MIME);
		if (!isMulti && sourceRelative && isSelfOrDescendant(sourceRelative, destFolderRelative)) {
			e.dataTransfer.dropEffect = 'none';
			return;
		}
		if (!isMulti && sourceRelative && parentDirOf(sourceRelative) === destFolderRelative) {
			e.dataTransfer.dropEffect = 'none';
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = 'move';
	}, []);

	const handleFolderDragEnter = useCallback((e: React.DragEvent, destFolderRelative: string) => {
		const hasMaestroDrag =
			e.dataTransfer.types.includes(FILE_TREE_SINGLE_MIME) ||
			e.dataTransfer.types.includes(FILE_TREE_MULTI_MIME);
		if (!hasMaestroDrag) return;
		e.stopPropagation();
		setDragOverFolder(destFolderRelative);
	}, []);

	const handleFolderDragLeave = useCallback((e: React.DragEvent) => {
		const hasMaestroDrag =
			e.dataTransfer.types.includes(FILE_TREE_SINGLE_MIME) ||
			e.dataTransfer.types.includes(FILE_TREE_MULTI_MIME);
		if (!hasMaestroDrag) return;
		e.stopPropagation();
		// Keep the highlight when moving into a descendant of the row.
		const next = e.relatedTarget as Node | null;
		const row = e.currentTarget as Node | null;
		if (row && next && row.contains(next)) return;
		setDragOverFolder(null);
	}, []);

	const handleMoveOverwriteAll = useCallback(() => {
		if (!moveConflict) return;
		const batch = [
			...moveConflict.nonConflicting.map((m) => ({
				sourceName: m.sourceName,
				sourceAbsolutePath: m.sourceAbsolutePath,
				destAbsolutePath: m.destAbsolutePath,
			})),
			...moveConflict.conflicts.map((m) => ({
				sourceName: m.sourceName,
				sourceAbsolutePath: m.sourceAbsolutePath,
				destAbsolutePath: m.destAbsolutePath,
				deleteDestFirst: true,
			})),
		];
		void performMoves(batch, moveConflict.destFolderRelativePath);
	}, [moveConflict, performMoves]);

	const handleMoveAutoRenameAll = useCallback(() => {
		if (!moveConflict) return;
		const batch = [
			...moveConflict.nonConflicting.map((m) => ({
				sourceName: m.sourceName,
				sourceAbsolutePath: m.sourceAbsolutePath,
				destAbsolutePath: m.destAbsolutePath,
			})),
			...moveConflict.conflicts.map((m) => ({
				sourceName: m.autoRenameName,
				sourceAbsolutePath: m.sourceAbsolutePath,
				destAbsolutePath: m.autoRenameAbsolutePath,
			})),
		];
		void performMoves(batch, moveConflict.destFolderRelativePath);
	}, [moveConflict, performMoves]);

	const handleMoveSkipConflicts = useCallback(() => {
		if (!moveConflict) return;
		const batch = moveConflict.nonConflicting.map((m) => ({
			sourceName: m.sourceName,
			sourceAbsolutePath: m.sourceAbsolutePath,
			destAbsolutePath: m.destAbsolutePath,
		}));
		void performMoves(batch, moveConflict.destFolderRelativePath);
	}, [moveConflict, performMoves]);

	const closeMoveConflict = useCallback(() => setMoveConflict(null), []);

	return {
		dragOverFolder,
		moveConflict,
		isMoving,
		performMoves,
		handleFolderDrop,
		handleFolderDragOver,
		handleFolderDragEnter,
		handleFolderDragLeave,
		handleMoveOverwriteAll,
		handleMoveAutoRenameAll,
		handleMoveSkipConflicts,
		closeMoveConflict,
	};
}
