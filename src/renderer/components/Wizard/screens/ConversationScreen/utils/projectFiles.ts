import type { DirectoryEntry } from '../../../../../../shared/types';
import { logger } from '../../../../../utils/logger';

/**
 * Entries that tell us nothing about what the project IS. A folder holding only
 * these is greenfield as far as discovery is concerned: `git init` and a Finder
 * visit are not a project description.
 */
const UNINFORMATIVE_ENTRIES = new Set(['.git', '.DS_Store', 'Thumbs.db', '.idea', '.vscode']);

export function hasInformativeEntries(entries: DirectoryEntry[]): boolean {
	return entries.some((entry) => !UNINFORMATIVE_ENTRIES.has(entry.name));
}

/**
 * Whether the chosen folder already contains a project.
 *
 * This is the fork in the discovery conversation: with files present the agent
 * should open by reading them and saying what it found, and only an empty
 * folder justifies asking the user to describe their project from scratch
 * (issue #1225).
 *
 * Returns `false` on any failure. The cost of being wrong here is one canned
 * opening question instead of an agent turn, so a read error must not block the
 * wizard or raise anything at the user.
 */
export async function projectHasFiles(
	directoryPath: string,
	sshRemoteId?: string
): Promise<boolean> {
	if (!directoryPath.trim()) return false;

	try {
		const entries = await window.maestro.fs.readDir(directoryPath, sshRemoteId);
		return hasInformativeEntries(entries ?? []);
	} catch (error) {
		logger.warn('Failed to check whether the project folder has files:', undefined, error);
		return false;
	}
}
