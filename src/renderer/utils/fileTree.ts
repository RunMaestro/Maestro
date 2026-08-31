/**
 * File tree construction helpers.
 *
 * Companion to the `FileNode` shape in `src/renderer/types/fileTree.ts`.
 *
 * Distinct from `buildTreeFromPaths()` in `fileExplorer.ts`, which takes a
 * separate directory list plus a file list and produces `FileTreeNode` for the
 * Files panel. This one infers folders from the paths themselves and produces
 * `FileNode`, which is what wiki-link resolution consumes.
 */

import type { FileNode } from '../types/fileTree';

/**
 * Build a nested `FileNode` tree from a flat list of relative file paths.
 *
 * Folders are inferred from the path segments rather than supplied separately,
 * so a caller that only knows which files exist (the Document Graph knows its
 * nodes, not the directories around them) still gets a tree that wiki-link
 * resolution can index.
 *
 * Empty and duplicate-folder paths are tolerated: blank entries are skipped and
 * a folder seen twice is reused rather than duplicated.
 */
export function buildFileTreeFromPaths(filePaths: string[]): FileNode[] {
	const root: FileNode[] = [];
	const folderMap = new Map<string, FileNode>();

	for (const filePath of filePaths) {
		if (!filePath) continue;

		const parts = filePath.split('/');
		let currentLevel = root;
		let currentPath = '';

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLastPart = i === parts.length - 1;
			currentPath = currentPath ? `${currentPath}/${part}` : part;

			if (isLastPart) {
				// It's a file
				currentLevel.push({
					name: part,
					type: 'file',
					fullPath: filePath,
				});
			} else {
				// It's a folder - check if it already exists
				let folder = folderMap.get(currentPath);
				if (!folder) {
					folder = {
						name: part,
						type: 'folder',
						isFolder: true,
						children: [],
					};
					folderMap.set(currentPath, folder);
					currentLevel.push(folder);
				}
				currentLevel = folder.children!;
			}
		}
	}

	return root;
}
