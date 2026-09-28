import { describe, expect, it } from 'vitest';
import {
	countTokens,
	estimateTokens,
	formatTokenCount,
	getEncoder,
} from '../../../renderer/utils/tokenCounter';

describe('tokenCounter', () => {
	it('loads the encoder on demand and reuses it', async () => {
		const first = getEncoder();
		const second = getEncoder();

		expect(second).toBe(first);
		expect(await countTokens('hello')).toBe(1);
	});

	it('keeps the lightweight estimate and display helpers synchronous', () => {
		expect(estimateTokens('12345678')).toBe(2);
		expect(formatTokenCount(1_500)).toBe('1.5k');
	});
});
