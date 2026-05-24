import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEncodingMock = vi.hoisted(() => vi.fn());

vi.mock('js-tiktoken', () => ({
	getEncoding: getEncodingMock,
}));

async function loadTokenCounter() {
	return import('../../../renderer/utils/tokenCounter');
}

describe('tokenCounter', () => {
	beforeEach(() => {
		vi.resetModules();
		getEncodingMock.mockReset();
	});

	it('lazy-loads and reuses the cl100k_base encoder', async () => {
		const encoder = { encode: vi.fn(() => [1, 2, 3]) };
		getEncodingMock.mockReturnValue(encoder);
		const { getEncoder } = await loadTokenCounter();

		await expect(getEncoder()).resolves.toBe(encoder);
		await expect(getEncoder()).resolves.toBe(encoder);

		expect(getEncodingMock).toHaveBeenCalledTimes(1);
		expect(getEncodingMock).toHaveBeenCalledWith('cl100k_base');
	});

	it('counts encoded tokens', async () => {
		getEncodingMock.mockReturnValue({ encode: vi.fn(() => [101, 102, 103, 104]) });
		const { countTokens } = await loadTokenCounter();

		await expect(countTokens('hello world')).resolves.toBe(4);
	});

	it('falls back to character estimate when tokenizer loading fails', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		getEncodingMock.mockImplementation(() => {
			throw new Error('tokenizer unavailable');
		});
		const { countTokens } = await loadTokenCounter();

		await expect(countTokens('123456789')).resolves.toBe(3);
		expect(consoleError).toHaveBeenCalledWith('Failed to count tokens:', expect.any(Error));
	});

	it('estimates tokens by rounding up every four characters', async () => {
		const { estimateTokens } = await loadTokenCounter();

		expect(estimateTokens('')).toBe(0);
		expect(estimateTokens('1234')).toBe(1);
		expect(estimateTokens('12345')).toBe(2);
	});

	it('formats token counts with k and M suffixes', async () => {
		const { formatTokenCount } = await loadTokenCounter();

		expect(formatTokenCount(999)).toBe('999');
		expect(formatTokenCount(1_000)).toBe('1.0k');
		expect(formatTokenCount(15_250)).toBe('15.3k');
		expect(formatTokenCount(1_500_000)).toBe('1.5M');
	});
});
