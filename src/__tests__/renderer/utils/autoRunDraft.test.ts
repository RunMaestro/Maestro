import { describe, it, expect } from 'vitest';
import {
	isAutoRunDocumentLocked,
	isAutoRunRunDocument,
	reconcileDiskContent,
} from '../../../renderer/utils/autoRunDraft';
import type { BatchRunState } from '../../../renderer/types';

const runState = (overrides: Partial<BatchRunState> = {}) =>
	({
		isRunning: true,
		worktreeActive: false,
		lockedDocuments: ['plan'],
		...overrides,
	}) as BatchRunState;

describe('reconcileDiskContent', () => {
	it('keeps the draft when the disk matches the saved text (own save echo)', () => {
		expect(
			reconcileDiskContent({ draft: 'Saved. More', saved: 'Saved.', incoming: 'Saved.' })
		).toEqual({ draft: 'Saved. More', saved: 'Saved.', conflict: false });
	});

	it('adopts the disk when there are no unsaved edits', () => {
		expect(reconcileDiskContent({ draft: 'A', saved: 'A', incoming: 'B' })).toEqual({
			draft: 'B',
			saved: 'B',
			conflict: false,
		});
	});

	it('treats a draft that already equals the disk as clean', () => {
		expect(reconcileDiskContent({ draft: 'B', saved: 'A', incoming: 'B' })).toEqual({
			draft: 'B',
			saved: 'B',
			conflict: false,
		});
	});

	it('keeps an unsaved draft over a different disk and moves the baseline', () => {
		expect(reconcileDiskContent({ draft: 'Mine', saved: 'A', incoming: 'Theirs' })).toEqual({
			draft: 'Mine',
			saved: 'Theirs',
			conflict: true,
		});
	});

	it('lets the disk win when a run owns the document', () => {
		expect(
			reconcileDiskContent({ draft: 'Mine', saved: 'A', incoming: 'Theirs', diskWins: true })
		).toEqual({ draft: 'Theirs', saved: 'Theirs', conflict: false });
	});
});

describe('isAutoRunRunDocument / isAutoRunDocumentLocked', () => {
	it('claims a locked document of a run on the main checkout', () => {
		expect(isAutoRunRunDocument(runState(), 'plan')).toBe(true);
		expect(isAutoRunDocumentLocked(runState(), 'plan', false)).toBe(true);
	});

	it('hands the document back while the run is paused', () => {
		expect(isAutoRunDocumentLocked(runState(), 'plan', true)).toBe(false);
	});

	it('never claims documents outside the run, in a worktree, or with no run', () => {
		expect(isAutoRunRunDocument(runState(), 'other')).toBe(false);
		expect(isAutoRunRunDocument(runState({ worktreeActive: true }), 'plan')).toBe(false);
		expect(isAutoRunRunDocument(runState({ isRunning: false }), 'plan')).toBe(false);
		expect(isAutoRunRunDocument(undefined, 'plan')).toBe(false);
		expect(isAutoRunRunDocument(runState(), null)).toBe(false);
	});
});
