import type { DocTreeNode } from '../types';

export function getFilesInNode(node: DocTreeNode): string[] {
	if (node.type === 'file') {
		return [node.path];
	}
	if (node.children) {
		return node.children.flatMap((child) => getFilesInNode(child));
	}
	return [];
}

export function isFolderFullySelected(node: DocTreeNode, selectedDocs: Set<string>): boolean {
	const files = getFilesInNode(node);
	return files.length > 0 && files.every((file) => selectedDocs.has(file));
}

export function isFolderPartiallySelected(node: DocTreeNode, selectedDocs: Set<string>): boolean {
	const files = getFilesInNode(node);
	const selectedCount = files.filter((file) => selectedDocs.has(file)).length;
	return selectedCount > 0 && selectedCount < files.length;
}

export function getFolderTaskCount(node: DocTreeNode, taskCounts: Record<string, number>): number {
	return getFilesInNode(node).reduce((sum, file) => sum + (taskCounts[file] ?? 0), 0);
}
