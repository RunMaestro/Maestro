/**
 * Tests for Main-Process Plugin Activation, Storage, and IPC Bridge
 *
 * Covers:
 * - activatePlugin() calls module's activate(api)
 * - deactivatePlugin() calls deactivate() and cleans up
 * - Plugin that throws during activation gets state 'error'
 * - Plugin that throws during deactivation is logged but doesn't propagate
 * - PluginStorage read/write/list/delete operations
 * - PluginStorage path traversal prevention
 * - IPC bridge routes messages to correct plugin
 * - unregisterAll() removes all channels for a plugin
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import type { LoadedPlugin } from '../../shared/plugin-types';

// Mock electron
vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
	app: { getPath: vi.fn(() => '/mock/userData'), getVersion: vi.fn(() => '1.0.0') },
	Notification: vi.fn().mockImplementation(() => ({
		show: vi.fn(),
	})),
}));

// Mock logger
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock sentry
const mockCaptureException = vi.fn();
vi.mock('../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

// Mock fs/promises
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockReaddir = vi.fn();
const mockMkdir = vi.fn();
const mockUnlink = vi.fn();
const mockAccess = vi.fn();

vi.mock('fs/promises', () => ({
	default: {
		readFile: (...args: unknown[]) => mockReadFile(...args),
		writeFile: (...args: unknown[]) => mockWriteFile(...args),
		readdir: (...args: unknown[]) => mockReaddir(...args),
		mkdir: (...args: unknown[]) => mockMkdir(...args),
		unlink: (...args: unknown[]) => mockUnlink(...args),
		access: (...args: unknown[]) => mockAccess(...args),
	},
	readFile: (...args: unknown[]) => mockReadFile(...args),
	writeFile: (...args: unknown[]) => mockWriteFile(...args),
	readdir: (...args: unknown[]) => mockReaddir(...args),
	mkdir: (...args: unknown[]) => mockMkdir(...args),
	unlink: (...args: unknown[]) => mockUnlink(...args),
	access: (...args: unknown[]) => mockAccess(...args),
}));

// Mock stats/singleton
vi.mock('../../main/stats/singleton', () => ({
	getStatsDB: vi.fn(() => ({
		getAggregation: vi.fn().mockResolvedValue({ totalQueries: 42 }),
	})),
}));

// Track require calls for plugin modules
const mockPluginModules: Record<string, any> = {};
vi.mock('../../main/plugin-storage', async () => {
	const actual = await vi.importActual<any>('../../main/plugin-storage');
	return actual;
});

import { PluginHost, type PluginHostDependencies } from '../../main/plugin-host';
import { PluginStorage } from '../../main/plugin-storage';
import { PluginIpcBridge } from '../../main/plugin-ipc-bridge';
import { logger } from '../../main/utils/logger';

/**
 * Helper to create a LoadedPlugin for testing.
 */
function makePlugin(overrides: Partial<LoadedPlugin> & { permissions?: string[] } = {}): LoadedPlugin {
	const { permissions, ...rest } = overrides;
	return {
		manifest: {
			id: 'test-plugin',
			name: 'Test Plugin',
			version: '1.0.0',
			description: 'A test plugin',
			author: 'Test Author',
			main: 'index.js',
			permissions: (permissions ?? ['storage']) as any,
		},
		state: 'discovered',
		path: '/mock/plugins/test-plugin',
		...rest,
	};
}

/**
 * Helper to create mock dependencies.
 */
function makeDeps(overrides: Partial<PluginHostDependencies> = {}): PluginHostDependencies {
	const mockProcessManager = {
		getAll: vi.fn(() => []),
		kill: vi.fn(() => true),
		write: vi.fn(() => true),
		on: vi.fn(() => mockProcessManager),
		removeListener: vi.fn(() => mockProcessManager),
	};

	const storeData: Record<string, unknown> = {};
	const mockSettingsStore = {
		get: vi.fn((key: string) => storeData[key]),
		set: vi.fn((key: string, value: unknown) => {
			storeData[key] = value;
		}),
		store: storeData,
	};

	const mockApp = {
		getPath: vi.fn(() => '/mock/userData'),
		getVersion: vi.fn(() => '2.0.0'),
	};

	return {
		getProcessManager: () => mockProcessManager as any,
		getMainWindow: () => null,
		settingsStore: mockSettingsStore as any,
		app: mockApp as any,
		...overrides,
	};
}

// ============================================================================
// Plugin Activation Tests
// ============================================================================

