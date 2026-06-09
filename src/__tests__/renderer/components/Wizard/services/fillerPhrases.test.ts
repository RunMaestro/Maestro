import { describe, expect, it } from 'vitest';
import {
	getAllFillerPhrases,
	getAllInitialQuestions,
	getNextFillerPhrase,
	getRandomInitialQuestion,
	resetFillerPhrases,
} from '../../../../../renderer/components/Wizard/services/fillerPhrases';

describe('fillerPhrases', () => {
	it('returns filler phrases from the queue and reshuffles after exhaustion', () => {
		const phrases = getAllFillerPhrases();

		resetFillerPhrases();
		const firstRun = Array.from({ length: phrases.length }, () => getNextFillerPhrase());
		const afterExhaustion = getNextFillerPhrase();

		expect(phrases.length).toBeGreaterThan(0);
		expect(firstRun).toHaveLength(phrases.length);
		expect(firstRun.every((phrase) => phrases.includes(phrase))).toBe(true);
		expect(phrases).toContain(afterExhaustion);
	});

	it('returns initial questions from the queue and reshuffles after exhaustion', () => {
		const questions = getAllInitialQuestions();
		const sampledQuestions = Array.from({ length: questions.length + 1 }, () =>
			getRandomInitialQuestion()
		);

		expect(questions.length).toBeGreaterThan(0);
		expect(sampledQuestions.every((question) => questions.includes(question))).toBe(true);
	});
});
