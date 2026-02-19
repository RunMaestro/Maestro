/**
 * Tests for Plugin Host API Sandboxing
 *
 * Covers:
 * - Permission-based API scoping
 * - Settings namespacing
 * - Storage path traversal prevention
 * - Event subscription cleanup on destroy
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import type { LoadedEncore } from '../../shared/encore-types';

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

// Mock fs/promises
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockReaddir = vi.fn();
const mockMkdir = vi.fn();
const mockUnlink = vi.fn();

vi.mock('fs/promises', () => ({
	default: {
		readFile: (...args: unknown[]) => mockReadFile(...args),
		writeFile: (...args: unknown[]) => mockWriteFile(...args),
		readdir: (...args: unknown[]) => mockReaddir(...args),
		mkdir: (...args: unknown[]) => mockMkdir(...args),
		unlink: (...args: unknown[]) => mockUnlink(...args),
	},
	readFile: (...args: unknown[]) => mockReadFile(...args),
	writeFile: (...args: unknown[]) => mockWriteFile(...args),
	readdir: (...args: unknown[]) => mockReaddir(...args),
	mkdir: (...args: unknown[]) => mockMkdir(...args),
	unlink: (...args: unknown[]) => mockUnlink(...args),
}));

// Mock stats/singleton
vi.mock('../../main/stats/singleton', () => ({
	getStatsDB: vi.fn(() => ({
		getAggregation: vi.fn().mockResolvedValue({ totalQueries: 42 }),
	})),
}));

import { EncoreHost, type EncoreHostDependencies } from '../../main/encore-host';

/**
 * Helper to create a LoadedEncore for testing.
 */
function makeEncore(overrides: Partial<LoadedEncore> & { permissions?: string[] } = {}): LoadedEncore {
	const { permissions, ...rest } = overrides;
	return {
		manifest: {
			id: 'test-encore',
			name: 'Test Plugin',
			version: '1.0.0',
			description: 'A test encore',
			author: 'Test Author',
			main: 'index.js',
			permissions: (permissions ?? []) as any,
		},
		state: 'discovered',
		path: '/mock/encores/test-encore',
		...rest,
	};
}

/**
 * Helper to create mock dependencies.
 */
