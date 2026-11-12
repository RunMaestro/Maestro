import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../../../main/web-server/auth/password';

describe('password hashing', () => {
	it('round-trips and salts', async () => {
		const a = await hashPassword('correct horse');
		const b = await hashPassword('correct horse');
		expect(a).not.toBe(b);
		expect(a.startsWith('scrypt$')).toBe(true);
		expect(await verifyPassword('correct horse', a)).toBe(true);
		expect(await verifyPassword('correct horse', b)).toBe(true);
		expect(await verifyPassword('wrong', a)).toBe(false);
	});

	it('verifies false on a malformed stored value instead of throwing', async () => {
		expect(await verifyPassword('x', '')).toBe(false);
		expect(await verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
		expect(await verifyPassword('x', 'scrypt$0$8$1$AAAA$AAAA')).toBe(false);
		expect(await verifyPassword('x', 'scrypt$16384$8$1$$')).toBe(false);
	});
});
