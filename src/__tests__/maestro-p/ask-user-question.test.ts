/**
 * @file ask-user-question.test.ts
 * @description Tests for src/maestro-p/ask-user-question.ts AskUserQuestion detection.
 *
 * On the TUI path an AskUserQuestion call parks claude on a picker maestro-p
 * cannot answer, so the call is terminal for the turn and its questions become
 * the reply. `extractAskUserQuestionText` returns that reply text for such a
 * message and `null` for a normal turn or a call with no usable question.
 */

import { describe, it, expect } from 'vitest';

import { extractAskUserQuestionText } from '../../maestro-p/ask-user-question';

describe('extractAskUserQuestionText', () => {
	it('renders the questions when the message calls AskUserQuestion', () => {
		const message = {
			stop_reason: 'tool_use',
			content: [
				{
					type: 'tool_use',
					name: 'AskUserQuestion',
					input: {
						questions: [
							{
								question: 'Where should the template live?',
								header: 'Where',
								options: [
									{ label: 'In place', description: 'Edit these repos' },
									{ label: 'Fork', description: 'Copy into new repos' },
								],
								multiSelect: false,
							},
						],
					},
				},
			],
		};
		expect(extractAskUserQuestionText(message)).toBe(
			[
				'**Where:** Where should the template live?',
				'',
				'1. **In place** - Edit these repos',
				'2. **Fork** - Copy into new repos',
			].join('\n')
		);
	});

	it('finds the call after other content blocks', () => {
		const message = {
			content: [
				{ type: 'text', text: 'One decision first.' },
				{
					type: 'tool_use',
					name: 'AskUserQuestion',
					input: { questions: [{ question: 'Proceed?', options: ['Yes', 'No'] }] },
				},
			],
		};
		expect(extractAskUserQuestionText(message)).toBe('Proceed?\n\n1. **Yes**\n2. **No**');
	});

	it('returns null when the call carries no usable question', () => {
		const message = {
			content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{}] } }],
		};
		expect(extractAskUserQuestionText(message)).toBeNull();
	});

	it('returns null for a message with no AskUserQuestion call', () => {
		expect(
			extractAskUserQuestionText({
				content: [
					{ type: 'text', text: 'done' },
					{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
				],
			})
		).toBeNull();
	});

	it('returns null for malformed messages', () => {
		expect(extractAskUserQuestionText(null)).toBeNull();
		expect(extractAskUserQuestionText('text')).toBeNull();
		expect(extractAskUserQuestionText({ content: 'not an array' })).toBeNull();
		expect(extractAskUserQuestionText({ content: [null, 7] })).toBeNull();
	});
});
