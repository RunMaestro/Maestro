import { describe, expect, it } from 'vitest';
import { MAX_BUFFER_SIZE } from '../../../../main/process-manager/constants';
import { appendToBuffer } from '../../../../main/process-manager/utils/bufferUtils';

describe('appendToBuffer', () => {
	it('appends data while the combined buffer stays under the limit', () => {
		expect(appendToBuffer('abc', 'def', 10)).toBe('abcdef');
	});

	it('keeps the full combined buffer when it exactly matches the limit', () => {
		expect(appendToBuffer('abc', 'def', 6)).toBe('abcdef');
	});

	it('keeps only the newest data when the combined buffer exceeds the limit', () => {
		expect(appendToBuffer('old-data:', 'new-data', 8)).toBe('new-data');
	});

	it('keeps the newest tail across the old and new buffer boundary', () => {
		expect(appendToBuffer('abcdef', 'gh', 5)).toBe('defgh');
	});

	it('handles empty existing buffers and empty appended data', () => {
		expect(appendToBuffer('', 'abc', 5)).toBe('abc');
		expect(appendToBuffer('abc', '', 5)).toBe('abc');
	});

	it('uses MAX_BUFFER_SIZE by default', () => {
		const oversized = 'a'.repeat(MAX_BUFFER_SIZE + 5);
		const result = appendToBuffer('', oversized);

		expect(result).toHaveLength(MAX_BUFFER_SIZE);
		expect(result).toBe('a'.repeat(MAX_BUFFER_SIZE));
	});
});
