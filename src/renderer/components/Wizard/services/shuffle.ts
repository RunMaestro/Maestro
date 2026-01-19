/**
 * shuffle.ts
 *
 * Shared shuffle utility for the wizard services.
 * Uses Fisher-Yates algorithm for unbiased random shuffling.
 */

/**
 * Shuffle an array using the Fisher-Yates algorithm.
 * Returns a new array with elements in random order.
 *
 * @param array - The array to shuffle
 * @returns A new shuffled array
 */
export function shuffle<T>(array: T[]): T[] {
	const result = [...array];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}
