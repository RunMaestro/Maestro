/**
 * @file model-routing.test.ts
 *
 * The pure rules of model routing by example: the text that is routed and
 * stored, the corrections file, how a correction joins the shipped examples,
 * and the distance-weighted vote. Also the shipped examples themselves, which
 * are data a compiler cannot fully check, and the report half of the routing
 * set (the eval's fixture), which no compiler checks at all.
 */

import { describe, it, expect } from 'vitest';

import {
	MAX_MODEL_ROUTING_CORRECTIONS,
	MODEL_ROUTING_CORRECTIONS_VERSION,
	MODEL_ROUTING_TEXT_MAX_CHARS,
	mergeModelRoutingExamples,
	modelRoutingNeighbourWeight,
	normalizeModelRoutingText,
	parseModelRoutingCorrections,
	serializeModelRoutingCorrections,
	voteModelRoute,
	withModelRoutingCorrection,
	type ModelRoutingCorrection,
	type ModelRoutingNeighbour,
} from '../../../shared/local-models/model-routing';
import { MODEL_ROUTING_EXAMPLES } from '../../../shared/local-models/model-routing-examples';
import { MODEL_ROUTING_TIER_DESCRIPTIONS } from '../../../shared/local-models/model-routing-task';
import { TIER_LEVELS, type EffortLevel, type ModelTier } from '../../../shared/modelTiers';
import reportFixture from '../../fixtures/model-routing-prompts.json';

function correction(
	text: string,
	tier: ModelTier,
	recordedAt = 1,
	effort?: EffortLevel
): ModelRoutingCorrection {
	return { text, tier, ...(effort ? { effort } : {}), recordedAt };
}

function neighbour(
	similarity: number,
	tier: ModelTier,
	effort?: EffortLevel
): ModelRoutingNeighbour {
	return {
		text: `${tier} at ${similarity}`,
		tier,
		...(effort ? { effort } : {}),
		origin: 'shipped',
		similarity,
	};
}

describe('normalizeModelRoutingText', () => {
	it('trims the text', () => {
		expect(normalizeModelRoutingText('  fix the typo \n')).toBe('fix the typo');
	});

	it('cuts a long text to the cap', () => {
		const text = normalizeModelRoutingText('word '.repeat(1000));
		expect(text.length).toBeLessThanOrEqual(MODEL_ROUTING_TEXT_MAX_CHARS);
		expect(text.endsWith(' ')).toBe(false);
	});

	it('replaces a secret before it cuts, so no half of one is kept', () => {
		const key = `sk-${'a'.repeat(40)}`;
		const padding = 'x'.repeat(MODEL_ROUTING_TEXT_MAX_CHARS - 10);
		const text = normalizeModelRoutingText(`${padding} ${key}`);
		expect(text).not.toContain('sk-aaaa');
	});

	it('gives the same text when it is applied twice', () => {
		const once = normalizeModelRoutingText(`  use the key sk-${'b'.repeat(40)} here `);
		expect(normalizeModelRoutingText(once)).toBe(once);
	});

	it('reads a blank text as nothing', () => {
		expect(normalizeModelRoutingText(' \n\t ')).toBe('');
	});
});

describe('withModelRoutingCorrection', () => {
	it('adds a correction at the newest end', () => {
		const result = withModelRoutingCorrection([correction('a', 'low')], correction('b', 'high'));
		expect(result.replaced).toBe(false);
		expect(result.corrections.map((c) => c.text)).toEqual(['a', 'b']);
	});

	it('replaces an earlier correction for the same text', () => {
		const result = withModelRoutingCorrection(
			[correction('a', 'low'), correction('b', 'low')],
			correction('a', 'high', 9)
		);
		expect(result.replaced).toBe(true);
		expect(result.corrections).toEqual([correction('b', 'low'), correction('a', 'high', 9)]);
	});

	it('drops the oldest corrections past the cap', () => {
		const full = Array.from({ length: MAX_MODEL_ROUTING_CORRECTIONS }, (_, index) =>
			correction(`prompt ${index}`, 'low', index)
		);
		const result = withModelRoutingCorrection(full, correction('newest', 'high'));
		expect(result.corrections).toHaveLength(MAX_MODEL_ROUTING_CORRECTIONS);
		expect(result.corrections[0].text).toBe('prompt 1');
		expect(result.corrections.at(-1)?.text).toBe('newest');
	});
});

