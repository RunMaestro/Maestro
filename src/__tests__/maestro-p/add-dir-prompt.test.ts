/**
 * @file add-dir-prompt.test.ts
 * @description Tests for src/maestro-p/add-dir-prompt.ts: which directories a
 * maestro-p command line grants, and which directory claude's add-dir dialog
 * names on a replayed screen.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
	addDirPromptPaths,
	grantedAddDirs,
	isGrantedAddDir,
	readAddDirDialog,
} from '../../maestro-p/add-dir-prompt';

const CWD = path.resolve('/work/project');
const abs = (p: string) => path.resolve(CWD, p);

describe('grantedAddDirs()', () => {
	it('collects repeated, variadic, and `=` spellings', () => {
		const granted = grantedAddDirs(
			['--model', 'opus', '--add-dir', '/a', '/b', '--add-dir', '/c', '--add-dir=/d', '--verbose'],
			CWD
		);
		for (const dir of ['/a', '/b', '/c', '/d']) expect(granted.has(abs(dir))).toBe(true);
		expect(granted.has(abs('opus'))).toBe(false);
	});

	it('stops a variadic list at a short flag', () => {
		const granted = grantedAddDirs(['--add-dir', '/a', '-c'], CWD);
		expect(granted.has(abs('-c'))).toBe(false);
		expect(granted.has(abs('/a'))).toBe(true);
	});

	it('resolves relative directories against cwd', () => {
		expect(grantedAddDirs(['--add-dir', '../shared'], CWD).has(abs('../shared'))).toBe(true);
	});

	it('grants nothing without --add-dir', () => {
		expect(grantedAddDirs(['--model', 'opus'], CWD).size).toBe(0);
	});
});

describe('addDirPromptPaths()', () => {
	const screen = (pathRows: string[]) =>
		[
			'────────────',
			' Adding a new directory:',
			'',
			...pathRows.map((row) => ` ${row}`),
			'',
			" This session hasn't worked here before.",
			'',
			' ❯ No, exit',
			'   Yes, add it',
		].join('\n');

	it('reads the path under the heading', () => {
		expect(addDirPromptPaths(screen(['/Users/me/Projects/sec590']))).toEqual([
			'/Users/me/Projects/sec590',
		]);
	});

	it('keeps spaces inside the path', () => {
		expect(addDirPromptPaths(screen(['/Users/me/SANS AI Pentesting']))).toEqual([
			'/Users/me/SANS AI Pentesting',
		]);
	});

	it('offers both readings of a wrapped path', () => {
		expect(addDirPromptPaths(screen(['/Users/me/a very', 'long/dir']))).toEqual([
			'/Users/me/a verylong/dir',
			'/Users/me/a very long/dir',
		]);
	});

	it('reads the newest dialog when several were painted', () => {
		const two = `${screen(['/first'])}\n${screen(['/second'])}`;
		expect(addDirPromptPaths(two)).toEqual(['/second']);
	});

	it('waits while the path is not followed by a blank row yet', () => {
		expect(addDirPromptPaths(' Adding a new directory:\n\n /Users/me/Proj')).toBeNull();
	});

	it('returns null with no dialog on screen', () => {
		expect(addDirPromptPaths(' ❯ Try "edit <filepath>"')).toBeNull();
	});
});

describe('readAddDirDialog()', () => {
	// The dialog as claude 2.1.326 leaves it on screen while it waits.
	const DIALOG = [
		'────────────',
		' Adding a new directory:',
		'',
		' /Users/me/Projects/sec590',
		'',
		" This session hasn't worked here before. Is this a directory you created or one you trust?",
		'',
		' Security guide',
		'',
		'   No, exit',
		' ❯ Yes, add it',
		'',
		' Enter to confirm · Esc to cancel',
	];
	// A resumed conversation is repainted above the input editor.
	const EDITOR = ['', '────────────', '❯ ', '────────────', '  ? for shortcuts'];

	it('reads a dialog that is the last thing on screen', () => {
		expect(readAddDirDialog(DIALOG.join('\n'))).toEqual({
			kind: 'shown',
			paths: ['/Users/me/Projects/sec590'],
		});
	});

	it('waits while the options are not drawn yet', () => {
		expect(readAddDirDialog(DIALOG.slice(0, 6).join('\n'))).toEqual({ kind: 'painting' });
	});

	it('ignores the wording quoted mid-row by a resumed conversation', () => {
		const screen = [
			'⏺ Today\'s error would have read "Adding a new directory: /Users/me/Projects/sec590 … No, exit".',
			...EDITOR,
		].join('\n');
		expect(readAddDirDialog(screen)).toEqual({ kind: 'none' });
	});

	it('ignores the wording quoted in code', () => {
		expect(
			readAddDirDialog('  //   Adding a new directory:\n  //\n  //   /Users/me/other')
		).toEqual({
			kind: 'none',
		});
	});

	it('ignores a whole dialog quoted in a resumed conversation above the input editor', () => {
		expect(readAddDirDialog([...DIALOG, ...EDITOR].join('\n'))).toEqual({ kind: 'none' });
	});

	it('ignores a quoted heading that starts a row once the input editor is drawn below it', () => {
		const screen = [
			'  Adding a new directory: /Users/me/other',
			'  and then claude quit.',
			...EDITOR,
		];
		expect(readAddDirDialog(screen.join('\n'))).toEqual({ kind: 'none' });
	});

	it('returns none with no heading on screen', () => {
		expect(readAddDirDialog(EDITOR.join('\n'))).toEqual({ kind: 'none' });
	});
});

describe('isGrantedAddDir()', () => {
	const granted = grantedAddDirs(['--add-dir', '/work/shared'], CWD);

	it('matches a granted directory', () => {
		expect(isGrantedAddDir(['/work/shared'], granted, CWD)).toBe(true);
	});

	it('refuses a sibling that only shares a prefix', () => {
		expect(isGrantedAddDir(['/work/shared-evil'], granted, CWD)).toBe(false);
	});

	it('matches when either reading of a wrapped path is granted', () => {
		expect(isGrantedAddDir(['/work/sha red', '/work/shared'], granted, CWD)).toBe(true);
	});
});
