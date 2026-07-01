import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Session } from '../../../types';
import type { FileNode } from '../../../types/fileTree';
import type { FileTreeChanges } from '../../../utils/fileExplorer';
import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';
import { getBasename } from '../../../../shared/formatters';
import { dragHasOsFiles, getDroppedPaths } from '../../../utils/osFileDrop';
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
	/**
	 * True while the active drag-over is an OS-file import (Finder/Explorer),
	 * as opposed to an in-tree move. Lets the panel show an explanatory
	 * "drop to import" overlay only for external drags. Read alongside
	 * `dragOverFolder !== null` so it self-clears when the drag leaves.
	 */
	isExternalDrag: boolean;
	/**
	 * True while an in-tree row drag is in flight (set on the row's dragstart,
	 * cleared on dragend). Drives the "move to root" receptacle, which only
	 * needs to appear while the user is actually dragging a tree item - mirrors
	 * the Left Bar's "Drop here to ungroup" zone that shows only mid-drag.
	 */
	internalDragActive: boolean;
	moveConflict: MoveConflictState | null;
	isMoving: boolean;
	performMoves: (
		moves: Array<{
			sourceName: string;
			sourceAbsolutePath: string;
			destAbsolutePath: string;
			deleteDestFirst?: boolean;
		}>,
		destFolderRelative: string,
		operation?: 'move' | 'copy'
	) => Promise<void>;
	handleFolderDrop: (e: React.DragEvent, destFolderRelative: string) => void;
	handleFolderDragOver: (e: React.DragEvent, destFolderRelative: string) => void;
	handleFolderDragEnter: (e: React.DragEvent, destFolderRelative: string) => void;
	handleFolderDragLeave: (e: React.DragEvent) => void;
	handleMoveOverwriteAll: () => void;
	handleMoveAutoRenameAll: () => void;
	handleMoveSkipConflicts: () => void;
	closeMoveConflict: () => void;
	handleInternalDragStart: (showRootReceptacle: boolean) => void;
	handleInternalDragEnd: () => void;
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
	const [isExternalDrag, setIsExternalDrag] = useState(false);
	const [internalDragActive, setInternalDragActive] = useState(false);
	// Guards the deferred dragstart flag: if the drag ends before the next tick
	// (a flick or instant cancel), we must not flip the receptacle on afterwards.
	const dragActiveRef = useRef(false);
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
			destFolderRelative: string,
			operation: 'move' | 'copy' = 'move'
		) => {
			if (moves.length === 0) {
				setMoveConflict(null);
				return;
			}
			const isCopy = operation === 'copy';
			// Past-tense verb for the flash banner: in-tree reorganisation is a
			// "move"; importing OS files copies them, surfaced to the user as
			// "Imported".
			const doneVerb = isCopy ? 'Imported' : 'Moved';
			const failVerb = isCopy ? 'Import' : 'Move';
			setIsMoving(true);
			let succeeded = 0;
			let failed = 0;
			let lastError: unknown = null;
			try {
				for (const m of moves) {
					try {
						if (isCopy) {
							// External import: copy from the OS source path into the tree.
							// `deleteDestFirst` encodes the user's overwrite decision. For a
							// remote session the dest is on the remote host, so pass the
							// sshRemoteId to upload the local source over SSH.
							await window.maestro.fs.copyPath(m.sourceAbsolutePath, m.destAbsolutePath, {
								overwrite: !!m.deleteDestFirst,
								sshRemoteId,
							});
						} else {
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
						}
						succeeded++;
					} catch (err) {
						failed++;
						lastError = err;
						logger.warn(`[FileExplorer] ${failVerb} failed for "${m.sourceName}"`, undefined, err);
					}
				}

				// Both rename and copy mutate the tree's shape, so do a full refresh
				// instead of in-place patching.
				await refreshFileTree(session.id);
				expandFolder(destFolderRelative);

				if (succeeded > 0 && failed === 0) {
					if (succeeded === 1) {
						onShowFlash?.(`${doneVerb} "${moves[0].sourceName}"`);
					} else {
						onShowFlash?.(`${doneVerb} ${succeeded} items`);
					}
				} else if (succeeded > 0 && failed > 0) {
					onShowFlash?.(`${doneVerb} ${succeeded}, ${failed} failed`);
				} else if (failed > 0) {
					const msg = lastError instanceof Error ? lastError.message : 'Unknown error';
					onShowFlash?.(`${failVerb} failed: ${msg}`);
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

	// Import OS files/folders (dragged in from Finder/Explorer) into a tree folder.
	// `destFolderRelative` is '' for the tree root. The dropped source is always a
	// local OS path; for a remote session the import uploads it to the remote host
	// over SSH (handled by `performMoves` -> `copyPath` with `sshRemoteId`).
	const handleExternalImport = useCallback(
		(osPaths: string[], destFolderRelative: string) => {
			if (osPaths.length === 0) return;

			const destFolderAbsolute = destFolderRelative
				? `${session.fullPath}/${destFolderRelative}`
				: session.fullPath;
			const destChildren = destFolderRelative
				? (findNodeAtPath(session.fileTree, destFolderRelative)?.children ?? [])
				: (session.fileTree ?? []);
			// Names already present in the destination drive conflict detection;
			// a separate mutable set lets auto-rename avoid colliding with both
			// existing files and earlier items in the same dropped batch.
			const originalNames = new Set(destChildren.map((c: FileNode) => c.name));
			const existingNames = new Set(originalNames);
			const noConflict: PendingMove[] = [];
			const conflicts: PendingMove[] = [];

			for (const sourcePath of osPaths) {
				const sourceName = getBasename(sourcePath);
				if (!sourceName) continue;
				const destAbsolute = `${destFolderAbsolute}/${sourceName}`;
				if (originalNames.has(sourceName)) {
					const autoRenameName = computeAutoRenameName(existingNames, sourceName);
					existingNames.add(autoRenameName);
					conflicts.push({
						sourceName,
						sourceRelativePath: sourcePath,
						sourceAbsolutePath: sourcePath,
						destAbsolutePath: destAbsolute,
						autoRenameName,
						autoRenameAbsolutePath: `${destFolderAbsolute}/${autoRenameName}`,
					});
				} else {
					existingNames.add(sourceName);
					noConflict.push({
						sourceName,
						sourceRelativePath: sourcePath,
						sourceAbsolutePath: sourcePath,
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
					destFolderRelative,
					'copy'
				);
				return;
			}

			setMoveConflict({
				destFolderRelativePath: destFolderRelative,
				destFolderAbsolutePath: destFolderAbsolute,
				conflicts,
				nonConflicting: noConflict,
				operation: 'copy',
			});
		},
		[session.fullPath, session.fileTree, performMoves]
	);

	const handleFolderDrop = useCallback(
		(e: React.DragEvent, destFolderRelative: string) => {
			// OS file import takes precedence: a Finder/Explorer drag carries the
			// 'Files' type and none of the internal MIME types. For remote sessions
			// the source uploads to the remote host (handled downstream).
			if (dragHasOsFiles(e.dataTransfer)) {
				e.preventDefault();
				e.stopPropagation();
				setDragOverFolder(null);
				setIsExternalDrag(false);
				handleExternalImport(getDroppedPaths(e.dataTransfer), destFolderRelative);
				return;
			}

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

			// destFolderRelative is '' for the tree root; join without a trailing
			// slash so root paths stay `${fullPath}/${name}` rather than `//`.
			const destFolderAbsolute = destFolderRelative
				? `${session.fullPath}/${destFolderRelative}`
				: session.fullPath;
			const destFolderNode = findNodeAtPath(session.fileTree, destFolderRelative);
			const existingNames = new Set(destFolderNode?.children?.map((c: FileNode) => c.name) ?? []);
			const noConflict: PendingMove[] = [];
			const conflicts: PendingMove[] = [];

			for (const sourceRelative of sources) {
				if (isSelfOrDescendant(sourceRelative, destFolderRelative)) continue;
				if (parentDirOf(sourceRelative) === destFolderRelative) continue;

				const sourceName = basenameOf(sourceRelative);
				const sourceAbsolute = `${session.fullPath}/${sourceRelative}`;
				// At root (destFolderRelative === '') the relative path is just the
				// name; otherwise nest it under the folder. A leading slash here would
				// make findNodeAtPath miss existing root files and skip conflict checks.
				const destRelative = destFolderRelative
					? `${destFolderRelative}/${sourceName}`
					: sourceName;
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
				operation: 'move',
			});
		},
		[session.fullPath, session.fileTree, performMoves, sshRemoteId, handleExternalImport]
	);

	const handleFolderDragOver = useCallback(
		(e: React.DragEvent, destFolderRelative: string) => {
			// OS file import: accept the drop and show a copy cursor. For remote
			// sessions the source uploads to the remote host over SSH.
			if (dragHasOsFiles(e.dataTransfer)) {
				e.preventDefault();
				e.stopPropagation();
				e.dataTransfer.dropEffect = 'copy';
				return;
			}
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
		},
		[sshRemoteId]
	);

	const handleFolderDragEnter = useCallback(
		(e: React.DragEvent, destFolderRelative: string) => {
			if (dragHasOsFiles(e.dataTransfer)) {
				e.stopPropagation();
				setDragOverFolder(destFolderRelative);
				setIsExternalDrag(true);
				return;
			}
			const hasMaestroDrag =
				e.dataTransfer.types.includes(FILE_TREE_SINGLE_MIME) ||
				e.dataTransfer.types.includes(FILE_TREE_MULTI_MIME);
			if (!hasMaestroDrag) return;
			e.stopPropagation();
			setDragOverFolder(destFolderRelative);
			setIsExternalDrag(false);
		},
		[sshRemoteId]
	);

	const handleFolderDragLeave = useCallback((e: React.DragEvent) => {
		const hasMaestroDrag =
			e.dataTransfer.types.includes(FILE_TREE_SINGLE_MIME) ||
			e.dataTransfer.types.includes(FILE_TREE_MULTI_MIME) ||
			dragHasOsFiles(e.dataTransfer);
		if (!hasMaestroDrag) return;
		e.stopPropagation();
		// Keep the highlight when moving into a descendant of the row.
		const next = e.relatedTarget as Node | null;
		const row = e.currentTarget as Node | null;
		if (row && next && row.contains(next)) return;
		setDragOverFolder(null);
		setIsExternalDrag(false);
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
		void performMoves(batch, moveConflict.destFolderRelativePath, moveConflict.operation);
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
		void performMoves(batch, moveConflict.destFolderRelativePath, moveConflict.operation);
	}, [moveConflict, performMoves]);

	const handleMoveSkipConflicts = useCallback(() => {
		if (!moveConflict) return;
		const batch = moveConflict.nonConflicting.map((m) => ({
			sourceName: m.sourceName,
			sourceAbsolutePath: m.sourceAbsolutePath,
			destAbsolutePath: m.destAbsolutePath,
		}));
		void performMoves(batch, moveConflict.destFolderRelativePath, moveConflict.operation);
	}, [moveConflict, performMoves]);

	const closeMoveConflict = useCallback(() => setMoveConflict(null), []);

	// Row dragstart/dragend pair. The row is the only thing that knows a tree
	// drag began (the panel doesn't see it until the cursor enters a drop zone),
	// so it flips this flag to reveal the "move to root" receptacle. dragend
	// always fires - successful drop or cancel - so it doubly clears any leftover
	// hover state in case the drop happened outside a registered handler.
	//
	// The flag flip is deferred to the next tick on purpose: mounting the
	// receptacle reflows the panel, and Chromium ABORTS an in-flight drag if the
	// layout mutates synchronously inside the dragstart handler. Letting dragstart
	// finish first (drag image captured) before the DOM grows keeps the drag alive.
	const handleInternalDragStart = useCallback((showRootReceptacle: boolean) => {
		dragActiveRef.current = true;
		// Skip mounting the receptacle when every dragged item already sits at the
		// workspace root - there's nothing to move there. dragActiveRef still flips
		// so dragend cleanup stays symmetric.
		if (!showRootReceptacle) return;
		setTimeout(() => {
			if (dragActiveRef.current) setInternalDragActive(true);
		}, 0);
	}, []);

	const handleInternalDragEnd = useCallback(() => {
		dragActiveRef.current = false;
		setInternalDragActive(false);
		setDragOverFolder(null);
		setIsExternalDrag(false);
	}, []);

	return {
		dragOverFolder,
		isExternalDrag,
		internalDragActive,
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
		handleInternalDragStart,
		handleInternalDragEnd,
	};
}
