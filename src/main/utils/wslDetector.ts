import * as fs from 'fs';
import { logger } from './logger';
import { isLinux } from '../../shared/platformDetection';

/**
 * WSL (Windows Subsystem for Linux) environment detection utilities.
 *
 * When running in WSL2, using Windows-mounted paths (/mnt/c, /mnt/d, etc.)
 * causes critical issues with Electron, socket binding, npm, and git.
 * These utilities help detect and warn about such configurations.
 */

let wslDetectionCache: boolean | null = null;

/**
 * Detect if the current environment is WSL (Windows Subsystem for Linux).
 * Result is cached after first call.
 */
export function isWsl(): boolean {
	if (wslDetectionCache !== null) {
		return wslDetectionCache;
	}

	if (!isLinux()) {
		wslDetectionCache = false;
		return false;
	}

	try {
		if (fs.existsSync('/proc/version')) {
			const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
			wslDetectionCache = version.includes('microsoft') || version.includes('wsl');
			return wslDetectionCache;
		}
	} catch {
		// Ignore read errors
	}

	wslDetectionCache = false;
	return false;
}

/**
 * Check if a path is on a Windows-mounted filesystem in WSL.
 * Windows mounts are typically at /mnt/c, /mnt/d, etc.
 */
function isWindowsMountPath(filepath: string): boolean {
	return /^\/mnt\/[a-zA-Z](\/|$)/.test(filepath);
}

/**
 * Check if running from a Windows mount in WSL and log a warning.
 * This should be called early in the application lifecycle.
 *
 * @param cwd - The current working directory to check
 * @returns true if running from a problematic Windows mount path
 */
export function checkWslEnvironment(cwd: string): boolean {
	if (!isWsl()) {
		return false;
	}

	if (isWindowsMountPath(cwd)) {
		logger.warn(
			'[WSL] Running from Windows mount path - this may cause socket binding failures, ' +
				'Electron sandbox crashes, npm install issues, and git corruption. ' +
				'Consider moving your project to the Linux filesystem (e.g., ~/projects/maestro).',
			'WSLDetector',
			{ cwd }
		);
		return true;
	}

	logger.debug('[WSL] Running from Linux filesystem - OK', 'WSLDetector', { cwd });
	return false;
}
