/**
 * Pricing utilities for AI agent cost calculations
 *
 * Centralizes cost calculation logic to eliminate duplication across
 * session storage, IPC handlers, and stats aggregation.
 */

import { CLAUDE_PRICING, TOKENS_PER_MILLION } from '../constants';

/**
 * Pricing configuration type (matches CLAUDE_PRICING structure)
 */
export interface PricingConfig {
	INPUT_PER_MILLION: number;
	OUTPUT_PER_MILLION: number;
	CACHE_READ_PER_MILLION: number;
	CACHE_CREATION_PER_MILLION: number;
}

/**
 * Token counts for cost calculation
 */
export interface TokenCounts {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
}

/**
 * Calculate cost for an AI session based on token counts and pricing config.
 *
 * @param tokens - Token counts from session usage
 * @param pricing - Pricing configuration (defaults to CLAUDE_PRICING)
 * @returns Total cost in USD
 *
 * @example
 * ```typescript
 * const cost = calculateCost({
 *   inputTokens: 1000,
 *   outputTokens: 500,
 *   cacheReadTokens: 200,
 *   cacheCreationTokens: 100
 * });
 * ```
 */
export function calculateCost(
	tokens: TokenCounts,
	pricing: PricingConfig = CLAUDE_PRICING
): number {
	const { inputTokens, outputTokens, cacheReadTokens = 0, cacheCreationTokens = 0 } = tokens;

	const inputCost = (inputTokens / TOKENS_PER_MILLION) * pricing.INPUT_PER_MILLION;
	const outputCost = (outputTokens / TOKENS_PER_MILLION) * pricing.OUTPUT_PER_MILLION;
	const cacheReadCost = (cacheReadTokens / TOKENS_PER_MILLION) * pricing.CACHE_READ_PER_MILLION;
	const cacheCreationCost =
		(cacheCreationTokens / TOKENS_PER_MILLION) * pricing.CACHE_CREATION_PER_MILLION;

	return inputCost + outputCost + cacheReadCost + cacheCreationCost;
}

/**
 * Calculate cost using individual token parameters (legacy interface).
 *
 * @deprecated Use calculateCost() with TokenCounts object instead
 */
export function calculateClaudeCost(
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens: number,
	cacheCreationTokens: number
): number {
	return calculateCost({
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
	});
}
