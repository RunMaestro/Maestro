import { afterEach, describe, expect, it, vi } from 'vitest';
import { shuffle, shuffleWithSeed } from '../../shared/shuffle';

afterEach(() => vi.restoreAllMocks());

describe('shuffleWithSeed', () => {
	it.each([
		{ seed: 0, expected: [3, 8, 6, 4, 5, 9, 7, 1, 0, 2] },
		{ seed: 1, expected: [7, 8, 3, 2, 1, 5, 9, 4, 0, 6] },
		{ seed: 42, expected: [0, 7, 3, 5, 2, 1, 8, 9, 4, 6] },
		{ seed: 4294967295, expected: [3, 0, 9, 4, 2, 7, 6, 5, 1, 8] },
	])('preserves the stable order for seed $seed', ({ seed, expected }) => {
		const input = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		expect(shuffleWithSeed(input, seed)).toEqual(expected);
		shuffleWithSeed(input, 123);
		expect(shuffleWithSeed(input, seed)).toEqual(expected);
	});

	it('preserves input, duplicate entries, and object identity', () => {
		const first = { id: 1 };
		const second = { id: 2 };
		const input = [first, first, second];
		Object.freeze(input);
		const result = shuffleWithSeed(input, 42);
		expect(result).not.toBe(input);
		expect(input).toEqual([first, first, second]);
		expect(result.filter((item) => item === first)).toHaveLength(2);
		expect(result.filter((item) => item === second)).toHaveLength(1);
	});

	it.each([{ input: [] }, { input: ['only'] }])(
		'returns a fresh copy for a short array $input',
		({ input }) => {
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
		expect(shuffle(input)).toEqual([0, 7, 3, 5, 2, 1, 8, 9, 4, 6]);
		expect(random).toHaveBeenCalledTimes(1);
		expect(input).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});
});
