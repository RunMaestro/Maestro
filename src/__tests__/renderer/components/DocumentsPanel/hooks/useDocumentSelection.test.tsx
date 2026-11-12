import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDocumentSelection } from '../../../../../renderer/components/DocumentsPanel/hooks/useDocumentSelection';
import type { BatchDocumentEntry } from '../../../../../renderer/types';
import type { DocTreeNode } from '../../../../../renderer/components/DocumentsPanel';

const documents: BatchDocumentEntry[] = [
	{ id: '1', filename: 'alpha', resetOnCompletion: false },
	{ id: '2', filename: 'beta', resetOnCompletion: true },
];

const folder: DocTreeNode = {
	name: 'folder',
	type: 'folder',
	path: 'folder',
	children: [
		{ name: 'gamma', type: 'file', path: 'folder/gamma' },
		{ name: 'delta', type: 'file', path: 'folder/delta' },
	],
};

describe('useDocumentSelection', () => {
	it('preselects currently added documents and derives task totals', () => {
		const { result } = renderHook(() =>
			useDocumentSelection({
				documents,
				allDocuments: ['alpha', 'beta', 'gamma'],
				taskCounts: { alpha: 2, beta: 3, gamma: 4 },
			})
		);

		expect([...result.current.selectedDocs]).toEqual(['alpha', 'beta']);
		expect(result.current.selectedTaskCount).toBe(5);
		expect(result.current.totalTaskCount).toBe(9);
		expect(result.current.allSelected).toBe(false);
	});

	it('toggles individual docs and select-all state', () => {
		const { result } = renderHook(() =>
			useDocumentSelection({
				documents,
				allDocuments: ['alpha', 'beta'],
				taskCounts: {},
			})
		);

		expect(result.current.allSelected).toBe(true);
		act(() => result.current.toggleDoc('alpha'));
		expect(result.current.selectedDocs.has('alpha')).toBe(false);
		act(() => result.current.deselectAll());
		expect(result.current.selectedDocs.size).toBe(0);
		act(() => result.current.selectAll());
		expect([...result.current.selectedDocs]).toEqual(['alpha', 'beta']);
	});

	it('keeps all-selected true when preselected docs include stale filenames', () => {
		const { result } = renderHook(() =>
			useDocumentSelection({
				documents: [
					{ id: '1', filename: 'alpha', resetOnCompletion: false },
					{ id: 'stale', filename: 'stale', resetOnCompletion: false },
				],
				allDocuments: ['alpha'],
				taskCounts: {},
			})
		);

		expect(result.current.allSelected).toBe(true);
	});

	it('toggles folder expansion and folder selection', () => {
		const { result } = renderHook(() =>
			useDocumentSelection({
				documents: [],
				allDocuments: ['folder/gamma', 'folder/delta'],
				taskCounts: {},
			})
		);

		act(() => result.current.toggleFolder('folder'));
		expect(result.current.expandedFolders.has('folder')).toBe(true);
		act(() => result.current.toggleFolderSelection(folder));
		expect([...result.current.selectedDocs]).toEqual(['folder/gamma', 'folder/delta']);
		act(() => result.current.toggleFolderSelection(folder));
		expect(result.current.selectedDocs.size).toBe(0);
	});
});