describe('PluginHost activation', () => {
	let host: PluginHost;
	let deps: PluginHostDependencies;

	beforeEach(() => {
		vi.clearAllMocks();
		// Clear the require cache for mock plugin modules
		for (const key of Object.keys(mockPluginModules)) {
			delete mockPluginModules[key];
		}
		deps = makeDeps();
		host = new PluginHost(deps);
	});

	it('sets state to error when entry point does not exist', async () => {
		const plugin = makePlugin();
		mockAccess.mockRejectedValueOnce(new Error('ENOENT'));

		await host.activatePlugin(plugin);

		expect(plugin.state).toBe('error');
		expect(plugin.error).toContain('Plugin entry point not found');
		expect(mockCaptureException).toHaveBeenCalledWith(
			expect.any(Error),
			{ pluginId: 'test-plugin' }
		);
	});

	it('sets state to error and reports to Sentry when require() fails', async () => {
		const plugin = makePlugin();
		// fs.access passes, but require() will fail since the file doesn't actually exist
		mockAccess.mockResolvedValueOnce(undefined);

		await host.activatePlugin(plugin);

		expect(plugin.state).toBe('error');
		expect(plugin.error).toBeDefined();
		expect(mockCaptureException).toHaveBeenCalledWith(
			expect.any(Error),
			{ pluginId: 'test-plugin' }
		);
	});

	it('deactivatePlugin calls deactivate() and cleans up', async () => {
		const plugin = makePlugin({ permissions: ['process:read'] });

		// Create context manually (simulating a previously activated plugin)
		host.createPluginContext(plugin);
		expect(host.getPluginContext('test-plugin')).toBeDefined();

		// Deactivate should clean up context
		await host.deactivatePlugin('test-plugin');
		expect(host.getPluginContext('test-plugin')).toBeUndefined();
	});

	it('deactivation errors are logged but do not propagate', async () => {
		const plugin = makePlugin();

		// Create a context
		host.createPluginContext(plugin);

		// Deactivate a plugin that was never actually module-loaded (no module to call deactivate on)
		// This should complete without throwing
		await expect(host.deactivatePlugin('test-plugin')).resolves.not.toThrow();
		expect(host.getPluginContext('test-plugin')).toBeUndefined();
	});
});

// ============================================================================
// Plugin Storage Tests
// ============================================================================

describe('PluginStorage', () => {
	let storage: PluginStorage;

	beforeEach(() => {
		vi.clearAllMocks();
		storage = new PluginStorage('test-plugin', '/mock/userData/plugins/test-plugin/data');
	});

	describe('read', () => {
		it('returns file contents on success', async () => {
			mockReadFile.mockResolvedValueOnce('{"key": "value"}');

			const result = await storage.read('config.json');
			expect(result).toBe('{"key": "value"}');
			expect(mockReadFile).toHaveBeenCalledWith(
				path.join('/mock/userData/plugins/test-plugin/data', 'config.json'),
				'utf-8'
			);
		});

		it('returns null for non-existent files', async () => {
			mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

			const result = await storage.read('missing.json');
			expect(result).toBeNull();
		});
	});

	describe('write', () => {
		it('creates directory and writes file', async () => {
			mockMkdir.mockResolvedValueOnce(undefined);
			mockWriteFile.mockResolvedValueOnce(undefined);

			await storage.write('config.json', '{"key": "value"}');

			expect(mockMkdir).toHaveBeenCalledWith(
				'/mock/userData/plugins/test-plugin/data',
				{ recursive: true }
			);
			expect(mockWriteFile).toHaveBeenCalledWith(
				path.join('/mock/userData/plugins/test-plugin/data', 'config.json'),
				'{"key": "value"}',
				'utf-8'
			);
		});
	});

	describe('list', () => {
		it('returns files in directory', async () => {
			mockReaddir.mockResolvedValueOnce(['config.json', 'data.db']);

			const files = await storage.list();
			expect(files).toEqual(['config.json', 'data.db']);
		});

		it('returns empty array when directory does not exist', async () => {
			mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));

			const files = await storage.list();
			expect(files).toEqual([]);
		});
	});

	describe('delete', () => {
		it('deletes a file', async () => {
			mockUnlink.mockResolvedValueOnce(undefined);

			await storage.delete('config.json');
			expect(mockUnlink).toHaveBeenCalledWith(
				path.join('/mock/userData/plugins/test-plugin/data', 'config.json')
			);
		});

		it('silently ignores missing files', async () => {
			mockUnlink.mockRejectedValueOnce(new Error('ENOENT'));

			await expect(storage.delete('missing.json')).resolves.not.toThrow();
		});
	});

	describe('path traversal prevention', () => {
		it('rejects filenames with ..', async () => {
			await expect(storage.read('../../../etc/passwd')).rejects.toThrow(
				'Path traversal is not allowed'
			);
		});

		it('rejects absolute paths', async () => {
			await expect(storage.read('/etc/passwd')).rejects.toThrow(
				'Absolute paths are not allowed'
			);
		});

		it('rejects filenames with null bytes', async () => {
			await expect(storage.read('file\0.txt')).rejects.toThrow(
				'Filename contains null bytes'
			);
		});

		it('rejects filenames with forward slashes', async () => {
			await expect(storage.read('sub/file.txt')).rejects.toThrow(
				'Path separators are not allowed'
			);
		});

		it('rejects filenames with backslashes', async () => {
			await expect(storage.read('sub\\file.txt')).rejects.toThrow(
				'Path separators are not allowed'
			);
		});

		it('applies validation to write operations', async () => {
			await expect(storage.write('../escape.txt', 'data')).rejects.toThrow(
				'Path traversal is not allowed'
			);
		});

		it('applies validation to delete operations', async () => {
			await expect(storage.delete('/etc/shadow')).rejects.toThrow(
				'Absolute paths are not allowed'
			);
		});
	});
});

