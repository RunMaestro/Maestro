// Argument parsing helpers shared by CLI commands.
//
// These exist so every verb spells the same value the same way: `--bookmark
// true`, `tab read-only yes`, and `--sync-history-to-remote 1` all accept the
// same vocabulary. Three near-identical copies of the boolean parser had
// already drifted (one accepted on/off, the others didn't).

import * as path from 'path';
import { expandTilde } from '../../shared/pathUtils';

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
 * Parse a TCP port argument: a whole number from 0 to 65535 (0 lets the OS
 * pick). Throws with the flag named, like {@link parseCliBool}.
 */
export function parseCliPort(value: string, flag: string): number {
	const v = String(value).trim();
	const port = /^\d+$/.test(v) ? Number(v) : NaN;
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`${flag} expects a port number from 0 to 65535, got "${value}"`);
	}
	return port;
}

/**
 * Parse a whole number of seconds, 0 or more. Throws with the flag named, like
 * {@link parseCliBool}.
 */
export function parseCliSeconds(value: string, flag: string): number {
	const v = String(value).trim();
	const seconds = /^\d+$/.test(v) ? Number(v) : NaN;
	if (!Number.isSafeInteger(seconds)) {
		throw new Error(`${flag} expects a whole number of seconds (0 or more), got "${value}"`);
	}
	return seconds;
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