describe('the corrections file', () => {
	it('round-trips a list', () => {
		const list = [correction('a', 'low', 5), correction('b', 'high', 6, 'medium')];
		const file = serializeModelRoutingCorrections(list);
		expect(file.version).toBe(MODEL_ROUTING_CORRECTIONS_VERSION);
		expect(parseModelRoutingCorrections(JSON.parse(JSON.stringify(file)))).toEqual({
			corrections: list,
			dropped: 0,
		});
	});

	it('reads anything that is not the file shape as no corrections', () => {
		for (const raw of [null, 'text', 7, [], {}, { corrections: 'no' }]) {
			expect(parseModelRoutingCorrections(raw)).toEqual({ corrections: [], dropped: 0 });
		}
	});

	it('drops and counts a record that fails its checks', () => {
		const parsed = parseModelRoutingCorrections({
			corrections: [
				{ text: 'kept', tier: 'low', recordedAt: 1 },
				{ text: 'no tier', recordedAt: 1 },
				{ text: 'bad tier', tier: 'huge', recordedAt: 1 },
				{ text: 'bad effort', tier: 'low', effort: 'max', recordedAt: 1 },
				{ text: '   ', tier: 'low', recordedAt: 1 },
				{ tier: 'low' },
				'not a record',
			],
		});
		expect(parsed.corrections.map((c) => c.text)).toEqual(['kept']);
		expect(parsed.dropped).toBe(6);
	});

	it('keeps the later of two records for the same text', () => {
		const parsed = parseModelRoutingCorrections({
			corrections: [
				{ text: 'same', tier: 'low', recordedAt: 1 },
				{ text: 'same', tier: 'high', recordedAt: 2 },
			],
		});
		expect(parsed.corrections).toEqual([correction('same', 'high', 2)]);
	});

	it('reads a record with no usable time as the oldest', () => {
		const parsed = parseModelRoutingCorrections({
			corrections: [{ text: 'a', tier: 'low', recordedAt: 'yesterday' }],
		});
		expect(parsed.corrections).toEqual([correction('a', 'low', 0)]);
	});

	it('holds a hand-edited file to the cap', () => {
		const parsed = parseModelRoutingCorrections({
			corrections: Array.from({ length: MAX_MODEL_ROUTING_CORRECTIONS + 3 }, (_, index) => ({
				text: `prompt ${index}`,
				tier: 'low',
				recordedAt: index,
			})),
		});
		expect(parsed.corrections).toHaveLength(MAX_MODEL_ROUTING_CORRECTIONS);
		expect(parsed.corrections[0].text).toBe('prompt 3');
	});
});

describe('mergeModelRoutingExamples', () => {
	const shipped = [
		{ text: 'rename it', tier: 'low', effort: 'low' },
		{ text: 'design it', tier: 'high', effort: 'high' },
	] as const;

	it('lists the shipped examples, then the corrections', () => {
		expect(mergeModelRoutingExamples(shipped, [correction('migrate it', 'high')])).toEqual([
			{ text: 'rename it', tier: 'low', effort: 'low', origin: 'shipped' },
			{ text: 'design it', tier: 'high', effort: 'high', origin: 'shipped' },
			{ text: 'migrate it', tier: 'high', origin: 'correction' },
		]);
	});

	it('lets a correction replace the shipped example with the same text', () => {
		const merged = mergeModelRoutingExamples(shipped, [correction('rename it', 'medium')]);
		expect(merged).toHaveLength(2);
		expect(merged.find((example) => example.text === 'rename it')).toEqual({
			text: 'rename it',
			tier: 'medium',
			origin: 'correction',
		});
	});
});

describe('modelRoutingNeighbourWeight', () => {
	it('weighs a nearer neighbour more', () => {
		expect(modelRoutingNeighbourWeight(0.9)).toBeGreaterThan(modelRoutingNeighbourWeight(0.6));
	});

	it('bounds the weight of an exact match', () => {
		expect(modelRoutingNeighbourWeight(1)).toBe(100);
		// Rounding can put a similarity a hair over 1.
		expect(modelRoutingNeighbourWeight(1.0000001)).toBe(100);
	});

	it('lets an exact match outvote four close neighbours', () => {
		expect(modelRoutingNeighbourWeight(1)).toBeGreaterThan(4 * modelRoutingNeighbourWeight(0.9));
	});
});

