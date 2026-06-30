import { describe, it, expect } from 'vitest';
import {
	COWORKING_MCP_SERVER_NAME,
	COWORKING_SOCKET_ENV_VAR,
	formatCoworkingId,
	parseCoworkingId,
} from '../../../main/coworking/coworking-types';

describe('coworking-types', () => {
	it('exports stable string constants', () => {
		expect(COWORKING_MCP_SERVER_NAME).toBe('maestro-coworking');
		expect(COWORKING_SOCKET_ENV_VAR).toBe('MAESTRO_COWORKING_SOCKET');
	});

	describe('formatCoworkingId', () => {
		it('returns "term:N" for a positive integer', () => {
			expect(formatCoworkingId(1)).toBe('term:1');
			expect(formatCoworkingId(42)).toBe('term:42');
		});
	});

	describe('parseCoworkingId', () => {
		it('returns the numeric id for valid input', () => {
			expect(parseCoworkingId('term:1')).toBe(1);
			expect(parseCoworkingId('term:99')).toBe(99);
		});

		it('returns null for invalid input', () => {
			expect(parseCoworkingId('bogus')).toBeNull();
			expect(parseCoworkingId('term:')).toBeNull();
			expect(parseCoworkingId('term:abc')).toBeNull();
			expect(parseCoworkingId('term:0')).toBeNull();
			expect(parseCoworkingId('term:-1')).toBeNull();
			expect(parseCoworkingId('term:1.5')).toBeNull();
		});
	});
});
