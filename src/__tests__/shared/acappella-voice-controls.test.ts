/**
 * @file acappella-voice-controls.test.ts
 *
 * The send phrases as they are stored. The list is a comma-separated string in
 * settings, an array everywhere it is used, and "absent" has to stay different
 * from "empty": absent takes the shipped phrases, empty turns the spoken send
 * off.
 */

import { describe, it, expect } from 'vitest';

import {
	DEFAULT_SEND_PHRASES,
	LEGACY_DEFAULT_SEND_PHRASES,
	formatSendPhrases,
	isLegacyDefaultSendPhrases,
	parseSendPhrases,
} from '../../shared/acappella/voice-controls';

describe('the shipped send phrases', () => {
	it('are one phrase, the one every surface quotes', () => {
		// The HUD and the held notice name `[0]`, so it is the one a user learns.
		expect([...DEFAULT_SEND_PHRASES]).toEqual(['go maestro']);
	});

	it('share nothing with the old list, whose phrases all end ordinary sentences', () => {
		for (const phrase of LEGACY_DEFAULT_SEND_PHRASES) {
			expect(DEFAULT_SEND_PHRASES).not.toContain(phrase);
		}
	});
});

describe('formatSendPhrases', () => {
	it('round-trips with the parser', () => {
		const phrases = ['go maestro', 'ship it', "that's all"];
		const stored = formatSendPhrases(phrases);

		expect(stored).toBe("go maestro, ship it, that's all");
		expect(parseSendPhrases(stored)).toEqual(phrases);
		expect(formatSendPhrases(DEFAULT_SEND_PHRASES)).toBe('go maestro');
	});

	it('writes an empty list as the empty string, which is "off" and not "absent"', () => {
		expect(formatSendPhrases([])).toBe('');
		expect(parseSendPhrases('')).toEqual([]);
		expect(parseSendPhrases(undefined)).toBeUndefined();
	});
});

describe('isLegacyDefaultSendPhrases', () => {
	it('recognises the old list however the commas were spaced', () => {
		expect(isLegacyDefaultSendPhrases(formatSendPhrases(LEGACY_DEFAULT_SEND_PHRASES))).toBe(true);
		expect(isLegacyDefaultSendPhrases("good to go,that's it ,  send it,go ahead,make it so,")).toBe(
			true
		);
		expect(isLegacyDefaultSendPhrases("Good to go, That's it, Send it, Go ahead, Make it so")).toBe(
			true
		);
	});

	it('leaves anything the user changed alone', () => {
		// One phrase removed, one added, the order changed: each is a choice.
		expect(isLegacyDefaultSendPhrases("good to go, that's it, send it, go ahead")).toBe(false);
		expect(
			isLegacyDefaultSendPhrases("good to go, that's it, send it, go ahead, make it so, ship it")
		).toBe(false);
		expect(isLegacyDefaultSendPhrases("that's it, good to go, send it, go ahead, make it so")).toBe(
			false
		);
		expect(isLegacyDefaultSendPhrases('good to go')).toBe(false);
	});

	it('is false for a list that was emptied, or never stored', () => {
		expect(isLegacyDefaultSendPhrases('')).toBe(false);
		expect(isLegacyDefaultSendPhrases(undefined)).toBe(false);
		expect(isLegacyDefaultSendPhrases(['good to go'])).toBe(false);
	});
});
