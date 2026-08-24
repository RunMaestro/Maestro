import { describe, it, expect } from 'vitest';
import { buildFileTreeFromPaths } from '../../../renderer/utils/fileTree';
import type { FileNode } from '../../../renderer/types/fileTree';

const names = (nodes: FileNode[]) => nodes.map((n) => n.name);
const folder = (nodes: FileNode[], name: string) =>
	nodes.find((n) => n.name === name && n.type === 'folder');

describe('buildFileTreeFromPaths', () => {
	it('returns an empty tree for no paths', () => {
		expect(buildFileTreeFromPaths([])).toEqual([]);
	});

	it('places a root-level file at the top level', () => {
		const tree = buildFileTreeFromPaths(['README.md']);
		expect(tree).toEqual([{ name: 'README.md', type: 'file', fullPath: 'README.md' }]);
	});

	it('infers folders from the path segments', () => {
		const tree = buildFileTreeFromPaths(['docs/guides/setup.md']);
		const docs = folder(tree, 'docs');
		expect(docs?.isFolder).toBe(true);
		const guides = folder(docs!.children!, 'guides');
		expect(names(guides!.children!)).toEqual(['setup.md']);
	});

	it('keeps fullPath as the original path, not just the basename', () => {
		const tree = buildFileTreeFromPaths(['docs/guides/setup.md']);
		const leaf = folder(folder(tree, 'docs')!.children!, 'guides')!.children![0];
		// Wiki-link resolution matches on fullPath, so a basename here would make
		// two same-named files in different folders indistinguishable.
		expect(leaf.fullPath).toBe('docs/guides/setup.md');
	});

	it('reuses a shared folder rather than duplicating it', () => {
		const tree = buildFileTreeFromPaths(['docs/a.md', 'docs/b.md']);
		expect(tree.filter((n) => n.name === 'docs')).toHaveLength(1);
		expect(names(folder(tree, 'docs')!.children!)).toEqual(['a.md', 'b.md']);
	});

	it('reuses shared ancestors across diverging branches', () => {
		const tree = buildFileTreeFromPaths(['docs/guides/a.md', 'docs/specs/b.md']);
		const docs = folder(tree, 'docs')!;
		expect(names(docs.children!).sort()).toEqual(['guides', 'specs']);
	});

	it('skips empty path entries instead of creating blank nodes', () => {
		const tree = buildFileTreeFromPaths(['', 'docs/a.md', '']);
		expect(tree).toHaveLength(1);
		expect(names(tree)).toEqual(['docs']);
	});

	it('keeps two same-named files in different folders separate', () => {
		const tree = buildFileTreeFromPaths(['docs/index.md', 'specs/index.md']);
		expect(folder(tree, 'docs')!.children![0].fullPath).toBe('docs/index.md');
		expect(folder(tree, 'specs')!.children![0].fullPath).toBe('specs/index.md');
	});
});
