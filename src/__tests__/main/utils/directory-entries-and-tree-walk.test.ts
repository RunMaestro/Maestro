// Source: src/__tests__/main/utils/file-tree-walk.test.ts
// Source: src/__tests__/main/utils/dirent-utils.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import path from 'path';
import { walkLocalFileTree } from '../../../main/utils/file-tree-walk';
import fs from 'fs/promises';
import { resolveDirentType } from '../../../main/utils/dirent-utils';
import { readDirWithResolvedTypes } from '../../../main/utils/dirent-utils';
vi.mock('fs/promises', () => ({
	default: {
		readdir: vi.fn(),
		readFile: vi.fn(),
		stat: vi.fn(),
	},
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
describe('file-tree-walk', () => {
	type FakeEntry = { name: string; kind: 'file' | 'dir' | 'symlink' };

	/** Build a Dirent-shaped object for the mocked `readdir`. */
	const dirent = (entry: FakeEntry) => ({
		name: entry.name,
		isDirectory: () => entry.kind === 'dir',
		isFile: () => entry.kind === 'file',
		isSymbolicLink: () => entry.kind === 'symlink',
	});

	/**
	 * A path as this test writes it, whatever separator the walker produced.
	 *
	 * The walker descends with `path.join`, which emits backslashes on Windows, so
	 * a directory map keyed by a literal `/project/src` misses every lookup there
	 * and the whole tree reads as unreadable. Normalizing at the boundary keeps the
	 * fixtures readable and is a no-op on POSIX, where `path.sep` is already `/`.
	 */
	const toPosix = (p: string) => p.split(path.sep).join('/');

	/** Every directory the mocked `readdir` was asked for, in call order. */
	const scannedPaths = () => vi.mocked(fs.readdir).mock.calls.map((c) => toPosix(String(c[0])));

	/**
	 * Point the mocked filesystem at a directory map keyed by absolute POSIX path.
	 * Any path missing from the map reads as an unreadable directory.
	 */
	const mockTree = (dirs: Record<string, FakeEntry[]>) => {
		vi.mocked(fs.readdir).mockImplementation((async (dirPath: string) => {
			const entries = dirs[toPosix(dirPath)];
			if (!entries) throw new Error(`ENOENT: ${dirPath}`);
			return entries.map(dirent);
		}) as never);
	};

	describe('walkLocalFileTree', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
		});

		it('returns files and folders sorted folders-first then alphabetically', async () => {
			mockTree({
				'/project': [
					{ name: 'zebra.txt', kind: 'file' },
					{ name: 'alpha', kind: 'dir' },
					{ name: 'apple.js', kind: 'file' },
					{ name: 'beta', kind: 'dir' },
				],
				'/project/alpha': [],
				'/project/beta': [],
			});

			const result = await walkLocalFileTree('/project', { maxDepth: 5 });

			expect(result.tree.map((n) => n.name)).toEqual(['alpha', 'beta', 'apple.js', 'zebra.txt']);
			expect(result.tree[0]).toEqual({ name: 'alpha', type: 'folder', children: [] });
			expect(result.filesFound).toBe(2);
			expect(result.directoriesScanned).toBe(3);
		});

		it('recurses into subdirectories', async () => {
			mockTree({
				'/project': [{ name: 'src', kind: 'dir' }],
				'/project/src': [
					{ name: 'index.ts', kind: 'file' },
					{ name: 'components', kind: 'dir' },
				],
				'/project/src/components': [{ name: 'App.tsx', kind: 'file' }],
			});

			const result = await walkLocalFileTree('/project', { maxDepth: 5 });

			expect(result.tree[0].children![0].name).toBe('components');
			expect(result.tree[0].children![0].children![0].name).toBe('App.tsx');
		});

		it('stops at maxDepth', async () => {
			vi.mocked(fs.readdir).mockResolvedValue([dirent({ name: 'deep', kind: 'dir' })] as never);

			await walkLocalFileTree('/project', { maxDepth: 3 });

			expect(fs.readdir).toHaveBeenCalledTimes(3);
		});

		it('reads an expanded folder past maxDepth, one level at a time', async () => {
			mockTree({
				'/project': [{ name: 'a', kind: 'dir' }],
				'/project/a': [{ name: 'b', kind: 'dir' }],
				'/project/a/b': [
					{ name: 'x.md', kind: 'file' },
					{ name: 'c', kind: 'dir' },
				],
				'/project/a/b/c': [{ name: 'y.md', kind: 'file' }],
			});

			const capped = await walkLocalFileTree('/project', { maxDepth: 2 });
			expect(capped.tree[0].children![0]).toEqual({ name: 'b', type: 'folder', children: [] });

			const result = await walkLocalFileTree('/project', { maxDepth: 2, expandedPaths: ['a/b'] });

			// b is opened, so its contents load; c is not, so it stays unread.
			expect(result.tree[0].children![0]).toEqual({
				name: 'b',
				type: 'folder',
				children: [
					{ name: 'c', type: 'folder', children: [] },
					{ name: 'x.md', type: 'file' },
				],
			});
		});

		it('includes hidden entries but applies the default ignore patterns', async () => {
			mockTree({
				'/project': [
					{ name: '.git', kind: 'dir' },
					{ name: 'node_modules', kind: 'dir' },
					{ name: '__pycache__', kind: 'dir' },
					{ name: 'src', kind: 'dir' },
				],
				'/project/.git': [],
				'/project/src': [],
			});

			const result = await walkLocalFileTree('/project', { maxDepth: 5 });

			// .git is not in the local defaults, so it stays visible.
			expect(result.tree.map((n) => n.name)).toEqual(['.git', 'src']);
		});

		it('uses caller-supplied ignore patterns instead of the defaults', async () => {
			mockTree({
				'/project': [
					{ name: '.git', kind: 'dir' },
					{ name: 'node_modules', kind: 'dir' },
					{ name: 'src', kind: 'dir' },
				],
				'/project/src': [],
			});

			const result = await walkLocalFileTree('/project', {
				maxDepth: 5,
				ignorePatterns: ['.git', 'node_modules'],
			});

			expect(result.tree.map((n) => n.name)).toEqual(['src']);
		});

		it('merges the root .gitignore when honorGitignore is set', async () => {
			mockTree({
				'/project': [
					{ name: 'dist', kind: 'dir' },
					{ name: 'src', kind: 'dir' },
				],
				'/project/src': [],
			});
			vi.mocked(fs.readFile).mockResolvedValue('dist\n# comment\n' as never);

			const result = await walkLocalFileTree('/project', { maxDepth: 5, honorGitignore: true });

			expect(result.tree.map((n) => n.name)).toEqual(['src']);
		});

		it('keeps .maestro visible even when the ignore patterns match it', async () => {
			mockTree({
				'/project': [
					{ name: '.maestro', kind: 'dir' },
					{ name: '.env', kind: 'file' },
					{ name: 'src', kind: 'dir' },
				],
				'/project/.maestro': [],
				'/project/src': [],
			});

			const result = await walkLocalFileTree('/project', {
				maxDepth: 5,
				ignorePatterns: ['.*'],
			});

			expect(result.tree.map((n) => n.name)).toEqual(['.maestro', 'src']);
		});

		it('classifies a symlink by its target', async () => {
			mockTree({
				'/project': [{ name: 'linked', kind: 'symlink' }],
				'/project/linked': [{ name: 'inner.md', kind: 'file' }],
			});
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as never);

			const result = await walkLocalFileTree('/project', { maxDepth: 5 });

			expect(result.tree[0]).toEqual({
				name: 'linked',
				type: 'folder',
				children: [{ name: 'inner.md', type: 'file' }],
			});
		});

		it('shows a broken symlink as a file rather than dropping it', async () => {
			mockTree({ '/project': [{ name: 'dangling', kind: 'symlink' }] });
			vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

			const result = await walkLocalFileTree('/project', { maxDepth: 5 });

			expect(result.tree).toEqual([{ name: 'dangling', type: 'file' }]);
		});

		it('deduplicates entries, including NFD/NFC pairs', async () => {
			mockTree({
				'/project': [
					{ name: 'café'.normalize('NFC'), kind: 'file' },
					{ name: 'café'.normalize('NFD'), kind: 'file' },
				],
			});

			const result = await walkLocalFileTree('/project', { maxDepth: 5 });

			expect(result.tree).toHaveLength(1);
			expect(result.tree[0].name).toBe('café'.normalize('NFC'));
		});

		it('throws when the root directory cannot be read', async () => {
			vi.mocked(fs.readdir).mockRejectedValue(new Error('Permission denied'));

			await expect(walkLocalFileTree('/restricted', { maxDepth: 5 })).rejects.toThrow(
				'Permission denied'
			);
		});

		it('keeps an unreadable subdirectory in the tree as an empty folder', async () => {
			mockTree({
				'/project': [
					{ name: 'locked', kind: 'dir' },
					{ name: 'ok.md', kind: 'file' },
				],
				// '/project/locked' deliberately absent - reads throw.
			});

			const result = await walkLocalFileTree('/project', { maxDepth: 5 });

			expect(result.tree.find((n) => n.name === 'locked')?.children).toEqual([]);
			expect(result.tree.find((n) => n.name === 'ok.md')).toBeDefined();
		});

		describe('maxEntries cap', () => {
			it('reports truncated=false when the scan stays under the cap', async () => {
				mockTree({
					'/project': [
						{ name: 'a.txt', kind: 'file' },
						{ name: 'b.txt', kind: 'file' },
					],
				});

				const result = await walkLocalFileTree('/project', { maxDepth: 5, maxEntries: 10 });

				expect(result.truncated).toBe(false);
				expect(result.filesFound).toBe(2);
			});

			it('stops adding files and flags truncation once the cap is hit', async () => {
				mockTree({
					'/project': [
						{ name: 'a.txt', kind: 'file' },
						{ name: 'b.txt', kind: 'file' },
						{ name: 'c.txt', kind: 'file' },
						{ name: 'd.txt', kind: 'file' },
					],
				});

				const result = await walkLocalFileTree('/project', { maxDepth: 5, maxEntries: 2 });

				expect(result.truncated).toBe(true);
				expect(result.tree).toHaveLength(2);
			});

			it('folds a sibling folder in as empty once the cap is reached', async () => {
				mockTree({
					'/project': [
						{ name: 'full', kind: 'dir' },
						{ name: 'skipped', kind: 'dir' },
					],
					'/project/full': [
						{ name: 'a.txt', kind: 'file' },
						{ name: 'b.txt', kind: 'file' },
					],
					'/project/skipped': [{ name: 'never.txt', kind: 'file' }],
				});

				const result = await walkLocalFileTree('/project', { maxDepth: 5, maxEntries: 2 });

				expect(result.truncated).toBe(true);
				expect(scannedPaths()).not.toContain('/project/skipped');
				expect(result.tree.find((n) => n.name === 'skipped')?.children).toEqual([]);
			});

			it('treats an omitted cap as unlimited', async () => {
				mockTree({
					'/project': [
						{ name: 'a.txt', kind: 'file' },
						{ name: 'b.txt', kind: 'file' },
					],
				});

				const result = await walkLocalFileTree('/project', { maxDepth: 5 });

				expect(result.truncated).toBe(false);
				expect(result.tree).toHaveLength(2);
			});
		});

		describe('always-visible directories', () => {
			it('reads .maestro before its siblings', async () => {
				mockTree({
					'/project': [
						{ name: 'src', kind: 'dir' },
						{ name: '.maestro', kind: 'dir' },
					],
					'/project/.maestro': [],
					'/project/src': [],
				});

				await walkLocalFileTree('/project', { maxDepth: 5 });

				expect(scannedPaths()).toEqual(['/project', '/project/.maestro', '/project/src']);
			});

			it('loads .maestro in full even past the entry cap', async () => {
				mockTree({
					'/project': [
						{ name: '.maestro', kind: 'dir' },
						{ name: 'a.txt', kind: 'file' },
						{ name: 'b.txt', kind: 'file' },
						{ name: 'c.txt', kind: 'file' },
					],
					'/project/.maestro': [
						{ name: 'cue.yaml', kind: 'file' },
						{ name: 'p1.md', kind: 'file' },
						{ name: 'p2.md', kind: 'file' },
						{ name: 'p3.md', kind: 'file' },
					],
				});

				const result = await walkLocalFileTree('/project', { maxDepth: 5, maxEntries: 2 });

				expect(result.tree.find((n) => n.name === '.maestro')?.children).toHaveLength(4);
				expect(result.tree.filter((n) => n.type === 'file')).toHaveLength(2);
				expect(result.truncated).toBe(true);
			});

			it('does not let .maestro spend a sibling directory budget', async () => {
				mockTree({
					'/project': [
						{ name: '.maestro', kind: 'dir' },
						{ name: 'src', kind: 'dir' },
					],
					'/project/.maestro': [
						{ name: 'a.md', kind: 'file' },
						{ name: 'b.md', kind: 'file' },
						{ name: 'c.md', kind: 'file' },
						{ name: 'd.md', kind: 'file' },
						{ name: 'e.md', kind: 'file' },
					],
					'/project/src': [
						{ name: 'index.ts', kind: 'file' },
						{ name: 'app.ts', kind: 'file' },
					],
				});

				const result = await walkLocalFileTree('/project', { maxDepth: 5, maxEntries: 3 });

				expect(result.tree.find((n) => n.name === 'src')?.children).toHaveLength(2);
				expect(result.tree.find((n) => n.name === '.maestro')?.children).toHaveLength(5);
			});

			it('propagates the unlimited budget through nested .maestro descendants', async () => {
				mockTree({
					'/project': [{ name: '.maestro', kind: 'dir' }],
					'/project/.maestro': [{ name: 'playbooks', kind: 'dir' }],
					'/project/.maestro/playbooks': [
						{ name: 'one.md', kind: 'file' },
						{ name: 'two.md', kind: 'file' },
						{ name: 'three.md', kind: 'file' },
					],
				});

				const result = await walkLocalFileTree('/project', { maxDepth: 5, maxEntries: 1 });

				const maestro = result.tree.find((n) => n.name === '.maestro');
				expect(maestro?.children?.find((n) => n.name === 'playbooks')?.children).toHaveLength(3);
			});
		});
	});
});
describe('dirent-utils', () => {
	// Helper to build a Dirent-like object with the flags we care about
	function makeDirent(opts: {
		name: string;
		isDir?: boolean;
		isFile?: boolean;
		isSymlink?: boolean;
	}) {
		return {
			name: opts.name,
			isDirectory: () => opts.isDir ?? false,
			isFile: () => opts.isFile ?? false,
			isSymbolicLink: () => opts.isSymlink ?? false,
		} as any;
	}

	describe('resolveDirentType', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('returns dir/file flags directly for non-symlink entries', async () => {
			const dir = makeDirent({ name: 'folder', isDir: true });
			const file = makeDirent({ name: 'readme.md', isFile: true });

			expect(await resolveDirentType(dir, '/x/folder')).toEqual({
				isDirectory: true,
				isFile: false,
				isBrokenSymlink: false,
			});
			expect(await resolveDirentType(file, '/x/readme.md')).toEqual({
				isDirectory: false,
				isFile: true,
				isBrokenSymlink: false,
			});
			// Non-symlinks never touch the filesystem
			expect(fs.stat).not.toHaveBeenCalled();
		});

		it('resolves a symlink that targets a directory', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => true,
				isFile: () => false,
			} as any);

			const entry = makeDirent({ name: 'linked-folder', isSymlink: true });
			const result = await resolveDirentType(entry, '/x/linked-folder');

			expect(fs.stat).toHaveBeenCalledWith('/x/linked-folder');
			expect(result).toEqual({
				isDirectory: true,
				isFile: false,
				isBrokenSymlink: false,
			});
		});

		it('resolves a symlink that targets a regular file', async () => {
			vi.mocked(fs.stat).mockResolvedValue({
				isDirectory: () => false,
				isFile: () => true,
			} as any);

			const entry = makeDirent({ name: 'linked-doc.md', isSymlink: true });
			const result = await resolveDirentType(entry, '/x/linked-doc.md');

			expect(result).toEqual({
				isDirectory: false,
				isFile: true,
				isBrokenSymlink: false,
			});
		});

		it('flags broken symlinks (fs.stat fails) without throwing', async () => {
			vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

			const entry = makeDirent({ name: 'broken', isSymlink: true });
			const result = await resolveDirentType(entry, '/x/broken');

			expect(result).toEqual({
				isDirectory: false,
				isFile: false,
				isBrokenSymlink: true,
			});
		});
	});

	describe('readDirWithResolvedTypes', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('resolves mixed regular + symlink entries and returns full paths', async () => {
			// Simulate readdir returning: a directory, a file, a symlink-to-dir, and a broken symlink.
			vi.mocked(fs.readdir).mockResolvedValue([
				makeDirent({ name: 'src', isDir: true }),
				makeDirent({ name: 'readme.md', isFile: true }),
				makeDirent({ name: 'linked-lib', isSymlink: true }),
				makeDirent({ name: 'dangling', isSymlink: true }),
			] as any);

			vi.mocked(fs.stat).mockImplementation((p: any) => {
				if (String(p).replace(/\\/g, '/') === '/proj/linked-lib') {
					return Promise.resolve({
						isDirectory: () => true,
						isFile: () => false,
					} as any);
				}
				return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
			});

			const result = await readDirWithResolvedTypes('/proj');

			expect(fs.readdir).toHaveBeenCalledWith('/proj', { withFileTypes: true });
			expect(result).toEqual([
				{
					name: 'src',
					fullPath: expect.stringContaining('src'),
					isDirectory: true,
					isFile: false,
					isBrokenSymlink: false,
				},
				{
					name: 'readme.md',
					fullPath: expect.stringContaining('readme.md'),
					isDirectory: false,
					isFile: true,
					isBrokenSymlink: false,
				},
				{
					name: 'linked-lib',
					fullPath: expect.stringContaining('linked-lib'),
					isDirectory: true,
					isFile: false,
					isBrokenSymlink: false,
				},
				{
					name: 'dangling',
					fullPath: expect.stringContaining('dangling'),
					isDirectory: false,
					isFile: false,
					isBrokenSymlink: true,
				},
			]);
		});
	});
});
