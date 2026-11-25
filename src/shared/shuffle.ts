/**
 * Shared Fisher-Yates shuffle utility.
 *
 * shuffleWithSeed makes a per-user tip order stable across launches. The same
 * (array, seed) pair must always produce the same output; tests assert this contract.
 */

/** Return a new array with elements in random order. */
export function shuffle<T>(array: T[]): T[] {
	return shuffleWithSeed(array, Math.floor(Math.random() * 2 ** 32));
}

/** Return a new shuffled array using a deterministic 32-bit seed. */
export function shuffleWithSeed<T>(array: T[], seed: number): T[] {
	const random = mulberry32(seed);
	const result = [...array];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

function mulberry32(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
		return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
	};
}
