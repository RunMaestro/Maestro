/**
 * Tests for the Cost & Tokens per-model accumulator: model-id normalization and
 * bucket merging, the reported-vs-estimated cost policy, and the Claude
 * rate-table mapping helper.
 */

import { describe, it, expect } from 'vitest';
import { ModelUsageAccumulator, claudeModelUsage } from '../../shared/modelUsage';
import { calculateModelCost, type ModelCost } from '../../shared/modelPricing';

describe('ModelUsageAccumulator', () => {
	it('starts empty and reports isEmpty', () => {
		const acc = new ModelUsageAccumulator();
		expect(acc.isEmpty).toBe(true);
		expect(acc.finalize()).toEqual([]);
	});

	it('is no longer empty once a record is added', () => {
		const acc = new ModelUsageAccumulator();
		acc.add('claude-opus-4-8', { inputTokens: 1, outputTokens: 0 });
		expect(acc.isEmpty).toBe(false);
	});

	it('sums all four token fields for the same model across records', () => {
		const acc = new ModelUsageAccumulator();
		acc.add('claude-opus-4-8', {
			inputTokens: 100,
			outputTokens: 10,
			cacheReadTokens: 5,
			cacheCreationTokens: 2,
		});
		acc.add('claude-opus-4-8', {
			inputTokens: 200,
			outputTokens: 20,
			cacheReadTokens: 5,
			cacheCreationTokens: 3,
		});

		const [bucket] = acc.finalize();
		expect(bucket).toMatchObject({
			model: 'claude-opus-4-8',
			inputTokens: 300,
			outputTokens: 30,
			cacheReadTokens: 10,
			cacheCreationTokens: 5,
		});
	});

	it('merges records whose raw model id normalizes to the same value', () => {
		const acc = new ModelUsageAccumulator();
		// [1m] marker and an 8-digit date suffix both normalize away.
		acc.add('claude-opus-4-8[1m]', { inputTokens: 100, outputTokens: 0 });
		acc.add('claude-opus-4-8-20260101', { inputTokens: 50, outputTokens: 0 });

		const finalized = acc.finalize();
		expect(finalized).toHaveLength(1);
		expect(finalized[0].model).toBe('claude-opus-4-8');
		expect(finalized[0].inputTokens).toBe(150);
	});

	it('keeps distinct models in separate buckets', () => {
		const acc = new ModelUsageAccumulator();
		acc.add('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 0 });
		acc.add('claude-fable-5', { inputTokens: 0, outputTokens: 1_000_000 });

		const finalized = acc.finalize();
		expect(finalized).toHaveLength(2);
		expect(finalized.map((m) => m.model).sort()).toEqual(['claude-fable-5', 'claude-opus-4-8']);
	});

	it('buckets a null/undefined model id under the empty-string key', () => {
		const acc = new ModelUsageAccumulator();
		acc.add(undefined, { inputTokens: 10, outputTokens: 0 });
		acc.add(null, { inputTokens: 5, outputTokens: 0 });

		const finalized = acc.finalize();
		expect(finalized).toHaveLength(1);
		expect(finalized[0].model).toBe('');
		expect(finalized[0].inputTokens).toBe(15);
	});

	it('estimates cost from the rate table when no cost is reported', () => {
		const acc = new ModelUsageAccumulator();
		acc.add('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 0 });

		const [bucket] = acc.finalize();
		expect(bucket.costEstimated).toBe(true);
		expect(bucket.costUsd).toBeCloseTo(
			calculateModelCost({ inputTokens: 1_000_000, outputTokens: 0 }, 'claude-opus-4-8'),
			10
		);
	});

	it('trusts a provider-reported cost and marks the bucket not estimated', () => {
		const acc = new ModelUsageAccumulator();
		acc.add('some-model', { inputTokens: 1_000_000, outputTokens: 0 }, 0.42);

		const [bucket] = acc.finalize();
		expect(bucket.costEstimated).toBe(false);
		expect(bucket.costUsd).toBeCloseTo(0.42, 10);
	});

	it('sums multiple reported costs for the same model', () => {
		const acc = new ModelUsageAccumulator();
		acc.add('m', { inputTokens: 1, outputTokens: 0 }, 0.1);
		acc.add('m', { inputTokens: 1, outputTokens: 0 }, 0.25);

		const [bucket] = acc.finalize();
		expect(bucket.costEstimated).toBe(false);
		expect(bucket.costUsd).toBeCloseTo(0.35, 10);
	});

	it('marks a bucket as reported once any contributing record carried a cost', () => {
		const acc = new ModelUsageAccumulator();
		acc.add('m', { inputTokens: 1_000_000, outputTokens: 0 }); // no cost
		acc.add('m', { inputTokens: 0, outputTokens: 0 }, 1.0); // reported

		const [bucket] = acc.finalize();
		expect(bucket.costEstimated).toBe(false);
		expect(bucket.costUsd).toBeCloseTo(1.0, 10);
	});

	it('ignores a non-finite reported cost and falls back to estimation', () => {
		const acc = new ModelUsageAccumulator();
		acc.add('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 0 }, NaN);

		const [bucket] = acc.finalize();
		expect(bucket.costEstimated).toBe(true);
		expect(bucket.costUsd).toBeGreaterThan(0);
	});
});

describe('claudeModelUsage', () => {
	it('maps the rate-table split to token usage, flagging every bucket estimated', () => {
		const byModel: ModelCost[] = [
			{
				model: 'claude-opus-4-8[1m]',
				inputTokens: 100,
				outputTokens: 20,
				cacheReadTokens: 5,
				cacheCreationTokens: 3,
				costUsd: 1.23,
			},
		];

		const usage = claudeModelUsage(byModel);
		expect(usage).toEqual([
			{
				model: 'claude-opus-4-8', // normalized ([1m] stripped)
				inputTokens: 100,
				outputTokens: 20,
				cacheReadTokens: 5,
				cacheCreationTokens: 3,
				costUsd: 1.23,
				costEstimated: true,
			},
		]);
	});

	it('returns an empty array for an empty split', () => {
		expect(claudeModelUsage([])).toEqual([]);
	});
});
