import { describe, expect, it } from 'vitest';
import {
	AUSTIN_FACTS,
	factHasLinks,
	getNextAustinFact,
	parseFactWithLinks,
	resetAustinFactQueue,
	type FactSegment,
} from '../../../../../renderer/components/Wizard/services/austinFacts';

describe('austinFacts', () => {
	it('returns every fact once before reshuffling after exhaustion', () => {
		resetAustinFactQueue();

		const firstRun = Array.from({ length: AUSTIN_FACTS.length }, () => getNextAustinFact());
		const afterExhaustion = getNextAustinFact();

		expect(AUSTIN_FACTS.length).toBeGreaterThan(100);
		expect(new Set(firstRun).size).toBe(AUSTIN_FACTS.length);
		expect(firstRun.every((fact) => AUSTIN_FACTS.includes(fact))).toBe(true);
		expect(AUSTIN_FACTS).toContain(afterExhaustion);
	});

	it('resets the fact queue so facts can be sampled from a fresh shuffle', () => {
		resetAustinFactQueue();

		const sampledBeforeReset = getNextAustinFact();
		resetAustinFactQueue();
		const sampledAfterReset = getNextAustinFact();

		expect(AUSTIN_FACTS).toContain(sampledBeforeReset);
		expect(AUSTIN_FACTS).toContain(sampledAfterReset);
	});

	it('parses plain text and empty facts as text segments', () => {
		expect(parseFactWithLinks('No links here.')).toEqual<FactSegment[]>([
			{ type: 'text', content: 'No links here.' },
		]);
		expect(parseFactWithLinks('')).toEqual<FactSegment[]>([{ type: 'text', content: '' }]);
	});

	it('parses markdown links with surrounding text', () => {
		expect(parseFactWithLinks('Visit [Austin Maps](https://maps.example) soon.')).toEqual<
			FactSegment[]
		>([
			{ type: 'text', content: 'Visit ' },
			{ type: 'link', text: 'Austin Maps', url: 'https://maps.example' },
			{ type: 'text', content: ' soon.' },
		]);
	});

	it('parses adjacent and trailing links without adding empty text segments', () => {
		expect(parseFactWithLinks('[One](https://one.example)[Two](https://two.example)')).toEqual<
			FactSegment[]
		>([
			{ type: 'link', text: 'One', url: 'https://one.example' },
			{ type: 'link', text: 'Two', url: 'https://two.example' },
		]);

		expect(parseFactWithLinks('Start [End](https://end.example)')).toEqual<FactSegment[]>([
			{ type: 'text', content: 'Start ' },
			{ type: 'link', text: 'End', url: 'https://end.example' },
		]);
	});

	it('detects whether facts contain markdown links', () => {
		expect(factHasLinks('Visit [Austin Maps](https://maps.example) soon.')).toBe(true);
		expect(factHasLinks('No markdown link here.')).toBe(false);
		expect(factHasLinks('[Broken](missing-closing-paren')).toBe(false);
	});
});
