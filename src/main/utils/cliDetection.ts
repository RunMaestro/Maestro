import { execFileNoThrow } from './execFile';
import { buildExpandedEnv } from '../../shared/pathUtils';
import { getWhichCommand } from '../../shared/platformDetection';

let cloudflaredInstalledCache: boolean | null = null;
let cloudflaredPathCache: string | null = null;

// PATH detection for gh: whether `which gh` found it, and where. Written only by
// isGhInstalled(), so it always describes the PATH-resolved binary.
let ghInstalledCache: boolean | null = null;
let ghPathCache: string | null = null;

// The last installed/authenticated verdict, and the gh command it was reached
// against. Kept apart from the detection cache above because callers probe
// different binaries: most use the PATH-resolved gh, but Send Feedback honours a
// configured custom path. A verdict about one binary says nothing about another.
let ghStatusCache: {
	command: string;
	installed: boolean;
	authenticated: boolean;
	cachedAt: number;
} | null = null;
const GH_STATUS_CACHE_TTL_MS = 60000; // 1 minute TTL for auth status

/**
 * Build an expanded PATH that includes common binary installation locations.
 * This is necessary because packaged Electron apps don't inherit shell environment.
 */
export function getExpandedEnv(): NodeJS.ProcessEnv {
	return buildExpandedEnv();
}

export async function isCloudflaredInstalled(): Promise<boolean> {
	// Return cached result if available
	if (cloudflaredInstalledCache !== null) {
		return cloudflaredInstalledCache;
	}

	// Use 'which' on macOS/Linux, 'where' on Windows
	const command = getWhichCommand();
	const env = getExpandedEnv();
	const result = await execFileNoThrow(command, ['cloudflared'], undefined, env);

	if (result.exitCode === 0 && result.stdout.trim()) {
		cloudflaredInstalledCache = true;
		// Handle Windows CRLF line endings properly
		const lines = result.stdout.trim().split(/\r?\n/);
		cloudflaredPathCache = lines[0]?.trim() || null;
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
	const command = getWhichCommand();
	const env = getExpandedEnv();
	const result = await execFileNoThrow(command, ['gh'], undefined, env);

	if (result.exitCode === 0 && result.stdout.trim()) {
		ghInstalledCache = true;
		// On Windows, 'where' can return multiple paths - take the first one
		// Handle Windows CRLF line endings properly
		const lines = result.stdout.trim().split(/\r?\n/);
		ghPathCache = lines[0]?.trim() || null;
	} else {
		ghInstalledCache = false;
	}

	return ghInstalledCache;
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

/**
 * Get the cached gh CLI status (installed + authenticated) for one gh command.
 *
 * `command` is the resolved gh command the caller is about to run, i.e. the
 * result of resolveGhPath(). A verdict reached against any other command is a
 * cache miss: the PATH-resolved gh and a configured custom path are different
 * binaries, and answering for one from the other is how a working install got
 * reported as missing.
 *
 * Returns null if nothing is cached, the verdict has expired, or it was reached
 * against a different command.
 */
export function getCachedGhStatus(
	command: string
): { installed: boolean; authenticated: boolean } | null {
	if (ghStatusCache === null) {
		return null;
	}

	// Every cached verdict expires, including a negative one. A failed probe is
	// usually environmental rather than permanent (a shim that could not reach its
	// parent tool, a PATH that had not been expanded yet), so a sticky
	// "not installed" would keep gh unavailable for the rest of the app run with
	// no way to recover short of a restart.
	if (Date.now() - ghStatusCache.cachedAt >= GH_STATUS_CACHE_TTL_MS) {
		// Drop the detection cache too, not just the verdict. isGhInstalled()
		// returns early on any non-null ghInstalledCache, so leaving a stale
		// `false` there would make the next lookup skip `which` entirely and
		// answer from the very result that just expired.
		clearGhCache();
		return null;
	}

	if (ghStatusCache.command !== command) {
		return null;
	}

	return { installed: ghStatusCache.installed, authenticated: ghStatusCache.authenticated };
}

/**
 * Cache the gh CLI status reached by probing `command`, the resolved gh
 * command. Replaces any verdict cached for a different command.
 */
export function setCachedGhStatus(
	command: string,
	installed: boolean,
	authenticated: boolean
): void {
	ghStatusCache = { command, installed, authenticated, cachedAt: Date.now() };
}

/**
 * Clear every cached gh CLI fact: installed, resolved path, and auth status.
 * Call this when the configured gh path changes so the next probe re-detects
 * instead of answering from a verdict that was reached against the old binary.
 */
export function clearGhCache(): void {
	ghInstalledCache = null;
	ghPathCache = null;
	ghStatusCache = null;
}

// SSH detection moved into maestro-lib so the SSH command builder can live there.
export { detectSshPath, resolveSshPath } from '../../shared/maestro-lib/launch/ssh-path';
