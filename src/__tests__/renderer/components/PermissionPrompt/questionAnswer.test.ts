import { describe, it, expect } from 'vitest';
import {
	encodeQuestionAnswer,
	hasAnswer,
	type QuestionForAnswer,
	type QuestionSelection,
} from '../../../../renderer/components/PermissionPrompt/questionAnswer';

describe('questionAnswer.hasAnswer', () => {
	it('is true when a label is selected', () => {
		expect(hasAnswer({ selectedLabels: ['Red'] })).toBe(true);
	});
	it('is true when free-text is non-blank', () => {
		expect(hasAnswer({ selectedLabels: [], otherText: 'teal' })).toBe(true);
	});
	it('is false when nothing is selected and free-text is blank/whitespace', () => {
		expect(hasAnswer({ selectedLabels: [], otherText: '   ' })).toBe(false);
		expect(hasAnswer({ selectedLabels: [] })).toBe(false);
	});
});

describe('questionAnswer.encodeQuestionAnswer', () => {
	it('labels a single-select answer by header', () => {
		const questions: QuestionForAnswer[] = [{ question: 'Which color?', header: 'Color' }];
		const selections: QuestionSelection[] = [{ selectedLabels: ['Blue'] }];
		expect(encodeQuestionAnswer(questions, selections)).toBe('Color: Blue');
	});

	it('falls back to the question text when there is no header', () => {
		const questions: QuestionForAnswer[] = [{ question: 'Which color?' }];
		const selections: QuestionSelection[] = [{ selectedLabels: ['Blue'] }];
		expect(encodeQuestionAnswer(questions, selections)).toBe('Which color?: Blue');
	});

	it('comma-joins multiple selected labels (multiSelect)', () => {
		const questions: QuestionForAnswer[] = [{ question: 'Pick colors', header: 'Colors' }];
		const selections: QuestionSelection[] = [{ selectedLabels: ['Red', 'Blue'] }];
		expect(encodeQuestionAnswer(questions, selections)).toBe('Colors: Red, Blue');
	});

	it('appends a trimmed free-text answer alongside labels', () => {
		const questions: QuestionForAnswer[] = [{ question: 'Which color?', header: 'Color' }];
		const selections: QuestionSelection[] = [{ selectedLabels: ['Red'], otherText: '  teal  ' }];
		expect(encodeQuestionAnswer(questions, selections)).toBe('Color: Red, teal');
	});

	it('uses only the free-text answer when no option is selected', () => {
		const questions: QuestionForAnswer[] = [{ question: 'Which color?', header: 'Color' }];
		const selections: QuestionSelection[] = [{ selectedLabels: [], otherText: 'teal' }];
		expect(encodeQuestionAnswer(questions, selections)).toBe('Color: teal');
	});

	it('renders (no answer) for an unanswered question', () => {
		const questions: QuestionForAnswer[] = [{ question: 'Which color?', header: 'Color' }];
		const selections: QuestionSelection[] = [{ selectedLabels: [] }];
		expect(encodeQuestionAnswer(questions, selections)).toBe('Color: (no answer)');
	});

	it('produces one line per question for a multi-question batch', () => {
		const questions: QuestionForAnswer[] = [
			{ question: 'Which color?', header: 'Color' },
			{ question: 'Which size?', header: 'Size' },
		];
		const selections: QuestionSelection[] = [
			{ selectedLabels: ['Blue'] },
			{ selectedLabels: ['Large'] },
		];
		expect(encodeQuestionAnswer(questions, selections)).toBe('Color: Blue\nSize: Large');
	});

	it('tolerates a missing selection slot', () => {
		const questions: QuestionForAnswer[] = [{ question: 'Which color?', header: 'Color' }];
		expect(encodeQuestionAnswer(questions, [])).toBe('Color: (no answer)');
	});
});
