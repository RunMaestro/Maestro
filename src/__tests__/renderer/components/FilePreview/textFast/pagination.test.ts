import { describe, it, expect } from 'vitest';
import {
	paginate,
	pageIndexAtOffset,
	DEFAULT_LINES_PER_PAGE,
} from '../../../../../renderer/components/FilePreview/textFast/pagination';

describe('paginate', () => {
	it('returns an empty array for empty input', () => {
		expect(paginate('')).toEqual([]);
	});

	it('returns one page of one line for a single line without trailing newline', () => {
		const pages = paginate('hello world');
		expect(pages.length).toBe(1);
		expect(pages[0].lines).toEqual(['hello world']);
		expect(pages[0].startLine).toBe(0);
		expect(pages[0].endLine).toBe(1);
		expect(pages[0].sourceStart).toBe(0);
		expect(pages[0].sourceEnd).toBe('hello world'.length);
	});

	it('treats a single trailing newline as an extra empty line', () => {
		const pages = paginate('hello\n');
		expect(pages.length).toBe(1);
		expect(pages[0].lines).toEqual(['hello', '']);
	});

	it('preserves CRLF content inside line strings (only LF splits)', () => {
		const pages = paginate('a\r\nb');
		expect(pages.length).toBe(1);
		expect(pages[0].lines).toEqual(['a\r', 'b']);
	});

	it('emits multiple pages when line count exceeds linesPerPage', () => {
		const content = Array.from({ length: 250 }, (_, i) => `line${i}`).join('\n');
		const pages = paginate(content, 100);
		expect(pages.length).toBe(3);
		expect(pages[0].lines.length).toBe(100);
		expect(pages[1].lines.length).toBe(100);
		expect(pages[2].lines.length).toBe(50);
	});

	it('assigns sequential ids starting at 0', () => {
		const content = Array.from({ length: 5 }, (_, i) => `l${i}`).join('\n');
		const pages = paginate(content, 2);
		expect(pages.map((p) => p.id)).toEqual([0, 1, 2]);
	});

	it('preserves source offset coverage with no gaps and no overlaps', () => {
		const content = 'aaa\nbbb\nccc\nddd\neee';
		const pages = paginate(content, 2);
		// Page 0: lines 0-1, source 0..8 ('aaa\nbbb\n')
		// Page 1: lines 2-3, source 8..16 ('ccc\nddd\n')
		// Page 2: line 4, source 16..19 ('eee')
		expect(pages[0].sourceStart).toBe(0);
		expect(pages[1].sourceStart).toBe(pages[0].sourceEnd);
		expect(pages[2].sourceStart).toBe(pages[1].sourceEnd);
		expect(pages[pages.length - 1].sourceEnd).toBe(content.length);
	});

	it('reconstructs the original content when pages are joined by newline', () => {
		const content = Array.from({ length: 33 }, (_, i) => `Line ${i}`).join('\n');
		const pages = paginate(content, 10);
		const recombined = pages.map((p) => p.lines.join('\n')).join('\n');
		expect(recombined).toBe(content);
	});

	it('uses DEFAULT_LINES_PER_PAGE when no size is specified', () => {
		expect(DEFAULT_LINES_PER_PAGE).toBe(80);
		const content = Array.from({ length: 100 }, (_, i) => `x${i}`).join('\n');
		const pages = paginate(content);
		expect(pages[0].lines.length).toBe(DEFAULT_LINES_PER_PAGE);
	});

	it('throws on non-positive linesPerPage', () => {
		expect(() => paginate('a\nb', 0)).toThrow();
		expect(() => paginate('a\nb', -5)).toThrow();
	});

	it('handles a 100k-line stress input without crashing', () => {
		const lines = Array.from({ length: 100_000 }, (_, i) => `l${i}`);
		const pages = paginate(lines.join('\n'), 80);
		expect(pages.length).toBeGreaterThan(0);
		expect(pages[0].startLine).toBe(0);
	});
});

describe('pageIndexAtOffset', () => {
	const pages = paginate(Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n'), 50);
	// 4 pages of 50 lines each.

	it('returns 0 for empty pages array', () => {
		expect(pageIndexAtOffset([], 100)).toBe(0);
	});

	it('returns 0 for offset 0', () => {
		expect(pageIndexAtOffset(pages, 0)).toBe(0);
	});

	it('returns the correct page index for offsets inside each page', () => {
		expect(pageIndexAtOffset(pages, pages[1].sourceStart + 5)).toBe(1);
		expect(pageIndexAtOffset(pages, pages[2].sourceStart + 5)).toBe(2);
		expect(pageIndexAtOffset(pages, pages[3].sourceStart + 5)).toBe(3);
	});

	it('clamps to the last page for offsets past the end', () => {
		expect(pageIndexAtOffset(pages, 10_000_000)).toBe(pages.length - 1);
	});

	it('handles negative offsets defensively', () => {
		expect(pageIndexAtOffset(pages, -10)).toBe(0);
	});

	it('treats sourceEnd as exclusive (next page wins at the boundary)', () => {
		const boundary = pages[1].sourceEnd;
		expect(pageIndexAtOffset(pages, boundary)).toBe(2);
	});
});
