import { describe, it, expect } from 'vitest';
import { BufferedLineReader, type FrameExtractionResult } from '../buffered-line-reader';

describe('BufferedLineReader', () => {
	it('returns nothing when a chunk has no complete line yet', () => {
		const reader = new BufferedLineReader();
		expect(reader.push('partial line, no newline')).toEqual([]);
		expect(reader.isEmpty).toBe(false);
	});

	it('returns a complete line once its newline arrives, and keeps the remainder pending', () => {
		const reader = new BufferedLineReader();
		expect(reader.push('{"a":1}\n{"b":2')).toEqual(['{"a":1}']);
		expect(reader.isEmpty).toBe(false);
	});

	it('returns every complete line from a multi-line chunk in arrival order', () => {
		const reader = new BufferedLineReader();
		const lines = reader.push('line1\nline2\nline3\n');
		expect(lines).toEqual(['line1', 'line2', 'line3']);
		expect(reader.isEmpty).toBe(true);
	});

	it('reassembles a line split across two chunks', () => {
		const reader = new BufferedLineReader();
		expect(reader.push('{"partial":')).toEqual([]);
		expect(reader.push('"done"}\n')).toEqual(['{"partial":"done"}']);
	});

	it('drops blank lines, matching the existing `if (!line.trim()) continue` behavior', () => {
		const reader = new BufferedLineReader();
		const lines = reader.push('line1\n\n   \nline2\n');
		expect(lines).toEqual(['line1', 'line2']);
	});

	it('flush returns the trimmed trailing partial content and clears state', () => {
		const reader = new BufferedLineReader();
		reader.push('trailing content with no newline');
		expect(reader.flush()).toBe('trailing content with no newline');
		expect(reader.isEmpty).toBe(true);
		// A second flush with nothing pending returns undefined, not ''.
		expect(reader.flush()).toBeUndefined();
	});

	it('flush returns undefined when only whitespace remains', () => {
		const reader = new BufferedLineReader();
		reader.push('   \n  ');
		expect(reader.flush()).toBeUndefined();
	});

	it('resets the buffer and returns no frames when maxBufferLength is exceeded (Copilot oversized-buffer protection, generalized)', () => {
		const reader = new BufferedLineReader({ maxBufferLength: 10 });
		expect(reader.push('this is way more than ten characters and has no newline')).toEqual([]);
		expect(reader.isEmpty).toBe(true);
	});

	it('does not reset the buffer when a complete frame is found before the length limit would matter', () => {
		const reader = new BufferedLineReader({ maxBufferLength: 1000 });
		expect(reader.push('short\n')).toEqual(['short']);
	});

	it('still returns complete frames from a chunk whose TOTAL size (frames + remainder) exceeds maxBufferLength, dropping only the leftover remainder', () => {
		// Regression test: the cap must be checked AFTER extraction, on the
		// remainder alone - not on the raw pushed buffer before extraction.
		// A burst of many complete, well-formed frames must not be punished
		// just because the chunk containing them happens to be large.
		const reader = new BufferedLineReader({ maxBufferLength: 20 });
		const manySmallFrames = Array.from({ length: 10 }, (_, i) => `frame-${i}`).join('\n') + '\n';
		expect(manySmallFrames.length).toBeGreaterThan(20); // the whole chunk exceeds the cap...

		const frames = reader.push(manySmallFrames + 'incomplete-tail-well-past-the-cap');

		// ...but every complete frame still comes back...
		expect(frames).toEqual(Array.from({ length: 10 }, (_, i) => `frame-${i}`));
		// ...and only the oversized unparsed remainder is dropped.
		expect(reader.isEmpty).toBe(true);
	});

	it('accepts a custom frame extractor (e.g. a Copilot-style concatenated-object strategy)', () => {
		// A deliberately non-newline extractor: frames are delimited by `;`
		// instead, to prove the class doesn't hardcode newline splitting when
		// a custom extractor is supplied.
		function semicolonExtractor(buffer: string): FrameExtractionResult {
			const parts = buffer.split(';');
			const remainder = parts.pop() ?? '';
			return { frames: parts, remainder };
		}

		const reader = new BufferedLineReader({ extractFrames: semicolonExtractor });
		expect(reader.push('a;b;c')).toEqual(['a', 'b']);
		expect(reader.push(';d;')).toEqual(['c', 'd']);
	});

	it('isEmpty reflects pending partial content, not frame history', () => {
		const reader = new BufferedLineReader();
		expect(reader.isEmpty).toBe(true);
		reader.push('complete\n');
		expect(reader.isEmpty).toBe(true);
		reader.push('incomplete');
		expect(reader.isEmpty).toBe(false);
	});
});