function makeDeps(overrides: Partial<EncoreHostDependencies> = {}): EncoreHostDependencies {
	const eventHandlers = new Map<string, Set<(...args: any[]) => void>>();

	const mockProcessManager = {
		getAll: vi.fn(() => [
			{ sessionId: 's1', toolType: 'claude-code', pid: 1234, startTime: 1000, cwd: '/test' },
		]),
		kill: vi.fn(() => true),
		write: vi.fn(() => true),
		on: vi.fn((event: string, handler: (...args: any[]) => void) => {
			if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
			eventHandlers.get(event)!.add(handler);
			return mockProcessManager;
		}),
		removeListener: vi.fn((event: string, handler: (...args: any[]) => void) => {
			eventHandlers.get(event)?.delete(handler);
			return mockProcessManager;
		}),
		// Expose for test assertions
		_eventHandlers: eventHandlers,
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

describe('EncoreHost', () => {
	let host: EncoreHost;
	let deps: EncoreHostDependencies;

	beforeEach(() => {
		vi.clearAllMocks();
		deps = makeDeps();
		host = new EncoreHost(deps);
	});

	describe('permission-based API scoping', () => {
		it('provides only maestro API when no permissions declared', () => {
			const encore = makeEncore({ permissions: [] });
			const ctx = host.createEncoreContext(encore);

			expect(ctx.api.maestro).toBeDefined();
			expect(ctx.api.maestro.encoreId).toBe('test-encore');
			expect(ctx.api.process).toBeUndefined();
			expect(ctx.api.processControl).toBeUndefined();
			expect(ctx.api.stats).toBeUndefined();
			expect(ctx.api.settings).toBeUndefined();
			expect(ctx.api.storage).toBeUndefined();
			expect(ctx.api.notifications).toBeUndefined();
		});

		it('provides process API with process:read permission', () => {
			const encore = makeEncore({ permissions: ['process:read'] });
			const ctx = host.createEncoreContext(encore);

			expect(ctx.api.process).toBeDefined();
			expect(ctx.api.processControl).toBeUndefined();
		});

		it('provides processControl API with process:write permission', () => {
			const encore = makeEncore({ permissions: ['process:write'] });
			const ctx = host.createEncoreContext(encore);

			expect(ctx.api.processControl).toBeDefined();
			expect(ctx.api.process).toBeUndefined();
		});

		it('provides stats API with stats:read permission', () => {
			const encore = makeEncore({ permissions: ['stats:read'] });
			const ctx = host.createEncoreContext(encore);

			expect(ctx.api.stats).toBeDefined();
		});

		it('provides settings API with settings:read permission', () => {
			const encore = makeEncore({ permissions: ['settings:read'] });
			const ctx = host.createEncoreContext(encore);

			expect(ctx.api.settings).toBeDefined();
		});

		it('provides storage API with storage permission', () => {
			const encore = makeEncore({ permissions: ['storage'] });
			const ctx = host.createEncoreContext(encore);

			expect(ctx.api.storage).toBeDefined();
		});

		it('provides notifications API with notifications permission', () => {
			const encore = makeEncore({ permissions: ['notifications'] });
			const ctx = host.createEncoreContext(encore);

			expect(ctx.api.notifications).toBeDefined();
		});
	});

	describe('maestro API', () => {
		it('provides correct metadata', () => {
			const encore = makeEncore();
			const ctx = host.createEncoreContext(encore);

			expect(ctx.api.maestro.version).toBe('2.0.0');
			expect(ctx.api.maestro.platform).toBe(process.platform);
			expect(ctx.api.maestro.encoreId).toBe('test-encore');
			expect(ctx.api.maestro.encoreDir).toBe('/mock/encores/test-encore');
			expect(ctx.api.maestro.dataDir).toBe(
				path.join('/mock/userData', 'encores', 'test-encore', 'data')
			);
		});
	});

	describe('process API', () => {
		it('getActiveProcesses returns safe fields only', async () => {
			const encore = makeEncore({ permissions: ['process:read'] });
			const ctx = host.createEncoreContext(encore);

			const processes = await ctx.api.process!.getActiveProcesses();
			expect(processes).toEqual([
				{ sessionId: 's1', toolType: 'claude-code', pid: 1234, startTime: 1000, name: null },
			]);
		});

		it('onData subscribes to data events', () => {
			const encore = makeEncore({ permissions: ['process:read'] });
			const ctx = host.createEncoreContext(encore);

			const callback = vi.fn();
			const unsub = ctx.api.process!.onData(callback);

			expect(typeof unsub).toBe('function');
			const pm = deps.getProcessManager()!;
			expect(pm.on).toHaveBeenCalledWith('data', expect.any(Function));
		});
	});

	describe('processControl API', () => {
		it('kill delegates to ProcessManager and logs', () => {
			const encore = makeEncore({ permissions: ['process:write'] });
			const ctx = host.createEncoreContext(encore);

			const result = ctx.api.processControl!.kill('s1');
			expect(result).toBe(true);
			expect(deps.getProcessManager()!.kill).toHaveBeenCalledWith('s1');
		});

		it('write delegates to ProcessManager and logs', () => {
			const encore = makeEncore({ permissions: ['process:write'] });
			const ctx = host.createEncoreContext(encore);

			const result = ctx.api.processControl!.write('s1', 'hello');
			expect(result).toBe(true);
			expect(deps.getProcessManager()!.write).toHaveBeenCalledWith('s1', 'hello');
		});
	});

	describe('settings API', () => {
		it('namespaces keys with encore ID prefix', async () => {
			const encore = makeEncore({ permissions: ['settings:read', 'settings:write'] });
			const ctx = host.createEncoreContext(encore);

			await ctx.api.settings!.set('refreshRate', 5000);
			expect(deps.settingsStore.set).toHaveBeenCalledWith(
				'encore:test-encore:refreshRate',
				5000
			);

			await ctx.api.settings!.get('refreshRate');
			expect(deps.settingsStore.get).toHaveBeenCalledWith('encore:test-encore:refreshRate');
		});

		it('settings:read without settings:write throws on set', async () => {
			const encore = makeEncore({ permissions: ['settings:read'] });
			const ctx = host.createEncoreContext(encore);

			await expect(ctx.api.settings!.set('key', 'value')).rejects.toThrow(
				"does not have 'settings:write' permission"
			);
		});

		it('getAll returns only namespaced keys', async () => {
			const d = makeDeps();
			// Populate store with mixed keys
			(d.settingsStore as any).store['encore:test-encore:a'] = 1;
			(d.settingsStore as any).store['encore:test-encore:b'] = 2;
			(d.settingsStore as any).store['encore:other-encore:c'] = 3;
			(d.settingsStore as any).store['someGlobalSetting'] = 'x';

			const h = new EncoreHost(d);
			const encore = makeEncore({ permissions: ['settings:read'] });
			const ctx = h.createEncoreContext(encore);

			const all = await ctx.api.settings!.getAll();
			expect(all).toEqual({ a: 1, b: 2 });
		});
	});

	describe('storage API', () => {
		it('prevents path traversal with ..', async () => {
			const encore = makeEncore({ permissions: ['storage'] });
			const ctx = host.createEncoreContext(encore);

			await expect(ctx.api.storage!.read('../../../etc/passwd')).rejects.toThrow(
				'Path traversal is not allowed'
			);
		});

		it('prevents absolute paths', async () => {
			const encore = makeEncore({ permissions: ['storage'] });
			const ctx = host.createEncoreContext(encore);

			await expect(ctx.api.storage!.read('/etc/passwd')).rejects.toThrow(
				'Absolute paths are not allowed'
			);
		});

		it('read returns null for non-existent files', async () => {
			mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
			const encore = makeEncore({ permissions: ['storage'] });
			const ctx = host.createEncoreContext(encore);

			const result = await ctx.api.storage!.read('config.json');
			expect(result).toBeNull();
		});

		it('write creates directory on first write', async () => {
			mockMkdir.mockResolvedValueOnce(undefined);
			mockWriteFile.mockResolvedValueOnce(undefined);

			const encore = makeEncore({ permissions: ['storage'] });
			const ctx = host.createEncoreContext(encore);

			await ctx.api.storage!.write('config.json', '{}');
			expect(mockMkdir).toHaveBeenCalledWith(
				expect.stringContaining(path.join('encores', 'test-encore', 'data')),
				{ recursive: true }
			);
		});

		it('list returns empty array when directory does not exist', async () => {
			mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));
			const encore = makeEncore({ permissions: ['storage'] });
			const ctx = host.createEncoreContext(encore);

			const files = await ctx.api.storage!.list();
			expect(files).toEqual([]);
		});
	});

	describe('destroyEncoreContext', () => {
		it('cleans up all event subscriptions', () => {
			const encore = makeEncore({ permissions: ['process:read'] });
			const ctx = host.createEncoreContext(encore);

			// Subscribe to multiple events
			ctx.api.process!.onData(vi.fn());
			ctx.api.process!.onExit(vi.fn());
			ctx.api.process!.onUsage(vi.fn());

			// 3 event subscriptions
			expect(ctx.eventSubscriptions.length).toBe(3);

			// Destroy the context
			host.destroyEncoreContext('test-encore');

			// Subscriptions array should be cleared
			expect(ctx.eventSubscriptions.length).toBe(0);

			// removeListener should have been called for each
			const pm = deps.getProcessManager()!;
			expect(pm.removeListener).toHaveBeenCalledTimes(3);
		});

		it('does not crash when destroying non-existent context', () => {
			expect(() => host.destroyEncoreContext('non-existent')).not.toThrow();
		});

		it('removes context from internal map', () => {
			const encore = makeEncore({ permissions: [] });
			host.createEncoreContext(encore);
			expect(host.getEncoreContext('test-encore')).toBeDefined();

			host.destroyEncoreContext('test-encore');
			expect(host.getEncoreContext('test-encore')).toBeUndefined();
		});
	});
});
