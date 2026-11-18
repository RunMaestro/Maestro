/**
 * Tests for sshRemote preload API
 *
 * Coverage:
 * - createSshRemoteApi: saveConfig, deleteConfig, getConfigs, getDefaultId, setDefaultId,
 *   test, getSshConfigHosts, getReachability, checkReachability, onReachability
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createSshRemoteApi, type SshRemoteConfig } from '../../../main/preload/sshRemote';

describe('SSH Remote Preload API', () => {
	let api: ReturnType<typeof createSshRemoteApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createSshRemoteApi();
	});

	describe('saveConfig', () => {
		it('should invoke ssh-remote:saveConfig with config', async () => {
			mockInvoke.mockResolvedValue({ id: 'config-123' });
			const config = {
				name: 'My Server',
				host: 'server.example.com',
				port: 22,
				username: 'user',
				privateKeyPath: '/path/to/key',
				enabled: true,
			};

			const result = await api.saveConfig(config);

			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:saveConfig', config);
			expect(result).toEqual({ id: 'config-123' });
		});

		it('should handle updating existing config', async () => {
			mockInvoke.mockResolvedValue({ id: 'existing-id' });
			const config = {
				id: 'existing-id',
				name: 'Updated Server',
			};

			await api.saveConfig(config);

			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:saveConfig', config);
		});

		it('should pass useSshConfig and sshConfigHost fields', async () => {
			mockInvoke.mockResolvedValue({ id: 'config-123' });
			const config = {
				name: 'SSH Config Server',
				host: 'my-server',
				port: 22,
				username: '', // Optional when using SSH config
				privateKeyPath: '', // Optional when using SSH config
				enabled: true,
				useSshConfig: true,
				sshConfigHost: 'my-server',
			};

			const result = await api.saveConfig(config);

			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:saveConfig', config);
			expect(result).toEqual({ id: 'config-123' });
		});
	});

	describe('deleteConfig', () => {
		it('should invoke ssh-remote:deleteConfig with id', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.deleteConfig('config-123');

			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:deleteConfig', 'config-123');
			expect(result).toBe(true);
		});
	});

	describe('getConfigs', () => {
		it('should invoke ssh-remote:getConfigs', async () => {
			const configs: SshRemoteConfig[] = [
				{
					id: '1',
					name: 'Server 1',
					host: 'server1.example.com',
					port: 22,
					username: 'user1',
					privateKeyPath: '/path/to/key1',
					enabled: true,
				},
				{
					id: '2',
					name: 'Server 2',
					host: 'server2.example.com',
					port: 2222,
					username: 'user2',
					privateKeyPath: '/path/to/key2',
					enabled: false,
				},
			];
			mockInvoke.mockResolvedValue(configs);

			const result = await api.getConfigs();

			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:getConfigs');
			expect(result).toEqual(configs);
		});
	});

	describe('getDefaultId', () => {
		it('should invoke ssh-remote:getDefaultId', async () => {
			mockInvoke.mockResolvedValue('default-config-id');

			const result = await api.getDefaultId();

			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:getDefaultId');
			expect(result).toBe('default-config-id');
		});

		it('should return null when no default', async () => {
			mockInvoke.mockResolvedValue(null);

			const result = await api.getDefaultId();

			expect(result).toBeNull();
		});
	});

	describe('setDefaultId', () => {
		it('should invoke ssh-remote:setDefaultId with id', async () => {
			mockInvoke.mockResolvedValue(true);

			await api.setDefaultId('config-123');

			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:setDefaultId', 'config-123');
		});

		it('should handle null to clear default', async () => {
			mockInvoke.mockResolvedValue(true);

			await api.setDefaultId(null);

			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:setDefaultId', null);
		});
	});

	describe('test', () => {
		it('should invoke ssh-remote:test with config id', async () => {
			mockInvoke.mockResolvedValue({ success: true });

			const result = await api.test('config-123');

			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:test', 'config-123', undefined);
			expect(result).toEqual({ success: true });
		});

		it('should invoke ssh-remote:test with config object', async () => {
			mockInvoke.mockResolvedValue({ success: true });
			const config: SshRemoteConfig = {
				id: 'test',
				name: 'Test Server',
				host: 'test.example.com',
				port: 22,
				username: 'testuser',
				privateKeyPath: '/path/to/key',
				enabled: true,
			};

			const result = await api.test(config);

			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:test', config, undefined);
			expect(result).toEqual({ success: true });
		});

		it('should invoke ssh-remote:test with agent command', async () => {
			mockInvoke.mockResolvedValue({ success: true, agentVersion: '1.0.0' });

			const result = await api.test('config-123', 'claude');

			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:test', 'config-123', 'claude');
			expect(result).toEqual({ success: true, agentVersion: '1.0.0' });
		});
	});

	describe('reachability', () => {
		it('getReachability invokes ssh-remote:getReachability', async () => {
			mockInvoke.mockResolvedValue({ success: true, unreachable: [] });
			await expect(api.getReachability()).resolves.toEqual({ success: true, unreachable: [] });
			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:getReachability');
		});

		it('checkReachability invokes ssh-remote:checkReachability with the remote id', async () => {
			mockInvoke.mockResolvedValue({ success: true, reachable: true });
			await api.checkReachability('remote-1');
			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:checkReachability', 'remote-1');
		});

		it('onReachability subscribes to the push channel and unsubscribes the same handler', () => {
			const callback = vi.fn();
			const unsubscribe = api.onReachability(callback);

			expect(mockOn).toHaveBeenCalledWith('ssh-remote:reachability', expect.any(Function));
			const handler = mockOn.mock.calls[0][1] as (event: unknown, payload: unknown) => void;
			const payload = { remoteId: 'r1', remoteName: 'pedtome', reachable: false, since: 1 };
			handler({}, payload);
			expect(callback).toHaveBeenCalledWith(payload);

			unsubscribe();
			expect(mockRemoveListener).toHaveBeenCalledWith('ssh-remote:reachability', handler);
		});
	});

	describe('getSshConfigHosts', () => {
		it('should invoke ssh-remote:getSshConfigHosts', async () => {
			const response = {
				success: true,
				hosts: [
					{ host: 'server1', hostName: 'server1.example.com', user: 'user1' },
					{ host: 'server2', hostName: 'server2.example.com', port: 2222 },
				],
				configPath: '/home/user/.ssh/config',
			};
			mockInvoke.mockResolvedValue(response);

			const result = await api.getSshConfigHosts();

			expect(mockInvoke).toHaveBeenCalledWith('ssh-remote:getSshConfigHosts');
			expect(result).toEqual(response);
		});

		it('should handle errors', async () => {
			const response = {
				success: false,
				hosts: [],
				error: 'Config file not found',
				configPath: '/home/user/.ssh/config',
			};
			mockInvoke.mockResolvedValue(response);

			const result = await api.getSshConfigHosts();

			expect(result.success).toBe(false);
			expect(result.error).toBe('Config file not found');
		});
	});
});
