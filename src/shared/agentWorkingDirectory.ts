/**
 * The pure rules about an agent's working directory, shared by the desktop
 * renderer and the TUI: when two paths name the same directory, how a path
 * under the old root moves to a new one, and when a move is refused. The
 * renderer's `withWorkingDirectory()` (which rewrites a whole `Session`) stays in
 * `src/renderer/utils/agentWorkingDirectory.ts` and builds on these.
 */

import { joinPath } from './formatters';

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
 * The form of a path used for comparison. A path that starts with `/` is
 * POSIX: case-sensitive, and a backslash in it is an ordinary character. Any
 * other path is Windows (`C:\...`, `\\server\share`): lowercased with forward
 * slashes, because Windows matches paths case-insensitively and accepts either
 * separator. Each mapping is one character to one, so a prefix length measured
 * here also holds for the original string.
 */
function comparablePath(p: string): string {
	const trimmed = trimTrailingSeparators(p);
	return trimmed.startsWith('/') ? trimmed : trimmed.replace(/\\/g, '/').toLowerCase();
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
export function workingDirectoryChangeBlocker(session: {
	state?: string;
	aiPid?: number;
}): string | null {
	if (session.state === 'busy' || session.state === 'connecting' || (session.aiPid ?? 0) > 0) {
		return 'Stop the agent before changing its working directory.';
	}
	return null;
}
