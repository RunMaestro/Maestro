import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	compareFileTrees,
	countNodesInTree,
	findNodeInTree,
	flattenTree,
	getAllFolderPaths,
	loadFileTree,
	removeNodeFromTree,
	renameNodeInTree,
	shouldOpenExternally,
	type FileTreeNode,
} from '../../renderer/utils/fileExplorer';
import { logger } from '../../renderer/utils/logger';
import { matchGlobPattern, parseGitignoreContent, shouldIgnore } from '../../shared/globUtils';

const entry = (name: string, type: 'file' | 'folder') => ({
	name,
	isFile: type === 'file',
	isDirectory: type === 'folder',
});

const sampleTree: FileTreeNode[] = [
	{
		name: 'src',
		type: 'folder',
		children: [
			{
				name: 'components',
				type: 'folder',
				children: [{ name: 'App.tsx', type: 'file' }],
			},
			{ name: 'old.ts', type: 'file' },
		],
	},
	{ name: 'README.md', type: 'file' },
	{ name: 'empty', type: 'folder' },
];

describe('fileExplorer integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.fs.readDir).mockReset();
		vi.mocked(window.maestro.fs.readFile).mockReset();
	});

	it('classifies external files, glob patterns, and gitignore content', () => {
		expect(shouldOpenExternally('photo.png')).toBe(false);
		expect(shouldOpenExternally('report.PDF')).toBe(true);
		expect(shouldOpenExternally('archive.backup.zip')).toBe(true);
		expect(shouldOpenExternally('Makefile')).toBe(false);
		expect(shouldOpenExternally('')).toBe(false);

		expect(matchGlobPattern('*.log', 'debug.LOG')).toBe(true);
		expect(matchGlobPattern('file?.txt', 'file1.txt')).toBe(true);
		expect(matchGlobPattern('literal.+', 'literal.+')).toBe(true);
		expect(shouldIgnore('debug.log', ['*.tmp', '*.log'])).toBe(true);
		expect(shouldIgnore('index.ts', ['*.tmp', '*.log'])).toBe(false);

		expect(
			parseGitignoreContent(['# comment', '', '!keep.log', '/dist/', '*.tmp'].join('\n'))
		).toEqual(['dist', '*.tmp']);
		expect(parseGitignoreContent('/\n')).toEqual([]);
	});

	it('loads local trees with gitignore patterns, duplicate guards, progress, sorting, and child failures', async () => {
		const progress = vi.fn();
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue('/dist/\n*.log\n');
		vi.mocked(window.maestro.fs.readDir)
			.mockResolvedValueOnce([
				entry('zeta.txt', 'file'),
				entry('docs', 'folder'),
				entry('docs', 'folder'),
				entry('debug.log', 'file'),
				entry('dist', 'folder'),
				entry('file-01.txt', 'file'),
				entry('file-02.txt', 'file'),
				entry('file-03.txt', 'file'),
				entry('file-04.txt', 'file'),
				entry('file-05.txt', 'file'),
				entry('file-06.txt', 'file'),
				entry('file-07.txt', 'file'),
				entry('file-08.txt', 'file'),
				entry('file-09.txt', 'file'),
				{ name: 'socket', isFile: false, isDirectory: false },
			])
			.mockRejectedValueOnce(new Error('docs denied'));

		const result = await loadFileTree('/repo', 10, 0, undefined, progress, {
			honorGitignore: true,
			ignorePatterns: [],
		});
		const { tree } = result;

		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/repo/.gitignore');
		expect(warnSpy).toHaveBeenCalledWith(
			'[loadFileTree] readDir returned duplicate entry:',
			undefined,
			['docs', 'in', '/repo']
		);
		expect(tree[0]).toEqual({ name: 'docs', type: 'folder', children: [] });
		expect(tree.map((node) => node.name)).not.toContain('debug.log');
		expect(tree.map((node) => node.name)).not.toContain('dist');
		expect(result).toMatchObject({ truncated: false, filesFound: 10 });
		expect(progress).toHaveBeenCalledWith({
			directoriesScanned: 1,
			filesFound: 0,
			currentDirectory: '/repo',
		});
		expect(progress).toHaveBeenCalledWith({
			directoriesScanned: 1,
			filesFound: 10,
			currentDirectory: '/repo',
		});
		warnSpy.mockRestore();
	});

	it('loads remote trees with remote gitignore success, empty, and failure paths', async () => {
		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('cache\n*.tmp\n');
		vi.mocked(window.maestro.fs.readDir)
			.mockResolvedValueOnce([
				entry('cache', 'folder'),
				entry('scratch.tmp', 'file'),
				entry('src', 'folder'),
				entry('README.md', 'file'),
			])
			.mockResolvedValueOnce([entry('index.ts', 'file')]);

		const remoteTree = await loadFileTree('/remote/repo', 10, 0, {
			sshRemoteId: 'remote-1',
			ignorePatterns: ['vendor'],
			honorGitignore: true,
		});
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/remote/repo/.gitignore', 'remote-1');
		expect(remoteTree).toMatchObject({
			truncated: false,
			filesFound: 2,
			tree: [
				{
					name: 'src',
					type: 'folder',
					children: [{ name: 'index.ts', type: 'file' }],
				},
				{ name: 'README.md', type: 'file' },
			],
		});

		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('');
		vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([entry('file.txt', 'file')]);
		await expect(
			loadFileTree('/remote/empty', 10, 0, { sshRemoteId: 'remote-1', honorGitignore: true })
		).resolves.toMatchObject({ tree: [{ name: 'file.txt', type: 'file' }] });

		vi.mocked(window.maestro.fs.readFile).mockRejectedValueOnce(new Error('missing gitignore'));
		vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([entry('vendor', 'folder')]);
		vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([]);
		await expect(
			loadFileTree('/remote/fallback', 10, 0, { sshRemoteId: 'remote-1', honorGitignore: true })
		).resolves.toMatchObject({ tree: [{ name: 'vendor', type: 'folder', children: [] }] });

		vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([entry('remote.txt', 'file')]);
		await expect(
			loadFileTree('/remote/no-honor', 10, 0, { sshRemoteId: 'remote-1' })
		).resolves.toMatchObject({ tree: [{ name: 'remote.txt', type: 'file' }] });

		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('');
		vi.mocked(window.maestro.fs.readDir).mockResolvedValueOnce([entry('local.txt', 'file')]);
		await expect(
			loadFileTree('/local/empty-gitignore', 10, 0, undefined, undefined, {
				honorGitignore: true,
				ignorePatterns: [],
			})
		).resolves.toMatchObject({ tree: [{ name: 'local.txt', type: 'file' }] });
	});

	it('handles max-depth and root read failures', async () => {
		await expect(loadFileTree('/repo', 1, 1)).resolves.toMatchObject({ tree: [] });
		expect(window.maestro.fs.readDir).not.toHaveBeenCalled();

		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.mocked(window.maestro.fs.readDir).mockRejectedValueOnce(new Error('root denied'));
		await expect(loadFileTree('/restricted')).rejects.toThrow('root denied');
		expect(errorSpy).toHaveBeenCalledWith('Error loading file tree:', undefined, expect.any(Error));
		errorSpy.mockRestore();
	});

	it('flattens, compares, counts, and finds tree nodes', () => {
		expect(getAllFolderPaths(sampleTree)).toEqual(['src', 'src/components', 'empty']);

		const flat = flattenTree(sampleTree, new Set(['src', 'src/components']));
		expect(flat.map((node) => [node.fullPath, node.isFolder])).toEqual([
			['src', true],
			['src/components', true],
			['src/components/App.tsx', false],
			['src/old.ts', false],
			['README.md', false],
			['empty', true],
		]);

		const changes = compareFileTrees(sampleTree, [
			{
				name: 'src',
				type: 'folder',
				children: [
					{ name: 'new.ts', type: 'file' },
					{ name: 'components', type: 'folder', children: [] },
				],
			},
			{ name: 'docs', type: 'folder', children: [{ name: 'guide.md', type: 'file' }] },
		]);
		expect(changes).toEqual({
			totalChanges: 7,
			newFiles: 2,
			newFolders: 1,
			removedFiles: 3,
			removedFolders: 1,
		});
		expect(
			compareFileTrees([{ name: 'same.txt', type: 'file' }], [{ name: 'same.txt', type: 'file' }])
		).toEqual({
			totalChanges: 0,
			newFiles: 0,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		});

		expect(countNodesInTree(sampleTree)).toEqual({ fileCount: 3, folderCount: 3 });
		expect(findNodeInTree(sampleTree, '')).toBeUndefined();
		expect(findNodeInTree(sampleTree, 'src/components/App.tsx')).toEqual({
			name: 'App.tsx',
			type: 'file',
		});
		expect(findNodeInTree(sampleTree, 'src/missing.ts')).toBeUndefined();
		expect(findNodeInTree(sampleTree, 'README.md/child')).toBeUndefined();
	});

	it('removes and renames root, nested, deep, missing, and childless nodes', () => {
		expect(removeNodeFromTree(sampleTree, '')).toBe(sampleTree);
		expect(removeNodeFromTree(sampleTree, 'README.md').map((node) => node.name)).toEqual([
			'src',
			'empty',
		]);
		expect(removeNodeFromTree(sampleTree, 'src/old.ts')[0].children).toEqual([
			{
				name: 'components',
				type: 'folder',
				children: [{ name: 'App.tsx', type: 'file' }],
			},
		]);
		expect(removeNodeFromTree(sampleTree, 'src/components/App.tsx')[0].children?.[0]).toEqual({
			name: 'components',
			type: 'folder',
			children: [],
		});
		expect(
			removeNodeFromTree(sampleTree, 'empty/file.txt').find((n) => n.name === 'empty')
		).toEqual({
			name: 'empty',
			type: 'folder',
			children: undefined,
		});
		expect(
			removeNodeFromTree(sampleTree, 'empty/nested/file.txt').find((n) => n.name === 'empty')
		).toEqual({
			name: 'empty',
			type: 'folder',
			children: undefined,
		});
		expect(removeNodeFromTree(sampleTree, 'missing/file.txt')).toEqual(sampleTree);

		expect(renameNodeInTree(sampleTree, '', 'ignored')).toBe(sampleTree);
		expect(renameNodeInTree(sampleTree, 'README.md', 'ABOUT.md').map((node) => node.name)).toEqual([
			'empty',
			'src',
			'ABOUT.md',
		]);
		expect(
			renameNodeInTree(sampleTree, 'src/old.ts', 'new.ts')[0].children?.map((n) => n.name)
		).toEqual(['components', 'new.ts']);
		expect(
			renameNodeInTree(sampleTree, 'src/components/App.tsx', 'Main.tsx')[0].children?.[0]
		).toEqual({
			name: 'components',
			type: 'folder',
			children: [{ name: 'Main.tsx', type: 'file' }],
		});
		expect(
			renameNodeInTree(sampleTree, 'empty/file.txt', 'renamed.txt').find((n) => n.name === 'empty')
		).toEqual({
			name: 'empty',
			type: 'folder',
			children: undefined,
		});
		expect(
			renameNodeInTree(sampleTree, 'empty/nested/file.txt', 'renamed.txt').find(
				(n) => n.name === 'empty'
			)
		).toEqual({
			name: 'empty',
			type: 'folder',
			children: undefined,
		});
		expect(renameNodeInTree(sampleTree, 'missing/file.txt', 'renamed.txt')).toEqual(sampleTree);
	});
});
