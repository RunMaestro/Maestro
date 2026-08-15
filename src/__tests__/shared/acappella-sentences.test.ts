/**
 * Tests for the single spoken-sentence splitter shared by the session service
 * (which announces `sentenceCount` up front) and every TTS provider (which
 * emits one chunk per sentence). If these two ever disagree, a client's
 * "sentence 3 of 5" progress never completes, so the splitter is pinned here.
 */

import { describe, it, expect } from 'vitest';
import {
	MAX_SPOKEN_SENTENCE_LENGTH,
	countSpokenSentences,
	splitIntoSpokenSentences,
} from '../../shared/acappella/sentences';

describe('splitIntoSpokenSentences', () => {
	it('returns nothing for empty or whitespace-only text', () => {
		expect(splitIntoSpokenSentences('')).toEqual([]);
		expect(splitIntoSpokenSentences('   \n\t ')).toEqual([]);
	});

	it('splits on terminal punctuation and keeps it', () => {
		expect(splitIntoSpokenSentences('All done. Two files changed! Ready?')).toEqual([
			'All done.',
			'Two files changed!',
			'Ready?',
		]);
	});

	it('normalizes whitespace so wrapped agent output has no embedded newlines', () => {
		expect(splitIntoSpokenSentences('Fixed the\n  auth bug.\n\nTests pass.')).toEqual([
			'Fixed the auth bug.',
			'Tests pass.',
		]);
	});

	it('keeps abbreviations intact', () => {
		expect(splitIntoSpokenSentences('Ask Dr. Kim about it.')).toEqual(['Ask Dr. Kim about it.']);
	});

	it('treats an unterminated tail as its own sentence', () => {
		expect(splitIntoSpokenSentences('Done. Now the tests')).toEqual(['Done.', 'Now the tests']);
	});

	it('collapses a run of terminal punctuation into one boundary', () => {
		expect(splitIntoSpokenSentences('Wow!!! Really?!')).toEqual(['Wow!!!', 'Really?!']);
	});

	it('hard-wraps punctuation-free text at a word boundary', () => {
		const long = 'word '.repeat(120).trim();
		const sentences = splitIntoSpokenSentences(long);

		expect(sentences.length).toBeGreaterThan(1);
		for (const sentence of sentences) {
			expect(sentence.length).toBeLessThanOrEqual(MAX_SPOKEN_SENTENCE_LENGTH);
			expect(sentence).not.toMatch(/^\s|\s$/);
		}
		expect(sentences.join(' ')).toBe(long);
	});

	it('counts what it splits', () => {
		const text = 'One. Two. Three.';
		expect(countSpokenSentences(text)).toBe(splitIntoSpokenSentences(text).length);
		expect(countSpokenSentences('   ')).toBe(0);
	});
});
