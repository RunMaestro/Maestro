/**
 * Tests for Kokoro's front end: the text rules ported from kokoro-js, the
 * phoneme-to-id mapping, the cut that keeps a long sequence under the model's
 * limit, and the shield around espeak's process-wide error handlers.
 *
 * espeak-ng here is the REAL one (the `phonemizer` package is plain
 * JavaScript, so it runs in a unit test), against the model's real vocabulary
 * (`fixtures/kokoro-tokenizer.json`, the pinned `tokenizer.json` with non-ASCII
 * keys written as escapes). So the golden ids below are checked on every run,
 * with no model download. `kokoro-e2e.test.ts` checks the audio.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';

import {
	kokoroPhonemes,
	normalizeKokoroText,
	type EspeakPhonemize,
} from '../../../../main/acappella/providers/local/kokoro/text';
import {
	KOKORO_MAX_TOKENS,
	kokoroVocabFrom,
	loadKokoroVocab,
	phonemesToIds,
	splitTokenRuns,
} from '../../../../main/acappella/providers/local/kokoro/tokens';
import {
	loadEspeak,
	withoutAddedErrorHandlers,
} from '../../../../main/acappella/providers/local/kokoro/espeak';
import { createKokoroFrontEnd } from '../../../../main/acappella/providers/local/kokoro/front-end';

const TOKENIZER = path.join(__dirname, '..', '..', '..', 'fixtures', 'kokoro-tokenizer.json');

/** kokoro-js 1.2.1 for "Hello world, this is a test.", without the pad tokens. */
const GOLDEN_IDS = [
	50, 83, 54, 156, 57, 135, 16, 65, 156, 87, 158, 54, 46, 3, 16, 81, 102, 61, 16, 102, 68, 16, 70,
	16, 62, 156, 86, 61, 62, 4,
];

/** A stand-in that returns each run of words unchanged, so the rules around it are visible. */
const echo: EspeakPhonemize = async (text) => [text];

describe('normalizeKokoroText', () => {
	it.each([
		['In 1999 and the 1980s', 'In 19 99 and the 19 80s'],
		['It was 1905', 'It was 19 oh 5'],
		// A year in the first decade of a millennium is left for espeak to read.
		['It was 2005', 'It was 2005'],
		['Born in 1900', 'Born in 19 hundred'],
		['Meet at 3:05 or 12:30 or 4:00', "Meet at 3 oh 5 or 12 30 or 4 o'clock"],
		['It costs $9.99', 'It costs 9 dollars and 99 cents'],
		['Only $1 or \u00a31.01', 'Only 1 dollar or 1 pound and 1 penny'],
		['Pi is 3.14', 'Pi is 3 point 1 4'],
		['Pages 10-20 of 1,000', 'Pages 10 to 20 of 1000'],
		['Dr. Smith and Mr. Jones', 'Doctor Smith and Mister Jones'],
		['yeah', "ye'a"],
		['the U.S.A. is', 'the U-S-A- is'],
	])('reads %j as %j', (input, expected) => {
		expect(normalizeKokoroText(input)).toBe(expected);
	});

	it('folds typographic quotes, and turns brackets into guillemets', () => {
		expect(normalizeKokoroText('\u2018it\u2019s\u2019')).toBe("'it's'");
		expect(normalizeKokoroText('\u201chi\u201d')).toBe('"hi"');
		// The vocabulary has no guillemet, so a parenthesis is silent, not spoken.
		expect(normalizeKokoroText('a (b) c')).toBe('a \u00abb\u00bb c');
	});

	it('collapses only the first run of spaces, as the reference does', () => {
		// Not a bug to fix: the voice was trained on text prepared by this rule.
		expect(normalizeKokoroText('a   b   c')).toBe('a b   c');
	});
});

describe('kokoroPhonemes', () => {
	it('phonemizes the words and leaves the punctuation between them where it was', async () => {
		const calls: string[] = [];
		const espeak: EspeakPhonemize = async (text, language) => {
			calls.push(`${language}:${text}`);
			return [text.toUpperCase()];
		};

		expect(await kokoroPhonemes('one, two. Three!', espeak)).toBe('ONE, TWO. THREE!');
		// espeak never sees the punctuation, which it would drop.
		expect(calls).toEqual(['en-us:one', 'en-us:two', 'en-us:Three']);
	});

	it('asks for British English for a British voice', async () => {
		const languages: string[] = [];
		await kokoroPhonemes(
			'hello',
			async (text, language) => {
				languages.push(language);
				return [text];
			},
			'b'
		);
		expect(languages).toEqual(['en']);
	});

	it("maps espeak's phonemes onto Kokoro's", async () => {
		// r is the turned r, x is k, and a clause espeak split is joined by a space.
		expect(await kokoroPhonemes('w', async () => ['rax', 'r'])).toBe('\u0279ak \u0279');
		// American English only: "ninety" with a flap.
		expect(await kokoroPhonemes('w', async () => ['n\u02c8a\u026anti'])).toBe('n\u02c8a\u026andi');
		expect(await kokoroPhonemes('w', async () => ['n\u02c8a\u026anti'], 'b')).toBe(
			'n\u02c8a\u026anti'
		);
	});

	it('produces the reference phonemes with the real espeak', async () => {
		expect(await kokoroPhonemes('Hello world, this is a test.', loadEspeak())).toBe(
			'h\u0259l\u02c8o\u028a w\u02c8\u025c\u02d0ld, \u00f0\u026as \u026az \u0250 t\u02c8\u025bst.'
		);
	});
});

