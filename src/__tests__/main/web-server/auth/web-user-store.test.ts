import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { WebUserStore, WEB_SESSION_TTL_MS } from '../../../../main/web-server/auth/web-user-store';

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'web-users-'));
	file = path.join(dir, 'web-users.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('WebUserStore', () => {
	it('starts empty when the file is missing', () => {
		const store = new WebUserStore(file);
		expect(store.hasUsers()).toBe(false);
		expect(store.listUsers()).toEqual([]);
	});

	it('creates an account, never exposes the hash, and persists', async () => {
		const store = new WebUserStore(file);
		const u = await store.createUser({ username: 'Pedram', password: 'hunter2hunter2' });
		expect(u.username).toBe('pedram');
		expect(u.displayName).toBe('pedram');
		expect('passwordHash' in u).toBe(false);
		await store.flush();
		expect(existsSync(file)).toBe(true);
		const onDisk = JSON.parse(readFileSync(file, 'utf8'));
		expect(onDisk.users[0].passwordHash.startsWith('scrypt$')).toBe(true);

		const reloaded = new WebUserStore(file);
		expect(reloaded.listUsers()).toEqual([u]);
	});

	it('rejects a bad username, a short password, and a duplicate', async () => {
		const store = new WebUserStore(file);
		await expect(store.createUser({ username: 'p', password: 'hunter2hunter2' })).rejects.toThrow(
			/at least/
		);
		await expect(store.createUser({ username: 'pedram', password: 'short' })).rejects.toThrow(
			/at least/
		);
		await store.createUser({ username: 'pedram', password: 'hunter2hunter2' });
		await expect(
			store.createUser({ username: 'PEDRAM', password: 'hunter2hunter2' })
		).rejects.toThrow(/already exists/);
	});

	it('logs in with the right password only, case-insensitive on username', async () => {
		const store = new WebUserStore(file);
		await store.createUser({ username: 'pedram', password: 'hunter2hunter2', displayName: 'P' });
		expect(await store.login('pedram', 'nope-nope-nope')).toEqual({ ok: false, reason: 'invalid' });
		expect(await store.login('nobody', 'hunter2hunter2')).toEqual({ ok: false, reason: 'invalid' });
		const res = await store.login('Pedram', 'hunter2hunter2');
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error('unreachable');
		expect(res.user).toEqual({ id: expect.any(String), username: 'pedram', displayName: 'P' });
		expect(store.resolveSession(res.sessionId)).toEqual(res.user);
		expect(store.listUsers()[0].lastLoginAt).toEqual(expect.any(Number));
	});

	it('reports no-users so the login page can say so', async () => {
		const store = new WebUserStore(file);
		expect(await store.login('x', 'y')).toEqual({ ok: false, reason: 'no-users' });
	});

	it('resolves nothing for an unknown, expired, or logged-out session', async () => {
		const store = new WebUserStore(file);
		await store.createUser({ username: 'pedram', password: 'hunter2hunter2' });
		const res = await store.login('pedram', 'hunter2hunter2');
		if (!res.ok) throw new Error('unreachable');
		expect(store.resolveSession(undefined)).toBeUndefined();
		expect(store.resolveSession('bogus')).toBeUndefined();

		await store.logout(res.sessionId);
		expect(store.resolveSession(res.sessionId)).toBeUndefined();

		const again = await store.login('pedram', 'hunter2hunter2');
		if (!again.ok) throw new Error('unreachable');
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + WEB_SESSION_TTL_MS + 1);
		expect(store.resolveSession(again.sessionId)).toBeUndefined();
		vi.restoreAllMocks();
	});

	it('a password reset, a disable, and a delete all end the account sessions', async () => {
		const store = new WebUserStore(file);
		const u = await store.createUser({ username: 'pedram', password: 'hunter2hunter2' });

		let res = await store.login('pedram', 'hunter2hunter2');
		if (!res.ok) throw new Error('unreachable');
		await store.setPassword(u.id, 'new-password-1');
		expect(store.resolveSession(res.sessionId)).toBeUndefined();
		expect(await store.login('pedram', 'hunter2hunter2')).toEqual({ ok: false, reason: 'invalid' });

		res = await store.login('pedram', 'new-password-1');
		if (!res.ok) throw new Error('unreachable');
		await store.setDisabled(u.id, true);
		expect(store.resolveSession(res.sessionId)).toBeUndefined();
		expect(await store.login('pedram', 'new-password-1')).toEqual({
			ok: false,
			reason: 'disabled',
		});
		expect(store.listUsers()[0].disabled).toBe(true);

		await store.setDisabled(u.id, false);
		res = await store.login('pedram', 'new-password-1');
		if (!res.ok) throw new Error('unreachable');
		await store.deleteUser(u.id);
		expect(store.resolveSession(res.sessionId)).toBeUndefined();
		expect(store.hasUsers()).toBe(false);
		await expect(store.deleteUser(u.id)).rejects.toThrow(/No such account/);
	});

	it('notifies listeners on every mutation', async () => {
		const store = new WebUserStore(file);
		const seen = vi.fn();
		store.onChange(seen);
		const u = await store.createUser({ username: 'pedram', password: 'hunter2hunter2' });
		await store.setDisplayName(u.id, 'Pedram A');
		expect(seen).toHaveBeenCalledTimes(2);
		expect(store.getUser(u.id)?.displayName).toBe('Pedram A');
	});

	it('survives a corrupt file by starting empty', () => {
		writeFileSync(file, '{not json');
		const store = new WebUserStore(file);
		expect(store.listUsers()).toEqual([]);
	});
});
