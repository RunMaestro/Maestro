import { afterEach, describe, expect, it, vi } from 'vitest';
import { shuffle, shuffleWithSeed } from '../../shared/shuffle';

afterEach(() => vi.restoreAllMocks());

describe('shuffleWithSeed', () => {
	it.each([0, 1, 42, 4294967295])('repeats the same permutation for seed %i', (seed) => {
		const input = Array.from({ length: 20 }, (_, index) => index);
		const expected = shuffleWithSeed(input, seed);
		for (let repeat = 0; repeat < 3; repeat++) {
			shuffleWithSeed(input, 123);
			expect(shuffleWithSeed([...input], seed)).toEqual(expected);
		}
	});

	it.each([
		[0, 1],
		[42, 123],
	])('produces different permutations for seeds %i and %i', (firstSeed, secondSeed) => {
		const input = Array.from({ length: 20 }, (_, index) => index);
		expect(shuffleWithSeed(input, firstSeed)).not.toEqual(shuffleWithSeed(input, secondSeed));
	});

	it.each([0, 1, 42, 4294967295])('preserves the multiset and input for seed %i', (seed) => {
		const input = [5, 2, 5, 0, -1, 2, 10, 0];
		const original = [...input];
		Object.freeze(input);
		const result = shuffleWithSeed(input, seed);
		expect(result).not.toBe(input);
		expect(result).toHaveLength(original.length);
		expect([...result].sort((a, b) => a - b)).toEqual([...original].sort((a, b) => a - b));
		expect(input).toEqual(original);
	});

	it.each([0, 1, 42, 4294967295])('preserves duplicate object identities for seed %i', (seed) => {
		const first = { id: 1 };
		const second = { id: 2 };
		const input = [first, first, second];
		Object.freeze(input);
		const result = shuffleWithSeed(input, seed);
		expect(result).not.toBe(input);
		expect(result).toHaveLength(input.length);
		expect(input).toEqual([first, first, second]);
		expect(result.filter((item) => item === first)).toHaveLength(2);
		expect(result.filter((item) => item === second)).toHaveLength(1);
	});

	it.each([{ input: [] }, { input: ['only'] }])(
		'returns a fresh copy for a short array $input',
		({ input }) => {
			Object.freeze(input);
			const result = shuffleWithSeed(input, 0);
			expect(result).toEqual(input);
			expect(result).not.toBe(input);
		}
	);

	it('does not use ambient randomness', () => {
		const random = vi.spyOn(Math, 'random').mockImplementation(() => {
			throw new Error('Unexpected ambient randomness');
		});
		expect(shuffleWithSeed([1, 2, 3], 42)).toHaveLength(3);
		expect(random).not.toHaveBeenCalled();
	});
});

describe('shuffle', () => {
	it('uses one random seed and the shared deterministic shuffle', () => {
		const random = vi.spyOn(Math, 'random').mockReturnValue(42 / 2 ** 32);
		const input = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		expect(shuffle(input)).toEqual(shuffleWithSeed(input, 42));
		expect(random).toHaveBeenCalledTimes(1);
		expect(input).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});
});