describe('the vocabulary', () => {
	it('reads the model tokenizer and finds where a sequence may be cut', async () => {
		const vocab = await loadKokoroVocab(TOKENIZER);
		expect(vocab.ids.size).toBe(115);
		expect(vocab.ids.get('$')).toBe(0);
		expect(vocab.space).toBe(16);
		// ; : , . ! ? and the dash and the ellipsis.
		expect([...vocab.punctuation].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 9, 10]);
	});

	it('refuses a tokenizer file with no vocabulary', () => {
		expect(() => kokoroVocabFrom({})).toThrow(/empty/);
		expect(() => kokoroVocabFrom({ a: 'x' })).toThrow(/empty/);
	});

	it('maps each phoneme to its id and drops what the vocabulary lacks', () => {
		const vocab = kokoroVocabFrom({ a: 1, b: 2, ' ': 3 });
		expect(phonemesToIds('a b', vocab)).toEqual([1, 3, 2]);
		// The model's own tokenizer deletes unknown characters; so does this.
		expect(phonemesToIds('a?b\u00ab', vocab)).toEqual([1, 2]);
		expect(phonemesToIds('', vocab)).toEqual([]);
	});

	it('turns the sentence into the ids the reference implementation produces', async () => {
		const frontEnd = await createKokoroFrontEnd({ tokenizerPath: TOKENIZER });
		expect(await frontEnd.phonemize('Hello world, this is a test.')).toEqual(GOLDEN_IDS);
		// Brackets become guillemets, which are not in the vocabulary: nothing to say.
		expect(await frontEnd.phonemize('()')).toEqual([]);
	});

	it('keeps an ordinary sentence under the limit and a run of digits far over it', async () => {
		const frontEnd = await createKokoroFrontEnd({ tokenizerPath: TOKENIZER });
		const prose = await frontEnd.phonemize(
			'The quick brown fox jumps over the lazy dog, and then it goes home to sleep for a while.'
		);
		const digits = await frontEnd.phonemize('1234567 '.repeat(29));
		expect(prose.length).toBeLessThan(KOKORO_MAX_TOKENS);
		// Why a sentence is not a safe unit to hand the model.
		expect(digits.length).toBeGreaterThan(2 * KOKORO_MAX_TOKENS);
		for (const run of splitTokenRuns(digits, frontEnd.vocab)) {
			expect(run.length).toBeLessThanOrEqual(KOKORO_MAX_TOKENS);
		}
	});
});

describe('splitTokenRuns', () => {
	const vocab = { punctuation: new Set([9]), space: 0 };

	it('returns a short sequence whole', () => {
		expect(splitTokenRuns([1, 2, 3], vocab, 10)).toEqual([[1, 2, 3]]);
		expect(splitTokenRuns([], vocab, 10)).toEqual([]);
	});

	it('cuts after the last punctuation that fits, and keeps it with its run', () => {
		expect(splitTokenRuns([1, 2, 9, 0, 3, 4, 5, 6], vocab, 5)).toEqual([
			[1, 2, 9],
			[3, 4, 5, 6],
		]);
	});

	it('cuts at the last space that fits when there is no punctuation, and drops that space', () => {
		// The space at index 5 is one past the limit, so the cut is the one at 2.
		expect(splitTokenRuns([1, 2, 0, 3, 4, 0, 5, 6], vocab, 5)).toEqual([
			[1, 2],
			[3, 4, 0, 5, 6],
		]);
	});

	it('cuts mid-word only when one word alone is longer than the limit', () => {
		expect(splitTokenRuns([1, 2, 3, 4, 5, 6, 7], vocab, 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
	});

	it('never loses an id other than a space it cut at', () => {
		const ids = Array.from({ length: 1000 }, (_, index) => (index % 7 === 6 ? 0 : (index % 5) + 1));
		const runs = splitTokenRuns(ids, vocab, 64);
		for (const run of runs) expect(run.length).toBeLessThanOrEqual(64);
		expect(runs.flat().filter((id) => id !== 0)).toEqual(ids.filter((id) => id !== 0));
	});
});

describe('withoutAddedErrorHandlers', () => {
	it('removes the process error handlers a load adds, and keeps the ones that were there', () => {
		const mine = () => {};
		process.on('unhandledRejection', mine);
		try {
			const added = () => {};
			const value = withoutAddedErrorHandlers(() => {
				process.on('uncaughtException', added);
				process.on('unhandledRejection', added);
				return 42;
			});

			expect(value).toBe(42);
			expect(process.listeners('uncaughtException')).not.toContain(added);
			expect(process.listeners('unhandledRejection')).not.toContain(added);
			expect(process.listeners('unhandledRejection')).toContain(mine);
		} finally {
			process.removeListener('unhandledRejection', mine);
		}
	});

	it('removes them when the load throws, too', () => {
		const added = () => {};
		expect(() =>
			withoutAddedErrorHandlers(() => {
				process.on('uncaughtException', added);
				throw new Error('load failed');
			})
		).toThrow('load failed');
		expect(process.listeners('uncaughtException')).not.toContain(added);
	});

	it('leaves no handler behind after the real espeak is loaded', async () => {
		// The package registers one of each on import. Left in place, any uncaught
		// error anywhere in the app would end the process.
		const before = [
			process.listenerCount('uncaughtException'),
			process.listenerCount('unhandledRejection'),
		];
		const espeak = loadEspeak();
		expect(await espeak('test', 'en-us')).toEqual(['t\u02c8\u025bst']);
		expect([
			process.listenerCount('uncaughtException'),
			process.listenerCount('unhandledRejection'),
		]).toEqual(before);
	});
});
