import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	_resetWslDetectorForTesting,
	checkWslEnvironment,
	getWslWarningMessage,
	isWindowsMountPath,
	isWsl,
} from '../../main/utils/wslDetector';

function configureWslDetector({
	linux = true,
	procVersionExists = true,
	procVersion = 'Linux version 5.15.90.1-microsoft-standard-WSL2',
	readError,
}: {
	linux?: boolean;
	procVersionExists?: boolean;
	procVersion?: string;
	readError?: unknown;
} = {}) {
	const existsSync = vi.fn(() => procVersionExists);
	const readFileSync = vi.fn(() => {
		if (readError) throw readError;
		return procVersion;
	});
	const isLinux = vi.fn(() => linux);
	const logger = {
		warn: vi.fn(),
		debug: vi.fn(),
	};

	_resetWslDetectorForTesting({
		isLinux,
		existsSync,
		readFileSync,
		logger,
	});

	return {
		existsSync,
		readFileSync,
		isLinux,
		logger,
	};
}

afterEach(() => {
	_resetWslDetectorForTesting();
	vi.clearAllMocks();
});

describe('wslDetector', () => {
	describe('isWsl', () => {
		it('returns false and caches the result outside Linux', () => {
			const { existsSync, isLinux } = configureWslDetector({ linux: false });

			expect(isWsl()).toBe(false);
			expect(isWsl()).toBe(false);

			expect(isLinux).toHaveBeenCalledTimes(1);
			expect(existsSync).not.toHaveBeenCalled();
		});

		it('detects Microsoft WSL proc versions and caches the result', () => {
			const { existsSync, readFileSync, isLinux } = configureWslDetector({
				procVersion: 'Linux version 5.15.90.1-microsoft-standard-WSL2',
			});

			expect(isWsl()).toBe(true);
			expect(isWsl()).toBe(true);

			expect(isLinux).toHaveBeenCalledTimes(1);
			expect(existsSync).toHaveBeenCalledWith('/proc/version');
			expect(readFileSync).toHaveBeenCalledWith('/proc/version', 'utf8');
			expect(readFileSync).toHaveBeenCalledTimes(1);
		});

		it('detects generic wsl markers without a microsoft marker', () => {
			configureWslDetector({ procVersion: 'Linux version 6.1.0-custom-wsl' });

			expect(isWsl()).toBe(true);
		});

		it('returns false when proc version exists without WSL markers', () => {
			configureWslDetector({ procVersion: 'Linux version 6.1.0-generic' });

			expect(isWsl()).toBe(false);
		});

		it('returns false when proc version is unavailable', () => {
			const { readFileSync } = configureWslDetector({ procVersionExists: false });

			expect(isWsl()).toBe(false);
			expect(readFileSync).not.toHaveBeenCalled();
		});

		it('returns false when proc version cannot be read', () => {
			configureWslDetector({ readError: new Error('EACCES') });

			expect(isWsl()).toBe(false);
		});
	});

	describe('isWindowsMountPath', () => {
		it('matches WSL Windows drive mount roots and descendants', () => {
			expect(isWindowsMountPath('/mnt/c')).toBe(true);
			expect(isWindowsMountPath('/mnt/Z/project')).toBe(true);
		});

		it('does not match Linux paths or similar non-drive mount names', () => {
			expect(isWindowsMountPath('/home/user/project')).toBe(false);
			expect(isWindowsMountPath('/mnt/cache/project')).toBe(false);
			expect(isWindowsMountPath('/mnt/cc')).toBe(false);
			expect(isWindowsMountPath('C:\\projects\\maestro')).toBe(false);
		});
	});

	describe('checkWslEnvironment', () => {
		it('returns false without logging when the runtime is not WSL', () => {
			const { logger } = configureWslDetector({ linux: false });

			expect(checkWslEnvironment('/mnt/c/project')).toBe(false);

			expect(logger.warn).not.toHaveBeenCalled();
			expect(logger.debug).not.toHaveBeenCalled();
		});

		it('warns and returns true for Windows-mounted paths in WSL', () => {
			const { logger } = configureWslDetector();

			expect(checkWslEnvironment('/mnt/c/projects/maestro')).toBe(true);

			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Running from Windows-mounted path'),
				'WSLDetector',
				{ cwd: '/mnt/c/projects/maestro' }
			);
			expect(logger.debug).not.toHaveBeenCalled();
		});

		it('debug logs and returns false for Linux filesystem paths in WSL', () => {
			const { logger } = configureWslDetector();

			expect(checkWslEnvironment('/home/user/maestro')).toBe(false);

			expect(logger.debug).toHaveBeenCalledWith(
				'[WSL] Running from Linux filesystem - OK',
				'WSLDetector',
				{ cwd: '/home/user/maestro' }
			);
			expect(logger.warn).not.toHaveBeenCalled();
		});
	});

	describe('getWslWarningMessage', () => {
		it('returns actionable migration guidance for WSL users', () => {
			expect(getWslWarningMessage()).toContain('Windows-mounted path in WSL2');
			expect(getWslWarningMessage()).toContain('Socket binding failures');
			expect(getWslWarningMessage()).toContain('mv /mnt/c/projects/maestro ~/maestro');
			expect(getWslWarningMessage()).toContain('docs.runmaestro.ai/installation');
		});
	});
});
