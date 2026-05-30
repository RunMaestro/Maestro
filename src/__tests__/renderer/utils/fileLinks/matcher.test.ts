import { describe, it, expect } from 'vitest';
import {
	buildFileTreeIndices,
	calculateProximity,
	findClosestMatch,
	toRelativePath,
	validatePathReference,
	type FileTreeIndices,
} from '../../../../renderer/utils/fileLinks/matcher';
import type { FileNode } from '../../../../renderer/types/fileTree';

const makeTree = (paths: string[]): FileNode[] => {
	const root: FileNode[] = [];
	for (const path of paths) {
		const parts = path.split('/');
		let cursor = root;
		for (let i = 0; i < parts.length; i++) {
			const segment = parts[i];
			const isLast = i === parts.length - 1;
			let node = cursor.find((n) => n.name === segment);
			if (!node) {
				node = {
					name: segment,
					type: isLast ? 'file' : 'folder',
					children: isLast ? undefined : [],
				};
				cursor.push(node);
			}
			if (!isLast) {
				if (!node.children) node.children = [];
				cursor = node.children;
			}
		}
	}
	return root;
};

const indicesFrom = (paths: string[]): FileTreeIndices => buildFileTreeIndices(makeTree(paths));

describe('calculateProximity', () => {
	it('returns 1 when file is one level under cwd (0 steps up + 1 step down)', () => {
		expect(calculateProximity('docs/x.md', 'docs')).toBe(1);
	});

	it('grows when the file lives deeper than the cwd', () => {
		expect(calculateProximity('docs/sub/x.md', 'docs')).toBe(2);
	});

	it('grows when cwd is deeper than the common prefix', () => {
		expect(calculateProximity('docs/x.md', 'docs/deeply/nested')).toBe(3); // 2 up + 1 down
	});

	it('treats unrelated paths as fully disjoint', () => {
		expect(calculateProximity('a/b/c.md', 'x/y')).toBe(5); // 2 up + 3 down
	});

	it('ignores empty cwd segments', () => {
		expect(calculateProximity('a/b.md', '')).toBe(2);
	});
});

describe('buildFileTreeIndices', () => {
	it('returns empty indices for an empty tree', () => {
		const { allPaths, filenameIndex } = buildFileTreeIndices([]);
		expect(allPaths.size).toBe(0);
		expect(filenameIndex.size).toBe(0);
	});

	it('indexes a flat tree by full path', () => {
		const idx = indicesFrom(['a.md', 'b.md']);
		expect(idx.allPaths.has('a.md')).toBe(true);
		expect(idx.allPaths.has('b.md')).toBe(true);
	});

	it('indexes filenames so wiki-links can resolve by basename', () => {
		const idx = indicesFrom(['docs/Notes.md']);
		expect(idx.filenameIndex.get('Notes.md')).toEqual(['docs/Notes.md']);
	});

	it('also indexes filenames without .md so [[Note]] resolves to Note.md', () => {
		const idx = indicesFrom(['docs/Notes.md']);
		expect(idx.filenameIndex.get('Notes')).toEqual(['docs/Notes.md']);
	});

	it('groups multiple files sharing a filename under one filename key', () => {
		const idx = indicesFrom(['a/README.md', 'b/README.md']);
		expect(idx.filenameIndex.get('README.md')).toEqual(['a/README.md', 'b/README.md']);
	});

	it('groups by base name without .md as well', () => {
		const idx = indicesFrom(['a/README.md', 'b/README.md']);
		expect(idx.filenameIndex.get('README')).toEqual(['a/README.md', 'b/README.md']);
	});
});

describe('findClosestMatch', () => {
	it('returns null when reference matches nothing', () => {
		const idx = indicesFrom(['docs/x.md']);
		expect(findClosestMatch('nope', idx, 'docs')).toBeNull();
	});

	it('returns an exact full-path match unchanged', () => {
		const idx = indicesFrom(['docs/x.md']);
		expect(findClosestMatch('docs/x.md', idx, '')).toBe('docs/x.md');
	});

	it('appends .md when an exact match is found with the extension', () => {
		const idx = indicesFrom(['docs/Note.md']);
		expect(findClosestMatch('docs/Note', idx, '')).toBe('docs/Note.md');
	});

	it('resolves wiki-style basename to a unique full path', () => {
		const idx = indicesFrom(['notes/Hello World.md']);
		expect(findClosestMatch('Hello World', idx, '')).toBe('notes/Hello World.md');
	});

	it('disambiguates duplicate basenames by cwd proximity', () => {
		const idx = indicesFrom(['a/sub/README.md', 'b/README.md']);
		expect(findClosestMatch('README', idx, 'b')).toBe('b/README.md');
		expect(findClosestMatch('README', idx, 'a/sub')).toBe('a/sub/README.md');
	});

	it('filters by partial path when reference contains a slash', () => {
		const idx = indicesFrom(['a/Notes.md', 'b/Notes.md']);
		expect(findClosestMatch('a/Notes', idx, '')).toBe('a/Notes.md');
	});

	it('falls back to filename when partial-path filter yields nothing', () => {
		// Reference with a slash that doesn't end-match any candidate; the
		// matcher keeps the original candidate set and chooses by proximity.
		const idx = indicesFrom(['a/x.md', 'b/x.md']);
		const got = findClosestMatch('elsewhere/x', idx, 'b');
		expect(got).toBe('b/x.md');
	});
});

describe('validatePathReference', () => {
	it('returns the path when present', () => {
		const idx = indicesFrom(['docs/x.md']);
		expect(validatePathReference('docs/x.md', idx)).toBe('docs/x.md');
	});

	it('appends .md when only the extension-less form was supplied', () => {
		const idx = indicesFrom(['docs/x.md']);
		expect(validatePathReference('docs/x', idx)).toBe('docs/x.md');
	});

	it('returns null when the path does not exist', () => {
		const idx = indicesFrom(['docs/x.md']);
		expect(validatePathReference('docs/missing.md', idx)).toBeNull();
	});

	it('does NOT use proximity matching (unlike findClosestMatch)', () => {
		const idx = indicesFrom(['a/README.md', 'b/README.md']);
		// Plain basename → no exact match → null.
		expect(validatePathReference('README', idx)).toBeNull();
	});
});

describe('toRelativePath', () => {
	it('returns null when projectRoot is undefined', () => {
		expect(toRelativePath('/x/y/z.md', undefined)).toBeNull();
	});

	it('returns null when the path is outside projectRoot', () => {
		expect(toRelativePath('/tmp/x.md', '/Users/me/proj')).toBeNull();
	});

	it('strips the projectRoot prefix', () => {
		expect(toRelativePath('/Users/me/proj/docs/x.md', '/Users/me/proj')).toBe('docs/x.md');
	});

	it('handles a trailing slash on the projectRoot', () => {
		expect(toRelativePath('/Users/me/proj/docs/x.md', '/Users/me/proj/')).toBe('docs/x.md');
	});

	it('does not strip a partial directory prefix', () => {
		// /Users/me/projector/x.md starts with /Users/me/proj but is in a
		// different directory; we should refuse to strip.
		expect(toRelativePath('/Users/me/projector/x.md', '/Users/me/proj')).toBeNull();
	});
});
