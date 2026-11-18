/**
 * @file add-dir-prompt.test.ts
 * @description Tests for src/maestro-p/add-dir-prompt.ts: which directories a
 * maestro-p command line grants, and which directory claude's add-dir dialog
 * names on a replayed screen.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { addDirPromptPaths, grantedAddDirs, isGrantedAddDir } from '../../maestro-p/add-dir-prompt';

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
