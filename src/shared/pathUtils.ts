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
		// Use POSIX path separator for consistency, especially for SSH remote paths
		return `${home}/${filePath.slice(2)}`;
	}

	return filePath;
}

/**
 * Encode a project path the same way Claude Code does.
 * Claude replaces all non-alphanumeric characters with '-'.
 * See: https://github.com/RunMaestro/Maestro/issues/348
 */
export function encodeClaudeProjectPath(projectPath: string): string {
	return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Split a version string into its numeric part and optional pre-release suffix.
 *
 * @param version - Cleaned version string (no 'v' prefix), e.g., "0.15.0-rc.1"
 * @returns Tuple of [numericPart, prereleaseTag | undefined]
 *
 * @example
 * ```typescript
 * splitVersionParts('0.15.0')       // ['0.15.0', undefined]
 * splitVersionParts('0.15.0-rc.1')  // ['0.15.0', 'rc.1']
 * ```
 */
function splitVersionParts(version: string): [string, string | undefined] {
	const dashIndex = version.indexOf('-');
	if (dashIndex === -1) return [version, undefined];
	return [version.substring(0, dashIndex), version.substring(dashIndex + 1)];
}

/**
 * Parse version string to comparable array of numbers.
 * Pre-release suffixes (e.g., -rc.1, -beta.2) are stripped before parsing.
 *
 * @param version - Version string (e.g., "v22.10.0" or "0.14.0" or "0.15.0-rc.1")
 * @returns Array of version numbers (e.g., [22, 10, 0])
 *
 * @example
 * ```typescript
 * parseVersion('v22.10.0')      // [22, 10, 0]
 * parseVersion('0.14.0')        // [0, 14, 0]
 * parseVersion('0.15.0-rc.1')   // [0, 15, 0]
 * ```
 */
export function parseVersion(version: string): number[] {
	const cleaned = version.replace(/^v/, '');
	const [numericPart] = splitVersionParts(cleaned);
	return numericPart.split('.').map((n) => parseInt(n, 10) || 0);
}

/**
 * Compare two version strings following semver pre-release rules.
 *
 * Returns: 1 if a > b, -1 if a < b, 0 if equal.
 * Handles versions with or without 'v' prefix, and pre-release suffixes.
 *
 * Per semver: a pre-release version has lower precedence than the same
 * version without a pre-release suffix (e.g., 0.15.0-rc.1 < 0.15.0).
 * When both versions have pre-release suffixes with the same numeric base,
 * they are compared lexically.
 *
 * @param a - First version string
 * @param b - Second version string
 * @returns 1 if a > b, -1 if a < b, 0 if equal
 *
 * @example
 * ```typescript
 * compareVersions('v22.0.0', 'v20.0.0')        // 1 (a > b)
 * compareVersions('v18.0.0', 'v20.0.0')        // -1 (a < b)
 * compareVersions('v20.0.0', 'v20.0.0')        // 0 (equal)
 * compareVersions('0.15.0-rc.1', '0.15.0')     // -1 (prerelease < stable)
 * compareVersions('0.15.0', '0.15.0-rc.1')     // 1 (stable > prerelease)
 * compareVersions('0.15.0-rc.1', '0.15.0-rc.2') // -1 (rc.1 < rc.2)
 *
 * // For descending sort (highest first):
 * versions.sort((a, b) => compareVersions(b, a))
 *
 * // For ascending sort (lowest first):
 * versions.sort(compareVersions)
 * ```
 */
export function compareVersions(a: string, b: string): number {
	const cleanA = a.replace(/^v/, '');
	const cleanB = b.replace(/^v/, '');

	const [numA, preA] = splitVersionParts(cleanA);
	const [numB, preB] = splitVersionParts(cleanB);

	const partsA = numA.split('.').map((n) => parseInt(n, 10) || 0);
	const partsB = numB.split('.').map((n) => parseInt(n, 10) || 0);

	const maxLength = Math.max(partsA.length, partsB.length);

	for (let i = 0; i < maxLength; i++) {
		const na = partsA[i] || 0;
		const nb = partsB[i] || 0;

		if (na > nb) return 1;
		if (na < nb) return -1;
	}

	// Numeric parts are equal — apply semver pre-release rules:
	// A version without a pre-release suffix has higher precedence
	if (!preA && preB) return 1; // 0.15.0 > 0.15.0-rc.1
	if (preA && !preB) return -1; // 0.15.0-rc.1 < 0.15.0
	if (!preA && !preB) return 0; // both stable, equal

	// Both have pre-release suffixes — compare lexically
	if (preA! < preB!) return -1;
	if (preA! > preB!) return 1;
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
	const safeExistsSync =
		typeof fs.existsSync === 'function' ? fs.existsSync.bind(fs) : () => false;

	// nvm: Check for ~/.nvm and find installed node versions
	const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
	if (safeExistsSync(nvmDir)) {
		// Check nvm/current symlink first (preferred)
		const nvmCurrentBin = path.join(nvmDir, 'current', 'bin');
		if (safeExistsSync(nvmCurrentBin)) {
			detectedPaths.push(nvmCurrentBin);
		}

		// Also check all installed versions
		const versionsDir = path.join(nvmDir, 'versions', 'node');
		if (safeExistsSync(versionsDir)) {
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
		if (safeExistsSync(fnmDir)) {
			// fnm uses aliases/current or node-versions/<version>
			const fnmCurrentBin = path.join(fnmDir, 'aliases', 'default', 'bin');
			if (safeExistsSync(fnmCurrentBin)) {
				detectedPaths.push(fnmCurrentBin);
			}

			const fnmNodeVersions = path.join(fnmDir, 'node-versions');
			if (safeExistsSync(fnmNodeVersions)) {
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
	if (safeExistsSync(voltaBin)) {
		detectedPaths.push(voltaBin);
	}

	// mise (formerly rtx): Uses ~/.local/share/mise/shims
	const miseShims = path.join(home, '.local', 'share', 'mise', 'shims');
	if (safeExistsSync(miseShims)) {
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

/**
 * Build an expanded PATH string with common binary installation locations.
 *
 * This consolidates PATH building logic used across the application to ensure
 * consistency and prevent duplication. Handles platform differences automatically.
 *
 * @param customPaths - Optional additional paths to prepend to PATH
 * @returns Expanded PATH string with platform-appropriate paths included
 *
 * @example
 * ```typescript
 * const expandedPath = buildExpandedPath();
 * // Returns PATH with common binary locations added
 *
 * const customPath = buildExpandedPath(['/custom/bin']);
 * // Returns PATH with custom paths + common locations
 * ```
 */
export function buildExpandedPath(customPaths?: string[]): string {
	const isWindows = process.platform === 'win32';
	const delimiter = path.delimiter;
	const home = os.homedir();
	const versionManagerPaths = detectNodeVersionManagerBinPaths();

	// Start with current PATH
	const currentPath = process.env.PATH || '';
	const pathParts = currentPath.split(delimiter);

	// Platform-specific additional paths
	let additionalPaths: string[];

	if (isWindows) {
		const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
		const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
		const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
		const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
		const systemRoot = process.env.SystemRoot || 'C:\\Windows';

		additionalPaths = [
			// .NET SDK installations
			path.join(programFiles, 'dotnet'),
			path.join(programFilesX86, 'dotnet'),
			// Claude Code PowerShell installer
			path.join(home, '.local', 'bin'),
			// Claude Code winget install
			path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
			path.join(programFiles, 'WinGet', 'Links'),
			path.join(localAppData, 'Microsoft', 'WinGet', 'Packages'),
			path.join(programFiles, 'WinGet', 'Packages'),
			// npm global installs
			path.join(appData, 'npm'),
			path.join(localAppData, 'npm'),
			// Claude Code CLI install location (npm global)
			path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli'),
			// Codex CLI install location (npm global)
			path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin'),
			// Gemini CLI install location (npm global)
			path.join(appData, 'npm', 'node_modules', '@google', 'gemini-cli', 'bin'),
			// User local programs
			path.join(localAppData, 'Programs'),
			path.join(localAppData, 'Microsoft', 'WindowsApps'),
			// Python/pip user installs
			path.join(appData, 'Python', 'Scripts'),
			path.join(localAppData, 'Programs', 'Python', 'Python312', 'Scripts'),
			path.join(localAppData, 'Programs', 'Python', 'Python311', 'Scripts'),
			path.join(localAppData, 'Programs', 'Python', 'Python310', 'Scripts'),
			// Git for Windows
			path.join(programFiles, 'Git', 'cmd'),
			path.join(programFiles, 'Git', 'bin'),
			path.join(programFiles, 'Git', 'usr', 'bin'),
			path.join(programFilesX86, 'Git', 'cmd'),
			path.join(programFilesX86, 'Git', 'bin'),
			// Node.js
			path.join(programFiles, 'nodejs'),
			path.join(localAppData, 'Programs', 'node'),
			// Cloudflared
			path.join(programFiles, 'cloudflared'),
			// Scoop package manager
			path.join(home, 'scoop', 'shims'),
			path.join(home, 'scoop', 'apps', 'opencode', 'current'),
			// Chocolatey
			path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin'),
			// Go binaries
			path.join(home, 'go', 'bin'),
			// Windows system paths
			path.join(systemRoot, 'System32'),
			path.join(systemRoot),
			// Windows OpenSSH
			path.join(systemRoot, 'System32', 'OpenSSH'),
		];
	} else {
		// Unix-like paths (macOS/Linux)
		additionalPaths = [
			'/opt/homebrew/bin', // Homebrew on Apple Silicon
			'/opt/homebrew/sbin',
			'/usr/local/bin', // Homebrew on Intel, common install location
			'/usr/local/sbin',
			`${home}/.local/bin`, // User local installs (pip, etc.)
			`${home}/.npm-global/bin`, // npm global with custom prefix
			`${home}/bin`, // User bin directory
			`${home}/.claude/local`, // Claude local install location
			`${home}/.opencode/bin`, // OpenCode installer default location
			'/usr/bin',
			'/bin',
			'/usr/sbin',
			'/sbin',
			...versionManagerPaths,
		];
	}

	// Add custom paths first (if provided)
	if (customPaths && customPaths.length > 0) {
		for (const p of customPaths) {
			if (!pathParts.includes(p)) {
				pathParts.unshift(p);
			}
		}
	}

	// Add standard additional paths
	for (const p of additionalPaths) {
		if (!pathParts.includes(p)) {
			pathParts.unshift(p);
		}
	}

	return pathParts.join(delimiter);
}

/**
 * Build an expanded environment object with common binary installation locations in PATH.
 *
 * This creates a complete environment object (copy of process.env) with an expanded PATH
 * that includes platform-specific binary locations. Useful for spawning processes that
 * need access to tools not in the default PATH.
 *
 * @param customEnvVars - Optional additional environment variables to set
 * @returns Complete environment object with expanded PATH
 *
 * @example
 * ```typescript
 * const env = buildExpandedEnv({ NODE_ENV: 'development' });
 * // Returns process.env copy with expanded PATH + custom vars
 * ```
 */
export function buildExpandedEnv(customEnvVars?: Record<string, string>): NodeJS.ProcessEnv {
	const env = { ...process.env };
	env.PATH = buildExpandedPath();

	// Apply custom environment variables
	if (customEnvVars && Object.keys(customEnvVars).length > 0) {
		const home = os.homedir();
		for (const [key, value] of Object.entries(customEnvVars)) {
			env[key] = value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
		}
	}

	return env;
}
