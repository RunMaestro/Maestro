import { describe, it, expect, vi } from 'vitest';
import {
	isSelfOrDescendant,
	parentDirOf,
	basenameOf,
	findNodeAtPath,
	computeAutoRenameName,
	collectPreviewableFiles,
	formatBytes,
} from '../../../../../renderer/components/FileExplorerPanel/utils/pathHelpers';
import type { FileNode } from '../../../../../renderer/types/fileTree';

vi.mock('../../../../../renderer/utils/fileExplorer', () => ({
	shouldOpenExternally: (name: string) => /\.(pdf|mp4|zip|dmg|exe|bin)$/i.test(name),
}));

// ─── isSelfOrDescendant ────────────────────────────────────────────────────

describe('isSelfOrDescendant', () => {
	it('returns true when dest equals source', () => {
		expect(isSelfOrDescendant('src/foo', 'src/foo')).toBe(true);
	});

	it('returns true when dest is a descendant of source', () => {
		expect(isSelfOrDescendant('src', 'src/foo/bar')).toBe(true);
	});

	it('returns false when dest is a sibling', () => {
		expect(isSelfOrDescendant('src/foo', 'src/bar')).toBe(false);
	});

	it('returns false when source name is a prefix but not a path prefix', () => {
		// "src/foobar" starts with "src/foo" but is NOT a descendant
		expect(isSelfOrDescendant('src/foo', 'src/foobar')).toBe(false);
	});

	it('returns false when dest is an ancestor of source', () => {
		expect(isSelfOrDescendant('src/foo/bar', 'src/foo')).toBe(false);
	});
});

// ─── parentDirOf ──────────────────────────────────────────────────────────

describe('parentDirOf', () => {
	it('returns empty string for top-level paths', () => {
		expect(parentDirOf('file.ts')).toBe('');
	});

	it('returns the parent directory', () => {
		expect(parentDirOf('src/foo/bar.ts')).toBe('src/foo');
	});

	it('returns single segment for one-level-deep paths', () => {
		expect(parentDirOf('src/bar.ts')).toBe('src');
	});
});

// ─── basenameOf ───────────────────────────────────────────────────────────

describe('basenameOf', () => {
	it('returns the whole string when there is no slash', () => {
		expect(basenameOf('file.ts')).toBe('file.ts');
	});

	it('returns the last segment', () => {
		expect(basenameOf('src/foo/bar.ts')).toBe('bar.ts');
	});

	it('returns the last folder name', () => {
		expect(basenameOf('src/components')).toBe('components');
	});
});

// ─── findNodeAtPath ───────────────────────────────────────────────────────

describe('findNodeAtPath', () => {
	const tree: FileNode[] = [
		{
			name: 'src',
			type: 'folder',
			children: [
				{
					name: 'components',
					type: 'folder',
					children: [{ name: 'App.tsx', type: 'file' }],
				},
			],
		},
	];

	it('returns null for an empty path', () => {
		expect(findNodeAtPath(tree, '')).toBeNull();
	});

	it('returns null when the tree is undefined', () => {
		expect(findNodeAtPath(undefined, 'src')).toBeNull();
	});

	it('finds a top-level node', () => {
		const node = findNodeAtPath(tree, 'src');
		expect(node?.name).toBe('src');
	});

	it('finds a deeply nested node', () => {
		const node = findNodeAtPath(tree, 'src/components/App.tsx');
		expect(node?.name).toBe('App.tsx');
	});

	it('returns null for a path that does not exist', () => {
		expect(findNodeAtPath(tree, 'src/missing/file.ts')).toBeNull();
	});
});

// ─── computeAutoRenameName ────────────────────────────────────────────────

describe('computeAutoRenameName', () => {
	it('returns the original name when no conflict', () => {
		const existing = new Set(['other.ts']);
		expect(computeAutoRenameName(existing, 'file.ts')).toBe('file.ts');
	});

	it('appends (2) on first conflict', () => {
		const existing = new Set(['file.ts']);
		expect(computeAutoRenameName(existing, 'file.ts')).toBe('file (2).ts');
	});

	it('increments suffix until a free slot is found', () => {
		const existing = new Set(['file.ts', 'file (2).ts', 'file (3).ts']);
		expect(computeAutoRenameName(existing, 'file.ts')).toBe('file (4).ts');
	});

	it('handles files with no extension', () => {
		const existing = new Set(['Makefile']);
		expect(computeAutoRenameName(existing, 'Makefile')).toBe('Makefile (2)');
	});

	it('preserves the leading dot for hidden files (.env → .env (2))', () => {
		const existing = new Set(['.env']);
		// dotIdx = 0 for ".env" → hasExt = false (dotIdx > 0 is false)
		// so stem = ".env", ext = ""
		expect(computeAutoRenameName(existing, '.env')).toBe('.env (2)');
	});

	it('works for batch: two files dropped together do not collide', () => {
		const existing = new Set(['index.ts']);
		const first = computeAutoRenameName(existing, 'index.ts');
		existing.add(first);
		const second = computeAutoRenameName(existing, 'index.ts');
		expect(first).toBe('index (2).ts');
		expect(second).toBe('index (3).ts');
	});
});

// ─── collectPreviewableFiles ──────────────────────────────────────────────

describe('collectPreviewableFiles', () => {
	const folderNode: FileNode = {
		name: 'docs',
		type: 'folder',
		children: [
			{ name: 'readme.md', type: 'file' },
			{ name: 'report.pdf', type: 'file' },
			{
				name: 'images',
				type: 'folder',
				children: [
					{ name: 'logo.png', type: 'file' },
					{ name: 'archive.zip', type: 'file' },
				],
			},
		],
	};

	it('collects only previewable files recursively', () => {
		const result = collectPreviewableFiles(folderNode, 'docs');
		const paths = result.map((r) => r.path);
		expect(paths).toContain('docs/readme.md');
		expect(paths).toContain('docs/images/logo.png');
		expect(paths).not.toContain('docs/report.pdf');
		expect(paths).not.toContain('docs/images/archive.zip');
	});

	it('returns empty array for a folder with no previewable children', () => {
		const node: FileNode = {
			name: 'bin',
			type: 'folder',
			children: [{ name: 'app.exe', type: 'file' }],
		};
		expect(collectPreviewableFiles(node, 'bin')).toHaveLength(0);
	});

	it('handles undefined children gracefully', () => {
		const node: FileNode = { name: 'empty', type: 'folder', children: undefined };
		expect(collectPreviewableFiles(node, 'empty')).toHaveLength(0);
	});
});

// ─── formatBytes ──────────────────────────────────────────────────────────

describe('formatBytes', () => {
	it('formats 0 bytes', () => {
		expect(formatBytes(0)).toBe('0 B');
	});

	it('formats bytes', () => {
		expect(formatBytes(512)).toBe('512 B');
	});

	it('formats kilobytes', () => {
		expect(formatBytes(1024)).toBe('1 KB');
	});

	it('formats megabytes', () => {
		expect(formatBytes(1024 * 1024)).toBe('1 MB');
	});

	it('formats gigabytes', () => {
		expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
	});

	it('rounds to one decimal place', () => {
		expect(formatBytes(1536)).toBe('1.5 KB');
	});

	it('clamps the suffix for values larger than terabytes', () => {
		expect(formatBytes(1024 ** 6)).toBe('1048576 TB');
	});

	it('uses binary units but intentionally trims a zero decimal', () => {
		expect(formatBytes(1024)).toBe('1 KB');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(1024 ** 4)).toBe('1 TB');
	});
});
