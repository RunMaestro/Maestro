import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { urlTransformAllowingMaestro } from '../../../renderer/utils/markdownUrlTransform';
import { vi } from 'vitest';
import { generateId } from '../../../renderer/utils/ids';
import { countTokens } from '../../../renderer/utils/tokenCounter';
import { estimateTokens } from '../../../renderer/utils/tokenCounter';
import { formatTokenCount } from '../../../renderer/utils/tokenCounter';
import { getEncoder } from '../../../renderer/utils/tokenCounter';
__maestroMicrobenchDescribe('markdownUrlTransform', () => {
	describe('urlTransformAllowingMaestro', () => {
		it('keeps http(s) and internal schemes', () => {
			expect(urlTransformAllowingMaestro('https://x.com')).toBe('https://x.com');
			expect(urlTransformAllowingMaestro('maestro://agent/1')).toBe('maestro://agent/1');
			expect(urlTransformAllowingMaestro('file:///tmp/a.png')).toBe('file:///tmp/a.png');
		});

		it('keeps routing-hinted http(s) URLs intact for the click handler', () => {
			expect(urlTransformAllowingMaestro('maestro+https://x.com/p')).toBe(
				'maestro+https://x.com/p'
			);
			expect(urlTransformAllowingMaestro('system+http://localhost:5173')).toBe(
				'system+http://localhost:5173'
			);
		});

		it('blanks a hint in front of a dangerous scheme', () => {
			expect(urlTransformAllowingMaestro('maestro+javascript:alert(1)')).toBe('');
			expect(urlTransformAllowingMaestro('javascript:alert(1)')).toBe('');
		});
	});
});
__maestroMicrobenchDescribe('ids', () => {
	describe('generateId', () => {
		it('should generate a valid UUID v4', () => {
			const id = generateId();
			const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
			expect(id).toMatch(uuidRegex);
		});

		it('should generate unique IDs', () => {
			const ids = new Set<string>();
			for (let i = 0; i < 100; i++) {
				ids.add(generateId());
			}
			expect(ids.size).toBe(100);
		});

		it('should use crypto.randomUUID', () => {
			const mockUUID = '12345678-1234-4123-8123-123456789abc';
			const spy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(mockUUID);

			expect(generateId()).toBe(mockUUID);
			expect(spy).toHaveBeenCalled();

			spy.mockRestore();
		});
	});
});
__maestroMicrobenchDescribe('tokenCounter', () => {
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
});