describe('voteModelRoute', () => {
	it('decides nothing from no neighbours', () => {
		expect(voteModelRoute([])).toBeNull();
	});

	it('is unanimous at confidence 1', () => {
		const vote = voteModelRoute([neighbour(0.9, 'low', 'low'), neighbour(0.8, 'low', 'low')]);
		expect(vote).toEqual({ tier: 'low', effort: 'low', tierConfidence: 1, effortConfidence: 1 });
	});

	it('weighs the vote by distance, so one near neighbour beats two far ones', () => {
		const vote = voteModelRoute([
			neighbour(0.95, 'high', 'high'),
			neighbour(0.5, 'low', 'low'),
			neighbour(0.5, 'low', 'low'),
		]);
		expect(vote?.tier).toBe('high');
		// Weights 20 against 2 + 2, of 24 in all.
		expect(vote?.tierConfidence).toBeCloseTo(16 / 24, 10);
	});

	it('gives a tie to the higher level, at confidence 0', () => {
		const vote = voteModelRoute([neighbour(0.8, 'low', 'low'), neighbour(0.8, 'medium', 'high')]);
		expect(vote).toEqual({
			tier: 'medium',
			effort: 'high',
			tierConfidence: 0,
			effortConfidence: 0,
		});
	});

	it('votes each axis on its own', () => {
		const vote = voteModelRoute([
			neighbour(0.9, 'medium', 'low'),
			neighbour(0.9, 'medium', 'high'),
			neighbour(0.9, 'medium', 'high'),
		]);
		expect(vote?.tier).toBe('medium');
		expect(vote?.tierConfidence).toBe(1);
		expect(vote?.effort).toBe('high');
		expect(vote?.effortConfidence).toBeCloseTo(1 / 3, 10);
	});

	it('gives a neighbour with no effort label no say in the effort', () => {
		const vote = voteModelRoute([neighbour(0.99, 'high'), neighbour(0.6, 'low', 'low')]);
		expect(vote?.tier).toBe('high');
		expect(vote?.effort).toBe('low');
		expect(vote?.effortConfidence).toBe(1);
	});

	it('takes the effort from the tier when no neighbour carries one', () => {
		const vote = voteModelRoute([neighbour(0.9, 'high'), neighbour(0.8, 'high')]);
		expect(vote).toEqual({ tier: 'high', effort: 'high', tierConfidence: 1, effortConfidence: 0 });
	});
});

describe('the shipped examples', () => {
	it('labels every tier and every effort with enough examples to vote', () => {
		for (const level of TIER_LEVELS) {
			expect(
				MODEL_ROUTING_EXAMPLES.filter((example) => example.tier === level).length
			).toBeGreaterThanOrEqual(10);
			expect(
				MODEL_ROUTING_EXAMPLES.filter((example) => example.effort === level).length
			).toBeGreaterThanOrEqual(5);
		}
	});

	it('carries only known levels', () => {
		for (const example of MODEL_ROUTING_EXAMPLES) {
			expect(TIER_LEVELS).toContain(example.tier);
			expect(TIER_LEVELS).toContain(example.effort);
		}
	});

	it('holds each prompt once, already in the form the router embeds', () => {
		const texts = MODEL_ROUTING_EXAMPLES.map((example) => example.text);
		expect(new Set(texts).size).toBe(texts.length);
		for (const text of texts) expect(normalizeModelRoutingText(text)).toBe(text);
		expect(mergeModelRoutingExamples(MODEL_ROUTING_EXAMPLES, [])).toHaveLength(texts.length);
	});
});

describe('the report half of the routing set (the eval fixture)', () => {
	const { prompts } = reportFixture;

	it('holds about 40 prompts, with every tier well represented', () => {
		expect(prompts.length).toBeGreaterThanOrEqual(36);
		for (const level of TIER_LEVELS) {
			expect(prompts.filter((prompt) => prompt.tier === level).length).toBeGreaterThanOrEqual(12);
		}
	});

	it('carries only known levels', () => {
		for (const prompt of prompts) {
			expect(TIER_LEVELS).toContain(prompt.tier);
			expect(TIER_LEVELS).toContain(prompt.effort);
		}
	});

	it('holds each prompt once, already in the form a router is handed', () => {
		const texts = prompts.map((prompt) => prompt.text);
		expect(new Set(texts).size).toBe(texts.length);
		for (const text of texts) expect(normalizeModelRoutingText(text)).toBe(text);
	});

	it('shares no prompt with the tune half, so the eval never reports on a memorized prompt', () => {
		const tune = new Set(
			MODEL_ROUTING_EXAMPLES.map((example) => normalizeModelRoutingText(example.text).toLowerCase())
		);
		for (const prompt of prompts) {
			expect(tune.has(normalizeModelRoutingText(prompt.text).toLowerCase())).toBe(false);
		}
	});

	it('states the rubric the task asks a judge to score against, word for word', () => {
		// The labels were picked against this rubric. If the task's wording moves,
		// the labels have to be read again, not just the strings copied over.
		expect(reportFixture.rubric).toEqual({ ...MODEL_ROUTING_TIER_DESCRIPTIONS });
	});
});
