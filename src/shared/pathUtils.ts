/**
 * Shared path and version utility functions
 *
 * This module provides utilities used across multiple parts of the application.
 *
 * Consolidates duplicated logic from:
 * - agent-detector.ts (expandTilde, detectNodeVersionManagerBinPaths)
 * - ssh-command-builder.ts (expandPath)
 * - ssh-config-parser.ts (expandPath)
 * - ssh-remote-manager.ts (expandPath)
 * - process-manager.ts (inline tilde expansion, detectNodeVersionManagerPaths)
 * - update-checker.ts (version comparison)
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Expand tilde (~) to home directory in paths.
 *
 * Node.js fs functions don't understand shell tilde expansion,
 * so this function provides consistent tilde handling across the codebase.
 *
 * @param filePath - Path that may start with ~ or ~/
 * @param homeDir - Optional custom home directory (for testing/dependency injection)
 * @returns Expanded absolute path with ~ replaced by home directory
 *
 * @example
 * ```typescript
 * expandTilde('~/.ssh/id_rsa')   // '/Users/username/.ssh/id_rsa'
 * expandTilde('~')               // '/Users/username'
 * expandTilde('/absolute/path') // '/absolute/path' (unchanged)
 * expandTilde('~/config', '/custom/home') // '/custom/home/config'
 * ```
 */
export function expandTilde(filePath: string, homeDir?: string): string {
	if (!filePath) {
		return filePath;
	}

	const home = homeDir ?? os.homedir();

	if (filePath === '~') {
		return home;
	}

	if (filePath.startsWith('~/')) {
		return path.join(home, filePath.slice(2));
	}

	return filePath;
}

/**
 * Parse version string to comparable array of numbers.
 *
 * @param version - Version string (e.g., "v22.10.0" or "0.14.0")
 * @returns Array of version numbers (e.g., [22, 10, 0])
 *
 * @example
 * ```typescript
 * parseVersion('v22.10.0')  // [22, 10, 0]
 * parseVersion('0.14.0')    // [0, 14, 0]
 * ```
 */
export function parseVersion(version: string): number[] {
	const cleaned = version.replace(/^v/, '');
	return cleaned.split('.').map((n) => parseInt(n, 10) || 0);
}

/**
 * Compare two version strings.
 *
 * Returns: 1 if a > b, -1 if a < b, 0 if equal.
 * Handles versions with or without 'v' prefix.
 *
 * @param a - First version string
 * @param b - Second version string
 * @returns 1 if a > b, -1 if a < b, 0 if equal
 *
 * @example
 * ```typescript
 * compareVersions('v22.0.0', 'v20.0.0')  // 1 (a > b)
 * compareVersions('v18.0.0', 'v20.0.0')  // -1 (a < b)
 * compareVersions('v20.0.0', 'v20.0.0')  // 0 (equal)
 *
 * // For descending sort (highest first):
 * versions.sort((a, b) => compareVersions(b, a))
 *
 * // For ascending sort (lowest first):
 * versions.sort(compareVersions)
 * ```
 */
export function compareVersions(a: string, b: string): number {
	const partsA = parseVersion(a);
	const partsB = parseVersion(b);

	const maxLength = Math.max(partsA.length, partsB.length);

	for (let i = 0; i < maxLength; i++) {
		const numA = partsA[i] || 0;
		const numB = partsB[i] || 0;

		if (numA > numB) return 1;
		if (numA < numB) return -1;
	}

	return 0;
}

/**
 * Detect Node version manager bin paths on Unix systems (macOS/Linux).
 *
 * Checks for nvm, fnm, volta, mise, and asdf installations and returns their bin paths.
 * These paths are needed to find npm-installed CLIs (codex, claude, gemini, etc.) when
 * launched from GUI applications (Electron) that don't inherit shell PATH configuration.
 *
 * @returns Array of existing bin paths from detected version managers, sorted with newest versions first
 *
 * @example
 * ```typescript
 * const binPaths = detectNodeVersionManagerBinPaths();
 * // ['/Users/user/.nvm/versions/node/v22.10.0/bin', '/Users/user/.volta/bin', ...]
 * ```
 */
