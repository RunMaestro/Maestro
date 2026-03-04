import { describe, it, expect, afterEach } from 'vitest';
import {
	getRevealLabel,
	getOpenInLabel,
	isWindowsPlatform,
	isMacOSPlatform,
	isLinuxPlatform,
} from '../../../renderer/utils/platformUtils';

describe('platformUtils', () => {
	afterEach(() => {
		(window as any).maestro = { platform: 'darwin' };
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
