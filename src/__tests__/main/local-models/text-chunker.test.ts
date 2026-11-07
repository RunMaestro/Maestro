/**
 * @file text-chunker.test.ts
 *
 * The semantic index's text chunker. Most cases use a word counter (one token
 * per whitespace-separated word) so the expected windows can be read off the
 * input; the last block runs the real bge-small tokenizer fixture to show a
 * window is what the model will actually accept.
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import {
	CHUNK_OVERLAP_TOKENS,
	CHUNK_TARGET_TOKENS,
	MAX_CHUNKS_PER_SOURCE,
	chunkText,
} from '../../../main/local-models/text-chunker';
import { loadTokenizer } from '../../../main/local-models/tokenizer';

/** One token per word. */
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** `count` sentences of `length` words each: "s0w0 s0w1 ... ." */
function sentences(count: number, length: number): string {
	return Array.from(
		{ length: count },
		(_, s) => Array.from({ length }, (_, w) => `s${s}w${w}`).join(' ') + '.'
	).join(' ');
}

describe('chunkText', () => {
	it('has no windows for empty or blank text', () => {
		expect(chunkText('', { countTokens: words })).toEqual([]);
		expect(chunkText('  \n\t ', { countTokens: words })).toEqual([]);
	});

	it('returns a text that fits as one window, with one count', () => {
		const countTokens = vi.fn(words);
		expect(chunkText('  Fixed the login timeout.\n', { countTokens })).toEqual([
			'Fixed the login timeout.',
		]);
		expect(countTokens).toHaveBeenCalledTimes(1);
	});

	it('normalizes Windows line endings, so the same text hashes the same', () => {
		const unix = chunkText('one\ntwo\nthree', { countTokens: words });
		expect(chunkText('one\r\ntwo\r\nthree', { countTokens: words })).toEqual(unix);
	});

	it('cuts long text into windows that each fit, ending at sentence ends', () => {
		const chunks = chunkText(sentences(10, 10), {
			countTokens: words,
			maxTokens: 30,
			overlapTokens: 0,
		});
		expect(chunks).toHaveLength(4);
		for (const chunk of chunks) {
			expect(words(chunk)).toBeLessThanOrEqual(30);
			expect(chunk.endsWith('.')).toBe(true);
			expect(chunk.startsWith('s')).toBe(true);
		}
		// Nothing lost, nothing repeated, when the overlap is zero.
		expect(chunks.join(' ')).toBe(sentences(10, 10));
	});

	it('repeats the tail of a window at the start of the next', () => {
		const chunks = chunkText(sentences(6, 10), {
			countTokens: words,
			maxTokens: 30,
			overlapTokens: 10,
		});
		expect(chunks.length).toBeGreaterThan(2);
		for (let i = 1; i < chunks.length; i++) {
			const previousLast = chunks[i - 1].split('. ').pop();
			expect(chunks[i].startsWith(previousLast as string)).toBe(true);
			expect(words(chunks[i])).toBeLessThanOrEqual(30);
		}
	});

	it('drops the overlap rather than build an over-long window', () => {
		// The carried sentence (10) plus the next one (25) would be 35 > 30.
		const text = `${sentences(2, 10)} ${Array.from({ length: 25 }, (_, w) => `big${w}`).join(' ')}.`;
		const chunks = chunkText(text, { countTokens: words, maxTokens: 30, overlapTokens: 10 });
		for (const chunk of chunks) expect(words(chunk)).toBeLessThanOrEqual(30);
		expect(chunks[chunks.length - 1].startsWith('big0')).toBe(true);
	});

	it('splits a sentence longer than a window, at whitespace', () => {
		const long = Array.from({ length: 100 }, (_, w) => `w${w}`).join(' ');
		const chunks = chunkText(long, { countTokens: words, maxTokens: 30, overlapTokens: 0 });
		expect(chunks.length).toBeGreaterThanOrEqual(4);
		for (const chunk of chunks) expect(words(chunk)).toBeLessThanOrEqual(30);
		// No word was cut in half.
		expect(chunks.join(' ').split(' ')).toEqual(long.split(' '));
	});

	it('splits text with no whitespace at all, without breaking a surrogate pair', () => {
		const blob = '😀'.repeat(40);
		const perChar = (text: string) => [...text].length;
		const chunks = chunkText(blob, { countTokens: perChar, maxTokens: 8, overlapTokens: 0 });
		expect(chunks.join('')).toBe(blob);
		for (const chunk of chunks) {
			expect(perChar(chunk)).toBeLessThanOrEqual(8);
			// A lone surrogate would not survive a round trip through UTF-8.
			expect(Buffer.from(chunk, 'utf8').toString('utf8')).toBe(chunk);
		}
	});

	it('keeps at most maxChunks windows', () => {
		const chunks = chunkText(sentences(200, 10), {
			countTokens: words,
			maxTokens: 30,
			overlapTokens: 0,
			maxChunks: 3,
		});
		expect(chunks).toHaveLength(3);
		expect(chunks[0].startsWith('s0w0')).toBe(true);
	});

	it('bounds a huge text before counting it, so the work per source is capped', () => {
		const counted: number[] = [];
		const countTokens = (text: string) => {
			counted.push(text.length);
			return words(text);
		};
		const huge = sentences(50_000, 10);
		chunkText(huge, { countTokens, maxTokens: 30, maxChunks: 2 });
		// Never handed more than the bound, however long the text is.
		expect(Math.max(...counted)).toBeLessThan(1_000);
		expect(huge.length).toBeGreaterThan(1_000_000);
	});

	it('is deterministic: the same text and counter give the same windows', () => {
		const text = sentences(40, 12);
		const options = { countTokens: words, maxTokens: 50, overlapTokens: 12 };
		expect(chunkText(text, options)).toEqual(chunkText(text, options));
	});

	it('defaults to the documented window, overlap and cap', () => {
		expect(CHUNK_TARGET_TOKENS).toBeGreaterThanOrEqual(200);
		expect(CHUNK_TARGET_TOKENS).toBeLessThanOrEqual(400);
		expect(CHUNK_OVERLAP_TOKENS).toBeLessThan(CHUNK_TARGET_TOKENS / 2);
		// Short words, so the character bound is not what stops it.
		const text = Array.from({ length: 20_000 }, (_, i) => (i % 10 === 9 ? 'ab.' : 'ab')).join(' ');
		const chunks = chunkText(text, { countTokens: words });
		expect(chunks).toHaveLength(MAX_CHUNKS_PER_SOURCE);
		for (const chunk of chunks) expect(words(chunk)).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS);
	});
});

describe('chunkText with the bge-small tokenizer', () => {
	const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/tokenizers/bge-small-en-v1.5');

	it('produces windows the model reads whole, special tokens included', async () => {
		const tokenizer = await loadTokenizer(FIXTURE_DIR);
		const text = Array.from(
			{ length: 120 },
			(_, i) => `Entry ${i}: renamed the tab and fixed the login timeout in the session store.`
		).join('\n');

		const chunks = chunkText(text, { countTokens: (value) => tokenizer.countTokens(value) });

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			// Encoded the way the embedding service does, nothing is truncated.
			const encoded = tokenizer.encode(chunk, { truncation: false });
			expect(encoded.inputIds.length).toBeLessThanOrEqual(512);
			expect(tokenizer.countTokens(chunk)).toBeLessThanOrEqual(CHUNK_TARGET_TOKENS);
		}
	});
});
