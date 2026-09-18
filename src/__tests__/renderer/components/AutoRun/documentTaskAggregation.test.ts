import { describe, it, expect } from 'vitest';
import { aggregateFolderTaskCounts } from '../../../../renderer/components/AutoRun/documentTaskAggregation';
import type {
	DocTreeNode,
	DocumentTaskCount,
} from '../../../../renderer/components/AutoRun/AutoRunDocumentSelector';

const file = (path: string): DocTreeNode => ({
	name: path.split('/').pop() as string,
	type: 'file',
	path,
});

const folder = (path: string, children: DocTreeNode[]): DocTreeNode => ({
	name: path.split('/').pop() as string,
	type: 'folder',
	path,
	children,
});

const counts = (entries: Record<string, DocumentTaskCount>) =>
	new Map<string, DocumentTaskCount>(Object.entries(entries));

describe('aggregateFolderTaskCounts', () => {
	it('sums the documents directly inside a folder', () => {
		const tree = [folder('phase-1', [file('phase-1/a'), file('phase-1/b')])];
		const result = aggregateFolderTaskCounts(
			tree,
			counts({
				'phase-1/a': { completed: 2, total: 4 },
				'phase-1/b': { completed: 1, total: 2 },
			})
		);

		expect(result.get('phase-1')).toEqual({ completed: 3, total: 6 });
	});

	it('rolls nested folders up into their parent', () => {
		const tree = [
			folder('root', [file('root/top'), folder('root/inner', [file('root/inner/deep')])]),
		];
		const result = aggregateFolderTaskCounts(
			tree,
			counts({
				'root/top': { completed: 1, total: 1 },
				'root/inner/deep': { completed: 0, total: 3 },
			})
		);

		expect(result.get('root/inner')).toEqual({ completed: 0, total: 3 });
		expect(result.get('root')).toEqual({ completed: 1, total: 4 });
	});

	it('ignores documents with no counts and documents with zero tasks', () => {
		const tree = [folder('mixed', [file('mixed/a'), file('mixed/b'), file('mixed/c')])];
		const result = aggregateFolderTaskCounts(
			tree,
			counts({
				'mixed/a': { completed: 2, total: 2 },
				'mixed/b': { completed: 0, total: 0 },
			})
		);

		expect(result.get('mixed')).toEqual({ completed: 2, total: 2 });
	});

	it('omits folders whose whole subtree has no tasks', () => {
		const tree = [
			folder('empty', [file('empty/a'), folder('empty/inner', [file('empty/inner/b')])]),
		];
		const result = aggregateFolderTaskCounts(
			tree,
			counts({ 'empty/a': { completed: 0, total: 0 } })
		);

		expect(result.has('empty')).toBe(false);
		expect(result.has('empty/inner')).toBe(false);
	});

	it('returns an empty map when the tree or the counts are missing', () => {
		expect(
			aggregateFolderTaskCounts(undefined, counts({ a: { completed: 1, total: 1 } })).size
		).toBe(0);
		expect(aggregateFolderTaskCounts([folder('f', [file('f/a')])], undefined).size).toBe(0);
		expect(aggregateFolderTaskCounts([folder('f', [file('f/a')])], new Map()).size).toBe(0);
	});

	it('handles a folder with no children array', () => {
		const result = aggregateFolderTaskCounts(
			[{ name: 'bare', type: 'folder', path: 'bare' }],
			counts({ other: { completed: 1, total: 1 } })
		);

		expect(result.has('bare')).toBe(false);
	});
});
