/**
 * Binary Path Detection Utilities
 *
 * Packaged Electron apps don't inherit shell environment, so we need to
 * probe known installation paths directly.
 *
 * Detection Strategy:
 * 1. Direct file system probing of known installation paths (fastest, most reliable)
 * 2. Fall back to which/where command with expanded PATH
 *
 * This two-tier approach ensures we find binaries even when:
 * - PATH is not inherited correctly
 * - Binaries are in non-standard locations
 * - Shell initialization files (.bashrc, .zshrc) aren't sourced
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { getShellPath } from '../runtime/getShellPath';
import { execFileNoThrow } from '../utils/execFile';
import { logger } from '../utils/logger';
import { expandTilde, detectNodeVersionManagerBinPaths } from '../../shared/pathUtils';
import { isWindows, getWhichCommand } from '../../shared/platformDetection';

const LOG_CONTEXT = 'PathProber';

// ============ Types ============

export interface BinaryDetectionResult {
	exists: boolean;
	path?: string;
	paths?: string[];
}

// ============ Environment Expansion ============

/**
 * Build an expanded PATH that includes common binary installation locations.
 * This is necessary because packaged Electron apps don't inherit shell environment.
 */
export function getExpandedEnv(): NodeJS.ProcessEnv {
	const home = os.homedir();
	const env = { ...process.env };

	// Platform-specific paths
	let additionalPaths: string[];

	if (isWindows()) {
		// Windows-specific paths
		const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
		const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
		const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
		const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

		additionalPaths = [
			// Claude Code PowerShell installer (irm https://claude.ai/install.ps1 | iex)
			// This is the primary installation method - installs claude.exe to ~/.local/bin
			path.join(home, '.local', 'bin'),
			// Claude Code winget install (winget install --id Anthropic.ClaudeCode)
			path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
			path.join(programFiles, 'WinGet', 'Links'),
			path.join(localAppData, 'Microsoft', 'WinGet', 'Packages'),
			path.join(programFiles, 'WinGet', 'Packages'),
			// npm global installs (Claude Code, Codex CLI, Gemini CLI)
			path.join(appData, 'npm'),
			path.join(localAppData, 'npm'),
			// Claude Code CLI install location (npm global)
			path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli'),
			// Codex CLI install location (npm global)
			path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin'),
			// User local programs
			path.join(localAppData, 'Programs'),
			path.join(localAppData, 'Microsoft', 'WindowsApps'),
			// Python/pip user installs (for Aider)
			path.join(appData, 'Python', 'Scripts'),
			path.join(localAppData, 'Programs', 'Python', 'Python312', 'Scripts'),
			path.join(localAppData, 'Programs', 'Python', 'Python311', 'Scripts'),
			path.join(localAppData, 'Programs', 'Python', 'Python310', 'Scripts'),
			// Git for Windows (provides bash, common tools)
			path.join(programFiles, 'Git', 'cmd'),
			path.join(programFiles, 'Git', 'bin'),
			path.join(programFiles, 'Git', 'usr', 'bin'),
			path.join(programFilesX86, 'Git', 'cmd'),
			path.join(programFilesX86, 'Git', 'bin'),
			// Node.js
			path.join(programFiles, 'nodejs'),
			path.join(localAppData, 'Programs', 'node'),
			// Node Version Manager for Windows (nvm4w) - OpenCode commonly installed here
			'C:\\nvm4w\\nodejs',
			path.join(home, 'nvm4w', 'nodejs'),
			// Volta - Node version manager for Windows/macOS/Linux (installs shims to .volta/bin)
			path.join(home, '.volta', 'bin'),
			// Scoop package manager (OpenCode, other tools)
			path.join(home, 'scoop', 'shims'),
			path.join(home, 'scoop', 'apps', 'opencode', 'current'),
			// Chocolatey (OpenCode, other tools)
			path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin'),
			// Go binaries (some tools installed via 'go install')
			path.join(home, 'go', 'bin'),
			// Windows system paths
			path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
			path.join(process.env.SystemRoot || 'C:\\Windows'),
		];
	} else {
		// Unix-like paths (macOS/Linux)
		additionalPaths = [
			...detectNodeVersionManagerBinPaths(),
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
		];
	}

	const currentPath = env.PATH || '';
	// Use platform-appropriate path delimiter
	const pathParts = currentPath.split(path.delimiter);

	// Add paths that aren't already present
	for (const p of additionalPaths) {
		if (!pathParts.includes(p)) {
			pathParts.unshift(p);
		}
	}

	env.PATH = pathParts.join(path.delimiter);
	return env;
}

