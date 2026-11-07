/**
 * @file send-phrase.test.ts
 *
 * The spoken "that's it, go". Two things have to be exactly right: it fires only
 * at the END of a turn (mid-sentence agreement is not a send signal), and what
 * survives is the request WITHOUT the phrase, because that string becomes the
 * prompt an agent receives.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_SEND_PHRASES,
	matchSendPhrase,
	normalisePhrase,
} from '../../../../main/acappella/speech/send-phrase';

/**
 * Everyday phrases a user might add. The matcher's rules are shown on these
 * rather than on the shipped default, which is one phrase chosen because nobody
 * says it by accident.
 */
const EVERYDAY = ["that's it", 'send it', 'go ahead'];

describe('matchSendPhrase', () => {
	it('strips the phrase and keeps the request', () => {
		const match = matchSendPhrase('fix the auth bug, go maestro');

		expect(match?.text).toBe('fix the auth bug');
		expect(match?.phrase).toBe('go maestro');
	});

	it('returns empty text when the whole turn was the signal', () => {
		// The common case: you pause, then say it on its own. Everything already
		// buffered is the request.
		const match = matchSendPhrase("That's it.", EVERYDAY);

		expect(match).not.toBeNull();
		expect(match?.text).toBe('');
	});

	it('does NOT fire mid-sentence', () => {
		// Agreeing and then carrying on is not a send signal. Only position tells
		// these apart, which is why the match is anchored to the end.
		expect(matchSendPhrase("that's it, the bug is in the auth module", EVERYDAY)).toBeNull();
		expect(matchSendPhrase('go ahead and look at the tests', EVERYDAY)).toBeNull();
		expect(matchSendPhrase('go maestro, then fix the tests')).toBeNull();
	});

	it('ignores casing, punctuation and apostrophes the recogniser chose', () => {
		// Whether a transcript contains an apostrophe is a property of the engine,
		// not of the speaker.
		expect(matchSendPhrase('run the tests. Thats it', EVERYDAY)?.text).toBe('run the tests');
		expect(matchSendPhrase("run the tests, that's IT!", EVERYDAY)?.text).toBe('run the tests');
		expect(matchSendPhrase('run the tests. Go, Maestro!')?.text).toBe('run the tests');
	});

	it('keeps the original wording of the request', () => {
		// Normalising is for MATCHING. The surviving text becomes a prompt, so the
		// user's capitals and punctuation have to come through untouched.
		const match = matchSendPhrase('Look at OAuth in the API repo, send it', EVERYDAY);

		expect(match?.text).toBe('Look at OAuth in the API repo');
	});

	it('prefers the longest phrase when two could match', () => {
		const match = matchSendPhrase('do the thing, go ahead', ['ahead', 'go ahead']);

		expect(match?.phrase).toBe('go ahead');
		expect(match?.text).toBe('do the thing');
	});

	it('returns null when nothing matches', () => {
		expect(matchSendPhrase('fix the auth bug')).toBeNull();
	});

	it('returns null for an empty utterance', () => {
		expect(matchSendPhrase('   ')).toBeNull();
	});

	it('ignores a blank configured phrase rather than matching everything', () => {
		// An empty phrase normalises to '', which every string ends with.
		expect(matchSendPhrase('anything at all', ['', '  '])).toBeNull();
	});

	it('handles a symbol between the request and the phrase', () => {
		expect(matchSendPhrase('fix the bug -- go maestro')?.text).toBe('fix the bug');
	});

	it('ships one phrase, and it fires', () => {
		expect([...DEFAULT_SEND_PHRASES]).toEqual(['go maestro']);
		expect(matchSendPhrase('do the work, go maestro')?.text).toBe('do the work');
	});

	it('does not send on the everyday phrases the default list used to hold', () => {
		// Each of these ends ordinary sentences. Shipped switched on, a request
		// that closed with "...so go ahead" lost two words and went early.
		for (const phrase of ['good to go', ...EVERYDAY, 'make it so']) {
			expect(matchSendPhrase(`do the work, ${phrase}`)).toBeNull();
		}
	});
});

describe('normalisePhrase', () => {
	it('collapses casing, punctuation and spacing', () => {
		expect(normalisePhrase("  That's   IT!  ")).toBe('thats it');
	});

	it('reduces a string with nothing speakable in it to empty', () => {
		expect(normalisePhrase('!!! ...')).toBe('');
	});
});
