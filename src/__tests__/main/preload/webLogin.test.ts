/**
 * Web Login preload API.
 *
 * The renderer's Users pane can only be as correct as this mapping: a verb
 * pointed at the wrong channel, or one that drops an argument, fails silently
 * (the promise resolves, nothing changes on disk).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createWebLoginApi } from '../../../main/preload/webLogin';

describe('Web Login Preload API', () => {
	let api: ReturnType<typeof createWebLoginApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue(undefined);
		api = createWebLoginApi();
	});

	it('exposes exactly the six account verbs', () => {
		expect(Object.keys(api).sort()).toEqual([
			'createUser',
			'deleteUser',
			'listUsers',
			'setDisabled',
			'setDisplayName',
			'setPassword',
		]);
	});

	it('lists accounts', async () => {
		mockInvoke.mockResolvedValueOnce([{ id: 'u1' }]);
		await expect(api.listUsers()).resolves.toEqual([{ id: 'u1' }]);
		expect(mockInvoke).toHaveBeenCalledWith('webLogin:listUsers');
	});

	it('passes the create input through as one object', async () => {
		const input = { username: 'ada', password: 'hunter2hunter2', displayName: 'Ada' };
		await api.createUser(input);
		expect(mockInvoke).toHaveBeenCalledWith('webLogin:createUser', input);
	});

	it('passes id + value through in order', async () => {
		await api.setPassword('u1', 'nextpassword');
		expect(mockInvoke).toHaveBeenCalledWith('webLogin:setPassword', 'u1', 'nextpassword');

		await api.setDisplayName('u1', 'Ada L');
		expect(mockInvoke).toHaveBeenCalledWith('webLogin:setDisplayName', 'u1', 'Ada L');

		await api.setDisabled('u1', true);
		expect(mockInvoke).toHaveBeenCalledWith('webLogin:setDisabled', 'u1', true);

		await api.deleteUser('u1');
		expect(mockInvoke).toHaveBeenCalledWith('webLogin:deleteUser', 'u1');
	});
});