/**
 * Merge shell-provided PATH entries (when available) into an env object.
 * Shell PATH entries are prioritized (prepended) but de-duplicated.
 */
export async function getExpandedEnvWithShell(): Promise<NodeJS.ProcessEnv> {
	const env = getExpandedEnv();
	try {
		const shellPath = await getShellPath();
		if (!shellPath) return env;

		const delim = path.delimiter;
		const shellParts = shellPath.split(delim).filter(Boolean);
		const currentParts = env.PATH!.split(delim).filter(Boolean);

		const merged: string[] = [];
		// Start with shell parts to prioritize them
		for (const p of shellParts) {
			if (!merged.includes(p)) merged.push(p);
		}
		for (const p of currentParts) {
			if (!merged.includes(p)) merged.push(p);
		}

		env.PATH = merged.join(delim);
		return env;
	} catch (err) {
		// If shell probing fails, log debug so diagnostics can distinguish
		// a probe failure from an absent shell PATH, then fall back to base env.
		try {
			logger.debug('Shell PATH probe failed; using base expanded env', LOG_CONTEXT, { err });
		} catch {
			// Safe fallback if logger is not available
			console.debug('Shell PATH probe failed; using base expanded env', err);
		}
		return env;
	}
}

// ============ Custom Path Validation ============

/**
 * Check if a custom path points to a valid executable
 * On Windows, also tries .cmd and .exe extensions if the path doesn't exist as-is
 */
export async function checkCustomPath(customPath: string): Promise<BinaryDetectionResult> {
	// Expand tilde to home directory (Node.js fs doesn't understand ~)
	const expandedPath = expandTilde(customPath);

	// Helper to check if a specific path exists and is a file
	const checkPath = async (pathToCheck: string): Promise<boolean> => {
		try {
			const stats = await fs.promises.stat(pathToCheck);
			return stats.isFile();
		} catch {
			return false;
		}
	};

	try {
		// First, try the exact path provided (with tilde expanded)
		if (await checkPath(expandedPath)) {
			// Check if file is executable (on Unix systems)
			if (!isWindows()) {
				try {
					await fs.promises.access(expandedPath, fs.constants.X_OK);
				} catch {
					logger.warn(`Custom path exists but is not executable: ${customPath}`, LOG_CONTEXT);
					return { exists: false };
				}
			}
			// Return the expanded path so it can be used directly
			return { exists: true, path: expandedPath };
		}

		// On Windows, if the exact path doesn't exist, try with .cmd and .exe extensions
		if (isWindows()) {
			const lowerPath = expandedPath.toLowerCase();
			// Only try extensions if the path doesn't already have one
			if (!lowerPath.endsWith('.cmd') && !lowerPath.endsWith('.exe')) {
				// Try .exe first (preferred), then .cmd
				const exePath = expandedPath + '.exe';
				if (await checkPath(exePath)) {
					logger.debug(`Custom path resolved with .exe extension`, LOG_CONTEXT, {
						original: customPath,
						resolved: exePath,
					});
					return { exists: true, path: exePath };
				}

				const cmdPath = expandedPath + '.cmd';
				if (await checkPath(cmdPath)) {
					logger.debug(`Custom path resolved with .cmd extension`, LOG_CONTEXT, {
						original: customPath,
						resolved: cmdPath,
					});
					return { exists: true, path: cmdPath };
				}
			}
		}

		return { exists: false };
	} catch (error) {
		logger.debug(`Error checking custom path: ${customPath}`, LOG_CONTEXT, { error });
		return { exists: false };
	}
}

// ============ Windows Path Probing ============

/**
 * Known installation paths for binaries on Windows
 */