export function detectNodeVersionManagerBinPaths(): string[] {
	if (process.platform === 'win32') {
		return []; // Windows has different version manager paths handled elsewhere
	}

	const home = os.homedir();
	const detectedPaths: string[] = [];

	// nvm: Check for ~/.nvm and find installed node versions
	const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
	if (fs.existsSync(nvmDir)) {
		// Check nvm/current symlink first (preferred)
		const nvmCurrentBin = path.join(nvmDir, 'current', 'bin');
		if (fs.existsSync(nvmCurrentBin)) {
			detectedPaths.push(nvmCurrentBin);
		}

		// Also check all installed versions
		const versionsDir = path.join(nvmDir, 'versions', 'node');
		if (fs.existsSync(versionsDir)) {
			try {
				const versions = fs.readdirSync(versionsDir).filter((v) => v.startsWith('v'));
				// Sort versions descending to check newest first
				versions.sort((a, b) => compareVersions(b, a));
				for (const version of versions) {
					const versionBin = path.join(versionsDir, version, 'bin');
					if (fs.existsSync(versionBin) && !detectedPaths.includes(versionBin)) {
						detectedPaths.push(versionBin);
					}
				}
			} catch {
				// Ignore errors reading versions directory
			}
		}
	}

	// fnm: Fast Node Manager
	// - macOS: ~/Library/Application Support/fnm (default) or ~/.fnm
	// - Linux: ~/.local/share/fnm (default) or ~/.fnm
	const fnmPaths = [
		path.join(home, 'Library', 'Application Support', 'fnm'), // macOS default
		path.join(home, '.local', 'share', 'fnm'), // Linux default
		path.join(home, '.fnm'), // Legacy/custom location
	];
	for (const fnmDir of fnmPaths) {
		if (fs.existsSync(fnmDir)) {
			// fnm uses aliases/current or node-versions/<version>
			const fnmCurrentBin = path.join(fnmDir, 'aliases', 'default', 'bin');
			if (fs.existsSync(fnmCurrentBin)) {
				detectedPaths.push(fnmCurrentBin);
			}

			const fnmNodeVersions = path.join(fnmDir, 'node-versions');
			if (fs.existsSync(fnmNodeVersions)) {
				try {
					const versions = fs.readdirSync(fnmNodeVersions).filter((v) => v.startsWith('v'));
					versions.sort((a, b) => compareVersions(b, a));
					for (const version of versions) {
						const versionBin = path.join(fnmNodeVersions, version, 'installation', 'bin');
						if (fs.existsSync(versionBin)) {
							detectedPaths.push(versionBin);
						}
					}
				} catch {
					// Ignore errors
				}
			}
			break; // Only use the first fnm installation found
		}
	}

	// volta: Uses ~/.volta/bin for shims
	const voltaBin = path.join(home, '.volta', 'bin');
	if (fs.existsSync(voltaBin)) {
		detectedPaths.push(voltaBin);
	}

	// mise (formerly rtx): Uses ~/.local/share/mise/shims
	const miseShims = path.join(home, '.local', 'share', 'mise', 'shims');
	if (fs.existsSync(miseShims)) {
		detectedPaths.push(miseShims);
	}

	// asdf: Uses ~/.asdf/shims
	const asdfShims = path.join(home, '.asdf', 'shims');
	if (fs.existsSync(asdfShims)) {
		detectedPaths.push(asdfShims);
	}

	// n: Node version manager - uses /usr/local/n/versions or N_PREFIX
	const nPrefix = process.env.N_PREFIX || '/usr/local';
	const nBin = path.join(nPrefix, 'bin');
	// Only add if n is actually managing node (check for n binary)
	if (fs.existsSync(path.join(nPrefix, 'n', 'versions'))) {
		if (fs.existsSync(nBin)) {
			detectedPaths.push(nBin);
		}
	}

	return detectedPaths;
}
