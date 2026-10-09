import { useCallback } from 'react';
import type React from 'react';
import type { BatchDocumentEntry } from '../../../types';
import { generateId } from '../../../utils/ids';
import { applySelectionOrder } from '../../../utils/documentSelectionOrder';

interface UseDocumentListActionsArgs {
	documents: BatchDocumentEntry[];
	setDocuments: React.Dispatch<React.SetStateAction<BatchDocumentEntry[]>>;
	onAddComplete?: () => void;
}

export function useDocumentListActions({
	documents,
	setDocuments,
	onAddComplete,
}: UseDocumentListActionsArgs) {
	const handleRemoveDocument = useCallback(
		(id: string) => {
			setDocuments((prev) => prev.filter((doc) => doc.id !== id));
		},
		[setDocuments]
	);

	const handleToggleReset = useCallback(
		(id: string) => {
			setDocuments((prev) =>
				prev.map((doc) =>
					doc.id === id ? { ...doc, resetOnCompletion: !doc.resetOnCompletion } : doc
				)
			);
		},
		[setDocuments]
	);

	const handleDuplicateDocument = useCallback(
		(id: string) => {
			setDocuments((prev) => {
				const index = prev.findIndex((doc) => doc.id === id);
				if (index === -1) return prev;

				const original = prev[index];
				const duplicate: BatchDocumentEntry = {
					id: generateId(),
					filename: original.filename,
					resetOnCompletion: original.resetOnCompletion,
					isDuplicate: true,
				};

				return [...prev.slice(0, index + 1), duplicate, ...prev.slice(index + 1)];
			});
		},
		[setDocuments]
	);

	// The run list follows the picker's selection order: documents appear in the
	// order the user clicked them (or clicked the folder holding them). Entries
	// already in the list keep their id, reset flag, and duplicates - the picker
	// seeds its selection from the list, so an order built by dragging rows is
	// carried straight back in.
	const handleAddSelectedDocs = useCallback(
		(selectedDocs: Set<string>) => {
			setDocuments(
				applySelectionOrder(documents, selectedDocs, (filename) => ({
					id: generateId(),
					filename,
					resetOnCompletion: false,
					isDuplicate: false,
				}))
			);
			onAddComplete?.();
		},
		[documents, onAddComplete, setDocuments]
	);

	return {
		handleRemoveDocument,
		handleToggleReset,
		handleDuplicateDocument,
		handleAddSelectedDocs,
	};
}
