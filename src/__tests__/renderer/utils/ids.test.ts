import { describe, it, expect, vi } from 'vitest';
import { generateId } from '../../../renderer/utils/ids';

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