function getWindowsKnownPaths(binaryName: string): string[] {
	const home = os.homedir();
	const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
	const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
	const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

	// Common path builders to reduce duplication across binary definitions
	const npmGlobal = (bin: string) => [
		path.join(appData, 'npm', `${bin}.cmd`),
		path.join(localAppData, 'npm', `${bin}.cmd`),
	];
	const localBin = (bin: string) => [path.join(home, '.local', 'bin', `${bin}.exe`)];
	const wingetLinks = (bin: string) => [
		path.join(localAppData, 'Microsoft', 'WinGet', 'Links', `${bin}.exe`),
		path.join(programFiles, 'WinGet', 'Links', `${bin}.exe`),
	];
	const goBin = (bin: string) => [path.join(home, 'go', 'bin', `${bin}.exe`)];
	const pythonScripts = (bin: string) => [
		path.join(appData, 'Python', 'Scripts', `${bin}.exe`),
		path.join(localAppData, 'Programs', 'Python', 'Python312', 'Scripts', `${bin}.exe`),
		path.join(localAppData, 'Programs', 'Python', 'Python311', 'Scripts', `${bin}.exe`),
		path.join(localAppData, 'Programs', 'Python', 'Python310', 'Scripts', `${bin}.exe`),
	];

	// Define known installation paths for each binary, in priority order
	// Prefer .exe (standalone installers) over .cmd (npm wrappers)
	const knownPaths: Record<string, string[]> = {
		claude: [
			// PowerShell installer (primary method) - installs claude.exe
			...localBin('claude'),
			// Winget installation
			...wingetLinks('claude'),
			// npm global installation - creates .cmd wrapper
			...npmGlobal('claude'),
			// WindowsApps (Microsoft Store style)
			path.join(localAppData, 'Microsoft', 'WindowsApps', 'claude.exe'),
		],
		codex: [
			// npm global installation (primary method for Codex)
			...npmGlobal('codex'),
			// Possible standalone in future
			...localBin('codex'),
		],
		opencode: [
			// Scoop installation (recommended for OpenCode)
			path.join(home, 'scoop', 'shims', 'opencode.exe'),
			path.join(home, 'scoop', 'apps', 'opencode', 'current', 'opencode.exe'),
			// Volta - Node version manager (OpenCode commonly installed via Volta)
			path.join(home, '.volta', 'bin', 'opencode'),
			path.join(home, '.volta', 'bin', 'opencode.cmd'),
			// Chocolatey installation
			path.join(
				process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey',
				'bin',
				'opencode.exe'
			),
			// Go install
			...goBin('opencode'),
			// npm (has known issues on Windows, but check anyway)
			...npmGlobal('opencode'),
		],
		gemini: [
			// npm global installation
			...npmGlobal('gemini'),
		],
		aider: [
			// pip installation
			...pythonScripts('aider'),
		],
	};

	return knownPaths[binaryName] || [];
}

function dedupePaths(pathsToDedupe: string[]): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];

	for (const candidate of pathsToDedupe) {
		const trimmed = candidate.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		deduped.push(trimmed);
	}

	return deduped;
}

function sortWindowsCandidates(candidates: string[]): string[] {
	const dedupedCandidates = dedupePaths(candidates);
	const exeCandidates = dedupedCandidates.filter((p) => p.toLowerCase().endsWith('.exe'));
	const cmdCandidates = dedupedCandidates.filter((p) => p.toLowerCase().endsWith('.cmd'));
	const extensionlessCandidates = dedupedCandidates.filter(
		(p) => !p.toLowerCase().endsWith('.exe') && !p.toLowerCase().endsWith('.cmd')
	);

	return dedupePaths([...exeCandidates, ...extensionlessCandidates, ...cmdCandidates]);
}

/**
 * On Windows, directly probe known installation paths for a binary.
 * This is more reliable than `where` command which may fail in packaged Electron apps.
 * Returns the first existing path found (in priority order), preferring .exe over .cmd.
 *
 * Uses parallel probing for performance on slow file systems.
 */
export async function probeWindowsPaths(binaryName: string): Promise<string | null> {
	const candidates = await probeWindowsPathCandidates(binaryName);
	return candidates[0] ?? null;
}

export async function probeWindowsPathCandidates(binaryName: string): Promise<string[]> {
	const pathsToCheck = getWindowsKnownPaths(binaryName);

	if (pathsToCheck.length === 0) {
		return [];
	}

	// Check all paths in parallel for performance
	const results = await Promise.allSettled(
		pathsToCheck.map(async (probePath) => {
			await fs.promises.access(probePath, fs.constants.F_OK);
			return probePath;
		})
	);

	const candidates: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		if (result.status === 'fulfilled') {
			logger.debug(`Direct probe found ${binaryName}`, LOG_CONTEXT, { path: result.value });
			candidates.push(result.value);
		}
	}

	return dedupePaths(candidates);
}

