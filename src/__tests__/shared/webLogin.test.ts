import { describe, it, expect } from 'vitest';
import {
	normalizeWebDisplayName,
	normalizeWebUsername,
	validateWebPassword,
	validateWebUsername,
	WEB_LOGIN_PASSWORD_MIN,
} from '../../shared/webLogin';

describe('validateWebUsername', () => {
	it('accepts lowercase letters, digits, dot, dash, underscore', () => {
		expect(validateWebUsername('pedram')).toBeNull();
		expect(validateWebUsername('p.amini-1_x')).toBeNull();
	});

	it('normalizes case and whitespace before checking', () => {
		expect(validateWebUsername('  Pedram ')).toBeNull();
		expect(normalizeWebUsername('  Pedram ')).toBe('pedram');
	});

	it('rejects too short, too long, bad characters, bad leading character', () => {
		expect(validateWebUsername('p')).toMatch(/at least/);
		expect(validateWebUsername('a'.repeat(33))).toMatch(/at most/);
		expect(validateWebUsername('ped ram')).toMatch(/may contain/);
		expect(validateWebUsername('.pedram')).toMatch(/may contain/);
	});
});

describe('validateWebPassword', () => {
	it('enforces the minimum length', () => {
		expect(validateWebPassword('a'.repeat(WEB_LOGIN_PASSWORD_MIN - 1))).toMatch(/at least/);
		expect(validateWebPassword('a'.repeat(WEB_LOGIN_PASSWORD_MIN))).toBeNull();
	});

	it('rejects a non-string', () => {
		expect(validateWebPassword(undefined as unknown as string)).toMatch(/at least/);
	});
});

describe('normalizeWebDisplayName', () => {
	it('falls back to the username when blank', () => {
		expect(normalizeWebDisplayName('   ', 'pedram')).toBe('pedram');
		expect(normalizeWebDisplayName(undefined, 'pedram')).toBe('pedram');
	});

	it('trims and caps', () => {
		expect(normalizeWebDisplayName('  Pedram Amini ', 'pedram')).toBe('Pedram Amini');
		expect(normalizeWebDisplayName('x'.repeat(100), 'pedram')).toHaveLength(64);
	});
});
