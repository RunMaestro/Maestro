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
	splitCompleteSentences,
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
		expect(splitIntoSpokenSentences('Check a store, e.g. the session one.')).toEqual([
			'Check a store, e.g. the session one.',
		]);
		expect(splitIntoSpokenSentences('It ships in the U.S. only.')).toEqual([
			'It ships in the U.S. only.',
		]);
	});

	it('splits after an acronym, which agents write constantly', () => {
		// A `(?<![A-Z])` lookbehind used to swallow this boundary, so TTS read two
		// sentences as one breathless run every time an agent mentioned an API.
		expect(splitIntoSpokenSentences('Fixed the API. Then I ran the tests.')).toEqual([
			'Fixed the API.',
			'Then I ran the tests.',
		]);
	});

	it('does not split inside decimals, version numbers, or file paths', () => {
		expect(splitIntoSpokenSentences('Coverage is 99.5 percent now.')).toEqual([
			'Coverage is 99.5 percent now.',
		]);
		expect(splitIntoSpokenSentences('Bumped it to v1.2.3 this morning.')).toEqual([
			'Bumped it to v1.2.3 this morning.',
		]);
		expect(splitIntoSpokenSentences('The fix is in src/main/index.ts near the top.')).toEqual([
			'The fix is in src/main/index.ts near the top.',
		]);
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

describe('splitCompleteSentences', () => {
	it('holds back the fragment still being written', () => {
		expect(splitCompleteSentences('All done. Now the te')).toEqual({
			sentences: ['All done.'],
			rest: 'Now the te',
		});
	});

	it('holds back a token that ends in a period, because the next character decides', () => {
		// "index." becomes "index.ts" one token later. A sentence already synthesized
		// cannot be taken back.
		expect(splitCompleteSentences('The fix is in index.')).toEqual({
			sentences: [],
			rest: 'The fix is in index.',
		});
	});

	it('preserves the separator so the next delta does not fuse onto the tail', () => {
		let buffer = '';
		const spoken: string[] = [];
		for (const delta of ['Done, ', 'the auth bug ', 'was stale. ', 'Two files changed.']) {
			buffer += delta;
			const result = splitCompleteSentences(buffer);
			buffer = result.rest;
			spoken.push(...result.sentences);
		}

		expect(spoken).toEqual(['Done, the auth bug was stale.']);
		expect(buffer).toBe('Two files changed.');
	});

	it('has nothing to say about an empty buffer', () => {
		expect(splitCompleteSentences('')).toEqual({ sentences: [], rest: '' });
	});
});