// ============ Unix Path Probing ============

/**
 * Known installation paths for binaries on Unix-like systems
 */
function getUnixKnownPaths(binaryName: string): string[] {
	const home = os.homedir();

	// Get dynamic paths from Node version managers (nvm, fnm, volta, etc.)
	const versionManagerPaths = detectNodeVersionManagerBinPaths();

	// Common path builders to reduce duplication across binary definitions
	const homebrew = (bin: string) => [`/opt/homebrew/bin/${bin}`, `/usr/local/bin/${bin}`];
	const localBin = (bin: string) => [path.join(home, '.local', 'bin', bin)];
	const npmGlobal = (bin: string) => [path.join(home, '.npm-global', 'bin', bin)];
	const nodeVersionManagers = (bin: string) => versionManagerPaths.map((p) => path.join(p, bin));

	// Define known installation paths for each binary, in priority order
	const knownPaths: Record<string, string[]> = {
		claude: [
			// Claude Code default installation location
			path.join(home, '.claude', 'local', 'claude'),
			// User local bin (pip, manual installs)
			...localBin('claude'),
			// Homebrew (Apple Silicon + Intel)
			...homebrew('claude'),
			// npm global with custom prefix
			...npmGlobal('claude'),
			// User bin directory
			path.join(home, 'bin', 'claude'),
			// Node version managers (nvm, fnm, volta, etc.)
			...nodeVersionManagers('claude'),
		],
		codex: [
			// User local bin
			...localBin('codex'),
			// Homebrew paths
			...homebrew('codex'),
			// npm global
			...npmGlobal('codex'),
			// Node version managers (nvm, fnm, volta, etc.)
			...nodeVersionManagers('codex'),
		],
		opencode: [
			// OpenCode installer default location
			path.join(home, '.opencode', 'bin', 'opencode'),
			// Go install location
			path.join(home, 'go', 'bin', 'opencode'),
			// User local bin
			...localBin('opencode'),
			// Homebrew paths
			...homebrew('opencode'),
			// Node version managers (nvm, fnm, volta, etc.)
			...nodeVersionManagers('opencode'),
		],
		gemini: [
			// npm global paths
			...npmGlobal('gemini'),
			// Homebrew paths
			...homebrew('gemini'),
			// Node version managers (nvm, fnm, volta, etc.)
			...nodeVersionManagers('gemini'),
		],
		aider: [
			// pip installation
			...localBin('aider'),
			// Homebrew paths
			...homebrew('aider'),
			// Node version managers (in case installed via npm)
			...nodeVersionManagers('aider'),
		],
	};

	return knownPaths[binaryName] || [];
}

/**
 * On macOS/Linux, directly probe known installation paths for a binary.
 * This is necessary because packaged Electron apps don't inherit shell aliases,
 * and 'which' may fail to find binaries in non-standard locations.
 * Returns the first existing executable path found (in priority order).
 *
 * Uses parallel probing for performance on slow file systems.
 */
export async function probeUnixPaths(binaryName: string): Promise<string | null> {
	const candidates = await probeUnixPathCandidates(binaryName);
	return candidates[0] ?? null;
}

export async function probeUnixPathCandidates(binaryName: string): Promise<string[]> {
	const pathsToCheck = getUnixKnownPaths(binaryName);

	if (pathsToCheck.length === 0) {
		return [];
	}

	// Check all paths in parallel for performance
	const results = await Promise.allSettled(
		pathsToCheck.map(async (probePath) => {
			// Check both existence and executability
			await fs.promises.access(probePath, fs.constants.F_OK | fs.constants.X_OK);
			return probePath;
		})
	);

	const candidates: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		if (result.status === 'fulfilled') {
			logger.debug(`Direct probe found ${binaryName}`, LOG_CONTEXT, { path: result.value });
			candidates.push(result.value);
		}
	}

	return dedupePaths(candidates);
}

