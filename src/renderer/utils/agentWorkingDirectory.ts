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
import type { Session } from '../types';

/**
 * Return `session` relocated to `newDir`, with every path field moved together.
 * State that describes the OLD directory (file tree, changed files, git refs)
 * is cleared, so the Files panel reloads from the new root and git polling
 * re-detects the repo instead of showing the previous project's tree. Returns
 * the session untouched when `newDir` is blank or the agent already lives there.
 */
export function withWorkingDirectory(session: Session, newDir: string): Session {
	const dir = newDir.trim();
	if (!dir) return session;

	const oldRoot = session.projectRoot || session.cwd;
	const ssh = session.sessionSshRemoteConfig;
	// "Already there" means every field that says where the agent lives names
	// `dir`, not just projectRoot: an agent an older `update-agent --cwd` left
	// split (cwd moved, projectRoot did not) is repaired by moving it onto its
	// own projectRoot. `shellCwd` is not compared, because a `cd` in the command
	// terminal moves it on purpose.
	const alreadyThere =
		isSameDirectory(oldRoot, dir) &&
		isSameDirectory(session.cwd, dir) &&
		isSameDirectory(session.fullPath, dir) &&
		(!ssh?.enabled || !ssh.workingDirOverride || isSameDirectory(ssh.workingDirOverride, dir));
	if (alreadyThere) return session;

	return {
		...session,
		cwd: dir,
		fullPath: dir,
		shellCwd: dir,
		projectRoot: dir,
		autoRunFolderPath: session.autoRunFolderPath
			? rebasePathOntoRoot(session.autoRunFolderPath, oldRoot, dir)
			: session.autoRunFolderPath,
		// Over SSH the remote spawn cwd is read from the override, so it moves too.
		sessionSshRemoteConfig: ssh?.enabled ? { ...ssh, workingDirOverride: dir } : ssh,
		// The remote cwd the agent last reported described the old project. New
		// terminal tabs read it ahead of the override, so it must not survive.
		remoteCwd: undefined,
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
		changedFiles: [],
		isGitRepo: false,
		gitBranches: undefined,
		gitTags: undefined,
		gitRefsCacheTime: undefined,
	};
}

// Callers import the pure rules from here, as they always have.
export { isSameDirectory, rebasePathOntoRoot, workingDirectoryChangeBlocker };
