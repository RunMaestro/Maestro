import type { BatchDocumentEntry } from '../../../types';

export function getDocumentTaskCount(taskCounts: Record<string, number>, filename: string): number {
	return taskCounts[filename] ?? 0;
}

export function getTotalDocumentTaskCount(
	documents: BatchDocumentEntry[],
	taskCounts: Record<string, number>
): number {
	return documents.reduce((sum, doc) => {
		if (doc.isMissing) return sum;
		return sum + (taskCounts[doc.filename] || 0);
	}, 0);
}

export function getSelectedTaskCount(
	selectedDocs: Set<string>,
	taskCounts: Record<string, number>
): number {
	let count = 0;
	selectedDocs.forEach((doc) => {
		count += taskCounts[doc] ?? 0;
	});
	return count;
}

export function getAllDocumentsTaskCount(
	allDocuments: string[],
	taskCounts: Record<string, number>
): number {
	return allDocuments.reduce((sum, filename) => sum + (taskCounts[filename] ?? 0), 0);
}

export function getMissingDocumentCount(documents: BatchDocumentEntry[]): number {
	return documents.filter((doc) => doc.isMissing).length;
}

export function hasDuplicateFilename(documents: BatchDocumentEntry[], filename: string): boolean {
	return documents.filter((doc) => doc.filename === filename).length > 1;
}

export function canDisableReset(documents: BatchDocumentEntry[], filename: string): boolean {
	return !hasDuplicateFilename(documents, filename);
}
