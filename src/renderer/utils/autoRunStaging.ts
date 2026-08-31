/**
 * Staging Auto Run documents straight from the Files panel.
 *
 * The playbooks folder shows up in the file tree like any other directory, so a
 * folder of task docs, a single doc, or a hand-picked selection is one
 * right-click away from being a run list. These helpers answer what that takes:
 * is this path inside the agent's Auto Run folder, and which documents does it
 * resolve to.
 *
 * Document ids are always reconciled against the batch store's list rather than
 * read off the file tree. The tree is truncated on large workspaces, and the run
 * list only accepts ids the Auto Run loader already knows about - deriving them
 * from a partial tree would stage names the modal cannot resolve.
 */

/** Strip trailing slashes and normalize Windows separators for comparison. */
function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Path of `absolutePath` relative to the Auto Run folder, or null when it sits
 * outside it. The Auto Run folder itself returns '' (meaning "everything").
 */
export function relativeToAutoRunFolder(
	absolutePath: string | undefined,
	autoRunFolderPath: string | undefined
): string | null {
	if (!absolutePath || !autoRunFolderPath) return null;
	const target = normalizePath(absolutePath);
	const root = normalizePath(autoRunFolderPath);
	if (!root) return null;
	if (target === root) return '';
	if (target.startsWith(`${root}/`)) return target.slice(root.length + 1);
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

/**
 * Document id for a single file inside the Auto Run folder, or null when the
 * file sits outside it or isn't markdown. Only the `.md` extension is dropped:
 * the run list re-appends it when it reads the document back.
 */
export function autoRunDocIdForFile(
	fileAbsolutePath: string | undefined,
	autoRunFolderPath: string | undefined
): string | null {
	const relative = relativeToAutoRunFolder(fileAbsolutePath, autoRunFolderPath);
	if (!relative) return null;
	if (!/\.md$/i.test(relative)) return null;
	return relative.slice(0, -3);
}
