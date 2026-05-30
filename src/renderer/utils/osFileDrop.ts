/**
 * Helpers for handling files dragged into Maestro from the OS (Finder on macOS,
 * Explorer on Windows, file managers on Linux).
 *
 * Electron removed the non-standard `File.path` property, so the absolute
 * filesystem path of a dropped file must be recovered via `webUtils`, which is
 * only reachable from the preload context. `window.maestro.fs.getPathForFile`
 * bridges to it. Folders dropped from the OS arrive as a single `File` entry
 * (the directory itself); the resolved path points at the folder and the main
 * process copies it recursively.
 */

/** True when a drag carries OS files (as opposed to an internal element drag). */
export function dragHasOsFiles(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) return false;
	return Array.from(dataTransfer.types).includes('Files');
}

/**
 * Resolve the absolute paths of every OS file/folder in a drop. Entries whose
 * path cannot be resolved (e.g. synthesized File objects with no disk backing)
 * are dropped from the result.
 */
export function getDroppedPaths(dataTransfer: DataTransfer | null): string[] {
	if (!dataTransfer) return [];
	const out: string[] = [];
	const files = dataTransfer.files;
	for (let i = 0; i < files.length; i++) {
		const path = window.maestro.fs.getPathForFile(files[i]);
		if (path) out.push(path);
	}
	return out;
}
