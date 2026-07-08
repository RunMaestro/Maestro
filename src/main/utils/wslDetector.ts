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

interface WslDetectorDeps {
	isLinux: () => boolean;
	existsSync: typeof fs.existsSync;
	readFileSync: typeof fs.readFileSync;
	logger: Pick<typeof logger, 'debug' | 'warn'>;
}

const defaultDeps: WslDetectorDeps = {
	isLinux,
	existsSync: fs.existsSync,
	readFileSync: fs.readFileSync,
	logger,
};

let deps = defaultDeps;

export function _resetWslDetectorForTesting(overrides?: Partial<WslDetectorDeps>): void {
	wslDetectionCache = null;
	deps = { ...defaultDeps, ...overrides };
}

/**
 * Detect if the current environment is WSL (Windows Subsystem for Linux).
 * Result is cached after first call.
 */
export function isWsl(): boolean {
	if (wslDetectionCache !== null) {
		return wslDetectionCache;
	}

	if (!deps.isLinux()) {
		wslDetectionCache = false;
		return false;
	}

	try {
		if (deps.existsSync('/proc/version')) {
			const version = deps.readFileSync('/proc/version', 'utf8').toLowerCase();
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
export function isWindowsMountPath(filepath: string): boolean {
	return /^\/mnt\/[a-zA-Z](\/|$)/.test(filepath);
}

export function getWslWarningMessage(): string {
	return (
		'[WSL] Running from Windows-mounted path in WSL2. Socket binding failures, ' +
		'Electron sandbox crashes, npm install issues, and git corruption can occur. ' +
		'Move the project to the Linux filesystem, for example: mv /mnt/c/projects/maestro ~/maestro. ' +
		'See docs.runmaestro.ai/installation for setup guidance.'
	);
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
		deps.logger.warn(getWslWarningMessage(), 'WSLDetector', { cwd });
		return true;
	}

	deps.logger.debug('[WSL] Running from Linux filesystem - OK', 'WSLDetector', { cwd });
	return false;
}
