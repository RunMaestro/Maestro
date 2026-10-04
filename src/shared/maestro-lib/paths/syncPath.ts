/**
 * Whether a `customSyncPath` from `maestro-bootstrap.json` may be used.
 *
 * The desktop (`src/main/stores/utils.ts`) and any process without Electron
 * must agree on this, or the two read sessions and settings from different
 * directories: a path the desktop rejects falls back to userData, so a reader
 * that accepted it would be looking at files the desktop never writes.
 *
 * Pure: it inspects the string only and never touches the filesystem.
 */

import * as path from 'path';

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const WINDOWS_SENSITIVE_ROOTS = [
	'\\Windows',
	'\\Program Files',
	'\\Program Files (x86)',
	'\\System',
	'\\System32',
	'\\SysWOW64',
];

const POSIX_SENSITIVE_ROOTS = [
	'/bin',
	'/sbin',
	'/usr/bin',
	'/usr/sbin',
	'/etc',
	'/var',
	'/tmp',
	'/dev',
	'/proc',
	'/sys',
];

/**
 * Why `customPath` cannot be a sync path, or `null` when it can.
 *
 * The reason is a complete sentence naming the path, ready to log.
 */
export function syncPathRejection(
	customPath: string,
	platform: NodeJS.Platform = process.platform
): string | null {
	const isWindows = platform === 'win32';
	const pathApi = isWindows ? path.win32 : path.posix;

	if (!pathApi.isAbsolute(customPath)) {
		return `Custom sync path must be absolute: ${customPath}`;
	}

	// Null bytes truncate the path at the syscall boundary on Unix.
	if (customPath.includes('\0')) {
		return `Custom sync path contains null bytes: ${customPath}`;
	}

	// Checked BEFORE normalization, which would quietly resolve the `..` away.
	if (customPath.split(/[/\\]/).includes('..')) {
		return `Custom sync path contains traversal sequences: ${customPath}`;
	}

	const normalizedPath = pathApi.normalize(customPath);

	// Shorter than `/a/b` or `C:\a` is almost certainly a system directory.
	if (normalizedPath.length < (isWindows ? 4 : 5)) {
		return `Custom sync path is too short: ${customPath}`;
	}

	if (isWindows) {
		for (const segment of normalizedPath.split(/[/\\]/)) {
			if (WINDOWS_RESERVED_NAME.test(segment.split('.')[0])) {
				return `Custom sync path contains Windows reserved name: ${customPath}`;
			}
		}
	}

	const lowerPath = normalizedPath.toLowerCase();
	const sensitive = `Custom sync path cannot be in sensitive system directory: ${customPath}`;

	if (isWindows) {
		// A sensitive root on ANY drive letter: C:\Windows, D:\Windows, ...
		if (/^[a-z]:/i.test(lowerPath)) {
			const pathWithoutDrive = lowerPath.slice(2);
			for (const root of WINDOWS_SENSITIVE_ROOTS) {
				const rootLower = root.toLowerCase();
				if (pathWithoutDrive === rootLower || pathWithoutDrive.startsWith(rootLower + '\\')) {
					return sensitive;
				}
			}
		}
	} else {
		for (const root of POSIX_SENSITIVE_ROOTS) {
			if (lowerPath === root || lowerPath.startsWith(root + '/')) {
				return sensitive;
			}
		}
	}

	return null;
}
