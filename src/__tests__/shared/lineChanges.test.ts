import { describe, it, expect, vi, afterEach } from 'vitest';
import * as jsdiff from 'diff';
import { countLineChanges } from '../../shared/lineChanges';

vi.mock('diff', async (importOriginal) => {
	const actual = await importOriginal<typeof import('diff')>();
	return { ...actual, diffLines: vi.fn(actual.diffLines) };
});

describe('countLineChanges', () => {
	afterEach(() => {
		vi.mocked(jsdiff.diffLines).mockClear();
	});

	it('returns zero for identical text without diffing', () => {
		expect(countLineChanges('a\nb\n', 'a\nb\n')).toEqual({ linesAdded: 0, linesRemoved: 0 });
		expect(jsdiff.diffLines).not.toHaveBeenCalled();
	});

	it('counts a changed line as one removed and one added', () => {
		expect(countLineChanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ linesAdded: 1, linesRemoved: 1 });
	});

	it('counts pure additions and pure removals', () => {
		expect(countLineChanges('a\n', 'a\nb\nc\n')).toEqual({ linesAdded: 2, linesRemoved: 0 });
		expect(countLineChanges('a\nb\nc\n', 'c\n')).toEqual({ linesAdded: 0, linesRemoved: 2 });
	});

	it('counts scattered edits exactly', () => {
		const before = ['1', '2', '3', '4', '5', '6'].join('\n');
		const after = ['1', 'two', '3', '4', 'five', '6', '7'].join('\n');
		expect(countLineChanges(before, after)).toEqual({ linesAdded: 3, linesRemoved: 2 });
	});

	it('counts a new file and an emptied file', () => {
		expect(countLineChanges('', 'a\nb\n')).toEqual({ linesAdded: 2, linesRemoved: 0 });
		expect(countLineChanges('a\nb\n', '')).toEqual({ linesAdded: 0, linesRemoved: 2 });
	});

	it('does not count a newline added or dropped at the end of the file', () => {
		expect(countLineChanges('a\nb', 'a\nb\n')).toEqual({ linesAdded: 0, linesRemoved: 0 });
	});

	it('falls back to the changed span when the exact diff runs out of time', () => {
		vi.mocked(jsdiff.diffLines).mockReturnValueOnce(undefined as never);
		// Two separate edits: the span from the first to the last counts as changed.
		const before = ['1', '2', '3', '4', '5'].join('\n');
		const after = ['1', 'two', '3', 'four', '5'].join('\n');
		expect(countLineChanges(before, after)).toEqual({ linesAdded: 3, linesRemoved: 3 });
	});
});
