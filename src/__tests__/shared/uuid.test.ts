import { describe, it, expect } from 'vitest';
import { generateUUID } from '../../shared/uuid';

describe('generateUUID', () => {
	it('should generate a valid UUID v4 format', () => {
		const uuid = generateUUID();
		// UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
		// where y is one of 8, 9, a, or b
		const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		expect(uuid).toMatch(uuidRegex);
	});

	it('should generate unique UUIDs on each call', () => {
		const uuids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			uuids.add(generateUUID());
		}
		// All 100 generated UUIDs should be unique
		expect(uuids.size).toBe(100);
	});

	it('should always have version 4 indicator at position 14', () => {
		for (let i = 0; i < 10; i++) {
			const uuid = generateUUID();
			expect(uuid[14]).toBe('4');
		}
	});

	it('should always have valid variant indicator at position 19', () => {
		for (let i = 0; i < 10; i++) {
			const uuid = generateUUID();
			// Position 19 should be 8, 9, a, or b
			expect(['8', '9', 'a', 'b']).toContain(uuid[19]);
		}
	});

	it('should return a string of exactly 36 characters', () => {
		const uuid = generateUUID();
		expect(uuid.length).toBe(36);
	});

	it('should have hyphens at the correct positions', () => {
		const uuid = generateUUID();
		expect(uuid[8]).toBe('-');
		expect(uuid[13]).toBe('-');
		expect(uuid[18]).toBe('-');
		expect(uuid[23]).toBe('-');
	});
});
