/**
 * Tests for the Linux window icon resolver.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

const { mockIsLinux, mockExistsSync } = vi.hoisted(() => ({
	mockIsLinux: vi.fn(() => true),
	mockExistsSync: vi.fn((_p: string) => false),
}));

vi.mock('../../../shared/platformDetection', () => ({
	isLinux: mockIsLinux,
}));

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return { ...actual, existsSync: mockExistsSync };
});

import { resolveLinuxWindowIconPath } from '../../../main/app-lifecycle/app-icon';

const DEV_ICON = path.resolve(__dirname, '..', '..', '..', '..', 'build', 'icon.png');

describe('app-lifecycle/app-icon', () => {
	const originalResourcesPath = process.resourcesPath;

	beforeEach(() => {
		mockIsLinux.mockReturnValue(true);
		mockExistsSync.mockReset();
		mockExistsSync.mockReturnValue(false);
		Object.defineProperty(process, 'resourcesPath', {
			value: '/opt/Maestro/resources',
			configurable: true,
			writable: true,
		});
	});

	afterEach(() => {
		Object.defineProperty(process, 'resourcesPath', {
			value: originalResourcesPath,
			configurable: true,
			writable: true,
		});
	});

	it('returns undefined off Linux without touching the disk', () => {
		mockIsLinux.mockReturnValue(false);
		expect(resolveLinuxWindowIconPath()).toBeUndefined();
		expect(mockExistsSync).not.toHaveBeenCalled();
	});

	it('prefers the packaged icon in resources', () => {
		const packaged = path.join('/opt/Maestro/resources', 'icon.png');
		mockExistsSync.mockImplementation((p: string) => p === packaged || p === DEV_ICON);
		expect(resolveLinuxWindowIconPath()).toBe(packaged);
	});

	it('falls back to the repo build/icon.png in dev', () => {
		mockExistsSync.mockImplementation((p: string) => p === DEV_ICON);
		expect(resolveLinuxWindowIconPath()).toBe(DEV_ICON);
	});

	it('skips the resources candidate when resourcesPath is unset', () => {
		Object.defineProperty(process, 'resourcesPath', {
			value: undefined,
			configurable: true,
			writable: true,
		});
		mockExistsSync.mockImplementation((p: string) => p === DEV_ICON);
		expect(resolveLinuxWindowIconPath()).toBe(DEV_ICON);
		expect(mockExistsSync).toHaveBeenCalledTimes(1);
	});

	it('returns undefined when no icon exists', () => {
		expect(resolveLinuxWindowIconPath()).toBeUndefined();
	});
});
