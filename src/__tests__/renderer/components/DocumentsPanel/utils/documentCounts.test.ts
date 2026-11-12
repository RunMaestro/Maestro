import { describe, expect, it } from 'vitest';
import {
	canDisableReset,
	getAllDocumentsTaskCount,
	getDocumentTaskCount,
	getMissingDocumentCount,
	getSelectedTaskCount,
	getTotalDocumentTaskCount,
	hasDuplicateFilename,
} from '../../../../../renderer/components/DocumentsPanel/utils/documentCounts';
import type { BatchDocumentEntry } from '../../../../../renderer/types';

const docs: BatchDocumentEntry[] = [
	{ id: '1', filename: 'alpha', resetOnCompletion: false },
	{ id: '2', filename: 'beta', resetOnCompletion: true },
	{ id: '3', filename: 'missing', resetOnCompletion: false, isMissing: true },
	{ id: '4', filename: 'beta', resetOnCompletion: true, isDuplicate: true },
];

describe('DocumentsPanel documentCounts utils', () => {
	it('returns zero for missing task-count entries', () => {
		expect(getDocumentTaskCount({ alpha: 2 }, 'none')).toBe(0);
	});

	it('sums selected documents by filename', () => {
		expect(getSelectedTaskCount(new Set(['alpha', 'beta']), { alpha: 2, beta: 4 })).toBe(6);
	});

	it('sums all available document task counts without selected-list missing docs', () => {
		expect(getTotalDocumentTaskCount(docs, { alpha: 2, beta: 4, missing: 99 })).toBe(10);
	});

	it('sums the selector document list', () => {
		expect(getAllDocumentsTaskCount(['alpha', 'gamma'], { alpha: 2, gamma: 7 })).toBe(9);
	});

	it('counts missing docs and duplicate filenames', () => {
		expect(getMissingDocumentCount(docs)).toBe(1);
		expect(hasDuplicateFilename(docs, 'beta')).toBe(true);
		expect(hasDuplicateFilename(docs, 'alpha')).toBe(false);
	});

	it('only allows reset disable when no duplicate filename exists', () => {
		expect(canDisableReset(docs, 'alpha')).toBe(true);
		expect(canDisableReset(docs, 'beta')).toBe(false);
	});
});
