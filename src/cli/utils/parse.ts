// Argument parsing helpers shared by CLI commands.
//
// These exist so every verb spells the same value the same way: `--bookmark
// true`, `tab read-only yes`, and `--sync-history-to-remote 1` all accept the
// same vocabulary. Three near-identical copies of the boolean parser had
// already drifted (one accepted on/off, the others didn't).

import * as path from 'path';
import { expandTilde } from '../../shared/pathUtils';
import { isWindows } from '../../shared/platformDetection';

/** Values that read as `true` / `false` on the command line. */
const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/**
 * Parse a CLI boolean argument. Accepts true/false, 1/0, yes/no, on/off
 * (case-insensitive). Throws with the offending flag named so the caller can
 * report it however it reports its other errors.
 */
export function parseCliBool(value: string, flag: string): boolean {
	const v = String(value).trim().toLowerCase();
	if (TRUE_WORDS.has(v)) return true;
	if (FALSE_WORDS.has(v)) return false;
	throw new Error(`${flag} expects true or false, got "${value}"`);
}

/**
 * Words that clear a per-tab or per-agent override so the value is inherited
 * again (from the agent, or from the global setting). Distinct from `false`:
 * clearing enter-to-send returns the tab to the `enterToSendAI` setting rather
 * than pinning it off.
 */
const INHERIT_WORDS = new Set(['', 'inherit', 'default', 'none', 'clear', 'unset']);

/** True when an argument means "drop the override and inherit". */
export function isInheritValue(value: string): boolean {
	return INHERIT_WORDS.has(String(value).trim().toLowerCase());
}

/**
 * Resolve a path the user typed: `~` expanded, then made absolute against the
 * CLI's cwd. The desktop app's cwd is unrelated (`/` for a Finder launch), so
 * a path must be absolute before it crosses the bridge.
 */
export function resolveCliPath(input: string): string {
	return path.resolve(process.cwd(), expandTilde(input.trim()));
}

/**
 * Resolve an agent working directory the user typed (`--cwd`). Same as
 * `resolveCliPath()`, except on Windows a POSIX absolute path such as
 * `/home/me/repo` is kept as typed: it names a directory on an SSH remote
 * (Linux, WSL), and `path.resolve` would turn it into `C:\home\me\repo`.
 * `--ssh-cwd` is already passed through verbatim for the same reason. A UNC
 * path (`//server/share`) still resolves with the Windows rules.
 */
export function resolveAgentCwdArg(input: string): string {
	const trimmed = input.trim();
	if (isWindows() && trimmed.startsWith('/') && !trimmed.startsWith('//')) {
		return path.posix.normalize(trimmed);
	}
	return resolveCliPath(trimmed);
}
