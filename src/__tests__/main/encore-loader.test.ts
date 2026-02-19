/**
 * Tests for Plugin Manifest Validation and Discovery
 *
 * Covers:
 * - validateEncoreManifest() type guard
 * - discoverEncores() directory scanning
 * - loadEncore() manifest reading
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock electron
vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
	app: { getPath: vi.fn(() => '/mock/userData') },
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
const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockMkdir = vi.fn();

vi.mock('fs/promises', () => ({
	default: {
		readFile: (...args: unknown[]) => mockReadFile(...args),
		readdir: (...args: unknown[]) => mockReaddir(...args),
		stat: (...args: unknown[]) => mockStat(...args),
		mkdir: (...args: unknown[]) => mockMkdir(...args),
	},
	readFile: (...args: unknown[]) => mockReadFile(...args),
	readdir: (...args: unknown[]) => mockReaddir(...args),
	stat: (...args: unknown[]) => mockStat(...args),
	mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

import { validateEncoreManifest, discoverEncores, loadEncore } from '../../main/encore-loader';

/**
 * Helper to create a valid manifest object for testing.
 */
function validManifest(overrides: Record<string, unknown> = {}) {
	return {
		id: 'test-encore',
		name: 'Test Plugin',
		version: '1.0.0',
		description: 'A test encore',
		author: 'Test Author',
		main: 'index.js',
		permissions: ['stats:read'],
		...overrides,
	};
}

describe('validateEncoreManifest', () => {
	it('accepts a valid manifest', () => {
		expect(validateEncoreManifest(validManifest())).toBe(true);
	});

	it('accepts a valid manifest with all optional fields', () => {
		const manifest = validManifest({
			authorLink: 'https://example.com',
			minMaestroVersion: '1.0.0',
			renderer: 'renderer.js',
			ui: { rightPanelTabs: [{ id: 'tab1', label: 'Tab 1' }], settingsSection: true },
			settings: [{ key: 'enabled', type: 'boolean', label: 'Enabled', default: true }],
			tags: ['dashboard', 'monitoring'],
		});
		expect(validateEncoreManifest(manifest)).toBe(true);
	});

	it('rejects null', () => {
		expect(validateEncoreManifest(null)).toBe(false);
	});

	it('rejects non-object', () => {
		expect(validateEncoreManifest('string')).toBe(false);
	});

	it('rejects manifest missing required field: id', () => {
		const { id, ...rest } = validManifest();
		expect(validateEncoreManifest(rest)).toBe(false);
	});

	it('rejects manifest missing required field: name', () => {
		const { name, ...rest } = validManifest();
		expect(validateEncoreManifest(rest)).toBe(false);
	});

	it('rejects manifest missing required field: version', () => {
		const { version, ...rest } = validManifest();
		expect(validateEncoreManifest(rest)).toBe(false);
	});

	it('rejects manifest missing required field: description', () => {
		const { description, ...rest } = validManifest();
		expect(validateEncoreManifest(rest)).toBe(false);
	});

	it('rejects manifest missing required field: author', () => {
		const { author, ...rest } = validManifest();
		expect(validateEncoreManifest(rest)).toBe(false);
	});

	it('rejects manifest missing required field: main', () => {
		const { main, ...rest } = validManifest();
		expect(validateEncoreManifest(rest)).toBe(false);
	});

	it('rejects manifest with empty string for required field', () => {
		expect(validateEncoreManifest(validManifest({ id: '' }))).toBe(false);
		expect(validateEncoreManifest(validManifest({ name: '  ' }))).toBe(false);
	});

	it('rejects manifest with invalid slug format (uppercase)', () => {
		expect(validateEncoreManifest(validManifest({ id: 'TestPlugin' }))).toBe(false);
	});

	it('rejects manifest with invalid slug format (spaces)', () => {
		expect(validateEncoreManifest(validManifest({ id: 'test encore' }))).toBe(false);
	});

	it('rejects manifest with invalid slug format (underscores)', () => {
		expect(validateEncoreManifest(validManifest({ id: 'test_plugin' }))).toBe(false);
	});

	it('rejects manifest with invalid slug format (leading hyphen)', () => {
		expect(validateEncoreManifest(validManifest({ id: '-test' }))).toBe(false);
	});

	it('accepts valid slug formats', () => {
		expect(validateEncoreManifest(validManifest({ id: 'my-encore' }))).toBe(true);
		expect(validateEncoreManifest(validManifest({ id: 'encore123' }))).toBe(true);
		expect(validateEncoreManifest(validManifest({ id: 'a' }))).toBe(true);
	});

	it('rejects manifest with missing permissions array', () => {
		const { permissions, ...rest } = validManifest();
		expect(validateEncoreManifest(rest)).toBe(false);
	});

	it('rejects manifest with permissions as non-array', () => {
		expect(validateEncoreManifest(validManifest({ permissions: 'stats:read' }))).toBe(false);
	});

	it('rejects unknown permissions', () => {
		expect(validateEncoreManifest(validManifest({ permissions: ['unknown:perm'] }))).toBe(false);
	});

	it('accepts empty permissions array', () => {
		expect(validateEncoreManifest(validManifest({ permissions: [] }))).toBe(true);
	});

	it('accepts all known permissions', () => {
		const allPerms = [
			'process:read', 'process:write', 'stats:read',
			'settings:read', 'settings:write', 'notifications',
			'network', 'storage', 'middleware',
		];
		expect(validateEncoreManifest(validManifest({ permissions: allPerms }))).toBe(true);
	});

	it('does not fail on extra unknown fields (forward compatibility)', () => {
		const manifest = validManifest({ futureField: 'some value', anotherField: 42 });
		expect(validateEncoreManifest(manifest)).toBe(true);
	});
});

