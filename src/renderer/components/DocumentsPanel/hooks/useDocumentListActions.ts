import { useCallback } from 'react';
import type React from 'react';
import type { BatchDocumentEntry } from '../../../types';
import { generateId } from '../../../utils/ids';

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

	const handleAddSelectedDocs = useCallback(
		(selectedDocs: Set<string>) => {
			const existingFilenames = new Set(documents.map((doc) => doc.filename));

			const newDocs: BatchDocumentEntry[] = [];
			selectedDocs.forEach((filename) => {
				if (!existingFilenames.has(filename)) {
					newDocs.push({
						id: generateId(),
						filename,
						resetOnCompletion: false,
						isDuplicate: false,
					});
				}
			});

			const filteredDocs = documents.filter((doc) => selectedDocs.has(doc.filename));
			setDocuments([...filteredDocs, ...newDocs]);
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
