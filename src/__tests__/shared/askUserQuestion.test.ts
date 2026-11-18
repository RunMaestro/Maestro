/**
 * @file askUserQuestion.test.ts
 * @description Tests for src/shared/askUserQuestion.ts: the defensive parser
 * both the permission relay and maestro-p read AskUserQuestion input with, and
 * the reply-text rendering maestro-p shows on the TUI path.
 */

import { describe, it, expect } from 'vitest';

import { formatAskUserQuestionsAsText, parseAskUserQuestions } from '../../shared/askUserQuestion';

describe('parseAskUserQuestions', () => {
	it('parses questions, options, header, and multiSelect', () => {
		expect(
			parseAskUserQuestions({
				questions: [
					{
						question: 'Pick toppings',
						header: 'Pizza',
						options: [{ label: 'Cheese', description: 'Mozzarella' }, 'Basil', { label: '' }],
						multiSelect: true,
					},
				],
			})
		).toEqual([
			{
				question: 'Pick toppings',
				header: 'Pizza',
				options: [{ label: 'Cheese', description: 'Mozzarella' }, { label: 'Basil' }],
				multiSelect: true,
			},
		]);
	});

	it('drops entries without a question and tolerates missing options', () => {
		expect(
			parseAskUserQuestions({ questions: [{}, { header: 'x' }, { question: 'Why?' }] })
		).toEqual([{ question: 'Why?', header: undefined, options: [], multiSelect: false }]);
	});

	it('returns an empty array for input without a questions array', () => {
		expect(parseAskUserQuestions(undefined)).toEqual([]);
		expect(parseAskUserQuestions({})).toEqual([]);
		expect(parseAskUserQuestions({ questions: 'nope' })).toEqual([]);
	});
});

describe('formatAskUserQuestionsAsText', () => {
	it('renders one question without a Q number', () => {
		expect(
			formatAskUserQuestionsAsText([
				{ question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false },
			])
		).toBe('Proceed?\n\n1. **Yes**\n2. **No**');
	});

	it('numbers several questions and marks multi-select ones', () => {
		expect(
			formatAskUserQuestionsAsText([
				{
					question: 'Where?',
					header: 'Where',
					options: [{ label: 'Here', description: 'This repo' }],
					multiSelect: false,
				},
				{ question: 'Which parts?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
			])
		).toBe(
			[
				'Q1. **Where:** Where?',
				'',
				'1. **Here** - This repo',
				'',
				'Q2. Which parts?',
				'',
				'1. **A**',
				'2. **B**',
				'',
				'_Pick one or more._',
			].join('\n')
		);
	});

	it('renders a question with no options as the bare question', () => {
		expect(
			formatAskUserQuestionsAsText([
				{ question: 'Anything else?', options: [], multiSelect: false },
			])
		).toBe('Anything else?');
	});
});
