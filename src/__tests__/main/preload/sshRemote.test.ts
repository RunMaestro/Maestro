/**
 * Tests for sshRemote preload API
 *
 * Coverage:
 * - createSshRemoteApi: saveConfig, deleteConfig, getConfigs, getDefaultId, setDefaultId,
 *   test, getSshConfigHosts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
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
