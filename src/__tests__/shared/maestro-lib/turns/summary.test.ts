/**
 * The one-line answer summary the desktop's exit toast and the runtime's History entry share.
 */
import { describe, it, expect } from 'vitest';

import { summarizeAnswer } from '../../../../shared/maestro-lib/turns/summary';

describe('summarizeAnswer', () => {
	it('takes the first sentence that says something', () => {
		expect(
			summarizeAnswer('Fixed the login bug in the session handler. Then I reran the tests.')
		).toBe('Fixed the login bug in the session handler.');
	});

	it('skips an opening filler sentence', () => {
		expect(summarizeAnswer('Perfect! Added pagination to the user list. All tests pass.')).toBe(
			'Added pagination to the user list.'
		);
		expect(summarizeAnswer('Done. Renamed the helper across 4 files.')).toBe(
			'Renamed the helper across 4 files.'
		);
	});

	it('has no summary for an answer of 10 characters or fewer, or an empty one', () => {
		expect(summarizeAnswer('Done.')).toBe('');
		expect(summarizeAnswer('   ')).toBe('');
		expect(summarizeAnswer(undefined)).toBe('');
	});

	it('trims surrounding whitespace before it decides', () => {
		expect(summarizeAnswer('\n  Updated the README with the new flags.  \n')).toBe(
			'Updated the README with the new flags.'
		);
	});

	it('takes the first 120 characters of text with no sentence in it', () => {
		// Behavior carried over from the exit toast: the head is returned as is, because it is
		// already shorter than the text. The ellipsis only appears when no sentence was found
		// AND the head is the whole text, which cannot exceed 120 characters.
		expect(summarizeAnswer('a'.repeat(200))).toBe('a'.repeat(120));
	});

	it('returns a short unpunctuated answer whole, without an ellipsis', () => {
		expect(summarizeAnswer('Updated three files')).toBe('Updated three files');
	});

	it('falls back to the head when every sentence is filler', () => {
		expect(summarizeAnswer('Perfect! Great! Awesome!')).toBe('Perfect! Great! Awesome!');
	});
});
