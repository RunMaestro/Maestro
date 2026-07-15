import type { FileNode } from '../../../types/fileTree';
import { shouldOpenExternally } from '../../../utils/fileExplorer';

/** True when `destFolderRelative` is the same as or a descendant of `sourceRelative`. */
export function isSelfOrDescendant(sourceRelative: string, destFolderRelative: string): boolean {
	return (
		destFolderRelative === sourceRelative || destFolderRelative.startsWith(sourceRelative + '/')
	);
}

/** Returns the parent directory of `relativePath`, or '' for top-level paths. */
export function parentDirOf(relativePath: string): string {
	const idx = relativePath.lastIndexOf('/');
	return idx < 0 ? '' : relativePath.slice(0, idx);
}

/** Returns the basename (last segment) of `relativePath`. */
export function basenameOf(relativePath: string): string {
	const idx = relativePath.lastIndexOf('/');
	return idx < 0 ? relativePath : relativePath.slice(idx + 1);
}

/**
 * Find a node at `relativePath` within the given file tree. Returns null when
 * the path doesn't resolve - treated as "no conflict" so fs:rename can surface
 * any race between this lookup and the actual move.
 */
export function findNodeAtPath(
	fileTree: FileNode[] | undefined,
	relativePath: string
): FileNode | null {
	if (!relativePath) return null;
	const parts = relativePath.split('/').filter(Boolean);
	let children: FileNode[] | undefined = fileTree;
	let node: FileNode | null = null;
	for (const part of parts) {
		if (!children) return null;
		const match: FileNode | undefined = children.find((c) => c.name === part);
		if (!match) return null;
		node = match;
		children = match.children;
	}
	return node;
}

/**
 * Compute "name (2).ext", "name (3).ext", etc. against existing names. Hidden
 * files (".env") keep their leading dot as part of the stem so we don't end
 * up with "(2).env".
 */
export function computeAutoRenameName(existingNames: Set<string>, baseName: string): string {
	if (!existingNames.has(baseName)) return baseName;
	const dotIdx = baseName.lastIndexOf('.');
	const hasExt = dotIdx > 0;
	const stem = hasExt ? baseName.slice(0, dotIdx) : baseName;
	const ext = hasExt ? baseName.slice(dotIdx) : '';
	for (let i = 2; i < 1000; i++) {
		const candidate = `${stem} (${i})${ext}`;
		if (!existingNames.has(candidate)) return candidate;
	}
	return baseName;
}

/**
 * Recursively collect every previewable file under a folder node, paired with
 * its tree-relative path. Files that open in an external app (PDFs, video,
 * archives, binaries, etc.) are skipped.
 */
export function collectPreviewableFiles(
	folderNode: FileNode,
	folderPath: string
): { node: FileNode; path: string }[] {
	const result: { node: FileNode; path: string }[] = [];
	const walk = (nodes: FileNode[] | undefined, basePath: string) => {
		if (!nodes) return;
		for (const child of nodes) {
			const childPath = `${basePath}/${child.name}`;
			if (child.type === 'folder') {
				walk(child.children, childPath);
			} else if (!shouldOpenExternally(child.name)) {
				result.push({ node: child, path: childPath });
			}
		}
	};
	walk(folderNode.children, folderPath);
	return result;
}

/** Format bytes into human-readable format. */
export function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1));
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
