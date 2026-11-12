import { describe, it, expect } from 'vitest';
import { getActingUser, runAsActingUser } from '../../../../main/web-server/auth/acting-user';

const user = { id: 'u1', username: 'pedram', displayName: 'Pedram' };

describe('acting user context', () => {
	it('is undefined outside any context (the desktop)', () => {
		expect(getActingUser()).toBeUndefined();
	});

	it('is visible across awaits inside the context and gone after it', async () => {
		const seen = await runAsActingUser(user, async () => {
			await Promise.resolve();
			const inner = getActingUser();
			await new Promise((r) => setTimeout(r, 1));
			return [inner, getActingUser()];
		});
		expect(seen).toEqual([user, user]);
		expect(getActingUser()).toBeUndefined();
	});

	it('does not leak between two concurrent contexts', async () => {
		const other = { id: 'u2', username: 'raza', displayName: 'Raza' };
		const [a, b] = await Promise.all([
			runAsActingUser(user, async () => {
				await new Promise((r) => setTimeout(r, 2));
				return getActingUser()?.username;
			}),
			runAsActingUser(other, async () => {
				await new Promise((r) => setTimeout(r, 1));
				return getActingUser()?.username;
			}),
		]);
		expect(a).toBe('pedram');
		expect(b).toBe('raza');
	});
});
