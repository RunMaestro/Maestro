import fs from 'fs';
import os from 'os';
import path from 'path';

export interface CompleteDirectoryOptions {
	/** What `~` means. Defaults to the current user's home. */
	homeDir?: string;
	/** At most this many candidates. Default 8. */
	limit?: number;
}

const DEFAULT_LIMIT = 8;

/**
 * Directory candidates for a path typed so far, for a working-directory field.
 *
 * `~/Pro` lists `~/Projects/`, `~/Programs/`. Each candidate is the whole path
 * in the form the user typed it (a leading `~` stays `~`), ends in a separator,
 * and is a directory: a file can never be a working directory. A path ending in
 * a separator lists that directory's children. Hidden directories appear only
 * once the user types the dot, so `~/` does not open with a screen of dotfiles.
 *
 * Reads the local disk. A caller completing a path for an SSH remote must not
 * call it: the typed path names a directory on the other machine.
 *
 * Never throws: an unreadable or missing directory has no candidates.
 */
export function completeDirectoryPath(
	typed: string,
	options: CompleteDirectoryOptions = {}
): string[] {
	if (!typed) return [];
	const home = options.homeDir ?? os.homedir();
	const limit = options.limit ?? DEFAULT_LIMIT;

	const expand = (value: string): string =>
		value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value;

	// `~` alone is the home directory itself; offer its children with the separator typed for the user.
	const text = typed === '~' ? '~/' : typed;
	const split = text.lastIndexOf('/');
	if (split < 0) return [];
	const parentTyped = text.slice(0, split + 1);
	const prefix = text.slice(split + 1);
	const parent = expand(parentTyped);
	if (!path.isAbsolute(parent)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(parent, { withFileTypes: true });
	} catch {
		return [];
	}

	const lowered = prefix.toLowerCase();
	const showHidden = prefix.startsWith('.');
	const names: string[] = [];
	for (const entry of entries) {
		if (!showHidden && entry.name.startsWith('.')) continue;
		if (!entry.name.toLowerCase().startsWith(lowered)) continue;
		if (!isDirectoryEntry(entry, parent)) continue;
		names.push(entry.name);
	}
	// Plain lowercase order, not `localeCompare`: the list must read the same on every machine.
	names.sort((a, b) => {
		const [x, y] = [a.toLowerCase(), b.toLowerCase()];
		return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
	});
	return names.slice(0, limit).map((name) => `${parentTyped}${name}/`);
}

/** A symlink to a directory counts; a dangling or file link does not. */
function isDirectoryEntry(entry: fs.Dirent, parent: string): boolean {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return fs.statSync(path.join(parent, entry.name)).isDirectory();
	} catch {
		return false;
	}
}
