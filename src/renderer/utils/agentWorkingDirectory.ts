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
 * The form of a path used for comparison. A Windows path (drive letter or a
 * backslash) is lowercased with forward slashes, because Windows matches paths
 * case-insensitively: `C:\Work\old` and `c:\work\old` are one folder. POSIX
 * paths stay case-sensitive. Each mapping is one character to one, so a prefix
 * length measured here also holds for the original string.
 */
function comparablePath(p: string): string {
	const trimmed = trimTrailingSeparators(p);
	return /^[a-zA-Z]:|\\/.test(trimmed) ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed;
}

function samePath(a: string | undefined, b: string): boolean {
	return comparablePath(a ?? '') === comparablePath(b);
}

/**
 * Rebase `target` from under `oldRoot` onto `newRoot`. A path that does not
 * live under `oldRoot` is returned unchanged: an Auto Run folder outside the
 * project was the user's own choice, not something derived from the old root.
 */
export function rebasePathOntoRoot(target: string, oldRoot: string, newRoot: string): string {
	const to = trimTrailingSeparators(newRoot);
	const from = comparablePath(oldRoot);
	const current = comparablePath(target);
	if (current === from) return to;
	const rest = trimTrailingSeparators(target).slice(from.length);
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
		samePath(oldRoot, dir) &&
		samePath(session.cwd, dir) &&
		samePath(session.fullPath, dir) &&
		(!ssh?.enabled || !ssh.workingDirOverride || samePath(ssh.workingDirOverride, dir));
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
