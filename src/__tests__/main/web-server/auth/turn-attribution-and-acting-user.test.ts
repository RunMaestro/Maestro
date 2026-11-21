import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { forgetAgentActors } from '../../../../main/web-server/auth/turn-attribution';
import { noteTurnActor } from '../../../../main/web-server/auth/turn-attribution';
import { resetTurnActors } from '../../../../main/web-server/auth/turn-attribution';
import { resolveTurnActor } from '../../../../main/web-server/auth/turn-attribution';
import { getActingUser } from '../../../../main/web-server/auth/acting-user';
import { runAsActingUser } from '../../../../main/web-server/auth/acting-user';
import { getCliSecret } from '../../../../main/web-server/auth/cli-secret';
import { isCliSecret } from '../../../../main/web-server/auth/cli-secret';
import { resetCliSecretForTests } from '../../../../main/web-server/auth/cli-secret';
import { hashPassword } from '../../../../main/web-server/auth/password';
import { verifyPassword } from '../../../../main/web-server/auth/password';
__maestroMicrobenchDescribe('turn-attribution', () => {
	const user = { id: 'u1', username: 'pedram', displayName: 'Pedram' };

	describe('turn attribution', () => {
		beforeEach(() => resetTurnActors());

		it('remembers who started the turn on a tab', () => {
			noteTurnActor('agent-1', 'tab-1', user);
			expect(resolveTurnActor('agent-1', 'tab-1')).toEqual(user);
			expect(resolveTurnActor('agent-1', 'tab-2')).toBeUndefined();
		});

		it('a desktop-started turn clears the phone that came before it', () => {
			noteTurnActor('agent-1', 'tab-1', user);
			noteTurnActor('agent-1', 'tab-1', undefined);
			expect(resolveTurnActor('agent-1', 'tab-1')).toBeUndefined();
		});

		it('treats a missing tab id as its own key', () => {
			noteTurnActor('agent-1', null, user);
			expect(resolveTurnActor('agent-1', undefined)).toEqual(user);
			expect(resolveTurnActor('agent-1', 'tab-1')).toBeUndefined();
		});

		it('forgets every tab of a closed agent and nothing else', () => {
			noteTurnActor('agent-1', 'tab-1', user);
			noteTurnActor('agent-1', 'tab-2', user);
			noteTurnActor('agent-10', 'tab-1', user);
			forgetAgentActors('agent-1');
			expect(resolveTurnActor('agent-1', 'tab-1')).toBeUndefined();
			expect(resolveTurnActor('agent-1', 'tab-2')).toBeUndefined();
			expect(resolveTurnActor('agent-10', 'tab-1')).toEqual(user);
		});
	});
});
__maestroMicrobenchDescribe('acting-user', () => {
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
});
__maestroMicrobenchDescribe('cli-secret', () => {
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
});
__maestroMicrobenchDescribe('password', () => {
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
});
