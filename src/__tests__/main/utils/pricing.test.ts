/**
 * Tests for pricing utility
 */

import { describe, it, expect } from 'vitest';
import { calculateCost, calculateClaudeCost, PricingConfig } from '../../../main/utils/pricing';
import { CLAUDE_PRICING, TOKENS_PER_MILLION } from '../../../main/constants';

describe('pricing utilities', () => {
	describe('calculateCost', () => {
		it('should calculate cost correctly with default Claude pricing', () => {
			const cost = calculateCost({
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
				cacheReadTokens: 1_000_000,
				cacheCreationTokens: 1_000_000,
			});

			// Expected: 3 + 15 + 0.30 + 3.75 = 22.05
			expect(cost).toBeCloseTo(22.05, 2);
		});

		it('should handle zero tokens', () => {
			const cost = calculateCost({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
			});

			expect(cost).toBe(0);
		});

		it('should handle missing optional token counts', () => {
			const cost = calculateCost({
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
			});

			// Expected: 3 + 15 = 18
			expect(cost).toBeCloseTo(18, 2);
		});

		it('should accept custom pricing config', () => {
			const customPricing: PricingConfig = {
				INPUT_PER_MILLION: 1,
				OUTPUT_PER_MILLION: 2,
				CACHE_READ_PER_MILLION: 0.5,
				CACHE_CREATION_PER_MILLION: 1.5,
			};

			const cost = calculateCost(
				{
					inputTokens: 2_000_000,
					outputTokens: 1_000_000,
					cacheReadTokens: 500_000,
					cacheCreationTokens: 250_000,
				},
				customPricing
			);

			// Expected: (2 * 1) + (1 * 2) + (0.5 * 0.5) + (0.25 * 1.5) = 2 + 2 + 0.25 + 0.375 = 4.625
			expect(cost).toBeCloseTo(4.625, 3);
		});
	});

	describe('calculateClaudeCost (legacy interface)', () => {
		it('should produce same result as calculateCost', () => {
			const inputTokens = 500_000;
			const outputTokens = 250_000;
			const cacheReadTokens = 100_000;
			const cacheCreationTokens = 50_000;

			const legacyCost = calculateClaudeCost(
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheCreationTokens
			);

			const modernCost = calculateCost({
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheCreationTokens,
			});

			expect(legacyCost).toBe(modernCost);
		});
	});

	describe('TOKENS_PER_MILLION constant', () => {
		it('should equal one million', () => {
			expect(TOKENS_PER_MILLION).toBe(1_000_000);
		});
	});

	describe('CLAUDE_PRICING', () => {
		it('should have all required pricing fields', () => {
			expect(CLAUDE_PRICING).toHaveProperty('INPUT_PER_MILLION');
			expect(CLAUDE_PRICING).toHaveProperty('OUTPUT_PER_MILLION');
			expect(CLAUDE_PRICING).toHaveProperty('CACHE_READ_PER_MILLION');
			expect(CLAUDE_PRICING).toHaveProperty('CACHE_CREATION_PER_MILLION');
		});

		it('should have correct Sonnet 4 pricing values', () => {
			expect(CLAUDE_PRICING.INPUT_PER_MILLION).toBe(3);
			expect(CLAUDE_PRICING.OUTPUT_PER_MILLION).toBe(15);
			expect(CLAUDE_PRICING.CACHE_READ_PER_MILLION).toBe(0.3);
			expect(CLAUDE_PRICING.CACHE_CREATION_PER_MILLION).toBe(3.75);
		});
	});
});
