import { execFileNoThrow } from './execFile';
import * as os from 'os';
import * as path from 'path';

let cloudflaredInstalledCache: boolean | null = null;
let cloudflaredPathCache: string | null = null;

let ghInstalledCache: boolean | null = null;
let ghPathCache: string | null = null;
let ghAuthenticatedCache: boolean | null = null;
let ghStatusCacheTime: number | null = null;
const GH_STATUS_CACHE_TTL_MS = 60000; // 1 minute TTL for auth status

/**
 * Build an expanded PATH that includes common binary installation locations.
 * This is necessary because packaged Electron apps don't inherit shell environment.
 */
export function getExpandedEnv(): NodeJS.ProcessEnv {
	const home = os.homedir();
	const env = { ...process.env };
	const isWindows = process.platform === 'win32';

	// Platform-specific paths
	let additionalPaths: string[];

	if (isWindows) {
		const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
		const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
		const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

		additionalPaths = [
			path.join(appData, 'npm'),
			path.join(localAppData, 'npm'),
			path.join(programFiles, 'cloudflared'),
			path.join(home, 'scoop', 'shims'),
			path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin'),
			path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
		];
	} else {
		additionalPaths = [
			'/opt/homebrew/bin', // Homebrew on Apple Silicon
			'/opt/homebrew/sbin',
			'/usr/local/bin', // Homebrew on Intel, common install location
			'/usr/local/sbin',
			`${home}/.local/bin`, // User local installs
			`${home}/bin`, // User bin directory
			'/usr/bin',
			'/bin',
			'/usr/sbin',
			'/sbin',
		];
	}

	const currentPath = env.PATH || '';
	const pathParts = currentPath.split(path.delimiter);

	for (const p of additionalPaths) {
		if (!pathParts.includes(p)) {
			pathParts.unshift(p);
		}
	}

	env.PATH = pathParts.join(path.delimiter);
	return env;
}

export async function isCloudflaredInstalled(): Promise<boolean> {
	// Return cached result if available
	if (cloudflaredInstalledCache !== null) {
		return cloudflaredInstalledCache;
	}

	// Use 'which' on macOS/Linux, 'where' on Windows
	const command = process.platform === 'win32' ? 'where' : 'which';
	const env = getExpandedEnv();
	const result = await execFileNoThrow(command, ['cloudflared'], undefined, env);

	if (result.exitCode === 0 && result.stdout.trim()) {
		cloudflaredInstalledCache = true;
		cloudflaredPathCache = result.stdout.trim().split('\n')[0];
	} else {
		cloudflaredInstalledCache = false;
	}

	return cloudflaredInstalledCache;
}

export function getCloudflaredPath(): string | null {
	return cloudflaredPathCache;
}

export function clearCloudflaredCache(): void {
	cloudflaredInstalledCache = null;
	cloudflaredPathCache = null;
}

/**
 * Check if GitHub CLI (gh) is installed and cache the result.
 * Uses platform-appropriate detection: 'where' on Windows, 'which' on Unix.
 */
export async function isGhInstalled(): Promise<boolean> {
	// Return cached result if available
	if (ghInstalledCache !== null) {
		return ghInstalledCache;
	}

	// Use 'which' on macOS/Linux, 'where' on Windows
	const command = process.platform === 'win32' ? 'where' : 'which';
	const env = getExpandedEnv();
	const result = await execFileNoThrow(command, ['gh'], undefined, env);

	if (result.exitCode === 0 && result.stdout.trim()) {
		ghInstalledCache = true;
		// On Windows, 'where' can return multiple paths - take the first one
		ghPathCache = result.stdout.trim().split('\n')[0];
	} else {
		ghInstalledCache = false;
	}

	return ghInstalledCache;
}

/**
 * Get the cached path to the gh CLI binary.
 * Returns null if gh is not installed or detection hasn't run yet.
 */
export function getGhPath(): string | null {
	return ghPathCache;
}

/**
 * Get the gh CLI path, auto-detecting if not already cached.
 * Allows override with a custom path.
 * @param customPath Optional custom path to gh binary
 * @returns The path to use for gh commands
 */
export async function resolveGhPath(customPath?: string): Promise<string> {
	if (customPath) {
		return customPath;
	}

	// Ensure detection has run
	await isGhInstalled();

	// Return cached path or fallback to 'gh'
	return ghPathCache || 'gh';
}

export function clearGhCache(): void {
	ghInstalledCache = null;
	ghPathCache = null;
	ghAuthenticatedCache = null;
	ghStatusCacheTime = null;
}

/**
 * Get cached gh CLI status (installed + authenticated).
 * Returns null if cache is empty or expired.
 */
export function getCachedGhStatus(): { installed: boolean; authenticated: boolean } | null {
	if (ghInstalledCache === null) {
		return null;
	}

	// If not installed, we don't need to check TTL
	if (!ghInstalledCache) {
		return { installed: false, authenticated: false };
	}

	// Check if authenticated cache is valid
	if (ghAuthenticatedCache !== null && ghStatusCacheTime !== null) {
		const age = Date.now() - ghStatusCacheTime;
		if (age < GH_STATUS_CACHE_TTL_MS) {
			return { installed: true, authenticated: ghAuthenticatedCache };
		}
	}

	return null;
}

/**
 * Set cached gh CLI status.
 */
export function setCachedGhStatus(installed: boolean, authenticated: boolean): void {
	ghInstalledCache = installed;
	ghAuthenticatedCache = authenticated;
	ghStatusCacheTime = Date.now();
}

// SSH CLI detection cache
let sshPathCache: string | null = null;
let sshDetectionDone = false;

/**
 * Detect the path to the ssh binary.
 * Uses 'which' on Unix, 'where' on Windows with expanded PATH.
 * Results are cached for performance.
 */
export async function detectSshPath(): Promise<string | null> {
	if (sshDetectionDone) {
		return sshPathCache;
	}

	const command = process.platform === 'win32' ? 'where' : 'which';
	const env = getExpandedEnv();
	const result = await execFileNoThrow(command, ['ssh'], undefined, env);

	if (result.exitCode === 0 && result.stdout.trim()) {
		sshPathCache = result.stdout.trim().split('\n')[0];
	}

	sshDetectionDone = true;
	return sshPathCache;
}

/**
 * Get the SSH binary path, auto-detecting if not already cached.
 * Falls back to 'ssh' if detection fails (will use PATH at runtime).
 * @returns The path to use for ssh commands
 */
export async function resolveSshPath(): Promise<string> {
	await detectSshPath();
	return sshPathCache || 'ssh';
}

/**
 * Get the cached SSH path synchronously (returns null if detection hasn't run).
 * Use resolveSshPath() for async detection with fallback.
 */
export function getSshPath(): string | null {
	return sshPathCache;
}

/**
 * Clear SSH path cache (for testing or re-detection).
 */
export function clearSshCache(): void {
	sshPathCache = null;
	sshDetectionDone = false;
}
