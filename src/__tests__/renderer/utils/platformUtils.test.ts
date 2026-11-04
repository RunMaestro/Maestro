import { describe, it, expect, afterEach, vi } from 'vitest';
import {
	getFileManagerName,
	fileManagerName,
	getRevealLabel,
	getOpenInLabel,
	isWindowsPlatform,
	isMacOSPlatform,
	isLinuxPlatform,
	isMacOSKeyboard,
} from '../../../renderer/utils/platformUtils';

describe('platformUtils', () => {
	const originalConfig = window.__MAESTRO_CONFIG__;
	afterEach(() => {
		(window as any).maestro = { platform: 'darwin' };
		window.__MAESTRO_CONFIG__ = originalConfig;
		vi.restoreAllMocks();
	});

	it('keeps physical keyboard conventions independent of remote execution OS', () => {
		window.__MAESTRO_CONFIG__ = {
			securityToken: 'test',
			sessionId: null,
			tabId: null,
			apiBase: '/test/api',
			wsUrl: '/test/ws',
			hostPlatform: 'win32',
		};
		(window as any).maestro = { platform: 'win32' };
		const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
		expect(isWindowsPlatform()).toBe(true);
		expect(isMacOSKeyboard()).toBe(true);
		(window as any).maestro = { platform: 'darwin' };
		platform.mockReturnValue('Win32');
		expect(isMacOSPlatform()).toBe(true);
		expect(isMacOSKeyboard()).toBe(false);
	});

	describe('isWindowsPlatform', () => {
		it('returns true for win32', () => {
			(window as any).maestro = { platform: 'win32' };
			expect(isWindowsPlatform()).toBe(true);
		});

		it('returns false for darwin', () => {
			(window as any).maestro = { platform: 'darwin' };
			expect(isWindowsPlatform()).toBe(false);
		});

		it('returns false when maestro is undefined', () => {
			(window as any).maestro = undefined;
			expect(isWindowsPlatform()).toBe(false);
		});
	});

	describe('isMacOSPlatform', () => {
		it('returns true for darwin', () => {
			(window as any).maestro = { platform: 'darwin' };
			expect(isMacOSPlatform()).toBe(true);
		});

		it('returns false for win32', () => {
			(window as any).maestro = { platform: 'win32' };
			expect(isMacOSPlatform()).toBe(false);
		});

		it('returns false for linux', () => {
			(window as any).maestro = { platform: 'linux' };
			expect(isMacOSPlatform()).toBe(false);
		});
	});

	describe('isLinuxPlatform', () => {
		it('returns true for linux', () => {
			(window as any).maestro = { platform: 'linux' };
			expect(isLinuxPlatform()).toBe(true);
		});

		it('returns false for darwin', () => {
			(window as any).maestro = { platform: 'darwin' };
			expect(isLinuxPlatform()).toBe(false);
		});
	});

	describe('getFileManagerName', () => {
		it('names the file manager per platform', () => {
			expect(getFileManagerName('darwin')).toBe('Finder');
			expect(getFileManagerName('win32')).toBe('Explorer');
			expect(getFileManagerName('linux')).toBe('File Manager');
		});

		it('falls back to Finder for unknown platforms', () => {
			expect(getFileManagerName('freebsd')).toBe('Finder');
			expect(getFileManagerName('')).toBe('Finder');
		});
	});

	describe('fileManagerName', () => {
		it('resolves the platform from the preload bridge', () => {
			(window as any).maestro = { platform: 'win32' };
			expect(fileManagerName()).toBe('Explorer');
			(window as any).maestro = { platform: 'darwin' };
			expect(fileManagerName()).toBe('Finder');
		});

		it('falls back to Finder when the bridge is missing', () => {
			(window as any).maestro = undefined;
			expect(fileManagerName()).toBe('Finder');
		});
	});

	describe('getRevealLabel', () => {
		it('returns "Reveal in Finder" for darwin', () => {
			expect(getRevealLabel('darwin')).toBe('Reveal in Finder');
		});

		it('returns "Reveal in Explorer" for win32', () => {
			expect(getRevealLabel('win32')).toBe('Reveal in Explorer');
		});

		it('returns "Reveal in File Manager" for linux', () => {
			expect(getRevealLabel('linux')).toBe('Reveal in File Manager');
		});

		it('returns "Reveal in Finder" for unknown platforms', () => {
			expect(getRevealLabel('freebsd')).toBe('Reveal in Finder');
			expect(getRevealLabel('')).toBe('Reveal in Finder');
		});
	});

	describe('getOpenInLabel', () => {
		it('returns "Open in Finder" for darwin', () => {
			expect(getOpenInLabel('darwin')).toBe('Open in Finder');
		});

		it('returns "Open in Explorer" for win32', () => {
			expect(getOpenInLabel('win32')).toBe('Open in Explorer');
		});

		it('returns "Open in File Manager" for linux', () => {
			expect(getOpenInLabel('linux')).toBe('Open in File Manager');
		});

		it('returns "Open in Finder" for unknown platforms', () => {
			expect(getOpenInLabel('freebsd')).toBe('Open in Finder');
			expect(getOpenInLabel('')).toBe('Open in Finder');
		});
	});
});
