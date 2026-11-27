// claude 2.1.326 added a trust dialog for every `--add-dir` directory a session
// has not worked in, painted before the input editor, one dialog per directory:
//
//   Adding a new directory:
//
//   /Users/me/Projects/other
//
//   This session hasn't worked here before. Is this a directory you created or
//   one you trust? ...
//
//   ❯ No, exit
//     Yes, add it
//
// "No, exit" is the default, and `--dangerously-skip-permissions` does not skip
// it. The driver's blind startup Enter therefore confirmed "No, exit" and claude
// quit, so every TUI turn of an agent with extra directories failed as
// `tui_exited` with nothing on screen to explain it.
//
// The caller asked for these directories by name on the command line, so the
// driver answers "Yes, add it" for them. It answers only for a directory it can
// read off the screen AND find among the `--add-dir` values it was given: the
// dialog is also claude's guard against directories that arrive by other routes
// (a project's settings), and those stay the user's call.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isFlagToken } from './args';

/** The dialog's heading, in raw or ANSI-stripped-without-padding output. */
export const ADD_DIR_PROMPT_REGEX = /Adding\s*a\s*new\s*directory/i;

/** The dialog's confirming option under the `❯` selector. */
export const ADD_DIR_SELECTOR_YES_REGEX = /❯\s*(?:\d+\.\s*)?Yes,?\s*add\s*it/gi;

const HEADING_ROW_REGEX = /Adding a new directory:?/i;

// The dialog draws its heading at the start of a row. Text that merely quotes
// it (a resumed conversation about this very dialog, a code comment, a bullet)
// has something in front of it.
const HEADING_AT_ROW_START_REGEX = /^[\s│]*Adding a new directory:?/i;
// One of the dialog's own options, highlighted or not, alone on its row.
const OPTION_ROW_REGEX = /^[\s│]*(?:[›❯]\s*)?(?:\d+\.\s*)?(?:No,?\s*exit|Yes,?\s*add\s*it)[\s│]*$/i;
const YES_OPTION_ROW_REGEX = /^[\s│]*(?:[›❯]\s*)?(?:\d+\.\s*)?Yes,?\s*add\s*it[\s│]*$/i;
const FOOTER_ROW_REGEX = /Enter\s*to\s*confirm|Esc\s*to\s*(?:cancel|exit)/i;
// A selector or the input editor's prompt.
const SELECTOR_ROW_REGEX = /^[\s│]*[›❯]/;

// commander ends a variadic option at any option token, short ones included.
function endsVariadic(token: string): boolean {
	return isFlagToken(token) || /^-[A-Za-z]/.test(token);
}

function normalizeDir(dir: string, cwd: string): string {
	return path.resolve(cwd, dir);
}

/**
 * Every directory `args` grants with `--add-dir` (variadic, repeatable, or
 * `--add-dir=<dir>`), resolved against `cwd`. Each one is held both as given and
 * with symlinks resolved, since claude may show either.
 */
export function grantedAddDirs(args: readonly string[], cwd: string): Set<string> {
	const dirs = new Set<string>();
	const add = (dir: string): void => {
		if (dir.length === 0) return;
		const resolved = normalizeDir(dir, cwd);
		dirs.add(resolved);
		try {
			dirs.add(fs.realpathSync.native(resolved));
		} catch {
			// Missing directory: claude refuses it on its own, nothing to match.
		}
	};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg.startsWith('--add-dir=')) {
			add(arg.slice('--add-dir='.length));
			continue;
		}
		if (arg !== '--add-dir') continue;
		while (i + 1 < args.length && !endsVariadic(args[i + 1])) {
			i += 1;
			add(args[i]);
		}
	}
	return dirs;
}

/**
 * The directory the newest add-dir dialog on `screen` (a replayed grid, see
 * screen-replay.ts) asks about. A path claude wrapped across rows comes back in
 * both possible spellings: joined as is, and with the break read as a space.
 * Null while the path is not fully painted yet, which a blank row after it
 * proves.
 */
export function addDirPromptPaths(screen: string): string[] | null {
	const rows = screen.split('\n');
	let heading = -1;
	for (let i = rows.length - 1; i >= 0; i -= 1) {
		if (HEADING_ROW_REGEX.test(rows[i])) {
			heading = i;
			break;
		}
	}
	if (heading < 0) return null;
	const sameRow = rows[heading].replace(/^.*?Adding a new directory:?/i, '').trim();
	if (sameRow.length > 0) return [sameRow];
	let i = heading + 1;
	while (i < rows.length && rows[i].trim() === '') i += 1;
	const parts: string[] = [];
	while (i < rows.length && rows[i].trim() !== '') {
		parts.push(rows[i].trim());
		i += 1;
	}
	if (parts.length === 0 || i >= rows.length) return null;
	return parts.length === 1 ? parts : [parts.join(''), parts.join(' ')];
}

/**
 * What `screen` (a replayed grid) shows of claude's add-dir dialog:
 * - `none`: no dialog. Either the heading is absent, or it is text further up
 *   the screen: quoted mid-row, or followed by the input editor or by rows the
 *   dialog never draws. `--resume` repaints the conversation before the input
 *   editor, so a conversation that discussed this dialog puts its wording on
 *   the startup screen.
 * - `painting`: the heading starts a row and nothing contradicts a dialog yet,
 *   but its path or its options are not drawn.
 * - `shown`: the whole dialog is the last thing on screen, as claude leaves it
 *   while it waits for an answer.
 */
export type AddDirDialogRead =
	| { kind: 'none' }
	| { kind: 'painting' }
	| { kind: 'shown'; paths: string[] };

export function readAddDirDialog(screen: string): AddDirDialogRead {
	const rows = screen.split('\n');
	let heading = -1;
	for (let i = rows.length - 1; i >= 0; i -= 1) {
		if (HEADING_AT_ROW_START_REGEX.test(rows[i])) {
			heading = i;
			break;
		}
	}
	if (heading < 0) return { kind: 'none' };
	const below = rows.slice(heading + 1);
	const yes = below.findIndex((row) => YES_OPTION_ROW_REGEX.test(row));
	if (yes < 0) {
		const foreignSelector = below.some(
			(row) => SELECTOR_ROW_REGEX.test(row) && !OPTION_ROW_REGEX.test(row)
		);
		return foreignSelector ? { kind: 'none' } : { kind: 'painting' };
	}
	const foreignTail = below
		.slice(yes + 1)
		.some((row) => row.trim() !== '' && !OPTION_ROW_REGEX.test(row) && !FOOTER_ROW_REGEX.test(row));
	if (foreignTail) return { kind: 'none' };
	const paths = addDirPromptPaths(rows.slice(heading).join('\n'));
	return paths ? { kind: 'shown', paths } : { kind: 'painting' };
}

/** Whether any spelling of the dialog's directory is one the caller granted. */
export function isGrantedAddDir(
	shown: readonly string[],
	granted: ReadonlySet<string>,
	cwd: string
): boolean {
	return shown.some((dir) => granted.has(normalizeDir(dir, cwd)));
}
