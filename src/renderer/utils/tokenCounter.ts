/**
 * Token Counter Utilities
 *
 * Provides accurate token counting using tiktoken's cl100k_base encoding
 * (the same tokenizer used by Claude and GPT-4).
 *
 * Uses lazy loading to avoid loading the tokenizer until it's needed.
 */

import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { estimateTokenCount } from '../../shared/formatters';
import { logger } from './logger';

// Lazy-loaded tokenizer encoder (cl100k_base is used by Claude/GPT-4)
let encoderPromise: Promise<Tiktoken> | null = null;

/**
 * Get the tiktoken encoder instance (lazy-loaded).
 * Uses cl100k_base encoding which is compatible with Claude and GPT-4.
 */
export function getEncoder(): Promise<Tiktoken> {
	if (!encoderPromise) {
		encoderPromise = Promise.resolve(getEncoding('cl100k_base'));
	}
	return encoderPromise;
}

/**
 * Count tokens in text using the tiktoken encoder.
 *
 * @param text - The text to count tokens for
 * @returns Promise resolving to the token count
 *
 * @example
 * const count = await countTokens("Hello, world!");
 * logger.info(`Text has ${count} tokens`);
 */
export async function countTokens(text: string): Promise<number> {
	try {
		const encoder = await getEncoder();
		return encoder.encode(text).length;
	} catch (error) {
		logger.error('Failed to count tokens:', undefined, error);
		// Fall back to character-based estimate if tokenizer fails
		return estimateTokens(text);
	}
}

/**
 * Synchronous token estimation using character-based heuristic.
 * Re-exports estimateTokenCount from shared/formatters for backwards compatibility.
 */
export const estimateTokens = (text: string): number => estimateTokenCount(text);

/**
 * Format a token count for display with appropriate suffix.
 *
 * @param count - The token count to format
 * @returns Formatted string (e.g., "1.2k", "15k", "1.5M")
 */
export function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	}
	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(1)}k`;
	}
	return count.toString();
}
