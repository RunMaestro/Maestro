/**
 * @file whisper-tokenizer.test.ts
 *
 * Turning Whisper's token ids back into text.
 *
 * The byte-level unmapping is the part worth testing, because getting it wrong
 * is invisible in English. GPT-2 style BPE cannot put a raw control byte in a
 * vocabulary key, so it maps all 256 byte values onto printable code points
 * first; concatenating token strings therefore yields PLACEHOLDERS, not text.
 * Skip the unmapping and plain ASCII still reads perfectly while every accented
 * character, curly quote, and emoji comes out as mojibake - a bug that would
 * survive any test written in English.
 */

import { describe, it, expect } from 'vitest';

import {
	WHISPER_EN_SPECIAL_TOKENS,
	WhisperTokenizer,
} from '../../../../main/acappella/providers/local/whisper/tokenizer';

/**
 * The GPT-2 byte-to-unicode map, built independently of the implementation.
 *
 * Written out here rather than imported so the test is a second opinion on the
 * encoding rather than a restatement of it.
 */
function byteEncoder(): Map<number, string> {
	const bytes: number[] = [];
	for (let b = 0x21; b <= 0x7e; b++) bytes.push(b);
	for (let b = 0xa1; b <= 0xac; b++) bytes.push(b);
	for (let b = 0xae; b <= 0xff; b++) bytes.push(b);
	const assigned = new Set(bytes);
	const points = [...bytes];
	let overflow = 0;
	for (let b = 0; b < 256; b++) {
		if (assigned.has(b)) continue;
		bytes.push(b);
		points.push(256 + overflow);
		overflow += 1;
	}
	const map = new Map<number, string>();
	for (let i = 0; i < bytes.length; i++) map.set(bytes[i], String.fromCodePoint(points[i]));
	return map;
}

const ENCODER = byteEncoder();

/** Encode a string the way the vocabulary stores it. */
function toVocabKey(text: string): string {
	return [...Buffer.from(text, 'utf8')].map((byte) => ENCODER.get(byte)!).join('');
}

/** Build a tokenizer whose vocabulary contains exactly `pieces`, in order. */
function tokenizerFor(pieces: string[]): { tokenizer: WhisperTokenizer; ids: number[] } {
	const vocab: Record<string, number> = {};
	const ids: number[] = [];
	pieces.forEach((piece, index) => {
		vocab[toVocabKey(piece)] = index;
		ids.push(index);
	});
	return {
		tokenizer: WhisperTokenizer.fromJson(JSON.stringify({ model: { vocab } })),
		ids,
	};
}

describe('WhisperTokenizer', () => {
	it('joins tokens into the sentence they spell', () => {
		const { tokenizer, ids } = tokenizerFor([' Open', ' the', ' auth', ' tab', '.']);
		expect(tokenizer.decode(ids)).toBe(' Open the auth tab.');
	});

	it('round-trips bytes that BPE cannot store literally', () => {
		// The test that fails when the byte-level step is skipped. Every one of
		// these is multi-byte UTF-8 or an unprintable ASCII value.
		for (const text of ['café', '“smart quotes”', 'naïve — dash', 'emoji 🎙 here', 'tab\there']) {
			const { tokenizer, ids } = tokenizerFor([text]);
			expect(tokenizer.decode(ids)).toBe(text);
		}
	});

	it('reassembles a character split across two tokens', () => {
		// BPE splits on bytes, not characters, so one code point can straddle a
		// token boundary. Decoding token-by-token to UTF-8 would produce two
		// replacement characters; decoding the whole byte run produces the letter.
		const bytes = [...Buffer.from('é', 'utf8')];
		expect(bytes.length).toBe(2);
		const vocab: Record<string, number> = {
			[ENCODER.get(bytes[0])!]: 0,
			[ENCODER.get(bytes[1])!]: 1,
		};
		const tokenizer = WhisperTokenizer.fromJson(JSON.stringify({ model: { vocab } }));
		expect(tokenizer.decode([0, 1])).toBe('é');
	});

	it('skips an id the vocabulary does not cover rather than throwing', () => {
		// A decode loop has no caller to catch for it: throwing here would lose the
		// whole utterance the user just spoke, to save one character.
		const { tokenizer } = tokenizerFor([' hello']);
		expect(tokenizer.decode([0, 999_999])).toBe(' hello');
	});

	it('decodes an empty sequence to an empty string', () => {
		const { tokenizer } = tokenizerFor([' hello']);
		expect(tokenizer.decode([])).toBe('');
	});

	it('reports its vocabulary size', () => {
		const { tokenizer } = tokenizerFor(['a', 'b', 'c']);
		expect(tokenizer.size).toBe(3);
	});

	it('refuses a tokenizer file with no vocabulary', () => {
		// Better to fail at load, where the recovery is "re-verify the model", than
		// to load happily and decode every utterance to an empty string.
		expect(() => WhisperTokenizer.fromJson('{}')).toThrow(/no model.vocab/);
		expect(() => WhisperTokenizer.fromJson(JSON.stringify({ model: { vocab: {} } }))).toThrow(
			/empty/
		);
	});

	it('pins the English-only special token ids', () => {
		// Read from the checkpoint's generation_config.json. Priming the decoder
		// with the wrong ids produces timestamp markers or a language token instead
		// of words, and nothing about the failure points back to these numbers.
		expect(WHISPER_EN_SPECIAL_TOKENS).toEqual({
			startOfTranscript: 50257,
			endOfText: 50256,
			noTimestamps: 50362,
		});
	});
});
