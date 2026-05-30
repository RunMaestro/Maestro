import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFileTreeFlatten } from '../../../../../renderer/components/FileExplorerPanel/hooks/useFileTreeFlatten';
import type { FileNode } from '../../../../../renderer/types/fileTree';

vi.mock('../../../../../renderer/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../../../../shared/maestro-paths', () => ({
	MAESTRO_DIR: '.maestro',
}));

const makeTree = (): FileNode[] => [
	{
		name: 'src',
		type: 'folder',
		children: [
			{ name: 'index.ts', type: 'file' },
			{ name: '.hidden', type: 'file' },
		],
	},
	{ name: '.env', type: 'file' },
	{ name: '.maestro', type: 'folder', children: [] },
	{ name: 'readme.md', type: 'file' },
];

const defaultArgs = {
	filteredFileTree: makeTree(),
	fileTreeFilter: '',
	fileExplorerExpanded: [],
	showHiddenFiles: false,
};

describe('useFileTreeFlatten', () => {
	it('filters hidden files when showHiddenFiles is false', () => {
		const { result } = renderHook(() => useFileTreeFlatten(defaultArgs));
		const names = result.current.flattenedTree.map((n) => n.node.name);
		expect(names).not.toContain('.env');
	});

	it('keeps .maestro visible regardless of showHiddenFiles setting', () => {
		const { result } = renderHook(() => useFileTreeFlatten(defaultArgs));
		const names = result.current.flattenedTree.map((n) => n.node.name);
		expect(names).toContain('.maestro');
	});

	it('shows hidden files when showHiddenFiles is true', () => {
		const { result } = renderHook(() =>
			useFileTreeFlatten({ ...defaultArgs, showHiddenFiles: true })
		);
		const names = result.current.flattenedTree.map((n) => n.node.name);
		expect(names).toContain('.env');
	});

	it('does not expand folders by default (empty expandedSet)', () => {
		const { result } = renderHook(() => useFileTreeFlatten(defaultArgs));
		const names = result.current.flattenedTree.map((n) => n.node.name);
		// 'src' is collapsed, so 'index.ts' and '.hidden' are not in the flattened tree
		expect(names).toContain('src');
		expect(names).not.toContain('index.ts');
	});

	it('expands folders listed in fileExplorerExpanded', () => {
		const { result } = renderHook(() =>
			useFileTreeFlatten({ ...defaultArgs, fileExplorerExpanded: ['src'] })
		);
		const names = result.current.flattenedTree.map((n) => n.node.name);
		expect(names).toContain('index.ts');
	});

	it('auto-expands all folders when fileTreeFilter is non-empty', () => {
		const { result } = renderHook(() =>
			useFileTreeFlatten({ ...defaultArgs, fileTreeFilter: 'index' })
		);
		const names = result.current.flattenedTree.map((n) => n.node.name);
		// 'src' children should appear because filter forces expansion
		expect(names).toContain('index.ts');
	});

	it('skips duplicate sibling nodes by NFC-normalised name', () => {
		// Create a tree with two nodes whose NFC names are identical
		const treeWithDup: FileNode[] = [
			{ name: 'caf\u00e9.ts', type: 'file' },
			{ name: 'cafe\u0301.ts', type: 'file' }, // duplicate after NFC normalization
		];
		const { result } = renderHook(() =>
			useFileTreeFlatten({ ...defaultArgs, filteredFileTree: treeWithDup })
		);
		// Only one should survive
		expect(result.current.flattenedTree).toHaveLength(1);
	});

	it('assigns monotonically increasing globalIndex values', () => {
		const { result } = renderHook(() =>
			useFileTreeFlatten({
				...defaultArgs,
				fileExplorerExpanded: ['src'],
				showHiddenFiles: false,
			})
		);
		const indices = result.current.flattenedTree.map((n) => n.globalIndex);
		for (let i = 0; i < indices.length; i++) {
			expect(indices[i]).toBe(i);
		}
	});

	it('returns correct depth for nested nodes', () => {
		const { result } = renderHook(() =>
			useFileTreeFlatten({ ...defaultArgs, fileExplorerExpanded: ['src'] })
		);
		const srcNode = result.current.flattenedTree.find((n) => n.node.name === 'src');
		const indexNode = result.current.flattenedTree.find((n) => n.node.name === 'index.ts');
		expect(srcNode?.depth).toBe(0);
		expect(indexNode?.depth).toBe(1);
	});
});