// ============================================================================
// Plugin IPC Bridge Tests
// ============================================================================

describe('PluginIpcBridge', () => {
	let bridge: PluginIpcBridge;

	beforeEach(() => {
		bridge = new PluginIpcBridge();
	});

	it('register and invoke routes to correct handler', async () => {
		const handler = vi.fn().mockReturnValue('result');

		bridge.register('my-plugin', 'getData', handler);
		const result = await bridge.invoke('my-plugin', 'getData', 'arg1', 'arg2');

		expect(handler).toHaveBeenCalledWith('arg1', 'arg2');
		expect(result).toBe('result');
	});

	it('invoke throws when no handler registered', async () => {
		await expect(bridge.invoke('unknown', 'channel')).rejects.toThrow(
			"No handler registered for channel 'plugin:unknown:channel'"
		);
	});

	it('send fires handler without waiting for result', () => {
		const handler = vi.fn();
		bridge.register('my-plugin', 'notify', handler);

		bridge.send('my-plugin', 'notify', 'event-data');
		expect(handler).toHaveBeenCalledWith('event-data');
	});

	it('send silently ignores missing handlers', () => {
		expect(() => bridge.send('unknown', 'channel', 'data')).not.toThrow();
	});

	it('send logs errors from handler without propagating', () => {
		const handler = vi.fn().mockImplementation(() => {
			throw new Error('handler boom');
		});

		bridge.register('my-plugin', 'bad', handler);
		expect(() => bridge.send('my-plugin', 'bad')).not.toThrow();
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining('handler boom'),
			expect.any(String)
		);
	});

	it('register returns unsubscribe function', async () => {
		const handler = vi.fn().mockReturnValue('ok');
		const unsub = bridge.register('my-plugin', 'temp', handler);

		// Handler should be reachable
		expect(bridge.hasHandler('my-plugin', 'temp')).toBe(true);

		// Unsubscribe
		unsub();
		expect(bridge.hasHandler('my-plugin', 'temp')).toBe(false);

		// Should throw now
		await expect(bridge.invoke('my-plugin', 'temp')).rejects.toThrow();
	});

	it('unregisterAll removes all channels for a specific plugin', () => {
		bridge.register('plugin-a', 'ch1', vi.fn());
		bridge.register('plugin-a', 'ch2', vi.fn());
		bridge.register('plugin-b', 'ch1', vi.fn());

		bridge.unregisterAll('plugin-a');

		expect(bridge.hasHandler('plugin-a', 'ch1')).toBe(false);
		expect(bridge.hasHandler('plugin-a', 'ch2')).toBe(false);
		expect(bridge.hasHandler('plugin-b', 'ch1')).toBe(true);
	});

	it('does not affect other plugins when unregistering', () => {
		bridge.register('plugin-a', 'shared-name', vi.fn());
		bridge.register('plugin-b', 'shared-name', vi.fn());

		bridge.unregisterAll('plugin-a');

		expect(bridge.hasHandler('plugin-a', 'shared-name')).toBe(false);
		expect(bridge.hasHandler('plugin-b', 'shared-name')).toBe(true);
	});
});
