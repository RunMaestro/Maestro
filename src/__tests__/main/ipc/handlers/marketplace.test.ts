/**
 * Tests for the marketplace IPC handlers
 *
 * These tests verify the marketplace operations including:
 * - Cache creation and TTL validation
 * - Force refresh bypassing cache
 * - Document and README fetching
 * - Playbook import with correct folder structure
 * - Default prompt fallback for null prompts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, App, BrowserWindow } from 'electron';
import fs from 'fs/promises';
import fsSync from 'fs';
import crypto from 'crypto';
import path from 'path';
import Store from 'electron-store';
import {
	registerMarketplaceHandlers,
	MarketplaceHandlerDependencies,
} from '../../../../main/ipc/handlers/marketplace';
import { logger } from '../../../../main/utils/logger';
import type { MarketplaceManifest, MarketplaceCache } from '../../../../shared/marketplace-types';
import type { SshRemoteConfig } from '../../../../shared/types';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	app: {
		getPath: vi.fn(),
		on: vi.fn(),
	},
	BrowserWindow: {
		getAllWindows: vi.fn(),
	},
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
		readdir: vi.fn(),
		stat: vi.fn(),
	},
}));

// Mock crypto
vi.mock('crypto', () => ({
	default: {
		randomUUID: vi.fn(),
	},
}));

// Mock electron-store
vi.mock('electron-store', () => {
	return {
		default: vi.fn().mockImplementation(() => ({
			get: vi.fn(),
			set: vi.fn(),
		})),
	};
});

// Mock remote-fs for SSH operations using vi.hoisted for factory hoisting
const { mockWriteFileRemote, mockMkdirRemote } = vi.hoisted(() => ({
	mockWriteFileRemote: vi.fn(),
	mockMkdirRemote: vi.fn(),
}));

vi.mock('../../../../main/utils/remote-fs', () => ({
	writeFileRemote: mockWriteFileRemote,
	mkdirRemote: mockMkdirRemote,
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('marketplace IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockApp: App;
	let mockSettingsStore: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
	let mockDeps: MarketplaceHandlerDependencies;

	// Sample SSH remote configuration for testing
	const sampleSshRemote: SshRemoteConfig = {
		id: 'ssh-remote-1',
		label: 'Test Remote',
		host: 'testserver.example.com',
		username: 'testuser',
		enabled: true,
	};

	// Sample test data
	const sampleManifest: MarketplaceManifest = {
		lastUpdated: '2024-01-15',
		playbooks: [
			{
				id: 'test-playbook-1',
				title: 'Test Playbook',
				description: 'A test playbook',
				category: 'Development',
				author: 'Test Author',
				lastUpdated: '2024-01-15',
				path: 'playbooks/test-playbook-1',
				documents: [
					{ filename: 'phase-1', resetOnCompletion: false },
					{ filename: 'phase-2', resetOnCompletion: true },
				],
				loopEnabled: false,
				maxLoops: null,
				prompt: null, // Uses Maestro default
			},
			{
				id: 'test-playbook-2',
				title: 'Custom Prompt Playbook',
				description: 'A playbook with custom prompt',
				category: 'Security',
				author: 'Test Author',
				lastUpdated: '2024-01-15',
				path: 'playbooks/test-playbook-2',
				documents: [{ filename: 'security-check', resetOnCompletion: false }],
				loopEnabled: true,
				maxLoops: 3,
				prompt: 'Custom instructions here',
			},
			{
				id: 'test-playbook-with-assets',
				title: 'Playbook With Assets',
				description: 'A playbook with asset files',
				category: 'Development',
				author: 'Test Author',
				lastUpdated: '2024-01-15',
				path: 'playbooks/test-playbook-assets',
				documents: [{ filename: 'main-doc', resetOnCompletion: false }],
				loopEnabled: false,
				maxLoops: null,
				prompt: null,
				assets: ['config.yaml', 'logo.png'],
			},
		],
	};

	beforeEach(() => {
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Setup mock app
		mockApp = {
			getPath: vi.fn().mockReturnValue('/mock/userData'),
			on: vi.fn(),
		} as unknown as App;

		// Setup mock settings store for SSH remote lookup
		// The get function is called with (key, defaultValue) - we mock it to return sshRemotes
		mockSettingsStore = {
			get: vi.fn().mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'sshRemotes') {
					return [sampleSshRemote];
				}
				return defaultValue;
			}),
			set: vi.fn(),
		};

		// Setup dependencies
		mockDeps = {
			app: mockApp,
			settingsStore: mockSettingsStore as unknown as Store,
		};

		// Default mock for crypto.randomUUID
		vi.mocked(crypto.randomUUID).mockReturnValue('test-uuid-123');

		// Reset remote-fs mocks
		mockWriteFileRemote.mockReset();
		mockMkdirRemote.mockReset();
		vi.mocked(fs.readdir).mockReset();
		vi.mocked(fs.stat).mockReset();
		vi.mocked(fs.readdir).mockRejectedValue({ code: 'ENOENT' });

		// Register handlers
		registerMarketplaceHandlers(mockDeps);
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all marketplace handlers', () => {
			const expectedChannels = [
				'marketplace:getManifest',
				'marketplace:refreshManifest',
				'marketplace:getDocument',
				'marketplace:getReadme',
				'marketplace:importPlaybook',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('local manifest watcher', () => {
		it('should broadcast manifest change events and clean up the watcher on quit', async () => {
			vi.useFakeTimers();
			const watcher = { close: vi.fn() };
			let watchCallback: ((eventType: string) => void) | undefined;
			const watchSpy = vi.spyOn(fsSync, 'watch').mockImplementation(((_filename, listener) => {
				watchCallback = listener as (eventType: string) => void;
				return watcher as unknown as fsSync.FSWatcher;
			}) as typeof fsSync.watch);
			const window = {
				isDestroyed: vi.fn().mockReturnValue(false),
				webContents: {
					isDestroyed: vi.fn().mockReturnValue(false),
					send: vi.fn(),
				},
			};

			try {
				handlers.clear();
				vi.mocked(mockApp.on).mockClear();
				vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window as any]);
				registerMarketplaceHandlers(mockDeps);
				registerMarketplaceHandlers(mockDeps);
				expect(watcher.close).toHaveBeenCalledTimes(1);

				expect(watchCallback).toBeDefined();
				watchCallback!('change');
				watchCallback!('change');
				await vi.advanceTimersByTimeAsync(500);

				expect(window.webContents.send).toHaveBeenCalledWith('marketplace:manifestChanged');

				const quitHandler = vi
					.mocked(mockApp.on)
					.mock.calls.find(([eventName]) => eventName === 'will-quit')?.[1] as
					| (() => void)
					| undefined;
				expect(quitHandler).toBeDefined();
				quitHandler!();
				expect(watcher.close).toHaveBeenCalledTimes(2);
			} finally {
				vi.useRealTimers();
				watchSpy.mockRestore();
			}
		});

		it('should skip destroyed windows when broadcasting manifest changes', async () => {
			vi.useFakeTimers();
			const watcher = { close: vi.fn() };
			let watchCallback: ((eventType: string) => void) | undefined;
			const watchSpy = vi.spyOn(fsSync, 'watch').mockImplementation(((_filename, listener) => {
				watchCallback = listener as (eventType: string) => void;
				return watcher as unknown as fsSync.FSWatcher;
			}) as typeof fsSync.watch);
			const window = {
				isDestroyed: vi.fn().mockReturnValue(true),
				webContents: {
					isDestroyed: vi.fn().mockReturnValue(false),
					send: vi.fn(),
				},
			};

			try {
				handlers.clear();
				vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window as any]);
				registerMarketplaceHandlers(mockDeps);

				expect(watchCallback).toBeDefined();
				watchCallback!('change');
				await vi.advanceTimersByTimeAsync(500);

				expect(window.webContents.send).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
				watchSpy.mockRestore();
			}
		});

		it('should log and continue when watcher cleanup fails', () => {
			const watcher = {
				close: vi.fn(() => {
					throw new Error('close failed');
				}),
			};
			const watchSpy = vi
				.spyOn(fsSync, 'watch')
				.mockReturnValue(watcher as unknown as fsSync.FSWatcher);

			try {
				handlers.clear();
				vi.mocked(mockApp.on).mockClear();
				registerMarketplaceHandlers(mockDeps);

				const quitHandler = vi
					.mocked(mockApp.on)
					.mock.calls.find(([eventName]) => eventName === 'will-quit')?.[1] as
					| (() => void)
					| undefined;
				expect(quitHandler).toBeDefined();
				quitHandler!();

				expect(logger.warn).toHaveBeenCalledWith(
					'Error closing local manifest watcher',
					'[Marketplace]',
					expect.objectContaining({ error: expect.any(Error) })
				);
			} finally {
				watchSpy.mockRestore();
			}
		});

		it('should log local manifest watcher runtime errors', () => {
			let errorHandler: ((error: Error) => void) | undefined;
			const watcher = {
				close: vi.fn(),
				on: vi.fn((event: string, handler: (error: Error) => void) => {
					if (event === 'error') {
						errorHandler = handler;
					}
				}),
			};
			const watchSpy = vi
				.spyOn(fsSync, 'watch')
				.mockReturnValue(watcher as unknown as fsSync.FSWatcher);

			try {
				handlers.clear();
				registerMarketplaceHandlers(mockDeps);

				expect(errorHandler).toBeDefined();
				expect(() => errorHandler?.(new Error('watch failed'))).not.toThrow();
				expect(logger.warn).toHaveBeenCalledWith(
					'Local manifest watcher error: watch failed',
					'[Marketplace]'
				);
			} finally {
				watchSpy.mockRestore();
			}
		});

		it('should no-op watcher cleanup when the local manifest file is missing', () => {
			const watchSpy = vi.spyOn(fsSync, 'watch').mockImplementation(() => {
				throw Object.assign(new Error('missing manifest'), { code: 'ENOENT' });
			});

			try {
				handlers.clear();
				vi.mocked(mockApp.on).mockClear();
				registerMarketplaceHandlers(mockDeps);

				const quitHandler = vi
					.mocked(mockApp.on)
					.mock.calls.find(([eventName]) => eventName === 'will-quit')?.[1] as
					| (() => void)
					| undefined;
				expect(quitHandler).toBeDefined();
				expect(() => quitHandler!()).not.toThrow();
			} finally {
				watchSpy.mockRestore();
			}
		});

		it('should warn and continue when watcher setup fails for non-missing-file errors', () => {
			const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
			const watchSpy = vi.spyOn(fsSync, 'watch').mockImplementation(() => {
				throw error;
			});

			try {
				handlers.clear();
				registerMarketplaceHandlers(mockDeps);

				expect(logger.warn).toHaveBeenCalledWith(
					'Failed to setup local manifest watcher (non-fatal)',
					'[Marketplace]',
					{ error }
				);
			} finally {
				watchSpy.mockRestore();
			}
		});
	});

	describe('marketplace:getManifest', () => {
		it('should create cache file in userData after first fetch', async () => {
			// No existing cache, no local manifest
			vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			// Mock successful fetch
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(sampleManifest),
			});

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			// Verify cache was written
			expect(fs.writeFile).toHaveBeenCalledWith(
				path.join('/mock/userData', 'marketplace-cache.json'),
				expect.any(String),
				'utf-8'
			);

			// Verify cache content structure
			const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
			const writtenCache = JSON.parse(writeCall[1] as string) as MarketplaceCache;
			expect(writtenCache.fetchedAt).toBeDefined();
			expect(typeof writtenCache.fetchedAt).toBe('number');
			expect(writtenCache.manifest).toEqual(sampleManifest);

			// Verify response indicates not from cache
			expect(result.fromCache).toBe(false);
			// Merged manifest includes source field for each playbook
			expect(result.manifest.playbooks.length).toBe(sampleManifest.playbooks.length);
			expect(result.manifest.playbooks.every((p: any) => p.source === 'official')).toBe(true);
		});

		it('should use cache when within TTL', async () => {
			const cacheAge = 1000 * 60 * 60; // 1 hour ago (within 6 hour TTL)
			const cachedData: MarketplaceCache = {
				fetchedAt: Date.now() - cacheAge,
				manifest: sampleManifest,
			};

			// First read returns cache, second read (local manifest) returns ENOENT
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(cachedData))
				.mockRejectedValueOnce({ code: 'ENOENT' });

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			// Should not fetch from network
			expect(mockFetch).not.toHaveBeenCalled();

			// Should return cached data
			expect(result.fromCache).toBe(true);
			expect(result.cacheAge).toBeDefined();
			expect(result.cacheAge).toBeGreaterThanOrEqual(cacheAge);
			// Merged manifest includes source field for each playbook
			expect(result.manifest.playbooks.length).toBe(sampleManifest.playbooks.length);
			expect(result.manifest.playbooks.every((p: any) => p.source === 'official')).toBe(true);
		});

		it('should fetch fresh data when cache is expired', async () => {
			const cacheAge = 1000 * 60 * 60 * 7; // 7 hours ago (past 6 hour TTL)
			const expiredCache: MarketplaceCache = {
				fetchedAt: Date.now() - cacheAge,
				manifest: {
					lastUpdated: '2024-01-01',
					playbooks: [],
				},
			};

			// First read returns expired cache, second read (local manifest) returns ENOENT
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(expiredCache))
				.mockRejectedValueOnce({ code: 'ENOENT' });
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(sampleManifest),
			});

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			// Should have fetched from network
			expect(mockFetch).toHaveBeenCalled();

			// Should return fresh data
			expect(result.fromCache).toBe(false);
			// Merged manifest includes source field for each playbook
			expect(result.manifest.playbooks.length).toBe(sampleManifest.playbooks.length);
			expect(result.manifest.playbooks.every((p: any) => p.source === 'official')).toBe(true);
		});

		it('should handle invalid cache structure gracefully', async () => {
			// Invalid cache - missing playbooks array
			vi.mocked(fs.readFile).mockResolvedValue(
				JSON.stringify({ fetchedAt: Date.now(), manifest: { invalid: true } })
			);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(sampleManifest),
			});

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			// Should have fetched fresh data due to invalid cache
			expect(mockFetch).toHaveBeenCalled();
			expect(result.fromCache).toBe(false);
		});

		it('should handle network errors gracefully when no cache exists', async () => {
			// No cache, no local manifest
			vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });

			mockFetch.mockRejectedValue(new Error('Network error'));

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			// With no cache to fall back to, returns empty manifest
			expect(result.manifest).toBeDefined();
			expect(result.manifest.playbooks).toEqual([]);
			expect(result.fromCache).toBe(false);
		});

		it('should return a local-only manifest when official fetch fails', async () => {
			const localManifest: MarketplaceManifest = {
				lastUpdated: '2024-02-01',
				playbooks: [
					{
						id: 'local-only',
						title: 'Local Only',
						description: 'Available without GitHub',
						category: 'Custom',
						author: 'Local Author',
						lastUpdated: '2024-02-01',
						path: '/local/playbooks/local-only',
						documents: [{ filename: 'plan', resetOnCompletion: false }],
						loopEnabled: false,
						maxLoops: null,
						prompt: null,
					},
				],
			};

			vi.mocked(fs.readFile)
				.mockRejectedValueOnce({ code: 'ENOENT' })
				.mockResolvedValueOnce(JSON.stringify(localManifest));
			mockFetch.mockRejectedValue(new Error('offline'));

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			expect(result.fromCache).toBe(false);
			expect(result.manifest.playbooks).toEqual([
				expect.objectContaining({
					id: 'local-only',
					source: 'local',
				}),
			]);
		});

		it('should use local manifest lastUpdated when official manifest has none', async () => {
			const officialManifest = {
				playbooks: [],
			} as unknown as MarketplaceManifest;
			const localManifest: MarketplaceManifest = {
				lastUpdated: '2024-02-01',
				playbooks: [
					{
						id: 'local-date',
						title: 'Local Date',
						description: 'Provides the merged manifest date',
						category: 'Custom',
						author: 'Local Author',
						lastUpdated: '2024-02-01',
						path: '/local/playbooks/date',
						documents: [{ filename: 'plan', resetOnCompletion: false }],
						loopEnabled: false,
						maxLoops: null,
						prompt: null,
					},
				],
			};

			vi.mocked(fs.readFile)
				.mockRejectedValueOnce({ code: 'ENOENT' })
				.mockResolvedValueOnce(JSON.stringify(localManifest));
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(officialManifest),
			});

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			expect(result.manifest.lastUpdated).toBe('2024-02-01');
			expect(result.manifest.playbooks).toEqual([
				expect.objectContaining({ id: 'local-date', source: 'local' }),
			]);
		});

		it('should use the current date when merged manifests have no lastUpdated value', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));

			try {
				const officialManifest = {
					playbooks: [],
				} as unknown as MarketplaceManifest;
				const localManifest = {
					playbooks: [],
				} as unknown as MarketplaceManifest;

				vi.mocked(fs.readFile)
					.mockRejectedValueOnce({ code: 'ENOENT' })
					.mockResolvedValueOnce(JSON.stringify(localManifest));
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				mockFetch.mockResolvedValue({
					ok: true,
					json: () => Promise.resolve(officialManifest),
				});

				const handler = handlers.get('marketplace:getManifest');
				const result = await handler!({} as any);

				expect(result.manifest.lastUpdated).toBe('2026-05-12');
				expect(result.manifest.playbooks).toEqual([]);
			} finally {
				vi.useRealTimers();
			}
		});

		it('should stringify non-Error manifest fetch failures', async () => {
			vi.mocked(fs.readFile)
				.mockRejectedValueOnce({ code: 'ENOENT' })
				.mockRejectedValueOnce({ code: 'ENOENT' });
			mockFetch.mockRejectedValue('offline');

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			expect(result.manifest.playbooks).toEqual([]);
			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to fetch official manifest from GitHub',
				'[Marketplace]',
				expect.objectContaining({
					error: expect.objectContaining({
						message: 'Network error fetching manifest: offline',
					}),
				})
			);
		});

		it('should fallback to expired cache when network fetch fails', async () => {
			const cacheAge = 1000 * 60 * 60 * 7; // 7 hours ago (past 6 hour TTL)
			const expiredCache: MarketplaceCache = {
				fetchedAt: Date.now() - cacheAge,
				manifest: sampleManifest,
			};

			// First read returns expired cache, second read (local manifest) returns ENOENT
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(expiredCache))
				.mockRejectedValueOnce({ code: 'ENOENT' });

			// Network fetch fails
			mockFetch.mockRejectedValue(new Error('Network error'));

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			// Should fallback to expired cache data
			expect(result.manifest.playbooks.length).toBe(sampleManifest.playbooks.length);
			expect(result.fromCache).toBe(true);
			expect(result.cacheAge).toBeGreaterThanOrEqual(cacheAge);
		});

		it('should handle HTTP error responses gracefully when no cache exists', async () => {
			// No cache, no local manifest
			vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });

			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				statusText: 'Internal Server Error',
			});

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			// With no cache to fall back to, returns empty manifest
			expect(result.manifest).toBeDefined();
			expect(result.manifest.playbooks).toEqual([]);
			expect(result.fromCache).toBe(false);
		});

		it('should ignore non-ENOENT cache read errors and fetch fresh data', async () => {
			vi.mocked(fs.readFile)
				.mockRejectedValueOnce({ code: 'EACCES' })
				.mockRejectedValueOnce({ code: 'ENOENT' });
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(sampleManifest),
			});

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			expect(result.fromCache).toBe(false);
			expect(mockFetch).toHaveBeenCalled();
			expect(logger.debug).toHaveBeenCalledWith(
				'Cache read error (non-ENOENT)',
				'[Marketplace]',
				expect.objectContaining({ error: expect.objectContaining({ code: 'EACCES' }) })
			);
		});

		it('should continue when cache writes fail after a successful fetch', async () => {
			vi.mocked(fs.readFile)
				.mockRejectedValueOnce({ code: 'ENOENT' })
				.mockRejectedValueOnce({ code: 'ENOENT' });
			vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('disk full'));
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(sampleManifest),
			});

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			expect(result.fromCache).toBe(false);
			expect(result.manifest.playbooks).toHaveLength(sampleManifest.playbooks.length);
			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to write cache',
				'[Marketplace]',
				expect.objectContaining({ error: expect.any(Error) })
			);
		});

		it('should reject invalid official manifest payloads and continue with local-only fallback', async () => {
			const localManifest: MarketplaceManifest = {
				lastUpdated: '2024-02-01',
				playbooks: [
					{
						id: 'local-fallback',
						title: 'Local Fallback',
						description: 'Fallback playbook',
						category: 'Custom',
						author: 'Local Author',
						lastUpdated: '2024-02-01',
						path: '/local/playbooks/fallback',
						documents: [{ filename: 'plan', resetOnCompletion: false }],
						loopEnabled: false,
						maxLoops: null,
						prompt: null,
					},
				],
			};

			vi.mocked(fs.readFile)
				.mockRejectedValueOnce({ code: 'ENOENT' })
				.mockResolvedValueOnce(JSON.stringify(localManifest));
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ lastUpdated: '2024-02-01' }),
			});

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			expect(result.manifest.playbooks).toEqual([
				expect.objectContaining({ id: 'local-fallback', source: 'local' }),
			]);
		});

		it('should ignore invalid local manifest JSON', async () => {
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache))
				.mockResolvedValueOnce('{invalid-json');

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			expect(result.manifest.playbooks).toHaveLength(sampleManifest.playbooks.length);
			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to read local manifest, ignoring',
				'[Marketplace]',
				expect.objectContaining({ error: expect.any(SyntaxError) })
			);
		});

		it('should skip local manifest playbooks that are missing required fields', async () => {
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};
			const localManifest = {
				lastUpdated: '2024-02-01',
				playbooks: [
					{
						title: 'Missing ID',
						description: 'Cannot be merged',
						path: '/local/missing-id',
						documents: [{ filename: 'doc', resetOnCompletion: false }],
					},
					{
						id: 'missing-docs',
						title: 'Missing Documents',
						path: '/local/missing-docs',
					},
				],
			};

			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache))
				.mockResolvedValueOnce(JSON.stringify(localManifest));

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			expect(result.manifest.playbooks.map((p: any) => p.id)).not.toContain('missing-docs');
			expect(logger.warn).toHaveBeenCalledWith(
				'Local playbook missing required "id" field, skipping',
				'[Marketplace]',
				{ title: 'Missing ID' }
			);
			expect(logger.warn).toHaveBeenCalledWith(
				'Local playbook "missing-docs" missing required fields, skipping',
				'[Marketplace]'
			);
		});
	});

	describe('marketplace:refreshManifest', () => {
		it('should bypass cache and fetch fresh data', async () => {
			// Valid cache exists
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now() - 1000, // 1 second ago (well within TTL)
				manifest: {
					lastUpdated: '2024-01-01',
					playbooks: [],
				},
			};

			// First read is for local manifest (returns ENOENT = no local manifest)
			vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(sampleManifest),
			});

			const handler = handlers.get('marketplace:refreshManifest');
			const result = await handler!({} as any);

			// Should have fetched from network despite valid cache
			expect(mockFetch).toHaveBeenCalled();

			// Should return fresh data
			expect(result.fromCache).toBe(false);

			// Manifest now includes source field from mergeManifests
			expect(result.manifest.playbooks.length).toBe(sampleManifest.playbooks.length);
			expect(result.manifest.playbooks.every((p: any) => p.source === 'official')).toBe(true);
			expect(result.manifest.playbooks.map((p: any) => p.id)).toEqual(
				sampleManifest.playbooks.map((p) => p.id)
			);

			// Should have updated cache
			expect(fs.writeFile).toHaveBeenCalled();
		});

		it('should fallback to existing cache when refresh fails', async () => {
			const existingCache: MarketplaceCache = {
				fetchedAt: Date.now() - 1000 * 60 * 60, // 1 hour ago
				manifest: sampleManifest,
			};

			// Order of reads in refreshManifest:
			// 1. Cache read (fallback after fetch failure)
			// 2. Local manifest read
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(existingCache)) // cache fallback
				.mockRejectedValueOnce({ code: 'ENOENT' }); // local manifest

			// Network fetch fails
			mockFetch.mockRejectedValue(new Error('Network error'));

			const handler = handlers.get('marketplace:refreshManifest');
			const result = await handler!({} as any);

			// Should have attempted to fetch
			expect(mockFetch).toHaveBeenCalled();

			// Should fallback to existing cache
			expect(result.manifest.playbooks.length).toBe(sampleManifest.playbooks.length);
			expect(result.fromCache).toBe(true);
		});

		it('should return empty manifest when refresh fails and no cache exists', async () => {
			// No cache, no local manifest
			vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });

			// Network fetch fails
			mockFetch.mockRejectedValue(new Error('Network error'));

			const handler = handlers.get('marketplace:refreshManifest');
			const result = await handler!({} as any);

			// Should return empty manifest
			expect(result.manifest.playbooks).toEqual([]);
			expect(result.fromCache).toBe(false);
		});
	});

	describe('marketplace:getDocument', () => {
		it('should fetch document from GitHub', async () => {
			const docContent = '# Phase 1\n\n- [ ] Task 1\n- [ ] Task 2';

			mockFetch.mockResolvedValue({
				ok: true,
				text: () => Promise.resolve(docContent),
			});

			const handler = handlers.get('marketplace:getDocument');
			const result = await handler!({} as any, 'playbooks/test-playbook', 'phase-1');

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('playbooks/test-playbook/phase-1.md')
			);
			expect(result.content).toBe(docContent);
		});

		it('should handle 404 for missing documents', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 404,
				statusText: 'Not Found',
			});

			const handler = handlers.get('marketplace:getDocument');
			const result = await handler!({} as any, 'playbooks/missing', 'doc');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Document not found');
		});

		it('should report non-404 document fetch failures', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 503,
				statusText: 'Service Unavailable',
			});

			const handler = handlers.get('marketplace:getDocument');
			const result = await handler!({} as any, 'playbooks/unavailable', 'doc');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to fetch document: 503 Service Unavailable');
		});

		it('should report network errors while fetching documents', async () => {
			mockFetch.mockRejectedValue(new Error('connection reset'));

			const handler = handlers.get('marketplace:getDocument');
			const result = await handler!({} as any, 'playbooks/network', 'doc');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Network error fetching document: connection reset');
		});

		it('should stringify non-Error network document failures', async () => {
			mockFetch.mockRejectedValue('offline');

			const handler = handlers.get('marketplace:getDocument');
			const result = await handler!({} as any, 'playbooks/network', 'doc');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Network error fetching document: offline');
		});

		it('should report local document read failures', async () => {
			vi.mocked(fs.readFile).mockRejectedValueOnce(
				Object.assign(new Error('permission denied'), { code: 'EACCES' })
			);

			const handler = handlers.get('marketplace:getDocument');
			const result = await handler!({} as any, '/local/playbook', 'doc');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to read local document: permission denied');
		});

		it('should stringify non-Error local document read failures', async () => {
			vi.mocked(fs.readFile).mockRejectedValueOnce('disk offline');

			const handler = handlers.get('marketplace:getDocument');
			const result = await handler!({} as any, '/local/playbook', 'doc');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to read local document: disk offline');
		});

		it('should report missing local documents', async () => {
			vi.mocked(fs.readFile).mockRejectedValueOnce({ code: 'ENOENT' });

			const handler = handlers.get('marketplace:getDocument');
			const result = await handler!({} as any, '/local/playbook', 'missing-doc');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Local document not found:');
		});
	});

	describe('marketplace:getReadme', () => {
		it('should fetch README from GitHub', async () => {
			const readmeContent = '# Test Playbook\n\nThis is a description.';

			mockFetch.mockResolvedValue({
				ok: true,
				text: () => Promise.resolve(readmeContent),
			});

			const handler = handlers.get('marketplace:getReadme');
			const result = await handler!({} as any, 'playbooks/test-playbook');

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining('playbooks/test-playbook/README.md')
			);
			expect(result.content).toBe(readmeContent);
		});

		it('should return null for missing README (404)', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 404,
				statusText: 'Not Found',
			});

			const handler = handlers.get('marketplace:getReadme');
			const result = await handler!({} as any, 'playbooks/no-readme');

			expect(result.content).toBeNull();
		});

		it('should read README files from local playbook paths', async () => {
			vi.mocked(fs.readFile).mockResolvedValueOnce('# Local README');

			const handler = handlers.get('marketplace:getReadme');
			const result = await handler!({} as any, '/local/playbook');

			expect(fs.readFile).toHaveBeenCalledWith(
				path.resolve('/local/playbook', 'README.md'),
				'utf-8'
			);
			expect(result.content).toBe('# Local README');
		});

		it('should return null when local README is missing', async () => {
			vi.mocked(fs.readFile).mockRejectedValueOnce({ code: 'ENOENT' });

			const handler = handlers.get('marketplace:getReadme');
			const result = await handler!({} as any, '/local/no-readme');

			expect(result.content).toBeNull();
		});

		it('should return null for non-fatal local README read errors', async () => {
			vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('permission denied'));

			const handler = handlers.get('marketplace:getReadme');
			const result = await handler!({} as any, '/local/readme-error');

			expect(result.content).toBeNull();
			expect(logger.debug).toHaveBeenCalledWith(
				expect.stringContaining('Local README read failed (non-fatal):'),
				'[Marketplace]'
			);
		});

		it('should report non-404 README fetch failures', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				statusText: 'Internal Server Error',
			});

			const handler = handlers.get('marketplace:getReadme');
			const result = await handler!({} as any, 'playbooks/readme-error');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to fetch README: 500 Internal Server Error');
		});

		it('should return null for network README fetch failures', async () => {
			mockFetch.mockRejectedValue(new Error('offline'));

			const handler = handlers.get('marketplace:getReadme');
			const result = await handler!({} as any, 'playbooks/readme-network');

			expect(result.content).toBeNull();
			expect(logger.debug).toHaveBeenCalledWith(
				expect.stringContaining('README fetch failed (non-fatal):'),
				'[Marketplace]'
			);
		});
	});

	describe('marketplace:importPlaybook', () => {
		it('should create correct folder structure', async () => {
			// Setup cache with manifest
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache)) // Cache read
				.mockRejectedValueOnce({ code: 'ENOENT' }); // No existing playbooks
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			// Mock document fetches
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve('# Phase 1 Content'),
				})
				.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve('# Phase 2 Content'),
				});

			const handler = handlers.get('marketplace:importPlaybook');
			const result = await handler!(
				{} as any,
				'test-playbook-1',
				'My Test Playbook',
				'/autorun/folder',
				'session-123'
			);

			// Verify target folder was created
			expect(fs.mkdir).toHaveBeenCalledWith(path.join('/autorun/folder', 'My Test Playbook'), {
				recursive: true,
			});

			// Verify documents were written
			expect(fs.writeFile).toHaveBeenCalledWith(
				path.join('/autorun/folder', 'My Test Playbook', 'phase-1.md'),
				'# Phase 1 Content',
				'utf-8'
			);
			expect(fs.writeFile).toHaveBeenCalledWith(
				path.join('/autorun/folder', 'My Test Playbook', 'phase-2.md'),
				'# Phase 2 Content',
				'utf-8'
			);

			// Verify playbook was saved
			expect(result.playbook).toBeDefined();
			expect(result.playbook.name).toBe('Test Playbook');
			expect(result.importedDocs).toEqual(['phase-1', 'phase-2']);

			// Verify documents have target folder prefixed in their filenames
			// This ensures the playbook can find documents in subfolders
			expect(result.playbook.documents).toEqual([
				{ filename: 'My Test Playbook/phase-1', resetOnCompletion: false },
				{ filename: 'My Test Playbook/phase-2', resetOnCompletion: true },
			]);
		});

		it('should keep document filenames unprefixed for root imports and replace invalid stored playbooks', async () => {
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache))
				.mockRejectedValueOnce({ code: 'ENOENT' })
				.mockResolvedValueOnce(JSON.stringify({ playbooks: { invalid: true } }));
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve('# Phase 1 Content'),
				})
				.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve('# Phase 2 Content'),
				});

			const handler = handlers.get('marketplace:importPlaybook');
			const result = await handler!(
				{} as any,
				'test-playbook-1',
				'',
				'/autorun/folder',
				'session-123'
			);

			expect(result.success).toBe(true);
			expect(result.playbook.documents).toEqual([
				{ filename: 'phase-1', resetOnCompletion: false },
				{ filename: 'phase-2', resetOnCompletion: true },
			]);

			const playbooksWrite = vi
				.mocked(fs.writeFile)
				.mock.calls.find(([filePath]) =>
					String(filePath).endsWith(path.join('playbooks', 'session-123.json'))
				);
			expect(playbooksWrite).toBeDefined();
			const saved = JSON.parse(playbooksWrite![1] as string);
			expect(saved.playbooks).toHaveLength(1);
			expect(saved.playbooks[0].id).toBe('test-uuid-123');
		});

		it('should store empty string for null prompt (Maestro default fallback)', async () => {
			// Setup cache with playbook that has prompt: null
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache))
				.mockRejectedValueOnce({ code: 'ENOENT' });
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve('# Content'),
				})
				.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve('# Content 2'),
				});

			const handler = handlers.get('marketplace:importPlaybook');
			const result = await handler!(
				{} as any,
				'test-playbook-1', // This playbook has prompt: null
				'Imported',
				'/autorun',
				'session-123'
			);

			// Verify prompt is empty string (not null)
			expect(result.playbook.prompt).toBe('');
			expect(typeof result.playbook.prompt).toBe('string');
		});

		it('should preserve custom prompt when provided', async () => {
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache))
				.mockRejectedValueOnce({ code: 'ENOENT' });
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			mockFetch.mockResolvedValueOnce({
				ok: true,
				text: () => Promise.resolve('# Content'),
			});

			const handler = handlers.get('marketplace:importPlaybook');
			const result = await handler!(
				{} as any,
				'test-playbook-2', // This playbook has a custom prompt
				'Custom',
				'/autorun',
				'session-123'
			);

			expect(result.playbook.prompt).toBe('Custom instructions here');
		});

		it('should save playbook to session storage', async () => {
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache))
				.mockRejectedValueOnce({ code: 'ENOENT' }); // No existing playbooks
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			mockFetch.mockResolvedValue({
				ok: true,
				text: () => Promise.resolve('# Content'),
			});

			const handler = handlers.get('marketplace:importPlaybook');
			await handler!({} as any, 'test-playbook-2', 'Test', '/autorun', 'session-123');

			// Verify playbooks directory was created
			expect(fs.mkdir).toHaveBeenCalledWith(path.join('/mock/userData', 'playbooks'), {
				recursive: true,
			});

			// Verify playbook was saved to session file
			expect(fs.writeFile).toHaveBeenCalledWith(
				path.join('/mock/userData', 'playbooks', 'session-123.json'),
				expect.any(String),
				'utf-8'
			);

			// Verify playbook data structure
			const playbooksWriteCall = vi
				.mocked(fs.writeFile)
				.mock.calls.find((call) => (call[0] as string).includes('session-123.json'));
			const writtenData = JSON.parse(playbooksWriteCall![1] as string);
			expect(writtenData.playbooks).toHaveLength(1);
			expect(writtenData.playbooks[0].id).toBe('test-uuid-123');
		});

		it('should append to existing playbooks', async () => {
			const existingPlaybooks = [{ id: 'existing-1', name: 'Existing' }];
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			// Mock file reads:
			// 1. First read: official cache
			// 2. Second read: local manifest (ENOENT = no local manifest)
			// 3. Third read: existing playbooks for this session
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache)) // Official cache
				.mockRejectedValueOnce({ code: 'ENOENT' }) // No local manifest
				.mockResolvedValueOnce(JSON.stringify({ playbooks: existingPlaybooks })); // Existing playbooks
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			mockFetch.mockResolvedValue({
				ok: true,
				text: () => Promise.resolve('# Content'),
			});

			const handler = handlers.get('marketplace:importPlaybook');
			await handler!({} as any, 'test-playbook-2', 'New', '/autorun', 'session-123');

			const playbooksWriteCall = vi
				.mocked(fs.writeFile)
				.mock.calls.find((call) => (call[0] as string).includes('session-123.json'));
			const writtenData = JSON.parse(playbooksWriteCall![1] as string);
			expect(writtenData.playbooks).toHaveLength(2);
		});

		it('should return error for non-existent playbook', async () => {
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			// Mock file reads:
			// 1. First read: official cache
			// 2. Second read: local manifest (ENOENT = no local manifest)
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache)) // Official cache
				.mockRejectedValueOnce({ code: 'ENOENT' }); // No local manifest

			const handler = handlers.get('marketplace:importPlaybook');
			const result = await handler!(
				{} as any,
				'non-existent-playbook',
				'Test',
				'/autorun',
				'session-123'
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Playbook not found');
		});

		it('should import a local playbook that only exists in the local manifest', async () => {
			// Create a local-only playbook that doesn't exist in the official manifest
			const localOnlyPlaybook = {
				id: 'local-playbook-1',
				title: 'Local Playbook',
				description: 'A playbook from the local manifest',
				category: 'Custom',
				author: 'Local Author',
				lastUpdated: '2024-01-20',
				path: 'local-playbooks/local-playbook-1',
				documents: [{ filename: 'local-phase-1', resetOnCompletion: false }],
				loopEnabled: false,
				maxLoops: null,
				prompt: 'Local custom instructions',
			};

			const localManifest: MarketplaceManifest = {
				lastUpdated: '2024-01-20',
				playbooks: [localOnlyPlaybook],
			};

			// Setup: cache with official manifest (no local-playbook-1)
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest, // Official manifest without local playbook
			};

			// Mock file reads:
			// 1. First read: official cache
			// 2. Second read: local manifest (with the local-only playbook)
			// 3. Third read: existing playbooks (ENOENT = none)
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache)) // Cache with official manifest
				.mockResolvedValueOnce(JSON.stringify(localManifest)) // Local manifest
				.mockRejectedValueOnce({ code: 'ENOENT' }); // No existing playbooks

			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			// Mock document fetch for the local playbook's document
			mockFetch.mockResolvedValueOnce({
				ok: true,
				text: () => Promise.resolve('# Local Phase 1 Content'),
			});

			const handler = handlers.get('marketplace:importPlaybook');
			const result = await handler!(
				{} as any,
				'local-playbook-1', // This ID only exists in the LOCAL manifest
				'My Local Playbook',
				'/autorun/folder',
				'session-123'
			);

			// Verify the import succeeded
			expect(result.success).toBe(true);
			expect(result.playbook).toBeDefined();
			expect(result.playbook.name).toBe('Local Playbook');
			expect(result.importedDocs).toEqual(['local-phase-1']);

			// Verify target folder was created
			expect(fs.mkdir).toHaveBeenCalledWith(path.join('/autorun/folder', 'My Local Playbook'), {
				recursive: true,
			});

			// Verify document was written
			expect(fs.writeFile).toHaveBeenCalledWith(
				path.join('/autorun/folder', 'My Local Playbook', 'local-phase-1.md'),
				'# Local Phase 1 Content',
				'utf-8'
			);

			// Verify the custom prompt was preserved
			expect(result.playbook.prompt).toBe('Local custom instructions');
		});

		it('should import a local playbook with filesystem path (reads from disk, not GitHub)', async () => {
			// Create a local playbook with a LOCAL FILESYSTEM path (absolute path)
			// This tests the isLocalPath() detection and fs.readFile document reading
			const localFilesystemPlaybook = {
				id: 'filesystem-playbook-1',
				title: 'Filesystem Playbook',
				description: 'A playbook stored on the local filesystem',
				category: 'Custom',
				author: 'Local Author',
				lastUpdated: '2024-01-20',
				path: '/Users/test/custom-playbooks/my-playbook', // ABSOLUTE PATH - triggers local file reading
				documents: [
					{ filename: 'phase-1', resetOnCompletion: false },
					{ filename: 'phase-2', resetOnCompletion: true },
				],
				loopEnabled: false,
				maxLoops: null,
				prompt: 'Filesystem playbook instructions',
			};

			const localManifest: MarketplaceManifest = {
				lastUpdated: '2024-01-20',
				playbooks: [localFilesystemPlaybook],
			};

			// Setup: cache with official manifest (no filesystem-playbook-1)
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			// Mock file reads in order:
			// 1. Official cache
			// 2. Local manifest (with the filesystem playbook)
			// 3. Document read: /Users/test/custom-playbooks/my-playbook/phase-1.md
			// 4. Document read: /Users/test/custom-playbooks/my-playbook/phase-2.md
			// 5. Existing playbooks file (ENOENT = none)
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache)) // 1. Official cache
				.mockResolvedValueOnce(JSON.stringify(localManifest)) // 2. Local manifest
				.mockResolvedValueOnce('# Phase 1 from filesystem\n\n- [ ] Task 1') // 3. phase-1.md
				.mockResolvedValueOnce('# Phase 2 from filesystem\n\n- [ ] Task 2') // 4. phase-2.md
				.mockRejectedValueOnce({ code: 'ENOENT' }); // 5. No existing playbooks

			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('marketplace:importPlaybook');
			const result = await handler!(
				{} as any,
				'filesystem-playbook-1',
				'Imported Filesystem Playbook',
				'/autorun/folder',
				'session-123'
			);

			// Verify the import succeeded
			expect(result.success).toBe(true);
			expect(result.playbook).toBeDefined();
			expect(result.playbook.name).toBe('Filesystem Playbook');
			expect(result.importedDocs).toEqual(['phase-1', 'phase-2']);

			// Verify documents were READ FROM LOCAL FILESYSTEM (not fetched from GitHub)
			// The fs.readFile mock should have been called for the document paths
			expect(fs.readFile).toHaveBeenCalledWith(
				path.resolve('/Users/test/custom-playbooks/my-playbook', 'phase-1.md'),
				'utf-8'
			);
			expect(fs.readFile).toHaveBeenCalledWith(
				path.resolve('/Users/test/custom-playbooks/my-playbook', 'phase-2.md'),
				'utf-8'
			);

			// Verify NO fetch calls were made for documents (since they're local)
			// Note: mockFetch should NOT have been called for document retrieval
			expect(mockFetch).not.toHaveBeenCalled();

			// Verify documents were written to the target folder
			expect(fs.writeFile).toHaveBeenCalledWith(
				path.join('/autorun/folder', 'Imported Filesystem Playbook', 'phase-1.md'),
				'# Phase 1 from filesystem\n\n- [ ] Task 1',
				'utf-8'
			);
			expect(fs.writeFile).toHaveBeenCalledWith(
				path.join('/autorun/folder', 'Imported Filesystem Playbook', 'phase-2.md'),
				'# Phase 2 from filesystem\n\n- [ ] Task 2',
				'utf-8'
			);
			expect(fs.writeFile).toHaveBeenCalledWith(
				path.join('/mock/userData', 'playbooks', 'session-123.json'),
				expect.stringContaining('"playbooks":'),
				'utf-8'
			);

			// Verify the prompt was preserved
			expect(result.playbook.prompt).toBe('Filesystem playbook instructions');
		});

		it('should import a local playbook with tilde path (reads from disk, not GitHub)', async () => {
			// Create a local playbook with a TILDE-PREFIXED path (home directory)
			const tildePathPlaybook = {
				id: 'tilde-playbook-1',
				title: 'Tilde Path Playbook',
				description: 'A playbook stored in home directory',
				category: 'Custom',
				author: 'Local Author',
				lastUpdated: '2024-01-20',
				path: '~/playbooks/my-tilde-playbook', // TILDE PATH - triggers local file reading
				documents: [{ filename: 'setup', resetOnCompletion: false }],
				loopEnabled: false,
				maxLoops: null,
				prompt: null,
			};

			const localManifest: MarketplaceManifest = {
				lastUpdated: '2024-01-20',
				playbooks: [tildePathPlaybook],
			};

			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			// Mock os.homedir() to return a predictable path
			vi.mock('os', () => ({
				homedir: vi.fn().mockReturnValue('/Users/testuser'),
			}));

			// The tilde path ~/playbooks/my-tilde-playbook will be resolved to:
			// /Users/testuser/playbooks/my-tilde-playbook (or similar based on os.homedir)
			// For this test, we just verify that fs.readFile is called (not fetch)
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache))
				.mockResolvedValueOnce(JSON.stringify(localManifest))
				.mockResolvedValueOnce('# Setup from tilde path')
				.mockRejectedValueOnce({ code: 'ENOENT' });

			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('marketplace:importPlaybook');
			const result = await handler!(
				{} as any,
				'tilde-playbook-1',
				'Tilde Playbook',
				'/autorun/folder',
				'session-123'
			);

			// Verify the import succeeded
			expect(result.success).toBe(true);
			expect(result.playbook).toBeDefined();
			expect(result.playbook.name).toBe('Tilde Path Playbook');
			expect(result.importedDocs).toEqual(['setup']);

			// Verify NO fetch calls were made (documents read from filesystem)
			expect(mockFetch).not.toHaveBeenCalled();

			// Verify null prompt is converted to empty string (Maestro default fallback)
			expect(result.playbook.prompt).toBe('');
		});

		it('should continue importing when individual document fetch fails', async () => {
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache))
				.mockRejectedValueOnce({ code: 'ENOENT' });
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			// First doc fails, second succeeds
			mockFetch.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce({
				ok: true,
				text: () => Promise.resolve('# Phase 2 Content'),
			});

			const handler = handlers.get('marketplace:importPlaybook');
			const result = await handler!(
				{} as any,
				'test-playbook-1',
				'Partial',
				'/autorun',
				'session-123'
			);

			// Should have imported the second doc
			expect(result.importedDocs).toEqual(['phase-2']);
		});

		it('should import from local manifest when official fetch fails during import', async () => {
			const localPlaybook = {
				id: 'local-import-fallback',
				title: 'Local Import Fallback',
				description: 'Importable without official manifest',
				category: 'Custom',
				author: 'Local Author',
				lastUpdated: '2024-02-01',
				path: 'custom/local-import-fallback',
				documents: [{ filename: 'local-doc', resetOnCompletion: false }],
				loopEnabled: false,
				maxLoops: null,
				prompt: null,
			};
			const localManifest: MarketplaceManifest = {
				lastUpdated: '2024-02-01',
				playbooks: [localPlaybook],
			};

			vi.mocked(fs.readFile)
				.mockRejectedValueOnce({ code: 'ENOENT' })
				.mockResolvedValueOnce(JSON.stringify(localManifest))
				.mockRejectedValueOnce({ code: 'ENOENT' });
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);
			mockFetch.mockRejectedValueOnce(new Error('official offline')).mockResolvedValueOnce({
				ok: true,
				text: () => Promise.resolve('# Local fallback doc'),
			});

			const handler = handlers.get('marketplace:importPlaybook');
			const result = await handler!(
				{} as any,
				'local-import-fallback',
				'Local Fallback',
				'/autorun',
				'session-123'
			);

			expect(result.success).toBe(true);
			expect(result.importedDocs).toEqual(['local-doc']);
			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to fetch official manifest during import, continuing with local only',
				'[Marketplace]',
				expect.objectContaining({ error: expect.any(Error) })
			);
		});

		it('should fetch and cache official manifest during import when no valid cache exists', async () => {
			vi.mocked(fs.readFile)
				.mockRejectedValueOnce({ code: 'ENOENT' })
				.mockRejectedValueOnce({ code: 'ENOENT' })
				.mockRejectedValueOnce({ code: 'ENOENT' });
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve(sampleManifest),
				})
				.mockResolvedValueOnce({
					ok: true,
					text: () => Promise.resolve('# Security content'),
				});

			const handler = handlers.get('marketplace:importPlaybook');
			const result = await handler!(
				{} as any,
				'test-playbook-2',
				'Fetched Manifest Import',
				'/autorun',
				'session-123'
			);

			expect(result.success).toBe(true);
			expect(result.importedDocs).toEqual(['security-check']);
			expect(fs.writeFile).toHaveBeenCalledWith(
				path.join('/mock/userData', 'marketplace-cache.json'),
				expect.stringContaining('"manifest"'),
				'utf-8'
			);
		});

		describe('SSH remote import', () => {
			it('should use remote-fs for SSH imports with POSIX paths', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' }); // No existing playbooks
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				// Remote functions return RemoteFsResult with success: true
				mockMkdirRemote.mockResolvedValue({ success: true });
				mockWriteFileRemote.mockResolvedValue({ success: true });

				// Mock document fetches
				mockFetch
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Phase 1 Content'),
					})
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Phase 2 Content'),
					});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-1',
					'My Test Playbook',
					'/remote/autorun/folder',
					'session-123',
					'ssh-remote-1' // SSH remote ID
				);

				// Verify remote mkdir was called with POSIX path
				// mkdirRemote(dirPath, sshRemote, recursive)
				expect(mockMkdirRemote).toHaveBeenCalledWith(
					'/remote/autorun/folder/My Test Playbook',
					sampleSshRemote,
					true
				);

				// Verify remote writeFile was called with POSIX paths
				// writeFileRemote(filePath, content, sshRemote)
				expect(mockWriteFileRemote).toHaveBeenCalledWith(
					'/remote/autorun/folder/My Test Playbook/phase-1.md',
					'# Phase 1 Content',
					sampleSshRemote
				);
				expect(mockWriteFileRemote).toHaveBeenCalledWith(
					'/remote/autorun/folder/My Test Playbook/phase-2.md',
					'# Phase 2 Content',
					sampleSshRemote
				);

				// Should NOT use local fs for documents
				expect(fs.mkdir).not.toHaveBeenCalledWith(
					'/remote/autorun/folder/My Test Playbook',
					expect.anything()
				);

				// Local fs.writeFile should only be used for playbooks metadata
				const docWriteCalls = vi
					.mocked(fs.writeFile)
					.mock.calls.filter((call) => (call[0] as string).includes('phase-'));
				expect(docWriteCalls).toHaveLength(0);

				expect(result.success).toBe(true);
				expect(result.importedDocs).toEqual(['phase-1', 'phase-2']);
			});

			it('should avoid double slashes when remote Auto Run folder already ends with a slash', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				mockMkdirRemote.mockResolvedValue({ success: true });
				mockWriteFileRemote.mockResolvedValue({ success: true });
				mockFetch
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Phase 1 Content'),
					})
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Phase 2 Content'),
					});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-1',
					'Remote Slash',
					'/remote/autorun/',
					'session-123',
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(mockMkdirRemote).toHaveBeenCalledWith(
					'/remote/autorun/Remote Slash',
					sampleSshRemote,
					true
				);
				expect(mockMkdirRemote).not.toHaveBeenCalledWith(
					'/remote/autorun//Remote Slash',
					expect.anything(),
					expect.anything()
				);
			});

			it('should fall back to local fs when SSH remote not found', async () => {
				// Return empty array - no SSH remotes configured
				mockSettingsStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
					if (key === 'sshRemotes') return [];
					return defaultValue;
				});

				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);

				mockFetch.mockResolvedValue({
					ok: true,
					text: () => Promise.resolve('# Content'),
				});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-2',
					'Test',
					'/autorun',
					'session-123',
					'non-existent-ssh-remote'
				);

				// Should fall back to local fs operations
				expect(mockMkdirRemote).not.toHaveBeenCalled();
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
				expect(fs.mkdir).toHaveBeenCalled();
				expect(result.success).toBe(true);
			});

			it('should fall back to local fs when SSH remote is disabled', async () => {
				// Return SSH remote that is disabled
				mockSettingsStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
					if (key === 'sshRemotes') return [{ ...sampleSshRemote, enabled: false }];
					return defaultValue;
				});

				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);

				mockFetch.mockResolvedValue({
					ok: true,
					text: () => Promise.resolve('# Content'),
				});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-2',
					'Test',
					'/autorun',
					'session-123',
					'ssh-remote-1'
				);

				// Should fall back to local fs because remote is disabled
				expect(mockMkdirRemote).not.toHaveBeenCalled();
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
				expect(fs.mkdir).toHaveBeenCalled();
				expect(result.success).toBe(true);
			});

			it('should fall back to local fs when settings store is unavailable for SSH lookup', async () => {
				handlers.clear();
				registerMarketplaceHandlers({ app: mockApp });

				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				mockFetch.mockResolvedValue({
					ok: true,
					text: () => Promise.resolve('# Content'),
				});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-2',
					'No Store',
					'/autorun',
					'session-123',
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(mockMkdirRemote).not.toHaveBeenCalled();
				expect(logger.warn).toHaveBeenCalledWith(
					'[Marketplace] Settings store not available for SSH remote lookup',
					'[Marketplace]'
				);
			});

			it('should handle SSH mkdir failure gracefully', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				// Return RemoteFsResult with success: false and error message (use mockResolvedValueOnce)
				mockMkdirRemote.mockResolvedValueOnce({ success: false, error: 'SSH connection failed' });

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-1',
					'Test',
					'/remote/autorun',
					'session-123',
					'ssh-remote-1'
				);

				expect(result.success).toBe(false);
				expect(result.error).toContain('SSH connection failed');
			});

			it('should continue importing remaining remote documents when one remote write fails', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				mockMkdirRemote.mockResolvedValue({ success: true });
				mockWriteFileRemote
					.mockResolvedValueOnce({ success: false, error: 'remote disk full' })
					.mockResolvedValueOnce({ success: true });
				mockFetch
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Phase 1 Content'),
					})
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Phase 2 Content'),
					});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-1',
					'Remote Partial',
					'/remote/autorun',
					'session-123',
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(result.importedDocs).toEqual(['phase-2']);
				expect(logger.warn).toHaveBeenCalledWith(
					'Failed to import document phase-1',
					'[Marketplace]',
					expect.objectContaining({ error: expect.any(Error) })
				);
			});

			it('should use fallback message when remote document write fails without an error', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				mockMkdirRemote.mockResolvedValue({ success: true });
				mockWriteFileRemote
					.mockResolvedValueOnce({ success: false })
					.mockResolvedValueOnce({ success: true });
				mockFetch
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Phase 1 Content'),
					})
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Phase 2 Content'),
					});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-1',
					'Remote Document Fallback',
					'/remote/autorun',
					'session-123',
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(result.importedDocs).toEqual(['phase-2']);
				expect(logger.warn).toHaveBeenCalledWith(
					'Failed to import document phase-1',
					'[Marketplace]',
					expect.objectContaining({
						error: expect.objectContaining({ message: 'Failed to write remote file' }),
					})
				);
			});

			it('should use local fs when no sshRemoteId provided', async () => {
				// Reset mocks from previous tests
				mockMkdirRemote.mockReset();
				mockWriteFileRemote.mockReset();
				vi.mocked(fs.readFile).mockReset();
				vi.mocked(fs.mkdir).mockReset();
				vi.mocked(fs.writeFile).mockReset();
				mockFetch.mockReset();

				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);

				mockFetch.mockResolvedValue({
					ok: true,
					text: () => Promise.resolve('# Content'),
				});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-2',
					'Test',
					'/autorun',
					'session-123'
					// No sshRemoteId
				);

				// Should succeed and use local fs, not remote
				expect(result.success).toBe(true);
				expect(mockMkdirRemote).not.toHaveBeenCalled();
				expect(mockWriteFileRemote).not.toHaveBeenCalled();
				expect(fs.mkdir).toHaveBeenCalled();
			});
		});

		describe('asset import', () => {
			it('should import assets to assets/ subfolder', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' }); // No existing playbooks
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);

				// Mock document fetch
				mockFetch
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Main Doc Content'),
					})
					// Mock asset fetches - return arrayBuffer for binary content
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from('yaml: content').buffer),
					})
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47]).buffer), // PNG header
					});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-with-assets',
					'With Assets',
					'/autorun/folder',
					'session-123'
				);

				// Verify assets directory was created
				expect(fs.mkdir).toHaveBeenCalledWith(
					path.join('/autorun/folder', 'With Assets', 'assets'),
					{
						recursive: true,
					}
				);

				// Verify assets were written
				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join('/autorun/folder', 'With Assets', 'assets', 'config.yaml'),
					expect.any(Buffer)
				);
				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join('/autorun/folder', 'With Assets', 'assets', 'logo.png'),
					expect.any(Buffer)
				);

				// Verify response includes imported assets
				expect(result.importedAssets).toEqual(['config.yaml', 'logo.png']);
			});

			it('should continue importing when individual asset fetch fails', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);

				// Mock document fetch
				mockFetch
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Main Doc'),
					})
					// First asset fails (404)
					.mockResolvedValueOnce({
						ok: false,
						status: 404,
						statusText: 'Not Found',
					})
					// Second asset succeeds
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47]).buffer),
					});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-with-assets',
					'Partial Assets',
					'/autorun',
					'session-123'
				);

				// Should still succeed with partial assets
				expect(result.success).toBe(true);
				expect(result.importedAssets).toEqual(['logo.png']);
			});

			it('should continue when remote asset fetch returns a non-404 error', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				mockFetch
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Main Doc'),
					})
					.mockResolvedValueOnce({
						ok: false,
						status: 500,
						statusText: 'Internal Server Error',
					})
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from('png').buffer),
					});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-with-assets',
					'Asset HTTP Error',
					'/autorun',
					'session-123'
				);

				expect(result.success).toBe(true);
				expect(result.importedAssets).toEqual(['logo.png']);
				expect(logger.warn).toHaveBeenCalledWith(
					'Failed to import asset config.yaml',
					'[Marketplace]',
					expect.objectContaining({ error: expect.any(Error) })
				);
			});

			it('should continue when remote asset fetch has a network error', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				mockFetch
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Main Doc'),
					})
					.mockRejectedValueOnce(new Error('asset network down'))
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from('png').buffer),
					});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-with-assets',
					'Asset Network Error',
					'/autorun',
					'session-123'
				);

				expect(result.success).toBe(true);
				expect(result.importedAssets).toEqual(['logo.png']);
				expect(logger.warn).toHaveBeenCalledWith(
					'Failed to import asset config.yaml',
					'[Marketplace]',
					expect.objectContaining({ error: expect.any(Error) })
				);
			});

			it('should stringify non-Error remote asset fetch failures', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				mockFetch
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Main Doc'),
					})
					.mockRejectedValueOnce('asset offline')
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from('png').buffer),
					});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-with-assets',
					'Asset String Error',
					'/autorun',
					'session-123'
				);

				expect(result.success).toBe(true);
				expect(result.importedAssets).toEqual(['logo.png']);
				expect(logger.warn).toHaveBeenCalledWith(
					'Failed to import asset config.yaml',
					'[Marketplace]',
					expect.objectContaining({
						error: expect.objectContaining({
							message: 'Network error fetching asset: asset offline',
						}),
					})
				);
			});

			it('should import assets via SSH for remote sessions', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				mockMkdirRemote.mockResolvedValue({ success: true });
				mockWriteFileRemote.mockResolvedValue({ success: true });

				// Mock document fetch
				mockFetch
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Main Doc'),
					})
					// Asset fetches
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from('yaml: content').buffer),
					})
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47]).buffer),
					});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-with-assets',
					'Remote Assets',
					'/remote/autorun',
					'session-123',
					'ssh-remote-1'
				);

				// Verify remote assets directory was created
				expect(mockMkdirRemote).toHaveBeenCalledWith(
					'/remote/autorun/Remote Assets/assets',
					sampleSshRemote,
					true
				);

				// Verify assets were written via remote-fs with Buffer content
				expect(mockWriteFileRemote).toHaveBeenCalledWith(
					'/remote/autorun/Remote Assets/assets/config.yaml',
					expect.any(Buffer),
					sampleSshRemote
				);
				expect(mockWriteFileRemote).toHaveBeenCalledWith(
					'/remote/autorun/Remote Assets/assets/logo.png',
					expect.any(Buffer),
					sampleSshRemote
				);

				expect(result.importedAssets).toEqual(['config.yaml', 'logo.png']);
			});

			it('should continue remote asset imports when remote assets directory creation fails', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				mockMkdirRemote
					.mockResolvedValueOnce({ success: true })
					.mockResolvedValueOnce({ success: false, error: 'mkdir assets failed' });
				mockWriteFileRemote.mockResolvedValue({ success: true });
				mockFetch
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Main Doc'),
					})
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from('yaml: content').buffer),
					})
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from('png').buffer),
					});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-with-assets',
					'Remote Assets Mkdir Failure',
					'/remote/autorun',
					'session-123',
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(result.importedAssets).toEqual(['config.yaml', 'logo.png']);
				expect(logger.warn).toHaveBeenCalledWith(
					'Failed to create remote assets directory: mkdir assets failed',
					'[Marketplace]'
				);
			});

			it('should continue importing remaining remote assets when one remote asset write fails', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				mockMkdirRemote.mockResolvedValue({ success: true });
				mockWriteFileRemote
					.mockResolvedValueOnce({ success: true })
					.mockResolvedValueOnce({ success: false, error: 'asset disk full' })
					.mockResolvedValueOnce({ success: true });
				mockFetch
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Main Doc'),
					})
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from('yaml: content').buffer),
					})
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from('png').buffer),
					});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-with-assets',
					'Remote Asset Partial',
					'/remote/autorun',
					'session-123',
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(result.importedAssets).toEqual(['logo.png']);
				expect(logger.warn).toHaveBeenCalledWith(
					'Failed to import asset config.yaml',
					'[Marketplace]',
					expect.objectContaining({ error: expect.any(Error) })
				);
			});

			it('should use fallback message when remote asset write fails without an error', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				mockMkdirRemote.mockResolvedValue({ success: true });
				mockWriteFileRemote
					.mockResolvedValueOnce({ success: true })
					.mockResolvedValueOnce({ success: false })
					.mockResolvedValueOnce({ success: true });
				mockFetch
					.mockResolvedValueOnce({
						ok: true,
						text: () => Promise.resolve('# Main Doc'),
					})
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from('yaml: content').buffer),
					})
					.mockResolvedValueOnce({
						ok: true,
						arrayBuffer: () => Promise.resolve(Buffer.from('png').buffer),
					});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-with-assets',
					'Remote Asset Fallback',
					'/remote/autorun',
					'session-123',
					'ssh-remote-1'
				);

				expect(result.success).toBe(true);
				expect(result.importedAssets).toEqual(['logo.png']);
				expect(logger.warn).toHaveBeenCalledWith(
					'Failed to import asset config.yaml',
					'[Marketplace]',
					expect.objectContaining({
						error: expect.objectContaining({ message: 'Failed to write remote asset file' }),
					})
				);
			});

			it('should not create assets folder when playbook has no assets', async () => {
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);

				mockFetch.mockResolvedValue({
					ok: true,
					text: () => Promise.resolve('# Content'),
				});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'test-playbook-2', // This playbook has no assets
					'No Assets',
					'/autorun',
					'session-123'
				);

				// Should not create assets folder
				const mkdirCalls = vi.mocked(fs.mkdir).mock.calls;
				const assetsFolderCreated = mkdirCalls.some((call) =>
					(call[0] as string).includes('/assets')
				);
				expect(assetsFolderCreated).toBe(false);

				// importedAssets should be empty or undefined
				expect(result.importedAssets || []).toEqual([]);
			});

			it('should auto-discover local assets from assets/ directory when manifest assets are absent', async () => {
				const localPlaybookNoManifestAssets = {
					id: 'local-assets-no-manifest',
					title: 'Local Assets Without Manifest',
					description: 'Assets should be discovered from disk',
					category: 'Custom',
					author: 'Local Author',
					lastUpdated: '2024-01-20',
					path: '/Users/test/local-playbooks/no-manifest-assets',
					documents: [{ filename: 'main-doc', resetOnCompletion: false }],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
				};

				const localManifest: MarketplaceManifest = {
					lastUpdated: '2024-01-20',
					playbooks: [localPlaybookNoManifestAssets],
				};

				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockResolvedValueOnce(JSON.stringify(localManifest))
					.mockResolvedValueOnce('# Main local doc')
					.mockResolvedValueOnce(Buffer.from('asset-one'))
					.mockResolvedValueOnce(Buffer.from('asset-two'))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				vi.mocked(fs.readdir).mockResolvedValue(['settings.yaml', 'logo.png']);
				vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'local-assets-no-manifest',
					'Imported Local Assets',
					'/autorun/folder',
					'session-123'
				);

				expect(result.success).toBe(true);
				expect(fs.readdir).toHaveBeenCalledWith(
					path.normalize('/Users/test/local-playbooks/no-manifest-assets/assets')
				);
				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join('/autorun/folder', 'Imported Local Assets', 'assets', 'settings.yaml'),
					expect.any(Buffer)
				);
				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join('/autorun/folder', 'Imported Local Assets', 'assets', 'logo.png'),
					expect.any(Buffer)
				);
				expect(result.importedAssets).toEqual(['settings.yaml', 'logo.png']);
				expect(mockFetch).not.toHaveBeenCalled();
			});

			it('should ignore discovered local asset candidates that are directories', async () => {
				const localPlaybookNoManifestAssets = {
					id: 'local-assets-directory-candidate',
					title: 'Local Assets Directory Candidate',
					description: 'Directories should not be imported as assets',
					category: 'Custom',
					author: 'Local Author',
					lastUpdated: '2024-01-20',
					path: '/Users/test/local-playbooks/directory-candidate',
					documents: [{ filename: 'main-doc', resetOnCompletion: false }],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
				};
				const localManifest: MarketplaceManifest = {
					lastUpdated: '2024-01-20',
					playbooks: [localPlaybookNoManifestAssets],
				};
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockResolvedValueOnce(JSON.stringify(localManifest))
					.mockResolvedValueOnce('# Main local doc')
					.mockResolvedValueOnce(Buffer.from('asset-one'))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				vi.mocked(fs.readdir).mockResolvedValue(['nested-folder', 'settings.yaml']);
				vi.mocked(fs.stat).mockImplementation(async (assetPath) => {
					if (String(assetPath).endsWith('nested-folder')) {
						return { isFile: () => false } as any;
					}
					return { isFile: () => true } as any;
				});

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'local-assets-directory-candidate',
					'Imported Directory Candidate',
					'/autorun/folder',
					'session-123'
				);

				expect(result.success).toBe(true);
				expect(result.importedAssets).toEqual(['settings.yaml']);
				expect(fs.writeFile).not.toHaveBeenCalledWith(
					path.join('/autorun/folder', 'Imported Directory Candidate', 'assets', 'nested-folder'),
					expect.any(Buffer)
				);
			});

			it('should stringify non-Error local asset read failures', async () => {
				const localPlaybookWithBrokenAsset = {
					id: 'local-assets-string-error',
					title: 'Local Asset String Error',
					description: 'String asset read failures should be reported',
					category: 'Custom',
					author: 'Local Author',
					lastUpdated: '2024-01-20',
					path: '/Users/test/local-playbooks/string-error',
					documents: [{ filename: 'main-doc', resetOnCompletion: false }],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					assets: ['broken.bin'],
				};
				const localManifest: MarketplaceManifest = {
					lastUpdated: '2024-01-20',
					playbooks: [localPlaybookWithBrokenAsset],
				};
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockResolvedValueOnce(JSON.stringify(localManifest))
					.mockResolvedValueOnce('# Main local doc')
					.mockRejectedValueOnce('asset disk offline')
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'local-assets-string-error',
					'Imported String Error',
					'/autorun/folder',
					'session-123'
				);

				expect(result.success).toBe(true);
				expect(result.importedAssets).toEqual([]);
				expect(logger.warn).toHaveBeenCalledWith(
					'Failed to import asset broken.bin',
					'[Marketplace]',
					expect.objectContaining({
						error: expect.objectContaining({
							message: 'Failed to read local asset: asset disk offline',
						}),
					})
				);
			});

			it('should merge local discovered assets with manifest assets without duplicates', async () => {
				const localPlaybookWithManifestAssets = {
					id: 'local-assets-with-manifest',
					title: 'Local Assets With Manifest',
					description: 'Manifest and discovered assets should be merged',
					category: 'Custom',
					author: 'Local Author',
					lastUpdated: '2024-01-20',
					path: '/Users/test/local-playbooks/with-manifest-assets',
					documents: [{ filename: 'main-doc', resetOnCompletion: false }],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					assets: ['config.yaml', 'logo.png'],
				};

				const localManifest: MarketplaceManifest = {
					lastUpdated: '2024-01-20',
					playbooks: [localPlaybookWithManifestAssets],
				};

				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockResolvedValueOnce(JSON.stringify(localManifest))
					.mockResolvedValueOnce('# Main local doc')
					.mockResolvedValueOnce(Buffer.from('config'))
					.mockResolvedValueOnce(Buffer.from('logo'))
					.mockResolvedValueOnce(Buffer.from('dockerignore'))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				vi.mocked(fs.readdir).mockResolvedValue(['logo.png', '.dockerignore']);
				vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'local-assets-with-manifest',
					'Merged Assets',
					'/autorun/folder',
					'session-123'
				);

				expect(result.success).toBe(true);
				expect(result.importedAssets).toEqual(['config.yaml', 'logo.png', '.dockerignore']);
				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join('/autorun/folder', 'Merged Assets', 'assets', 'config.yaml'),
					expect.any(Buffer)
				);
				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join('/autorun/folder', 'Merged Assets', 'assets', 'logo.png'),
					expect.any(Buffer)
				);
				expect(fs.writeFile).toHaveBeenCalledWith(
					path.join('/autorun/folder', 'Merged Assets', 'assets', '.dockerignore'),
					expect.any(Buffer)
				);
				expect(mockFetch).not.toHaveBeenCalled();
			});

			it('should skip local asset candidates that cannot be statted', async () => {
				const localPlaybook = {
					id: 'local-assets-stat-error',
					title: 'Local Assets Stat Error',
					description: 'Bad asset candidates should not stop import',
					category: 'Custom',
					author: 'Local Author',
					lastUpdated: '2024-02-01',
					path: '/Users/test/local-playbooks/stat-error',
					documents: [{ filename: 'main-doc', resetOnCompletion: false }],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
				};
				const localManifest: MarketplaceManifest = {
					lastUpdated: '2024-02-01',
					playbooks: [localPlaybook],
				};
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockResolvedValueOnce(JSON.stringify(localManifest))
					.mockResolvedValueOnce('# Main local doc')
					.mockResolvedValueOnce(Buffer.from('good asset'))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				vi.mocked(fs.readdir).mockResolvedValue(['broken.yaml', 'good.yaml']);
				vi.mocked(fs.stat)
					.mockRejectedValueOnce(new Error('stat failed'))
					.mockResolvedValueOnce({ isFile: () => true } as any);

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'local-assets-stat-error',
					'Stat Error Assets',
					'/autorun/folder',
					'session-123'
				);

				expect(result.success).toBe(true);
				expect(result.importedAssets).toEqual(['good.yaml']);
				expect(logger.warn).toHaveBeenCalledWith(
					expect.stringContaining('Failed to stat local asset candidate:'),
					'[Marketplace]',
					expect.objectContaining({ error: expect.any(Error) })
				);
			});

			it('should warn and continue when local asset discovery cannot read the assets directory', async () => {
				const localPlaybook = {
					id: 'local-assets-read-error',
					title: 'Local Assets Read Error',
					description: 'Asset discovery errors should be non-fatal',
					category: 'Custom',
					author: 'Local Author',
					lastUpdated: '2024-02-01',
					path: '/Users/test/local-playbooks/read-error',
					documents: [{ filename: 'main-doc', resetOnCompletion: false }],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
				};
				const localManifest: MarketplaceManifest = {
					lastUpdated: '2024-02-01',
					playbooks: [localPlaybook],
				};
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockResolvedValueOnce(JSON.stringify(localManifest))
					.mockResolvedValueOnce('# Main local doc')
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				vi.mocked(fs.readdir).mockRejectedValue({ code: 'EACCES' });

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'local-assets-read-error',
					'Read Error Assets',
					'/autorun/folder',
					'session-123'
				);

				expect(result.success).toBe(true);
				expect(result.importedAssets).toEqual([]);
				expect(logger.warn).toHaveBeenCalledWith(
					expect.stringContaining('Failed to read local assets directory:'),
					'[Marketplace]',
					expect.objectContaining({ error: expect.objectContaining({ code: 'EACCES' }) })
				);
			});

			it('should continue when local manifest assets are missing or unreadable', async () => {
				const localPlaybook = {
					id: 'local-assets-read-failures',
					title: 'Local Asset Read Failures',
					description: 'Bad manifest assets should be skipped',
					category: 'Custom',
					author: 'Local Author',
					lastUpdated: '2024-02-01',
					path: '/Users/test/local-playbooks/read-failures',
					documents: [{ filename: 'main-doc', resetOnCompletion: false }],
					loopEnabled: false,
					maxLoops: null,
					prompt: null,
					assets: ['missing.yaml', 'forbidden.png'],
				};
				const localManifest: MarketplaceManifest = {
					lastUpdated: '2024-02-01',
					playbooks: [localPlaybook],
				};
				const validCache: MarketplaceCache = {
					fetchedAt: Date.now(),
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile)
					.mockResolvedValueOnce(JSON.stringify(validCache))
					.mockResolvedValueOnce(JSON.stringify(localManifest))
					.mockResolvedValueOnce('# Main local doc')
					.mockRejectedValueOnce({ code: 'ENOENT' })
					.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
					.mockRejectedValueOnce({ code: 'ENOENT' });
				vi.mocked(fs.mkdir).mockResolvedValue(undefined);
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);
				vi.mocked(fs.readdir).mockRejectedValue({ code: 'ENOENT' });

				const handler = handlers.get('marketplace:importPlaybook');
				const result = await handler!(
					{} as any,
					'local-assets-read-failures',
					'Asset Read Failures',
					'/autorun/folder',
					'session-123'
				);

				expect(result.success).toBe(true);
				expect(result.importedAssets).toEqual([]);
				expect(logger.warn).toHaveBeenCalledWith(
					'Failed to import asset missing.yaml',
					'[Marketplace]',
					expect.objectContaining({ error: expect.any(Error) })
				);
				expect(logger.warn).toHaveBeenCalledWith(
					'Failed to import asset forbidden.png',
					'[Marketplace]',
					expect.objectContaining({ error: expect.any(Error) })
				);
			});
		});
	});

	describe('path traversal protection', () => {
		it('should resolve a normal local document filename correctly', async () => {
			// Setup a local playbook with a normal filename
			const localPlaybook = {
				id: 'local-safe-path',
				title: 'Safe Path Playbook',
				description: 'Test',
				category: 'Custom',
				author: 'Test',
				lastUpdated: '2024-01-20',
				path: '/Users/test/playbooks/safe',
				documents: [{ filename: 'phase-1', resetOnCompletion: false }],
				loopEnabled: false,
				maxLoops: null,
				prompt: null,
			};

			const localManifest: MarketplaceManifest = {
				lastUpdated: '2024-01-20',
				playbooks: [localPlaybook],
			};

			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache))
				.mockResolvedValueOnce(JSON.stringify(localManifest))
				.mockResolvedValueOnce('# Phase 1 Content') // The document read
				.mockRejectedValueOnce({ code: 'ENOENT' }); // No existing playbooks
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('marketplace:importPlaybook');
			const result = await handler!(
				{} as any,
				'local-safe-path',
				'Safe Import',
				'/autorun/folder',
				'session-123'
			);

			expect(result.success).toBe(true);
			expect(result.importedDocs).toEqual(['phase-1']);
			// Document should have been read from the correct path
			expect(fs.readFile).toHaveBeenCalledWith(
				path.resolve('/Users/test/playbooks/safe', 'phase-1.md'),
				'utf-8'
			);
		});

		it('should reject document filename containing ../', async () => {
			const handler = handlers.get('marketplace:getDocument');
			const result = await handler!({} as any, '/Users/test/playbooks/safe', '../../../etc/passwd');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid filename');
		});

		it('should reject document filename with absolute path', async () => {
			const handler = handlers.get('marketplace:getDocument');
			const result = await handler!({} as any, '/Users/test/playbooks/safe', '/etc/passwd');

			// path.resolve('/Users/test/playbooks/safe', '/etc/passwd.md') resolves to /etc/passwd.md
			// which is outside the base, so validateSafePath blocks it
			expect(result.success).toBe(false);
			expect(result.error).toContain('Path traversal blocked');
		});

		it('should reject asset filename containing ../../', async () => {
			// Create a local playbook with an asset that has traversal
			const localPlaybook = {
				id: 'local-traversal-asset',
				title: 'Traversal Asset Playbook',
				description: 'Test',
				category: 'Custom',
				author: 'Test',
				lastUpdated: '2024-01-20',
				path: '/Users/test/playbooks/safe',
				documents: [{ filename: 'doc', resetOnCompletion: false }],
				loopEnabled: false,
				maxLoops: null,
				prompt: null,
				assets: ['../../etc/shadow'],
			};

			const localManifest: MarketplaceManifest = {
				lastUpdated: '2024-01-20',
				playbooks: [localPlaybook],
			};

			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache))
				.mockResolvedValueOnce(JSON.stringify(localManifest))
				.mockResolvedValueOnce('# Doc content') // Document read
				.mockRejectedValueOnce({ code: 'ENOENT' }); // No existing playbooks
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('marketplace:importPlaybook');
			const result = await handler!(
				{} as any,
				'local-traversal-asset',
				'Traversal Test',
				'/autorun/folder',
				'session-123'
			);

			// The import should succeed overall but skip the bad asset
			// because the asset fetch throws and the loop continues
			expect(result.success).toBe(true);
			expect(result.importedAssets).toEqual([]);
		});

		it('should reject document filename with embedded .. segments', async () => {
			const handler = handlers.get('marketplace:getDocument');
			const result = await handler!({} as any, '/Users/test/playbooks/safe', 'subdir/../../secret');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid filename');
		});
	});

	describe('cache TTL validation', () => {
		it('should correctly identify cache as valid within TTL', async () => {
			const testCases = [
				{ age: 0, expected: true, desc: 'just created' },
				{ age: 1000 * 60 * 60 * 3, expected: true, desc: '3 hours old' },
				{ age: 1000 * 60 * 60 * 5.9, expected: true, desc: '5.9 hours old' },
				{ age: 1000 * 60 * 60 * 6, expected: false, desc: 'exactly 6 hours old' },
				{ age: 1000 * 60 * 60 * 7, expected: false, desc: '7 hours old' },
				{ age: 1000 * 60 * 60 * 24, expected: false, desc: '24 hours old' },
			];

			for (const testCase of testCases) {
				// Reset only the mocks we use in this test
				vi.mocked(fs.readFile).mockReset();
				vi.mocked(fs.writeFile).mockReset();
				mockFetch.mockReset();

				const cache: MarketplaceCache = {
					fetchedAt: Date.now() - testCase.age,
					manifest: sampleManifest,
				};

				vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(cache));
				vi.mocked(fs.writeFile).mockResolvedValue(undefined);

				mockFetch.mockResolvedValue({
					ok: true,
					json: () => Promise.resolve(sampleManifest),
				});

				const handler = handlers.get('marketplace:getManifest');
				const result = await handler!({} as any);

				if (testCase.expected) {
					expect(result.fromCache).toBe(true);
					expect(mockFetch).not.toHaveBeenCalled();
				} else {
					expect(result.fromCache).toBe(false);
					expect(mockFetch).toHaveBeenCalled();
				}
			}
		});
	});

	describe('merged manifest lookup', () => {
		it('should find playbook ID that exists only in local manifest', async () => {
			// Create a playbook that only exists in the local manifest
			const localOnlyPlaybook = {
				id: 'local-only-playbook',
				title: 'Local Only Playbook',
				description: 'This playbook only exists locally',
				category: 'Custom',
				author: 'Local Author',
				lastUpdated: '2024-01-20',
				path: 'custom/local-only-playbook',
				documents: [{ filename: 'doc1', resetOnCompletion: false }],
				loopEnabled: false,
				maxLoops: null,
				prompt: 'Local only prompt',
			};

			const localManifest: MarketplaceManifest = {
				lastUpdated: '2024-01-20',
				playbooks: [localOnlyPlaybook],
			};

			// Official manifest does NOT contain local-only-playbook
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest, // Only has test-playbook-1, test-playbook-2, test-playbook-with-assets
			};

			// Mock file reads:
			// 1. Cache (official manifest)
			// 2. Local manifest (with local-only-playbook)
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache))
				.mockResolvedValueOnce(JSON.stringify(localManifest));

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			// Verify the merged manifest contains the local-only playbook
			const foundPlaybook = result.manifest.playbooks.find(
				(p: any) => p.id === 'local-only-playbook'
			);
			expect(foundPlaybook).toBeDefined();
			expect(foundPlaybook.title).toBe('Local Only Playbook');
			expect(foundPlaybook.source).toBe('local');

			// Verify it also contains the official playbooks
			const officialPlaybook = result.manifest.playbooks.find(
				(p: any) => p.id === 'test-playbook-1'
			);
			expect(officialPlaybook).toBeDefined();
			expect(officialPlaybook.source).toBe('official');
		});

		it('should prefer local version when playbook ID exists in both manifests', async () => {
			// Create a local playbook that has the SAME ID as an official one
			const localOverridePlaybook = {
				id: 'test-playbook-1', // SAME ID as official playbook
				title: 'Local Override Version',
				description: 'This local version overrides the official one',
				category: 'Custom',
				author: 'Local Author',
				lastUpdated: '2024-01-25',
				path: '/Users/local/custom-playbooks/test-playbook-1', // Local filesystem path
				documents: [
					{ filename: 'custom-phase-1', resetOnCompletion: false },
					{ filename: 'custom-phase-2', resetOnCompletion: false },
				],
				loopEnabled: true,
				maxLoops: 5,
				prompt: 'Local override custom prompt',
			};

			const localManifest: MarketplaceManifest = {
				lastUpdated: '2024-01-25',
				playbooks: [localOverridePlaybook],
			};

			// Official manifest has test-playbook-1 with different properties
			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest, // Contains test-playbook-1 with title "Test Playbook"
			};

			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache))
				.mockResolvedValueOnce(JSON.stringify(localManifest));

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			// Find the playbook with ID 'test-playbook-1'
			const mergedPlaybook = result.manifest.playbooks.find((p: any) => p.id === 'test-playbook-1');

			// Verify the LOCAL version took precedence
			expect(mergedPlaybook).toBeDefined();
			expect(mergedPlaybook.title).toBe('Local Override Version'); // NOT "Test Playbook"
			expect(mergedPlaybook.source).toBe('local'); // Tagged as local
			expect(mergedPlaybook.author).toBe('Local Author');
			expect(mergedPlaybook.documents).toEqual([
				{ filename: 'custom-phase-1', resetOnCompletion: false },
				{ filename: 'custom-phase-2', resetOnCompletion: false },
			]);
			expect(mergedPlaybook.loopEnabled).toBe(true);
			expect(mergedPlaybook.maxLoops).toBe(5);
			expect(mergedPlaybook.prompt).toBe('Local override custom prompt');

			// Verify there's only ONE playbook with ID 'test-playbook-1' (no duplicates)
			const matchingPlaybooks = result.manifest.playbooks.filter(
				(p: any) => p.id === 'test-playbook-1'
			);
			expect(matchingPlaybooks.length).toBe(1);

			// Verify other official playbooks are still present
			const otherOfficialPlaybook = result.manifest.playbooks.find(
				(p: any) => p.id === 'test-playbook-2'
			);
			expect(otherOfficialPlaybook).toBeDefined();
			expect(otherOfficialPlaybook.source).toBe('official');
		});

		it('should tag playbooks with correct source (official vs local)', async () => {
			const localPlaybook = {
				id: 'brand-new-local',
				title: 'Brand New Local Playbook',
				description: 'A completely new local playbook',
				category: 'Custom',
				author: 'Local Author',
				lastUpdated: '2024-01-20',
				path: '/local/playbooks/brand-new',
				documents: [{ filename: 'doc', resetOnCompletion: false }],
				loopEnabled: false,
				maxLoops: null,
				prompt: null,
			};

			const localManifest: MarketplaceManifest = {
				lastUpdated: '2024-01-20',
				playbooks: [localPlaybook],
			};

			const validCache: MarketplaceCache = {
				fetchedAt: Date.now(),
				manifest: sampleManifest,
			};

			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(validCache))
				.mockResolvedValueOnce(JSON.stringify(localManifest));

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			// Verify all playbooks have the correct source tag
			for (const playbook of result.manifest.playbooks) {
				if (playbook.id === 'brand-new-local') {
					expect(playbook.source).toBe('local');
				} else {
					// All sample manifest playbooks should be tagged as official
					expect(playbook.source).toBe('official');
				}
			}
		});
	});
});
