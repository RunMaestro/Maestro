/**
 * Moving an agent to a different working directory.
 *
 * An agent's location is spread across fields that are each written once at
 * creation: `cwd` (where the agent spawns), `fullPath`, `shellCwd`,
 * `projectRoot` (what the Files panel and the Edit dialog read), and
 * `autoRunFolderPath` (normally `<projectRoot>/.maestro/playbooks`). Updating
 * only some of them leaves an agent that runs in one directory while its Files
 * panel lists another (#1565), so a relocation goes through
 * `withWorkingDirectory()` and moves them together.
 */

import {
	isSameDirectory,
	rebasePathOntoRoot,
	workingDirectoryChangeBlocker,
} from '../../shared/agentWorkingDirectory';
import { relocateAgentPaths } from '../../shared/maestro-lib/agents/rules';
import type { Session } from '../types';

/**
 * Return `session` relocated to `newDir`, with every path field moved together
 * (`relocateAgentPaths`, shared with the headless runtime). State that describes
 * the OLD directory (file tree, changed files, git refs) is cleared, so the Files
 * panel reloads from the new root and git polling re-detects the repo instead of
 * showing the previous project's tree. Returns the session untouched when
 * `newDir` is blank or the agent already lives there.
 */
export function withWorkingDirectory(session: Session, newDir: string): Session {
	const moved = relocateAgentPaths(session, newDir);
	if (moved === session) return session;

	return {
		...moved,
		fileTree: [],
		// A load that was in flight for the old root must not be allowed to land.
		// The auto-loader skips a session while `fileTreeLoading` is set, so the
		// flag is cleared here so a fresh load starts. The loader itself refuses
		// to write a scan whose root no longer matches the session, which covers
		// the old request finishing before that fresh load begins.
		fileTreeLoading: false,
		fileTreeLoadingProgress: undefined,
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeStats: undefined,
		fileTreeError: undefined,
		fileTreeRetryAt: undefined,
		fileTreeTruncated: undefined,
		fileTreeLoadedCap: undefined,
		fileTreeLastScanTime: undefined,
	};
}

// Callers import the pure rules from here, as they always have.
export { isSameDirectory, rebasePathOntoRoot, workingDirectoryChangeBlocker };
