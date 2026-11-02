/**
 * Sync Path (custom Storage Location)
 *
 * Settings -> General -> Storage Location moves the synced stores (settings,
 * agents, groups, session origins, pasted images, group chats) out of the
 * user-data directory and into a folder the user picked. The choice itself
 * stays behind, in `maestro-bootstrap.json` inside the user-data directory,
 * because something has to say where the rest went.
 *
 * Both the desktop app and maestro-cli resolve it through this module. The CLI
 * used to read every store from the user-data directory alone, so with a custom
 * location it listed the agents that existed before the move and answered
 * "Agent not found" for every one created since (issue #1784).
 *
 * Import-free of Electron on purpose: the CLI bundle loads it too.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isWindows } from './platformDetection';
import { parseJsonWithBom } from './jsonUtils';

/** The store that records the custom location. Never synced itself. */
export const BOOTSTRAP_STORE_FILE = 'maestro-bootstrap.json';

/**
 * Validates a custom sync path for security and correctness.
 * @returns true if the path is valid, false otherwise
 */
export function isValidSyncPath(customPath: string): boolean {
	// Path must be absolute
	if (!path.isAbsolute(customPath)) {
		console.error(`Custom sync path must be absolute: ${customPath}`);
		return false;
	}

	// Check for null bytes (security issue on Unix systems)
	if (customPath.includes('\0')) {
		console.error(`Custom sync path contains null bytes: ${customPath}`);
		return false;
	}

	// Check for path traversal BEFORE normalization
	// Split by separator and check for literal ".." segments
	const segments = customPath.split(/[/\\]/);
	if (segments.includes('..')) {
		console.error(`Custom sync path contains traversal sequences: ${customPath}`);
		return false;
	}

	// Normalize the path to resolve any . segments and redundant separators
	const normalizedPath = path.normalize(customPath);

	// Reject paths that are too short (likely system directories)
	// Minimum reasonable path: /a/b (5 chars on Unix) or C:\a (4 chars on Windows)
	const minPathLength = isWindows() ? 4 : 5;
	if (normalizedPath.length < minPathLength) {
		console.error(`Custom sync path is too short: ${customPath}`);
		return false;
	}

	// Check for Windows reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
	if (isWindows()) {
		const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
		const pathSegments = normalizedPath.split(/[/\\]/);
		for (const segment of pathSegments) {
			// Check the base name without extension
			const baseName = segment.split('.')[0];
			if (reservedNames.test(baseName)) {
				console.error(`Custom sync path contains Windows reserved name: ${customPath}`);
				return false;
			}
		}
	}

	// Reject known sensitive system directories
	// For Windows, check common sensitive paths across all drive letters
	const sensitiveRoots = isWindows()
		? [
				'\\Windows',
				'\\Program Files',
				'\\Program Files (x86)',
				'\\System',
				'\\System32',
				'\\SysWOW64',
			]
		: ['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/etc', '/var', '/tmp', '/dev', '/proc', '/sys'];

	const lowerPath = normalizedPath.toLowerCase();

	if (isWindows()) {
		// For Windows, check if any sensitive root appears after the drive letter
		// e.g., C:\Windows, D:\Windows, etc.
		for (const sensitive of sensitiveRoots) {
			const sensitiveLower = sensitive.toLowerCase();
			// Match pattern like "X:\Windows" or "X:\Windows\..."
			const drivePattern = /^[a-z]:/i;
			if (drivePattern.test(lowerPath)) {
				const pathWithoutDrive = lowerPath.slice(2); // Remove "C:" prefix
				if (
					pathWithoutDrive === sensitiveLower ||
					pathWithoutDrive.startsWith(sensitiveLower + '\\')
				) {
					console.error(`Custom sync path cannot be in sensitive system directory: ${customPath}`);
					return false;
				}
			}
		}
	} else {
		// Unix path checking
		for (const sensitive of sensitiveRoots) {
			if (lowerPath === sensitive || lowerPath.startsWith(sensitive + '/')) {
				console.error(`Custom sync path cannot be in sensitive system directory: ${customPath}`);
				return false;
			}
		}
	}

	return true;
}

/** Shown when the user picks a Storage Location inside the install directory. */
export const INSTALL_DIR_SYNC_PATH_ERROR =
	'This folder is removed when Maestro updates. Pick a folder outside the Maestro install directory.';

/**
 * Whether `customPath` is the app's install directory or lives inside it.
 *
 * An update replaces the install directory wholesale: the NSIS updater runs the
 * old uninstaller, which deletes everything under `$INSTDIR`, and macOS swaps
 * the whole `.app` bundle. A Storage Location in there loses every agent, group
 * and setting on the next update (issue #1875). `installDir` comes from the
 * main process so this module stays free of Electron.
 */
export function isInsideInstallDir(customPath: string, installDir: string): boolean {
	const fold = (p: string) => (isWindows() ? path.resolve(p).toLowerCase() : path.resolve(p));
	const relative = path.relative(fold(installDir), fold(customPath));
	if (relative === '') return true;
	return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The directory the synced stores live in, for a process without Electron.
 *
 * Mirrors the desktop's startup decision (`getCustomSyncPath()` in
 * `src/main/stores/utils.ts`) and falls back to `userDataDir` in every case the
 * app does: no bootstrap file, an unparseable one (the app quarantines it and
 * starts from defaults), no path configured, or a path that fails
 * `isValidSyncPath`. A missing directory falls back too rather than being
 * created: the app creates it at startup, so its absence means the app is not
 * using it, and a reader has no business making one.
 */
export function resolveSyncDir(userDataDir: string): string {
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(userDataDir, BOOTSTRAP_STORE_FILE), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return userDataDir;
		}
		throw error;
	}

	let customPath: unknown;
	try {
		customPath = parseJsonWithBom<{ customSyncPath?: unknown } | null>(raw)?.customSyncPath;
	} catch {
		return userDataDir;
	}

	if (typeof customPath !== 'string' || customPath.length === 0) {
		return userDataDir;
	}
	if (!isValidSyncPath(customPath) || !fs.existsSync(customPath)) {
		return userDataDir;
	}
	return customPath;
}
