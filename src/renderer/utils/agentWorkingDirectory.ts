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

import { joinPath } from '../../shared/formatters';
import type { Session } from '../types';

/** Drop trailing separators so `/a/b/` and `/a/b` compare equal. A bare root is kept. */
function trimTrailingSeparators(p: string): string {
	return p.replace(/[/\\]+$/, '') || p;
}

/**
 * Rebase `target` from under `oldRoot` onto `newRoot`. A path that does not
 * live under `oldRoot` is returned unchanged: an Auto Run folder outside the
 * project was the user's own choice, not something derived from the old root.
 */
export function rebasePathOntoRoot(target: string, oldRoot: string, newRoot: string): string {
	const from = trimTrailingSeparators(oldRoot);
	const to = trimTrailingSeparators(newRoot);
	const current = trimTrailingSeparators(target);
	if (current === from) return to;
	const rest = current.slice(from.length);
	if (current.startsWith(from) && /^[/\\]/.test(rest)) return joinPath(to, rest);
	return target;
}

/**
 * Why the agent's working directory cannot be changed right now, or `null`
 * when it can. A spawned process keeps the cwd it was launched with, so moving
 * the agent mid-turn would leave the process and the UI describing two
 * different directories. Same rule `update-agent --cwd` enforces.
 */
export function workingDirectoryChangeBlocker(
	session: Pick<Session, 'state' | 'aiPid'>
): string | null {
	if (session.state === 'busy' || session.aiPid > 0) {
		return 'Stop the agent before changing its working directory.';
	}
	return null;
}

/**
 * Return `session` relocated to `newDir`, with every path field moved together.
 * State that describes the OLD directory (file tree, changed files, git refs)
 * is cleared, so the Files panel reloads from the new root and git polling
 * re-detects the repo instead of showing the previous project's tree. Returns
 * the session untouched when `newDir` is blank or names the current directory.
 */
export function withWorkingDirectory(session: Session, newDir: string): Session {
	const dir = newDir.trim();
	const oldRoot = session.projectRoot || session.cwd;
	if (!dir || trimTrailingSeparators(dir) === trimTrailingSeparators(oldRoot)) return session;

	const ssh = session.sessionSshRemoteConfig;
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
		fileTree: [],
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
