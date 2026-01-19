/**
 * Tests for SSH Remote IPC Handlers
 *
 * Tests the IPC handlers for managing SSH remote configurations:
 * - ssh-remote:saveConfig
 * - ssh-remote:deleteConfig
 * - ssh-remote:getConfigs
 * - ssh-remote:getDefaultId
 * - ssh-remote:setDefaultId
 * - ssh-remote:test
 */

import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerSshRemoteHandlers } from '../../../../main/ipc/handlers/ssh-remote';
import { SshRemoteConfig } from '../../../../shared/types';
import * as sshRemoteManagerModule from '../../../../main/ssh-remote-manager';

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
}));

// Capture registered handlers
const registeredHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> = new Map();

describe('SSH Remote IPC Handlers', () => {
	let mockSettingsStore: {
		get: Mock;
		set: Mock;
	};

	const createMockConfig = (overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
		id: 'test-id',
		name: 'Test Remote',
		host: 'example.com',
		port: 22,
		username: 'testuser',
		privateKeyPath: '/home/user/.ssh/id_rsa',
		enabled: true,
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();

		// Capture handler registrations
		(ipcMain.handle as Mock).mockImplementation(
			(channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
				registeredHandlers.set(channel, handler);
			}
		);

		// Create mock settings store
		mockSettingsStore = {
			get: vi.fn(),
			set: vi.fn(),
		};

		// Default store state
		mockSettingsStore.get.mockImplementation((key: string, defaultValue: unknown) => {
			if (key === 'sshRemotes') return [];
			if (key === 'defaultSshRemoteId') return null;
			return defaultValue;
		});

		// Register handlers
		registerSshRemoteHandlers({
			settingsStore: mockSettingsStore as unknown as Parameters<
				typeof registerSshRemoteHandlers
			>[0]['settingsStore'],
		});
	});

	// Helper to invoke a registered handler
	async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
		const handler = registeredHandlers.get(channel);
		if (!handler) {
			throw new Error(`No handler registered for channel: ${channel}`);
		}
		// IPC handlers receive (event, ...args), but our wrapper strips the event
		return handler({}, ...args);
	}

	describe('handler registration', () => {
		it('registers all SSH remote handlers', () => {
			expect(ipcMain.handle).toHaveBeenCalledWith('ssh-remote:saveConfig', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('ssh-remote:deleteConfig', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('ssh-remote:getConfigs', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('ssh-remote:getDefaultId', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('ssh-remote:setDefaultId', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('ssh-remote:test', expect.any(Function));
		});
	});

	describe('ssh-remote:getConfigs', () => {
		it('returns empty array when no configs exist', async () => {
			const result = await invokeHandler('ssh-remote:getConfigs');
			expect(result).toEqual({ success: true, configs: [] });
		});

		it('returns existing configs', async () => {
			const configs = [createMockConfig()];
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return configs;
				return null;
			});

			const result = await invokeHandler('ssh-remote:getConfigs');
			expect(result).toEqual({ success: true, configs });
		});
	});

	describe('ssh-remote:saveConfig', () => {
		beforeEach(() => {
			// Mock validateConfig to return valid
			vi.spyOn(sshRemoteManagerModule.sshRemoteManager, 'validateConfig').mockReturnValue({
				valid: true,
				errors: [],
			});
		});

		it('creates a new config with generated ID', async () => {
			const configData = {
				name: 'New Remote',
				host: 'new.example.com',
				port: 22,
				username: 'user',
				privateKeyPath: '/path/to/key',
			};

			const result = (await invokeHandler('ssh-remote:saveConfig', configData)) as {
				success: boolean;
				config?: SshRemoteConfig;
			};

			expect(result.success).toBe(true);
			expect(result.config).toBeDefined();
			expect(result.config?.id).toBeDefined();
			expect(result.config?.name).toBe('New Remote');
			expect(mockSettingsStore.set).toHaveBeenCalledWith('sshRemotes', expect.any(Array));
		});

		it('updates existing config when ID matches', async () => {
			const existingConfig = createMockConfig();
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return [existingConfig];
				return null;
			});

			const updates = {
				id: existingConfig.id,
				name: 'Updated Remote',
				host: existingConfig.host,
				port: existingConfig.port,
				username: existingConfig.username,
				privateKeyPath: existingConfig.privateKeyPath,
				enabled: true,
			};

			const result = (await invokeHandler('ssh-remote:saveConfig', updates)) as {
				success: boolean;
				config?: SshRemoteConfig;
			};

			expect(result.success).toBe(true);
			expect(result.config?.name).toBe('Updated Remote');
			expect(mockSettingsStore.set).toHaveBeenCalled();
		});

		it('returns error when validation fails', async () => {
			vi.spyOn(sshRemoteManagerModule.sshRemoteManager, 'validateConfig').mockReturnValue({
				valid: false,
				errors: ['Host is required', 'Username is required'],
			});

			const result = (await invokeHandler('ssh-remote:saveConfig', {})) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid configuration');
			expect(result.error).toContain('Host is required');
		});
	});

	describe('ssh-remote:deleteConfig', () => {
		it('deletes an existing config', async () => {
			const config = createMockConfig();
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return [config];
				if (key === 'defaultSshRemoteId') return null;
				return null;
			});

			const result = await invokeHandler('ssh-remote:deleteConfig', config.id);

			expect(result).toEqual({ success: true });
			expect(mockSettingsStore.set).toHaveBeenCalledWith('sshRemotes', []);
		});

		it('clears default ID when deleted config was default', async () => {
			const config = createMockConfig();
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return [config];
				if (key === 'defaultSshRemoteId') return config.id;
				return null;
			});

			await invokeHandler('ssh-remote:deleteConfig', config.id);

			expect(mockSettingsStore.set).toHaveBeenCalledWith('defaultSshRemoteId', null);
		});

		it('returns error when config not found', async () => {
			const result = (await invokeHandler('ssh-remote:deleteConfig', 'non-existent-id')) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toContain('SSH remote not found');
		});
	});

	describe('ssh-remote:getDefaultId', () => {
		it('returns null when no default is set', async () => {
			const result = await invokeHandler('ssh-remote:getDefaultId');
			expect(result).toEqual({ success: true, id: null });
		});

		it('returns the default ID when set', async () => {
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'defaultSshRemoteId') return 'my-default-id';
				return null;
			});

			const result = await invokeHandler('ssh-remote:getDefaultId');
			expect(result).toEqual({ success: true, id: 'my-default-id' });
		});
	});

	describe('ssh-remote:setDefaultId', () => {
		it('sets the default ID', async () => {
			const config = createMockConfig({ id: 'config-to-set' });
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return [config];
				return null;
			});

			const result = await invokeHandler('ssh-remote:setDefaultId', 'config-to-set');

			expect(result).toEqual({ success: true });
			expect(mockSettingsStore.set).toHaveBeenCalledWith('defaultSshRemoteId', 'config-to-set');
		});

		it('clears the default ID when null is passed', async () => {
			const result = await invokeHandler('ssh-remote:setDefaultId', null);

			expect(result).toEqual({ success: true });
			expect(mockSettingsStore.set).toHaveBeenCalledWith('defaultSshRemoteId', null);
		});

		it('returns error when config ID does not exist', async () => {
			const result = (await invokeHandler('ssh-remote:setDefaultId', 'non-existent-id')) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toContain('SSH remote not found');
		});
	});

	describe('ssh-remote:test', () => {
		beforeEach(() => {
			// Default mock for testConnection
			vi.spyOn(sshRemoteManagerModule.sshRemoteManager, 'testConnection').mockResolvedValue({
				success: true,
				remoteInfo: {
					hostname: 'test-host',
				},
			});
		});

		it('tests connection using config object', async () => {
			const config = createMockConfig();

			const result = (await invokeHandler('ssh-remote:test', config)) as {
				success: boolean;
				result?: { success: boolean };
			};

			expect(result.success).toBe(true);
			expect(result.result?.success).toBe(true);
			expect(sshRemoteManagerModule.sshRemoteManager.testConnection).toHaveBeenCalledWith(
				config,
				undefined
			);
		});

		it('tests connection by config ID', async () => {
			const config = createMockConfig();
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return [config];
				return null;
			});

			const result = (await invokeHandler('ssh-remote:test', config.id)) as {
				success: boolean;
				result?: { success: boolean };
			};

			expect(result.success).toBe(true);
			expect(result.result?.success).toBe(true);
			expect(sshRemoteManagerModule.sshRemoteManager.testConnection).toHaveBeenCalledWith(
				config,
				undefined
			);
		});

		it('passes agent command when provided', async () => {
			const config = createMockConfig();
			mockSettingsStore.get.mockImplementation((key: string) => {
				if (key === 'sshRemotes') return [config];
				return null;
			});

			await invokeHandler('ssh-remote:test', config.id, 'claude');

			expect(sshRemoteManagerModule.sshRemoteManager.testConnection).toHaveBeenCalledWith(
				config,
				'claude'
			);
		});

		it('returns error when config ID not found', async () => {
			const result = (await invokeHandler('ssh-remote:test', 'non-existent-id')) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toContain('SSH remote not found');
		});

		it('returns test failure result', async () => {
			vi.spyOn(sshRemoteManagerModule.sshRemoteManager, 'testConnection').mockResolvedValue({
				success: false,
				error: 'Connection refused',
			});

			const config = createMockConfig();
			const result = (await invokeHandler('ssh-remote:test', config)) as {
				success: boolean;
				result?: { success: boolean; error?: string };
			};

			expect(result.success).toBe(true); // IPC call succeeded
			expect(result.result?.success).toBe(false); // But test failed
			expect(result.result?.error).toBe('Connection refused');
		});
	});
});
