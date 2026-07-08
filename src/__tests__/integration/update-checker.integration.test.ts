/**
 * @file update-checker.test.ts
 * @description Tests for the update checker module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;
const originalPlatform = process.platform;

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
}));

vi.mock('../../main/utils/logger', () => ({
	logger: mockLogger,
}));

// Import after mocking
import { checkForUpdates } from '../../main/update-checker';

const createMockAsset = (name: string) => ({
	name,
	browser_download_url: `https://example.com/${name}`,
	size: 1024,
	content_type: 'application/octet-stream',
});

// Helper to create mock release
const createMockRelease = (
	overrides: Partial<{
		tag_name: string;
		name: string;
		body: string;
		html_url: string;
		published_at: string;
		prerelease: boolean;
		draft: boolean;
		assets: ReturnType<typeof createMockAsset>[];
	}> = {}
) => ({
	tag_name: 'v1.0.0',
	name: 'Version 1.0.0',
	body: 'Release notes',
	html_url: 'https://github.com/RunMaestro/Maestro/releases/tag/v1.0.0',
	published_at: '2024-01-15T12:00:00Z',
	prerelease: false,
	draft: false,
	assets: [],
	...overrides,
});

describe('update-checker', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			configurable: true,
		});
		vi.restoreAllMocks();
	});

	function mockPlatform(platform: NodeJS.Platform): void {
		Object.defineProperty(process, 'platform', {
			value: platform,
			configurable: true,
		});
	}

	describe('checkForUpdates', () => {
		it('returns update available when newer version exists', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.1.0' }),
						createMockRelease({ tag_name: 'v1.0.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.updateAvailable).toBe(true);
			expect(result.latestVersion).toBe('1.1.0');
			expect(result.versionsBehind).toBe(1);
		});

		it('returns no update when on latest version', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([createMockRelease({ tag_name: 'v1.0.0' })]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.updateAvailable).toBe(false);
			expect(result.versionsBehind).toBe(0);
		});

		it('filters out draft releases', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.2.0', draft: true }),
						createMockRelease({ tag_name: 'v1.1.0' }),
						createMockRelease({ tag_name: 'v1.0.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.latestVersion).toBe('1.1.0');
			expect(result.versionsBehind).toBe(1);
		});

		it('filters out prerelease flag releases', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.2.0', prerelease: true }),
						createMockRelease({ tag_name: 'v1.1.0' }),
						createMockRelease({ tag_name: 'v1.0.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.latestVersion).toBe('1.1.0');
			expect(result.versionsBehind).toBe(1);
		});

		it('filters out releases with -rc suffix', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.2.0-rc' }),
						createMockRelease({ tag_name: 'v1.1.0' }),
						createMockRelease({ tag_name: 'v1.0.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.latestVersion).toBe('1.1.0');
			expect(result.versionsBehind).toBe(1);
			expect(result.releases.some((r) => r.tag_name.includes('-rc'))).toBe(false);
		});

		it('filters out releases with -beta suffix', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.2.0-beta' }),
						createMockRelease({ tag_name: 'v1.2.0-beta.1' }),
						createMockRelease({ tag_name: 'v1.1.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.latestVersion).toBe('1.1.0');
			expect(result.releases.some((r) => r.tag_name.includes('-beta'))).toBe(false);
		});

		it('filters out releases with -alpha suffix', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.2.0-alpha' }),
						createMockRelease({ tag_name: 'v1.1.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.latestVersion).toBe('1.1.0');
			expect(result.releases.some((r) => r.tag_name.includes('-alpha'))).toBe(false);
		});

		it('filters out releases with -dev suffix', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.2.0-dev' }),
						createMockRelease({ tag_name: 'v1.1.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.latestVersion).toBe('1.1.0');
		});

		it('filters out releases with -canary suffix', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.2.0-canary' }),
						createMockRelease({ tag_name: 'v1.1.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.latestVersion).toBe('1.1.0');
		});

		it('is case-insensitive for prerelease suffixes', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.3.0-RC' }),
						createMockRelease({ tag_name: 'v1.2.0-Beta' }),
						createMockRelease({ tag_name: 'v1.1.0-ALPHA' }),
						createMockRelease({ tag_name: 'v1.0.0' }),
					]),
			});

			const result = await checkForUpdates('0.9.0');

			expect(result.latestVersion).toBe('1.0.0');
			expect(result.releases.length).toBe(1);
		});

		it('handles API errors gracefully', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 403,
				statusText: 'Forbidden',
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.updateAvailable).toBe(false);
			expect(result.error).toContain('GitHub API error');
			expect(mockLogger.error).toHaveBeenCalledWith(
				'GitHub API error: 403 Forbidden',
				'UpdateChecker',
				expect.objectContaining({ status: 403, statusText: 'Forbidden' })
			);
		});

		it('handles network errors gracefully', async () => {
			mockFetch.mockRejectedValue(new Error('Network error'));

			const result = await checkForUpdates('1.0.0');

			expect(result.updateAvailable).toBe(false);
			expect(result.error).toBe('Network error');
			expect(mockLogger.error).toHaveBeenCalledWith(
				'Update check failed: Network error',
				'UpdateChecker',
				expect.objectContaining({ currentVersion: '1.0.0' })
			);
		});

		it('handles non-Error failures as unknown update-check errors', async () => {
			mockFetch.mockRejectedValue('offline');

			const result = await checkForUpdates('1.0.0');

			expect(result).toMatchObject({
				currentVersion: '1.0.0',
				latestVersion: '1.0.0',
				updateAvailable: false,
				versionsBehind: 0,
				assetsReady: false,
				error: 'Unknown error',
			});
			expect(mockLogger.error).toHaveBeenCalledWith(
				'Update check failed: Unknown error',
				'UpdateChecker',
				expect.objectContaining({ stack: undefined })
			);
		});

		it('counts multiple versions behind correctly', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.3.0' }),
						createMockRelease({ tag_name: 'v1.2.0' }),
						createMockRelease({ tag_name: 'v1.1.0' }),
						createMockRelease({ tag_name: 'v1.0.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.versionsBehind).toBe(3);
			expect(result.releases.length).toBe(3);
		});

		it('returns only newer releases in the releases array', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.2.0' }),
						createMockRelease({ tag_name: 'v1.1.0' }),
						createMockRelease({ tag_name: 'v1.0.0' }),
						createMockRelease({ tag_name: 'v0.9.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.releases.length).toBe(2);
			expect(result.releases.map((r) => r.tag_name)).toEqual(['v1.2.0', 'v1.1.0']);
		});

		it('handles empty releases array', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.updateAvailable).toBe(false);
			expect(result.releases.length).toBe(0);
		});

		it('reports assets as not ready when the latest release has no downloadable assets', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([createMockRelease({ tag_name: 'v1.1.0' })]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.updateAvailable).toBe(true);
			expect(result.assetsReady).toBe(false);
		});

		it('handles version with v prefix in current version', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([createMockRelease({ tag_name: 'v1.1.0' })]),
			});

			// Should work with or without v prefix
			const result = await checkForUpdates('v1.0.0');

			expect(result.updateAvailable).toBe(true);
		});
	});

	describe('platform asset readiness', () => {
		it.each([
			{
				platform: 'darwin' as NodeJS.Platform,
				assets: ['readme.txt', 'Maestro-1.2.0-mac.zip'],
				expectedAssetsReady: true,
			},
			{
				platform: 'darwin' as NodeJS.Platform,
				assets: ['Maestro-1.2.0-darwin.zip'],
				expectedAssetsReady: true,
			},
			{
				platform: 'darwin' as NodeJS.Platform,
				assets: ['Maestro-1.2.0.dmg'],
				expectedAssetsReady: true,
			},
			{
				platform: 'win32' as NodeJS.Platform,
				assets: ['readme.txt', 'MaestroSetup.msi'],
				expectedAssetsReady: true,
			},
			{
				platform: 'win32' as NodeJS.Platform,
				assets: ['MaestroSetup.exe'],
				expectedAssetsReady: true,
			},
			{
				platform: 'linux' as NodeJS.Platform,
				assets: ['Maestro.tar.gz', 'Maestro-linux.tar.gz'],
				expectedAssetsReady: true,
			},
			{
				platform: 'linux' as NodeJS.Platform,
				assets: ['Maestro.AppImage'],
				expectedAssetsReady: true,
			},
			{
				platform: 'linux' as NodeJS.Platform,
				assets: ['maestro.deb'],
				expectedAssetsReady: true,
			},
			{
				platform: 'linux' as NodeJS.Platform,
				assets: ['maestro.rpm'],
				expectedAssetsReady: true,
			},
			{
				platform: 'linux' as NodeJS.Platform,
				assets: ['Maestro.tar.gz'],
				expectedAssetsReady: false,
			},
			{
				platform: 'freebsd' as NodeJS.Platform,
				assets: ['Maestro.pkg'],
				expectedAssetsReady: true,
			},
		])(
			'reports assetsReady=$expectedAssetsReady for $platform assets $assets',
			async ({ platform, assets, expectedAssetsReady }) => {
				mockPlatform(platform);
				mockFetch.mockResolvedValue({
					ok: true,
					json: () =>
						Promise.resolve([
							createMockRelease({
								tag_name: 'v1.2.0',
								assets: assets.map(createMockAsset),
							}),
							createMockRelease({ tag_name: 'v1.0.0' }),
						]),
				});

				const result = await checkForUpdates('1.0.0');

				expect(result.updateAvailable).toBe(true);
				expect(result.latestVersion).toBe('1.2.0');
				expect(result.assetsReady).toBe(expectedAssetsReady);
			}
		);
	});

	describe('checkForUpdates with includePrerelease', () => {
		it('includes prerelease versions when includePrerelease is true', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.3.0-beta', prerelease: true }),
						createMockRelease({ tag_name: 'v1.2.0-rc', prerelease: true }),
						createMockRelease({ tag_name: 'v1.1.0' }),
						createMockRelease({ tag_name: 'v1.0.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0', true);

			expect(result.updateAvailable).toBe(true);
			expect(result.latestVersion).toBe('1.3.0-beta');
			expect(result.releases.length).toBe(3);
			expect(result.releases.some((r) => r.tag_name.includes('-beta'))).toBe(true);
			expect(result.releases.some((r) => r.tag_name.includes('-rc'))).toBe(true);
		});

		it('excludes prerelease versions when includePrerelease is false', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.3.0-beta', prerelease: true }),
						createMockRelease({ tag_name: 'v1.2.0-rc', prerelease: true }),
						createMockRelease({ tag_name: 'v1.1.0' }),
						createMockRelease({ tag_name: 'v1.0.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0', false);

			expect(result.latestVersion).toBe('1.1.0');
			expect(result.releases.length).toBe(1);
			expect(result.releases.some((r) => r.tag_name.includes('-beta'))).toBe(false);
			expect(result.releases.some((r) => r.tag_name.includes('-rc'))).toBe(false);
		});

		it('defaults to excluding prereleases when parameter not provided', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.2.0-alpha' }),
						createMockRelease({ tag_name: 'v1.1.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0');

			expect(result.latestVersion).toBe('1.1.0');
			expect(result.releases.some((r) => r.tag_name.includes('-alpha'))).toBe(false);
		});

		it('includes all prerelease suffix types when enabled', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.6.0-canary' }),
						createMockRelease({ tag_name: 'v1.5.0-dev' }),
						createMockRelease({ tag_name: 'v1.4.0-alpha' }),
						createMockRelease({ tag_name: 'v1.3.0-beta' }),
						createMockRelease({ tag_name: 'v1.2.0-rc' }),
						createMockRelease({ tag_name: 'v1.1.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0', true);

			expect(result.releases.length).toBe(6);
			expect(result.releases.some((r) => r.tag_name.includes('-canary'))).toBe(true);
			expect(result.releases.some((r) => r.tag_name.includes('-dev'))).toBe(true);
			expect(result.releases.some((r) => r.tag_name.includes('-alpha'))).toBe(true);
			expect(result.releases.some((r) => r.tag_name.includes('-beta'))).toBe(true);
			expect(result.releases.some((r) => r.tag_name.includes('-rc'))).toBe(true);
		});

		it('always filters out draft releases even with includePrerelease', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						createMockRelease({ tag_name: 'v1.3.0', draft: true }),
						createMockRelease({ tag_name: 'v1.2.0-beta' }),
						createMockRelease({ tag_name: 'v1.1.0' }),
					]),
			});

			const result = await checkForUpdates('1.0.0', true);

			expect(result.latestVersion).toBe('1.2.0-beta');
			expect(result.releases.every((r) => !r.draft)).toBe(true);
		});
	});
});
