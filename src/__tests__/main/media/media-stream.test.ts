import { describe, it, expect } from 'vitest';
import { parseRangeHeader } from '../../../main/media/media-stream';

const SIZE = 1000;

describe('parseRangeHeader', () => {
	it('returns null when there is no range header', () => {
		expect(parseRangeHeader(null, SIZE)).toBeNull();
		expect(parseRangeHeader('', SIZE)).toBeNull();
	});

	it('parses the open-ended request Chromium opens media with', () => {
		expect(parseRangeHeader('bytes=0-', SIZE)).toEqual({ start: 0, end: 999 });
	});

	it('parses a bounded range', () => {
		expect(parseRangeHeader('bytes=100-199', SIZE)).toEqual({ start: 100, end: 199 });
	});

	it('parses a single-byte range', () => {
		expect(parseRangeHeader('bytes=5-5', SIZE)).toEqual({ start: 5, end: 5 });
	});

	it('clamps an end past EOF instead of over-reading', () => {
		expect(parseRangeHeader('bytes=900-99999', SIZE)).toEqual({ start: 900, end: 999 });
	});

	it('parses a suffix range as the trailing N bytes', () => {
		expect(parseRangeHeader('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
	});

	it('clamps a suffix range longer than the file', () => {
		expect(parseRangeHeader('bytes=-99999', SIZE)).toEqual({ start: 0, end: 999 });
	});

	it('tolerates surrounding whitespace', () => {
		expect(parseRangeHeader('  bytes=0-9  ', SIZE)).toEqual({ start: 0, end: 9 });
	});

	it('reports ranges that start past EOF as unsatisfiable', () => {
		expect(parseRangeHeader('bytes=1000-', SIZE)).toBe('unsatisfiable');
		expect(parseRangeHeader('bytes=5000-6000', SIZE)).toBe('unsatisfiable');
	});

	it('reports an inverted range as unsatisfiable', () => {
		expect(parseRangeHeader('bytes=500-100', SIZE)).toBe('unsatisfiable');
	});

	it('reports a zero-length suffix as unsatisfiable', () => {
		expect(parseRangeHeader('bytes=-0', SIZE)).toBe('unsatisfiable');
	});

	it('treats any range against an empty file as unsatisfiable', () => {
		expect(parseRangeHeader('bytes=0-', 0)).toBe('unsatisfiable');
	});

	it('ignores unsupported range syntax rather than guessing', () => {
		// Multi-range and non-byte units fall back to serving the whole file.
		expect(parseRangeHeader('bytes=0-99,200-299', SIZE)).toBeNull();
		expect(parseRangeHeader('items=0-99', SIZE)).toBeNull();
		expect(parseRangeHeader('bytes=-', SIZE)).toBeNull();
		expect(parseRangeHeader('garbage', SIZE)).toBeNull();
	});
});
