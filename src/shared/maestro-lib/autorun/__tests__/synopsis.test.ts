import { describe, expect, it } from 'vitest';

import { extractGoalSynopsis, extractTaskSynopsis } from '../synopsis';

describe('extractTaskSynopsis', () => {
	it('takes the first sentence of the first paragraph and keeps the whole answer as the full text', () => {
		const response = 'Added the retry to the sender. It now backs off.\n\nDetails follow here.';
		expect(extractTaskSynopsis(response, 'doc')).toEqual({
			shortSummary: 'Added the retry to the sender.',
			fullSynopsis: response,
		});
	});

	it('does not split on the dot in a file name', () => {
		expect(
			extractTaskSynopsis('Edited src/app.tsx to add the guard. Done.', 'doc').shortSummary
		).toBe('Edited src/app.tsx to add the guard.');
	});

	it('drops a `Summary:` label and heading markers, and bold', () => {
		expect(
			extractTaskSynopsis('**Summary:** Fixed the **parser** crash.', 'doc').shortSummary
		).toBe('Fixed the parser crash.');
		expect(extractTaskSynopsis('## Fixed the loader crash.', 'doc').shortSummary).toBe(
			'Fixed the loader crash.'
		);
	});

	it('cuts a paragraph with no sentence end at 150 characters', () => {
		const long = 'word '.repeat(60).trim();
		const { shortSummary } = extractTaskSynopsis(long, 'doc');
		expect(shortSummary).toHaveLength(153);
		expect(shortSummary.endsWith('...')).toBe(true);
	});

	it('keeps the plain line for an empty answer or a paragraph too short to be a synopsis', () => {
		const plain = { shortSummary: '[doc] Task completed', fullSynopsis: '[doc] Task completed' };
		expect(extractTaskSynopsis(undefined, 'doc')).toEqual(plain);
		expect(extractTaskSynopsis('   \n ', 'doc')).toEqual(plain);
		expect(extractTaskSynopsis('Done.', 'doc')).toEqual(plain);
	});
});

describe('extractGoalSynopsis', () => {
	it('drops the control markers before it reads the answer', () => {
		expect(
			extractGoalSynopsis(
				'<!-- maestro:progress 40 | halfway -->\nWired the parser in. Next is the lexer.\n\nMore.',
				2
			)
		).toBe('Wired the parser in.');
	});

	it('falls back to the iteration when nothing usable is left', () => {
		expect(extractGoalSynopsis(undefined, 3)).toBe('Iteration 3 completed');
		expect(extractGoalSynopsis('<!-- maestro:goal-complete -->', 3)).toBe('Iteration 3 completed');
		expect(extractGoalSynopsis('ok', 3)).toBe('Iteration 3 completed');
	});
});
