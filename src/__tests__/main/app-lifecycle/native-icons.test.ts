// Source: src/__tests__/main/app-lifecycle/app-icon.test.ts
// Source: src/__tests__/main/utils/drag-out-icon.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import * as path from 'path';
import { resolveLinuxWindowIconPath } from '../../../main/app-lifecycle/app-icon';
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
// Preserve the captured PNG buffer while using Electron's native-image double.
const createFromBuffer = vi.hoisted(() =>
	vi.fn((buf: Buffer) => ({ isEmpty: () => buf.length === 0, __buf: buf }))
);
vi.mock('electron', () => ({
	nativeImage: { createFromBuffer },
}));
describe('app-icon', () => {
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
});
describe('drag-out-icon', () => {
	// 8-byte PNG file signature.
	const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

	// `drag-out-icon` caches the built image at module scope for the process
	// lifetime, so reset the module registry before each test to exercise a cold
	// build. Dynamic import re-runs the module factory against the same electron mock.
	async function loadFresh() {
		vi.resetModules();
		createFromBuffer.mockClear();
		return await import('../../../main/utils/drag-out-icon');
	}

	describe('getDragOutIcon', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('builds a non-empty NativeImage from a valid PNG buffer', async () => {
			const { getDragOutIcon } = await loadFresh();
			const icon = getDragOutIcon() as unknown as { isEmpty: () => boolean };
			expect(icon.isEmpty()).toBe(false);

			const buf: Buffer = createFromBuffer.mock.calls[0][0];
			// Valid PNG: signature + IHDR/IDAT/IEND chunk types present.
			expect(buf.subarray(0, 8).equals(PNG_SIG)).toBe(true);
			expect(buf.includes(Buffer.from('IHDR', 'ascii'))).toBe(true);
			expect(buf.includes(Buffer.from('IDAT', 'ascii'))).toBe(true);
			expect(buf.includes(Buffer.from('IEND', 'ascii'))).toBe(true);
		});

		it('declares a 28x28 RGBA image in the IHDR chunk', async () => {
			const { getDragOutIcon } = await loadFresh();
			getDragOutIcon();
			const buf: Buffer = createFromBuffer.mock.calls[0][0];
			// IHDR data begins 8 bytes after the "IHDR" type marker (skip 4-byte length
			// + 4-byte type). Width/height are the first two big-endian uint32s.
			const ihdr = buf.indexOf(Buffer.from('IHDR', 'ascii')) + 4;
			expect(buf.readUInt32BE(ihdr)).toBe(28); // width
			expect(buf.readUInt32BE(ihdr + 4)).toBe(28); // height
			expect(buf[ihdr + 8]).toBe(8); // bit depth
			expect(buf[ihdr + 9]).toBe(6); // color type: RGBA
		});

		it('caches the icon: builds once, returns the same instance on repeat calls', async () => {
			const { getDragOutIcon } = await loadFresh();
			const first = getDragOutIcon();
			const second = getDragOutIcon();
			expect(second).toBe(first);
			// Second call must hit the cache, not rebuild.
			expect(createFromBuffer).toHaveBeenCalledTimes(1);
		});
	});
});
