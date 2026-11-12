import { act, renderHook } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentListActions } from '../../../../../renderer/components/DocumentsPanel/hooks/useDocumentListActions';
import type { BatchDocumentEntry } from '../../../../../renderer/types';

vi.mock('../../../../../renderer/utils/ids', () => ({
	generateId: vi.fn(() => 'generated-id'),
}));

const initialDocs: BatchDocumentEntry[] = [
	{ id: '1', filename: 'alpha', resetOnCompletion: false },
	{ id: '2', filename: 'beta', resetOnCompletion: true },
];

function setup(docs = initialDocs) {
	let currentDocs = docs;
	const setDocuments = vi.fn((next: React.SetStateAction<BatchDocumentEntry[]>) => {
		currentDocs = typeof next === 'function' ? next(currentDocs) : next;
	});
	const onAddComplete = vi.fn();
	const hook = renderHook(
		({ documents }) =>
			useDocumentListActions({
				documents,
				setDocuments,
				onAddComplete,
			}),
		{ initialProps: { documents: currentDocs } }
	);
	return {
		...hook,
		getDocs: () => currentDocs,
		setDocuments,
		onAddComplete,
		rerenderWithCurrent: () => hook.rerender({ documents: currentDocs }),
	};
}

describe('useDocumentListActions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('removes documents by id', () => {
		const { result, getDocs } = setup();

		act(() => result.current.handleRemoveDocument('1'));

		expect(getDocs()).toEqual([{ id: '2', filename: 'beta', resetOnCompletion: true }]);
	});

	it('toggles reset on completion', () => {
		const { result, getDocs } = setup();

		act(() => result.current.handleToggleReset('1'));

		expect(getDocs()[0].resetOnCompletion).toBe(true);
		expect(getDocs()[1].resetOnCompletion).toBe(true);
	});

	it('duplicates a document after the original with duplicate flags preserved', () => {
		const { result, getDocs } = setup();

		act(() => result.current.handleDuplicateDocument('2'));

		expect(getDocs()).toEqual([
			{ id: '1', filename: 'alpha', resetOnCompletion: false },
			{ id: '2', filename: 'beta', resetOnCompletion: true },
			{ id: 'generated-id', filename: 'beta', resetOnCompletion: true, isDuplicate: true },
		]);
	});

	it('filters removed selections and appends newly selected docs', () => {
		const { result, getDocs, onAddComplete } = setup();

		act(() => result.current.handleAddSelectedDocs(new Set(['beta', 'gamma'])));

		expect(getDocs()).toEqual([
			{ id: '2', filename: 'beta', resetOnCompletion: true },
			{ id: 'generated-id', filename: 'gamma', resetOnCompletion: false, isDuplicate: false },
		]);
		expect(onAddComplete).toHaveBeenCalledTimes(1);
	});
});
