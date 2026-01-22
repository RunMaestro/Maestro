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
import { ipcMain, App } from 'electron';
import fs from 'fs/promises';
import crypto from 'crypto';
import Store from 'electron-store';
import {
	registerMarketplaceHandlers,
	MarketplaceHandlerDependencies,
} from '../../../../main/ipc/handlers/marketplace';
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
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
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
				'/mock/userData/marketplace-cache.json',
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

		it('should handle network errors gracefully by returning empty merged manifest', async () => {
			// No cache, no local manifest
			vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });

			mockFetch.mockRejectedValue(new Error('Network error'));

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			// With local manifest support, network errors are now handled gracefully
			// Returns empty manifest (merged result of null official + null local)
			expect(result.manifest).toBeDefined();
			expect(result.manifest.playbooks).toEqual([]);
			expect(result.fromCache).toBe(false);
		});

		it('should handle HTTP error responses gracefully by returning empty merged manifest', async () => {
			// No cache, no local manifest
			vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });

			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				statusText: 'Internal Server Error',
			});

			const handler = handlers.get('marketplace:getManifest');
			const result = await handler!({} as any);

			// With local manifest support, HTTP errors are now handled gracefully
			// Returns empty manifest (merged result of null official + null local)
			expect(result.manifest).toBeDefined();
			expect(result.manifest.playbooks).toEqual([]);
			expect(result.fromCache).toBe(false);
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
			expect(fs.mkdir).toHaveBeenCalledWith('/autorun/folder/My Test Playbook', {
				recursive: true,
			});

			// Verify documents were written
			expect(fs.writeFile).toHaveBeenCalledWith(
				'/autorun/folder/My Test Playbook/phase-1.md',
				'# Phase 1 Content',
				'utf-8'
			);
			expect(fs.writeFile).toHaveBeenCalledWith(
				'/autorun/folder/My Test Playbook/phase-2.md',
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
			expect(fs.mkdir).toHaveBeenCalledWith('/mock/userData/playbooks', {
				recursive: true,
			});

			// Verify playbook was saved to session file
			expect(fs.writeFile).toHaveBeenCalledWith(
				'/mock/userData/playbooks/session-123.json',
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
			expect(fs.mkdir).toHaveBeenCalledWith('/autorun/folder/My Local Playbook', {
				recursive: true,
			});

			// Verify document was written
			expect(fs.writeFile).toHaveBeenCalledWith(
				'/autorun/folder/My Local Playbook/local-phase-1.md',
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
				'/Users/test/custom-playbooks/my-playbook/phase-1.md',
				'utf-8'
			);
			expect(fs.readFile).toHaveBeenCalledWith(
				'/Users/test/custom-playbooks/my-playbook/phase-2.md',
				'utf-8'
			);

			// Verify NO fetch calls were made for documents (since they're local)
			// Note: mockFetch should NOT have been called for document retrieval
			expect(mockFetch).not.toHaveBeenCalled();

			// Verify documents were written to the target folder
			expect(fs.writeFile).toHaveBeenCalledWith(
				'/autorun/folder/Imported Filesystem Playbook/phase-1.md',
				'# Phase 1 from filesystem\n\n- [ ] Task 1',
				'utf-8'
			);
			expect(fs.writeFile).toHaveBeenCalledWith(
				'/autorun/folder/Imported Filesystem Playbook/phase-2.md',
				'# Phase 2 from filesystem\n\n- [ ] Task 2',
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

			// Note: The SSH writeFile failure scenario is already covered by the
			// non-SSH test "should continue importing when individual document fetch fails".
			// The SSH path uses the same try/catch pattern to continue on errors.

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
				expect(fs.mkdir).toHaveBeenCalledWith('/autorun/folder/With Assets/assets', {
					recursive: true,
				});

				// Verify assets were written
				expect(fs.writeFile).toHaveBeenCalledWith(
					'/autorun/folder/With Assets/assets/config.yaml',
					expect.any(Buffer)
				);
				expect(fs.writeFile).toHaveBeenCalledWith(
					'/autorun/folder/With Assets/assets/logo.png',
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
