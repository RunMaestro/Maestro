import { describe, it, expect } from 'vitest';
import {
	applySelectionOrder,
	deselectFolderFiles,
	selectAllDocuments,
	selectFolderFiles,
} from '../../../renderer/utils/documentSelectionOrder';
import type { BatchDocumentEntry } from '../../../shared/types';

function entry(filename: string, overrides: Partial<BatchDocumentEntry> = {}): BatchDocumentEntry {
	return {
		id: `id-${filename}`,
		filename,
		resetOnCompletion: false,
		isDuplicate: false,
		...overrides,
	};
}

let created = 0;
const createEntry = (filename: string): BatchDocumentEntry => {
	created += 1;
	return {
		id: `new-${created}`,
		filename,
		resetOnCompletion: false,
		isDuplicate: false,
	};
};

describe('selectFolderFiles', () => {
	it('appends a folder block in tree order', () => {
		const next = selectFolderFiles(new Set(['a/1']), ['b/1', 'b/2']);
		expect([...next]).toEqual(['a/1', 'b/1', 'b/2']);
	});

	it('keeps folder click order when folders are clicked out of tree order', () => {
		let selection = new Set<string>();
		selection = selectFolderFiles(selection, ['verify/1', 'verify/2']);
		selection = selectFolderFiles(selection, ['deploy/1']);
		expect([...selection]).toEqual(['verify/1', 'verify/2', 'deploy/1']);
	});

	it('moves already-selected files so the folder stays one contiguous block', () => {
		const next = selectFolderFiles(new Set(['b/2', 'a/1']), ['b/1', 'b/2']);
		expect([...next]).toEqual(['a/1', 'b/1', 'b/2']);
	});
});

describe('deselectFolderFiles', () => {
	it('removes only that folder and leaves the rest in order', () => {
		const next = deselectFolderFiles(new Set(['a/1', 'b/1', 'b/2', 'c/1']), ['b/1', 'b/2']);
		expect([...next]).toEqual(['a/1', 'c/1']);
	});
});

describe('selectAllDocuments', () => {
	it('extends the existing selection instead of resetting it', () => {
		const next = selectAllDocuments(new Set(['z', 'y']), ['x', 'y', 'z']);
		expect([...next]).toEqual(['z', 'y', 'x']);
	});
});

describe('applySelectionOrder', () => {
	it('emits documents in selection order, not list order', () => {
		const documents = [entry('a'), entry('b')];
		const result = applySelectionOrder(documents, new Set(['c', 'b', 'a']), createEntry);
		expect(result.map((d) => d.filename)).toEqual(['c', 'b', 'a']);
	});

	it('reuses existing entries so ids and reset flags survive', () => {
		const documents = [entry('a', { resetOnCompletion: true })];
		const result = applySelectionOrder(documents, new Set(['b', 'a']), createEntry);
		expect(result[1]).toBe(documents[0]);
		expect(result[1].resetOnCompletion).toBe(true);
	});

	it('keeps duplicates grouped with their original', () => {
		const documents = [entry('a'), entry('a', { id: 'id-a-dup', isDuplicate: true }), entry('b')];
		const result = applySelectionOrder(documents, new Set(['b', 'a']), createEntry);
		expect(result.map((d) => d.id)).toEqual(['id-b', 'id-a', 'id-a-dup']);
	});

	it('drops documents that were deselected', () => {
		const documents = [entry('a'), entry('b')];
		const result = applySelectionOrder(documents, new Set(['a']), createEntry);
		expect(result.map((d) => d.filename)).toEqual(['a']);
	});

	it('returns an empty list when nothing is selected', () => {
		expect(applySelectionOrder([entry('a')], new Set<string>(), createEntry)).toEqual([]);
	});
});
