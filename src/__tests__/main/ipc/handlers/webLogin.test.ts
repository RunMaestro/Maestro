/**
 * Web Login account-management IPC.
 *
 * The six channels are thin pass-throughs to `WebUserStore`, so what these
 * tests defend is the wiring: every channel is registered, each hands its
 * arguments through in order, and a store rejection REACHES the renderer
 * (swallowing it would leave the Users pane showing a success it never had).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

const registeredHandlers = new Map<string, (...args: any[]) => any>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
			registeredHandlers.set(channel, handler);
		}),
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const store = {
	listUsers: vi.fn(),
	createUser: vi.fn(),
	setPassword: vi.fn(),
	setDisplayName: vi.fn(),
	setDisabled: vi.fn(),
	deleteUser: vi.fn(),
};

vi.mock('../../../../main/web-server/auth/web-user-store', () => ({
	getWebUserStore: () => store,
}));

import { registerWebLoginHandlers } from '../../../../main/ipc/handlers/webLogin';

const USER = {
	id: 'u1',
	username: 'ada',
	displayName: 'Ada',
	createdAt: 1_700_000_000_000,
};

/** Invoke a registered channel with the synthetic event ipcMain would pass. */
function invoke(channel: string, ...args: unknown[]): Promise<any> {
	const handler = registeredHandlers.get(channel);
	if (!handler) throw new Error(`channel not registered: ${channel}`);
	return handler({}, ...args);
}

describe('web login handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		store.listUsers.mockReturnValue([USER]);
		store.createUser.mockResolvedValue(USER);
		store.setPassword.mockResolvedValue(undefined);
		store.setDisplayName.mockResolvedValue(USER);
		store.setDisabled.mockResolvedValue({ ...USER, disabled: true });
		store.deleteUser.mockResolvedValue(undefined);
		registerWebLoginHandlers();
	});

	it('registers exactly the six account channels', () => {
		expect([...registeredHandlers.keys()].sort()).toEqual([
			'webLogin:createUser',
			'webLogin:deleteUser',
			'webLogin:listUsers',
			'webLogin:setDisabled',
			'webLogin:setDisplayName',
			'webLogin:setPassword',
		]);
		expect(ipcMain.handle).toHaveBeenCalledTimes(6);
	});

	it('lists accounts', async () => {
		await expect(invoke('webLogin:listUsers')).resolves.toEqual([USER]);
	});

	it('creates an account from the input object', async () => {
		const input = { username: 'ada', password: 'hunter2hunter2', displayName: 'Ada' };
		await expect(invoke('webLogin:createUser', input)).resolves.toEqual(USER);
		expect(store.createUser).toHaveBeenCalledWith(input);
	});

	it('sets a password by id', async () => {
		await expect(invoke('webLogin:setPassword', 'u1', 'nextpassword')).resolves.toBeUndefined();
		expect(store.setPassword).toHaveBeenCalledWith('u1', 'nextpassword');
	});

	it('sets a display name by id and returns the updated account', async () => {
		await expect(invoke('webLogin:setDisplayName', 'u1', 'Ada L')).resolves.toEqual(USER);
		expect(store.setDisplayName).toHaveBeenCalledWith('u1', 'Ada L');
	});

	it('disables an account by id', async () => {
		await expect(invoke('webLogin:setDisabled', 'u1', true)).resolves.toMatchObject({
			disabled: true,
		});
		expect(store.setDisabled).toHaveBeenCalledWith('u1', true);
	});

	it('deletes an account by id', async () => {
		await expect(invoke('webLogin:deleteUser', 'u1')).resolves.toBeUndefined();
		expect(store.deleteUser).toHaveBeenCalledWith('u1');
	});

	it('re-throws a store rejection so the renderer can show its message', async () => {
		store.createUser.mockRejectedValueOnce(new Error('An account named "ada" already exists.'));
		await expect(
			invoke('webLogin:createUser', { username: 'ada', password: 'hunter2hunter2' })
		).rejects.toThrow('An account named "ada" already exists.');
	});
});
