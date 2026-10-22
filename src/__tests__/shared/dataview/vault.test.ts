/**
 * Tests for the pure `FullIndex` pieces in src/shared/dataview/vault.ts: the vault path set behind
 * `prefix`, the Bookmarks flattening behind `starred`, and `resolvedLinks`.
 */

import { describe, expect, it } from 'vitest';
import {
	Link,
	PathFilters,
	VaultPaths,
	buildResolvedLinks,
	isMarkdownPagePath,
	starredPathsFromBookmarks,
} from '../../../shared/dataview';
import type { PageMetadata } from '../../../shared/dataview';

describe('isMarkdownPagePath', () => {
	it('accepts .md only, as Obsidian indexes', () => {
		expect(isMarkdownPagePath('a/Note.md')).toBe(true);
		expect(isMarkdownPagePath('a/NOTE.MD')).toBe(true);
		expect(isMarkdownPagePath('a/Note.markdown')).toBe(false);
		expect(isMarkdownPagePath('data/people.csv')).toBe(false);
	});
});

describe('VaultPaths', () => {
	it('lists every folder and clones into an independent copy', () => {
		const paths = new VaultPaths(['a/b/Note.md'], ['empty']);
		expect(paths.allFolders().sort()).toEqual(['a', 'a/b', 'empty']);

		const copy = paths.clone();
		copy.addFile('c/New.md');
		copy.removeFolder('a');
		expect(paths.allFiles()).toEqual(['a/b/Note.md']);
		expect(paths.nodeExists('a/b')).toBe(true);
		expect(copy.allFiles()).toEqual(['c/New.md']);
		expect(copy.allFolders().sort()).toEqual(['c', 'empty']);
	});

	const paths = new VaultPaths(
		[
			'People/Pedram Amini.md',
			'People/Rami Example.md',
			'meetings/Kickoff.md',
			'data/people.csv',
			'Top.md',
		],
		['Empty']
	);

	it('lists every file under a folder, recursively, with an optional filter', () => {
		expect(paths.get('People')).toEqual(
			new Set(['People/Pedram Amini.md', 'People/Rami Example.md'])
		);
		expect(paths.get('', PathFilters.markdown).size).toBe(4);
		expect(paths.get('/').size).toBe(5);
		expect(paths.get('Empty')).toEqual(new Set());
	});

	it('returns nothing for a prefix that is not a folder, matching exactly and case-sensitively', () => {
		expect(paths.get('Peo')).toEqual(new Set());
		expect(paths.get('people')).toEqual(new Set());
		expect(paths.get('Top.md')).toEqual(new Set());
	});

	it('answers pathExists for files and folders, and nodeExists for folders only', () => {
		expect(paths.pathExists('Top.md')).toBe(true);
		expect(paths.pathExists('People')).toBe(true);
		expect(paths.pathExists('')).toBe(true);
		expect(paths.pathExists('Nope.md')).toBe(false);
		expect(paths.nodeExists('People')).toBe(true);
		expect(paths.nodeExists('Empty')).toBe(true);
		expect(paths.nodeExists('Top.md')).toBe(false);
	});

	it('derives parent folders from files', () => {
		const nested = new VaultPaths(['a/b/c/Note.md']);
		expect(nested.nodeExists('a')).toBe(true);
		expect(nested.nodeExists('a/b')).toBe(true);
		expect(nested.get('a')).toEqual(new Set(['a/b/c/Note.md']));
	});

	it('resolves a relative path against the origin folder only when that file exists', () => {
		const vault = new VaultPaths(['data/people.csv', 'data/sub/x.csv', 'people.csv']);
		expect(vault.resolveRelative('sub/x.csv', 'data/Note.md')).toBe('data/sub/x.csv');
		expect(vault.resolveRelative('people.csv', 'Elsewhere/Note.md')).toBe('people.csv');
		expect(vault.resolveRelative('/data/people.csv', 'x/Note.md')).toBe('data/people.csv');
		expect(vault.resolveRelative('people.csv')).toBe('people.csv');
	});

	it('adds and removes files and folders', () => {
		const vault = new VaultPaths(['a/One.md', 'a/b/Two.md']);
		vault.removeFile('a/One.md');
		expect(vault.hasFile('a/One.md')).toBe(false);
		expect(vault.nodeExists('a')).toBe(true);
		vault.removeFolder('a/b');
		expect(vault.hasFile('a/b/Two.md')).toBe(false);
		expect(vault.nodeExists('a/b')).toBe(false);
		vault.addFile('x/y/Three.md');
		expect(vault.nodeExists('x/y')).toBe(true);
		expect(vault.fileCount).toBe(1);
	});
});

describe('starredPathsFromBookmarks', () => {
	it('flattens groups at every depth and keeps file entries only', () => {
		const stars = starredPathsFromBookmarks({
			items: [
				{ type: 'file', path: 'Top.md', title: '' },
				{ type: 'folder' },
				{
					type: 'group',
					title: 'g',
					items: [
						{ type: 'file', path: 'In Group.md', title: '' },
						{ type: 'group', title: 'h', items: [{ type: 'file', path: 'Deep.md', title: '' }] },
					],
				},
				{ type: 'query' },
			],
		});
		expect(stars).toEqual(new Set(['Top.md', 'In Group.md', 'Deep.md']));
	});

	it('returns an empty set for missing or malformed input', () => {
		expect(starredPathsFromBookmarks(undefined)).toEqual(new Set());
		expect(starredPathsFromBookmarks({ items: 'nope' })).toEqual(new Set());
		expect(starredPathsFromBookmarks({ items: [null, { type: 'file' }] })).toEqual(new Set());
	});
});

describe('buildResolvedLinks', () => {
	const page = (links: Link[]) => ({ links }) as unknown as PageMetadata;

	it('has an entry for every page, counts resolved targets, and skips unresolved ones', () => {
		const exists = new Set(['B.md', 'C.md', 'img.png']);
		const table = buildResolvedLinks(
			[
				[
					'A.md',
					page([Link.file('B.md'), Link.file('B.md'), Link.file('img.png'), Link.file('Missing')]),
				],
				['C.md', page([])],
			],
			(path) => exists.has(path)
		);
		expect(table).toEqual({ 'A.md': { 'B.md': 2, 'img.png': 1 }, 'C.md': {} });
	});
});
