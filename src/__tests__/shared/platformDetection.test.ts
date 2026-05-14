import { describe, it, expect, afterEach } from 'vitest';
import { isWindows, isMacOS, isLinux, getWhichCommand } from '../../shared/platformDetection';

describe('platformDetection', () => {
	const originalPlatform = process.platform;

	afterEach(() => {
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			configurable: true,
		});
	});

	describe('isWindows', () => {
		it('returns true on win32', () => {
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			expect(isWindows()).toBe(true);
		});

		it('returns false on darwin', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
			expect(isWindows()).toBe(false);
		});

		it('returns false on linux', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
			expect(isWindows()).toBe(false);
		});
	});

	describe('isMacOS', () => {
		it('returns true on darwin', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
			expect(isMacOS()).toBe(true);
		});

		it('returns false on win32', () => {
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			expect(isMacOS()).toBe(false);
		});

		it('returns false on linux', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
			expect(isMacOS()).toBe(false);
		});
	});

	describe('isLinux', () => {
		it('returns true on linux', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
			expect(isLinux()).toBe(true);
		});

		it('returns false on darwin', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
			expect(isLinux()).toBe(false);
		});

		it('returns false on win32', () => {
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			expect(isLinux()).toBe(false);
		});
	});

	describe('getWhichCommand', () => {
		it('returns "where" on Windows', () => {
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
			expect(getWhichCommand()).toBe('where');
		});

		it('returns "which" on macOS', () => {
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
			expect(getWhichCommand()).toBe('which');
		});

		it('returns "which" on Linux', () => {
			Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
			expect(getWhichCommand()).toBe('which');
		});
	});

	describe('renderer (browser) fallback', () => {
		// In a renderer, `process` is undefined and `globalThis.maestro.platform`
		// is provided by the preload bridge. Simulate the no-process case by
		// blanking process.platform; the fallback should pick up maestro.platform.
		const g = globalThis as unknown as { maestro?: { platform?: string } };

		it('reads platform from globalThis.maestro.platform when process.platform is empty', () => {
			Object.defineProperty(process, 'platform', { value: '', configurable: true });
			const savedMaestro = g.maestro;
			try {
				g.maestro = { platform: 'darwin' };
				expect(isMacOS()).toBe(true);
				expect(isWindows()).toBe(false);
				expect(isLinux()).toBe(false);
			} finally {
				g.maestro = savedMaestro;
			}
		});

		it('falls back to linux when neither process.platform nor maestro is defined', () => {
			Object.defineProperty(process, 'platform', { value: '', configurable: true });
			const savedMaestro = g.maestro;
			try {
				g.maestro = undefined;
				expect(() => isMacOS()).not.toThrow();
				expect(isLinux()).toBe(true);
				expect(isMacOS()).toBe(false);
				expect(isWindows()).toBe(false);
			} finally {
				g.maestro = savedMaestro;
			}
		});
	});
});