async function scanPathCandidates(binaryName: string): Promise<string[]> {
	const env = await getExpandedEnvWithShell();
	const pathParts = (env.PATH || '').split(path.delimiter).filter(Boolean);
	const candidates: string[] = [];

	for (const pathPart of pathParts) {
		if (isWindows()) {
			const basePath = path.join(pathPart, binaryName);
			const candidatePaths = binaryName.toLowerCase().endsWith('.exe')
				? [basePath]
				: binaryName.toLowerCase().endsWith('.cmd')
					? [basePath]
					: [`${basePath}.exe`, basePath, `${basePath}.cmd`];

			for (const candidate of candidatePaths) {
				try {
					await fs.promises.access(candidate, fs.constants.F_OK);
					candidates.push(candidate);
				} catch {
					// Continue probing remaining PATH entries.
				}
			}
		} else {
			const candidate = path.join(pathPart, binaryName);
			try {
				await fs.promises.access(candidate, fs.constants.F_OK | fs.constants.X_OK);
				candidates.push(candidate);
			} catch {
				// Continue probing remaining PATH entries.
			}
		}
	}

	return dedupePaths(candidates);
}

async function lookupCommandCandidates(binaryName: string): Promise<string[]> {
	try {
		const command = getWhichCommand();
		const env = await getExpandedEnvWithShell();
		const result = await execFileNoThrow(command, [binaryName], undefined, env);

		if (result.exitCode !== 0 || !result.stdout.trim()) {
			return [];
		}

		const matches = result.stdout
			.trim()
			.split(/\r?\n/)
			.map((p) => p.trim())
			.filter(Boolean);

		if (!isWindows()) {
			return matches;
		}

		const resolvedMatches: string[] = [];
		for (const match of matches) {
			if (match.toLowerCase().endsWith('.exe') || match.toLowerCase().endsWith('.cmd')) {
				resolvedMatches.push(match);
				continue;
			}

			const exePath = `${match}.exe`;
			const cmdPath = `${match}.cmd`;
			try {
				await fs.promises.access(exePath, fs.constants.F_OK);
				resolvedMatches.push(exePath);
				logger.debug(`Found .exe version of ${binaryName}`, LOG_CONTEXT, {
					path: exePath,
				});
				continue;
			} catch {
				try {
					await fs.promises.access(cmdPath, fs.constants.F_OK);
					resolvedMatches.push(cmdPath);
					logger.debug(`Found .cmd version of ${binaryName}`, LOG_CONTEXT, {
						path: cmdPath,
					});
					continue;
				} catch {
					resolvedMatches.push(match);
				}
			}
		}

		return resolvedMatches;
	} catch {
		return [];
	}
}

export async function findBinaryCandidates(binaryName: string): Promise<string[]> {
	const directCandidates = isWindows()
		? await probeWindowsPathCandidates(binaryName)
		: await probeUnixPathCandidates(binaryName);
	const pathCandidates = await scanPathCandidates(binaryName);
	const candidatesBeforeLookup = dedupePaths([...directCandidates, ...pathCandidates]);
	const lookupCandidates =
		candidatesBeforeLookup.length === 0 ? await lookupCommandCandidates(binaryName) : [];

	if (!isWindows()) {
		return dedupePaths([...candidatesBeforeLookup, ...lookupCandidates]);
	}

	const candidates = dedupePaths([...candidatesBeforeLookup, ...lookupCandidates]);
	return sortWindowsCandidates(candidates);
}

// ============ Binary Detection ============

/**
 * Check if a binary exists in PATH or known installation locations.
 * On Windows, this also handles .cmd and .exe extensions properly.
 *
 * Detection order:
 * 1. Direct probe of known installation paths (most reliable)
 * 2. Fall back to which/where command with expanded PATH
 */
export async function checkBinaryExists(binaryName: string): Promise<BinaryDetectionResult> {
	const directCandidates = isWindows()
		? sortWindowsCandidates(await probeWindowsPathCandidates(binaryName))
		: await probeUnixPathCandidates(binaryName);
	if (directCandidates.length > 0) {
		return { exists: true, path: directCandidates[0], paths: directCandidates };
	}

	if (isWindows()) {
		logger.debug(`Direct probe failed for ${binaryName}, falling back to where`, LOG_CONTEXT);
	} else {
		logger.debug(`Direct probe failed for ${binaryName}, falling back to which`, LOG_CONTEXT);
	}

	const lookupCandidates = await lookupCommandCandidates(binaryName);
	const candidates = isWindows() ? sortWindowsCandidates(lookupCandidates) : lookupCandidates;
	if (candidates.length > 0) {
		return { exists: true, path: candidates[0], paths: candidates };
	}

	return { exists: false };
}
