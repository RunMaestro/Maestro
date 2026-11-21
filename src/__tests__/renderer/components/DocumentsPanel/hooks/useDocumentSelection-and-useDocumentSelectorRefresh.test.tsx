// Source: src/__tests__/renderer/components/DocumentsPanel/hooks/useDocumentSelection.test.tsx
// Source: src/__tests__/renderer/components/DocumentsPanel/hooks/useDocumentSelectorRefresh.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { useDocumentSelection } from '../../../../../renderer/components/DocumentsPanel/hooks/useDocumentSelection';
import type { BatchDocumentEntry } from '../../../../../renderer/types';
import type { DocTreeNode } from '../../../../../renderer/components/DocumentsPanel';
import { afterEach } from 'vitest';
import { vi } from 'vitest';
import { useDocumentSelectorRefresh } from '../../../../../renderer/components/DocumentsPanel/hooks/useDocumentSelectorRefresh';
describeSourceSuite('useDocumentSelection', () => {
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
});
describeSourceSuite('useDocumentSelectorRefresh', () => {
	describe('useDocumentSelectorRefresh', () => {
		afterEach(() => {
			vi.useRealTimers();
			vi.restoreAllMocks();
		});

		it('calls refresh, holds spinner for 500ms, and reports added documents', async () => {
			vi.useFakeTimers();
			const onRefresh = vi.fn().mockResolvedValue(undefined);
			const { result, rerender } = renderHook(
				({ length }) =>
					useDocumentSelectorRefresh({
						allDocumentsLength: length,
						onRefresh,
					}),
				{ initialProps: { length: 3 } }
			);

			await act(async () => {
				await result.current.handleRefresh();
			});
			expect(onRefresh).toHaveBeenCalledTimes(1);
			expect(result.current.refreshing).toBe(true);

			act(() => {
				vi.advanceTimersByTime(500);
			});
			act(() => {
				rerender({ length: 4 });
			});

			expect(result.current.refreshMessage).toBe('Found 1 new document');

			await act(async () => {});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});
			expect(result.current.refreshMessage).toBeNull();
		});

		it('reports removed documents', async () => {
			vi.useFakeTimers();
			const { result, rerender } = renderHook(
				({ length }) =>
					useDocumentSelectorRefresh({
						allDocumentsLength: length,
						onRefresh: vi.fn().mockResolvedValue(undefined),
					}),
				{ initialProps: { length: 5 } }
			);

			await act(async () => {
				await result.current.handleRefresh();
			});
			act(() => {
				vi.advanceTimersByTime(500);
			});
			act(() => {
				rerender({ length: 3 });
			});

			expect(result.current.refreshMessage).toBe('2 documents removed');
		});

		it('does not show a no-change message when count is unchanged', async () => {
			vi.useFakeTimers();
			const { result, rerender } = renderHook(
				({ length }) =>
					useDocumentSelectorRefresh({
						allDocumentsLength: length,
						onRefresh: vi.fn().mockResolvedValue(undefined),
					}),
				{ initialProps: { length: 2 } }
			);

			await act(async () => {
				await result.current.handleRefresh();
			});
			act(() => {
				vi.advanceTimersByTime(500);
			});
			rerender({ length: 2 });

			expect(result.current.refreshMessage).toBeNull();
		});

		it('releases refreshing state when refresh rejects', async () => {
			vi.useFakeTimers();
			const onRefresh = vi.fn().mockRejectedValue(new Error('refresh failed'));
			const { result } = renderHook(() =>
				useDocumentSelectorRefresh({
					allDocumentsLength: 2,
					onRefresh,
				})
			);

			await act(async () => {
				await result.current.handleRefresh();
			});

			expect(onRefresh).toHaveBeenCalledTimes(1);
			expect(result.current.refreshing).toBe(true);

			act(() => {
				vi.advanceTimersByTime(500);
			});

			expect(result.current.refreshing).toBe(false);
			expect(result.current.refreshMessage).toBeNull();
		});
	});
});
