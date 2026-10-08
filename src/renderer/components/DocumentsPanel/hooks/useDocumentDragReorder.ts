import { useCallback, useRef, useState } from 'react';
import type React from 'react';
import type { BatchDocumentEntry } from '../../../types';
import { generateId } from '../../../utils/ids';

interface UseDocumentDragReorderArgs {
	documents: BatchDocumentEntry[];
	setDocuments: React.Dispatch<React.SetStateAction<BatchDocumentEntry[]>>;
}

export function useDocumentDragReorder({ documents, setDocuments }: UseDocumentDragReorderArgs) {
	const [draggedId, setDraggedId] = useState<string | null>(null);
	const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
	const [isCopyDrag, setIsCopyDrag] = useState(false);
	const [cursorPosition, setCursorPosition] = useState<{ x: number; y: number } | null>(null);

	const draggedIdRef = useRef(draggedId);
	const dropTargetIndexRef = useRef(dropTargetIndex);
	const isCopyDragRef = useRef(isCopyDrag);
	const dropPerformedRef = useRef(false);
	const isOverDropTargetRef = useRef(false);
	draggedIdRef.current = draggedId;
	dropTargetIndexRef.current = dropTargetIndex;
	isCopyDragRef.current = isCopyDrag;

	const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
		dropPerformedRef.current = false;
		const isCopy = e.ctrlKey || e.metaKey;
		setDraggedId(id);
		setIsCopyDrag(isCopy);
		e.dataTransfer.effectAllowed = isCopy ? 'copy' : 'move';
		setCursorPosition({ x: e.clientX, y: e.clientY });
	}, []);

	const handleDrag = useCallback((e: React.DragEvent) => {
		if (e.clientX !== 0 || e.clientY !== 0) {
			setCursorPosition({ x: e.clientX, y: e.clientY });
		}
		setIsCopyDrag(e.ctrlKey || e.metaKey);
	}, []);

	const handleDragOver = useCallback(
		(e: React.DragEvent, _id: string, index: number) => {
			e.preventDefault();
			isOverDropTargetRef.current = true;
			const isCopy = e.ctrlKey || e.metaKey;
			setIsCopyDrag(isCopy);
			e.dataTransfer.dropEffect = isCopy ? 'copy' : 'move';

			const currentDraggedId = draggedIdRef.current;
			if (!currentDraggedId) return;

			const rect = e.currentTarget.getBoundingClientRect();
			const dropIndex = e.clientY < rect.top + rect.height / 2 ? index : index + 1;

			if (isCopy) {
				setDropTargetIndex(dropIndex);
			} else {
				const draggedIndex = documents.findIndex((doc) => doc.id === currentDraggedId);
				const isNewPosition = dropIndex !== draggedIndex && dropIndex !== draggedIndex + 1;
				setDropTargetIndex(isNewPosition ? dropIndex : null);
			}
		},
		[documents]
	);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		const nextTarget = e.relatedTarget;
		if (nextTarget instanceof Node && e.currentTarget.contains(nextTarget)) return;

		isOverDropTargetRef.current = false;
		setDropTargetIndex(null);
	}, []);

	const performDropOperation = useCallback(
		(force = false) => {
			const currentDraggedId = draggedIdRef.current;
			const currentDropTargetIndex = dropTargetIndexRef.current;
			const currentIsCopyDrag = isCopyDragRef.current;

			if (
				currentDraggedId &&
				currentDropTargetIndex !== null &&
				!dropPerformedRef.current &&
				(force || isOverDropTargetRef.current)
			) {
				dropPerformedRef.current = true;
				setDocuments((prev) => {
					const draggedIndex = prev.findIndex((doc) => doc.id === currentDraggedId);
					if (draggedIndex === -1) return prev;

					const items = [...prev];
					if (currentIsCopyDrag) {
						const original = items[draggedIndex];
						for (let index = 0; index < items.length; index++) {
							if (items[index].filename === original.filename) {
								items[index] = { ...items[index], resetOnCompletion: true };
							}
						}
						items.splice(currentDropTargetIndex, 0, {
							id: generateId(),
							filename: original.filename,
							resetOnCompletion: true,
							isDuplicate: true,
						});
					} else {
						const [removed] = items.splice(draggedIndex, 1);
						const adjustedIndex =
							draggedIndex < currentDropTargetIndex
								? currentDropTargetIndex - 1
								: currentDropTargetIndex;
						items.splice(adjustedIndex, 0, removed);
					}
					return items;
				});
			}
		},
		[setDocuments]
	);

	const resetDragState = useCallback(() => {
		setDraggedId(null);
		setDropTargetIndex(null);
		setIsCopyDrag(false);
		setCursorPosition(null);
		isOverDropTargetRef.current = false;
	}, []);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			performDropOperation(true);
			resetDragState();
		},
		[performDropOperation, resetDragState]
	);

	const handleDragEnd = useCallback(() => {
		performDropOperation();
		resetDragState();
	}, [performDropOperation, resetDragState]);

	return {
		draggedId,
		dropTargetIndex,
		isCopyDrag,
		cursorPosition,
		handleDragStart,
		handleDrag,
		handleDragOver,
		handleDragLeave,
		handleDrop,
		handleDragEnd,
	};
}
