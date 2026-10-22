/**
 * Auto Run document names, as every runner stores and reads them.
 *
 * A playbook or batch run names each document RELATIVE to the agent's Auto Run
 * folder and WITHOUT `.md` (`subdir/phase-1`). Both runners join it back the
 * same way: `${folderPath}/${filename}.md`. Remote callers (the CLI's
 * `auto-run`, a Cue `autorun` subscription) send absolute `.md` paths instead,
 * so they must be converted before a playbook is saved or a run is launched.
 *
 * A document outside the folder is refused by name. The old fallback reduced
 * it to its basename, which silently stored or ran a different file (or one
 * that does not exist, which the runners count as zero tasks).
 */

import { isAbsolutePath } from './formatters';
import { normalizeWorktreePath } from './worktreePaths';

export type AutoRunDocumentNameResult = { name: string } | { error: string };

/**
 * Convert one document path to its folder-relative name without `.md`.
 *
 * Accepts an absolute path under `folderPath` (matched case-insensitively, so
 * Windows drive letters and macOS casing agree) or a name that is already
 * folder-relative. Refuses an absolute path outside the folder and any name
 * that climbs out of it with `..`.
 */
export function resolveAutoRunDocumentName(
	filename: string,
	folderPath: string
): AutoRunDocumentNameResult {
	const raw = filename.trim();
	if (!raw) return { error: 'Document path is empty' };

	const normalized = normalizeWorktreePath(raw);
	let relative: string;
	if (isAbsolutePath(raw)) {
		const folder = normalizeWorktreePath(folderPath);
		const prefix = `${folder}/`;
		if (!folder || !normalized.toLowerCase().startsWith(prefix.toLowerCase())) {
			return { error: `Document is outside the Auto Run folder (${folderPath}): ${filename}` };
		}
		relative = normalized.slice(prefix.length);
	} else {
		relative = normalized.replace(/^(\.\/)+/, '');
	}

	const name = relative.replace(/\.md$/i, '');
	if (!name || name.split('/').some((segment) => segment === '..' || segment === '')) {
		return { error: `Document is outside the Auto Run folder (${folderPath}): ${filename}` };
	}
	return { name };
}

/**
 * Convert a list of documents, keeping every other field of each entry.
 * Returns the first refusal so the caller can name the offending document.
 */
export function resolveAutoRunDocumentNames<T extends { filename: string }>(
	documents: T[],
	folderPath: string
): { documents: T[] } | { error: string } {
	const resolved: T[] = [];
	for (const doc of documents) {
		const result = resolveAutoRunDocumentName(doc.filename, folderPath);
		if ('error' in result) return result;
		resolved.push({ ...doc, filename: result.name });
	}
	return { documents: resolved };
}