describe('loadEncore', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('loads a valid encore as discovered', async () => {
		const manifest = validManifest();
		mockReadFile.mockResolvedValue(JSON.stringify(manifest));

		const result = await loadEncore('/encores/test-encore');

		expect(result.state).toBe('discovered');
		expect(result.manifest.id).toBe('test-encore');
		expect(result.path).toBe('/encores/test-encore');
		expect(result.error).toBeUndefined();
	});

	it('returns error state when manifest.json is missing', async () => {
		mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

		const result = await loadEncore('/encores/broken');

		expect(result.state).toBe('error');
		expect(result.error).toContain('Failed to read manifest.json');
	});

	it('returns error state for invalid JSON', async () => {
		mockReadFile.mockResolvedValue('not valid json {{{');

		const result = await loadEncore('/encores/bad-json');

		expect(result.state).toBe('error');
		expect(result.error).toContain('Invalid JSON');
	});

	it('returns error state for manifest that fails validation', async () => {
		mockReadFile.mockResolvedValue(JSON.stringify({ id: 'BAD ID' }));

		const result = await loadEncore('/encores/bad-manifest');

		expect(result.state).toBe('error');
		expect(result.error).toContain('validation failed');
	});
});

describe('discoverEncores', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockMkdir.mockResolvedValue(undefined);
	});

	it('returns empty array for empty directory', async () => {
		mockReaddir.mockResolvedValue([]);

		const result = await discoverEncores('/encores');

		expect(result).toEqual([]);
	});

	it('discovers valid encores from subdirectories', async () => {
		mockReaddir.mockResolvedValue(['encore-a', 'encore-b']);
		mockStat.mockResolvedValue({ isDirectory: () => true });
		mockReadFile.mockImplementation((filePath: string) => {
			if (filePath.includes('encore-a')) {
				return Promise.resolve(JSON.stringify(validManifest({ id: 'encore-a' })));
			}
			return Promise.resolve(JSON.stringify(validManifest({ id: 'encore-b' })));
		});

		const result = await discoverEncores('/encores');

		expect(result).toHaveLength(2);
		expect(result[0].state).toBe('discovered');
		expect(result[1].state).toBe('discovered');
	});

	it('returns error state for encores with invalid manifests', async () => {
		mockReaddir.mockResolvedValue(['good-encore', 'bad-encore']);
		mockStat.mockResolvedValue({ isDirectory: () => true });
		mockReadFile.mockImplementation((filePath: string) => {
			if (filePath.includes('good-encore')) {
				return Promise.resolve(JSON.stringify(validManifest({ id: 'good-encore' })));
			}
			return Promise.resolve('not json');
		});

		const result = await discoverEncores('/encores');

		expect(result).toHaveLength(2);
		const good = result.find((p) => p.manifest.id === 'good-encore');
		const bad = result.find((p) => p.manifest.id !== 'good-encore');
		expect(good?.state).toBe('discovered');
		expect(bad?.state).toBe('error');
	});

	it('skips non-directory entries', async () => {
		mockReaddir.mockResolvedValue(['file.txt', 'encore-dir']);
		mockStat.mockImplementation((entryPath: string) => {
			if (entryPath.includes('file.txt')) {
				return Promise.resolve({ isDirectory: () => false });
			}
			return Promise.resolve({ isDirectory: () => true });
		});
		mockReadFile.mockResolvedValue(JSON.stringify(validManifest({ id: 'encore-dir' })));

		const result = await discoverEncores('/encores');

		expect(result).toHaveLength(1);
		expect(result[0].manifest.id).toBe('encore-dir');
	});

	it('creates the encores directory if it does not exist', async () => {
		mockReaddir.mockResolvedValue([]);

		await discoverEncores('/encores');

		expect(mockMkdir).toHaveBeenCalledWith('/encores', { recursive: true });
	});
});
