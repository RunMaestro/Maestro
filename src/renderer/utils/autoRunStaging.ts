/**
 * Staging Auto Run documents straight from the Files panel.
 *
 * The playbooks folder shows up in the file tree like any other directory, so a
 * folder of task docs is one right-click away from being a run list. These two
 * helpers answer what that takes: is this folder inside the agent's Auto Run
 * folder, and which documents live under it.
 *
 * Document ids come from the batch store's list rather than from the file tree.
 * The tree is truncated on large workspaces, and the run list only accepts ids
 * the Auto Run loader already knows about - deriving them from a partial tree
 * would stage names the modal cannot resolve.
 */

/** Strip trailing slashes and normalize Windows separators for comparison. */
function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Path of `folderAbsolutePath` relative to the Auto Run folder, or null when it
 * sits outside it. The Auto Run folder itself returns '' (stage everything).
 */
export function relativeAutoRunFolderPath(
	folderAbsolutePath: string | undefined,
	autoRunFolderPath: string | undefined
): string | null {
	if (!folderAbsolutePath || !autoRunFolderPath) return null;
	const folder = normalizePath(folderAbsolutePath);
	const root = normalizePath(autoRunFolderPath);
	if (!root) return null;
	if (folder === root) return '';
	if (folder.startsWith(`${root}/`)) return folder.slice(root.length + 1);
	return null;
}

/**
 * Auto Run document ids (relative to the Auto Run folder, without `.md`) that
 * live under `relativeFolder`, including nested subfolders. An empty
 * `relativeFolder` means the Auto Run folder itself, so every document matches.
 * Order follows `documentList`, which the loader keeps sorted.
 */
export function collectAutoRunDocsInFolder(
	relativeFolder: string,
	documentList: string[]
): string[] {
	const normalized = normalizePath(relativeFolder);
	if (!normalized) return [...documentList];
	const prefix = `${normalized}/`;
	return documentList.filter((doc) => normalizePath(doc).startsWith(prefix));
}
