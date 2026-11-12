import { describe, it, expect, beforeEach } from 'vitest';
import {
	getCliSecret,
	isCliSecret,
	resetCliSecretForTests,
} from '../../../../main/web-server/auth/cli-secret';

describe('cli secret', () => {
	beforeEach(() => resetCliSecretForTests());

	it('is minted once per process and is not guessable', () => {
		const a = getCliSecret();
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(getCliSecret()).toBe(a);
		resetCliSecretForTests();
		expect(getCliSecret()).not.toBe(a);
	});

	it('matches only the exact secret', () => {
		const s = getCliSecret();
		expect(isCliSecret(s)).toBe(true);
		expect(isCliSecret(s.slice(0, -1))).toBe(false);
		expect(isCliSecret(`${s}x`)).toBe(false);
		expect(isCliSecret('')).toBe(false);
		expect(isCliSecret(undefined)).toBe(false);
		expect(isCliSecret([s])).toBe(false);
	});
});
