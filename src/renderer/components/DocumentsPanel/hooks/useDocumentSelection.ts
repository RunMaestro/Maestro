import { useCallback, useMemo, useState } from 'react';
import type { BatchDocumentEntry } from '../../../types';
import type { DocTreeNode } from '../types';
import { getFilesInNode } from '../utils/documentTree';
import { getAllDocumentsTaskCount, getSelectedTaskCount } from '../utils/documentCounts';

interface UseDocumentSelectionArgs {
	documents: BatchDocumentEntry[];
	allDocuments: string[];
	taskCounts: Record<string, number>;
}

export function useDocumentSelection({
	documents,
	allDocuments,
	taskCounts,
}: UseDocumentSelectionArgs) {
	const [selectedDocs, setSelectedDocs] = useState<Set<string>>(
		() => new Set(documents.map((doc) => doc.filename))
	);
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

	const toggleDoc = useCallback((filename: string) => {
		setSelectedDocs((prev) => {
			const next = new Set(prev);
			if (next.has(filename)) {
				next.delete(filename);
			} else {
				next.add(filename);
			}
			return next;
		});
	}, []);

	const selectAll = useCallback(() => {
		setSelectedDocs(new Set(allDocuments));
	}, [allDocuments]);

	const deselectAll = useCallback(() => {
		setSelectedDocs(new Set());
	}, []);

	const toggleFolder = useCallback((folderPath: string) => {
		setExpandedFolders((prev) => {
			const next = new Set(prev);
			if (next.has(folderPath)) {
				next.delete(folderPath);
			} else {
				next.add(folderPath);
			}
			return next;
		});
	}, []);

	const toggleFolderSelection = useCallback(
		(node: DocTreeNode) => {
			const files = getFilesInNode(node);
			const allSelected = files.every((file) => selectedDocs.has(file));

			setSelectedDocs((prev) => {
				const next = new Set(prev);
				if (allSelected) {
					files.forEach((file) => next.delete(file));
				} else {
					files.forEach((file) => next.add(file));
				}
				return next;
			});
		},
		[selectedDocs]
	);

	const allSelected =
		allDocuments.length > 0 && allDocuments.every((document) => selectedDocs.has(document));
	const totalTaskCount = useMemo(
		() => getAllDocumentsTaskCount(allDocuments, taskCounts),
		[allDocuments, taskCounts]
	);
	const selectedTaskCount = useMemo(
		() => getSelectedTaskCount(selectedDocs, taskCounts),
		[selectedDocs, taskCounts]
	);

	return {
		selectedDocs,
		expandedFolders,
		toggleDoc,
		selectAll,
		deselectAll,
		toggleFolder,
		toggleFolderSelection,
		allSelected,
		totalTaskCount,
		selectedTaskCount,
	};
}
