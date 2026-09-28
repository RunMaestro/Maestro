/**
 * @file fileCategories.test.ts
 * @description Tests for the shared extension -> category table.
 *
 * The invariant that matters here is that `isPreviewableFile` and
 * `getFileCategory` are two views of ONE answer. If they can disagree, a file
 * either shows up under a pill and refuses to open, or is openable but
 * reachable only through `All`.
 */

import { describe, it, expect } from 'vitest';
import {
	FILE_CATEGORIES,
	getFileCategory,
	getFileExtension,
	isPreviewableFile,
	matchesFileCategory,
} from '../../shared/fileCategories';

describe('getFileExtension', () => {
	it('lowercases the extension', () => {
		expect(getFileExtension('Report.PDF')).toBe('pdf');
	});

	it('ignores dots in parent directories', () => {
		expect(getFileExtension('/a.b.c/dir/Makefile')).toBe('');
	});

	it('treats a leading dot as part of the name, not a separator', () => {
		expect(getFileExtension('.gitignore')).toBe('');
	});

	it('takes the last extension of a multi-part name', () => {
		expect(getFileExtension('archive.tar.gz')).toBe('gz');
	});
});

describe('getFileCategory', () => {
	it.each([
		['App.tsx', 'code'],
		['main.py', 'code'],
		['styles.scss', 'code'],
		['deploy.sh', 'code'],
		['Dockerfile', 'code'],
		['Makefile', 'code'],
		['README.md', 'docs'],
		['spec.rst', 'docs'],
		['contract.pdf', 'docs'],
		['LICENSE', 'docs'],
		['package.json', 'data'],
		['cue.yaml', 'data'],
		['rows.csv', 'data'],
		['events.parquet', 'data'],
		['app.log', 'data'],
		['.gitignore', 'data'],
		['.env', 'data'],
		['diagram.svg', 'media'],
		['shot.PNG', 'media'],
		['theme.mp3', 'media'],
		['demo.mp4', 'media'],
	])('classifies %s as %s', (name, expected) => {
		expect(getFileCategory(name)).toBe(expected);
	});

	it.each(['program.exe', 'data.bin', 'archive.zip', 'raw.mkv', 'lib.so'])(
		'returns null for %s, which Maestro cannot open',
		(name) => {
			expect(getFileCategory(name)).toBeNull();
		}
	);

	it('classifies by basename, not by the path around it', () => {
		expect(getFileCategory('/Users/x/notes.md/actually.ts')).toBe('code');
	});
});

describe('isPreviewableFile', () => {
	it('agrees with getFileCategory on every sample', () => {
		const samples = [
			'App.tsx',
			'README.md',
			'package.json',
			'shot.png',
			'theme.mp3',
			'program.exe',
			'archive.zip',
		];
		for (const name of samples) {
			expect(isPreviewableFile(name)).toBe(getFileCategory(name) !== null);
		}
	});
});

describe('matchesFileCategory', () => {
	it('passes everything under "all"', () => {
		expect(matchesFileCategory('program.exe', 'all')).toBe(true);
		expect(matchesFileCategory('App.tsx', 'all')).toBe(true);
	});

	it('passes only the file’s own bucket', () => {
		const matched = FILE_CATEGORIES.filter((key) => matchesFileCategory('App.tsx', key));
		expect(matched).toEqual(['code']);
	});
});
