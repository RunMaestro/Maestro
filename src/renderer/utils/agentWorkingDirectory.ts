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

/**
 * Drop trailing separators so `/a/b/` and `/a/b` compare equal. A bare root
 * keeps one: `/` stays `/`, and `C:\` stays `C:\` rather than becoming the
 * drive-relative `C:`.
 */
function trimTrailingSeparators(p: string): string {
	const trimmed = p.replace(/[/\\]+$/, '');
	if (!trimmed) return p;
	if (/^[a-zA-Z]:$/.test(trimmed)) return trimmed + p.charAt(trimmed.length);
	return trimmed;
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

/**
 * Whether two paths name the same directory: trailing separators are ignored,
 * and Windows paths compare case-insensitively. Use this, not `===`, when
 * deciding whether a user-entered directory differs from the agent's current
 * one, so `/a/b/` is not reported as a move away from `/a/b`.
 */
export function isSameDirectory(a: string | undefined, b: string | undefined): boolean {
	return comparablePath(a ?? '') === comparablePath(b ?? '');
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
	if (!current.startsWith(from)) return target;
	const rest = trimTrailingSeparators(target).slice(from.length);
	// A bare root (`/`, `C:\`) keeps its separator, so `rest` has none to check:
	// everything absolute lives under it. Anywhere else the separator is what
	// separates `/projects/old/docs` from the sibling `/projects/old-archive`.
	const fromIsBareRoot = /[/\\]$/.test(from);
	if (fromIsBareRoot || /^[/\\]/.test(rest)) return joinPath(to, rest);
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
	if (session.state === 'busy' || session.state === 'connecting' || session.aiPid > 0) {
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
