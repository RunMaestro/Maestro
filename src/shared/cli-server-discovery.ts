/**
 * CLI Server Discovery
 *
 * Shared module for the CLI server discovery file, used by both the Electron
 * main process (writes) and the CLI (reads) to locate the running server.
 *
 * The directory comes from `resolveUserDataDir()`, the same resolver the CLI's
 * agent store uses. A private lowercase `maestro` fallback used to live here, so
 * on a case-sensitive Linux install the CLI read agents from `~/.config/Maestro`
 * while looking for the app in `~/.config/maestro`, and reported the desktop as
 * not running while it was.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveUserDataDir } from './userDataDir';

export interface CliServerInfo {
	port: number;
	token: string;
	pid: number;
	startedAt: number;
	/**
	 * Version of the desktop app that wrote this file (`app.getVersion()`).
	 * Optional: older builds did not write it, so a missing value itself signals
	 * an app predating version-skew detection. Read by `maestro-cli doctor` /
	 * `status` to compare against the CLI's own build version.
	 */
	version?: string;
	/**
	 * Per-boot secret the CLI presents on its WebSocket upgrade
	 * (`CLI_SECRET_HEADER`) so the Web Login gate admits it without a session
	 * cookie. Optional: an older app did not write it, and the gate simply
	 * stays closed to the CLI on such a build when Web Login is on.
	 */
	cliSecret?: string;
}

const DISCOVERY_FILE = 'cli-server.json';

/**
 * Discovery file location. `dataDir` names a specific data directory (the
 * bundle importer asks whether a desktop runs against ITS target); without it
 * it is Maestro's data directory as `resolveUserDataDir()` resolves it.
 */
function getDiscoveryFilePath(dataDir?: string): string {
	return path.join(dataDir ?? resolveUserDataDir(), DISCOVERY_FILE);
}

/**
 * Write CLI server info atomically (write to .tmp then rename)
 */
export function writeCliServerInfo(info: CliServerInfo): void {
	const filePath = getDiscoveryFilePath();
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const tmpPath = filePath + '.tmp';
	fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2), 'utf-8');
	fs.renameSync(tmpPath, filePath);
}

/**
 * Read CLI server info from the discovery file (in `dataDir` when given).
 * Returns null if the file is missing or invalid
 */
export function readCliServerInfo(dataDir?: string): CliServerInfo | null {
	try {
		const filePath = getDiscoveryFilePath(dataDir);
		const content = fs.readFileSync(filePath, 'utf-8');
		const data = JSON.parse(content) as CliServerInfo;
		if (
			typeof data.port === 'number' &&
			typeof data.token === 'string' &&
			typeof data.pid === 'number' &&
			typeof data.startedAt === 'number'
		) {
			return data;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Delete the CLI server discovery file (called on shutdown)
 */
export function deleteCliServerInfo(): void {
	try {
		const filePath = getDiscoveryFilePath();
		fs.unlinkSync(filePath);
	} catch {
		// File may not exist, ignore
	}
}

/**
 * Check if the CLI server is still running by reading the discovery file
 * (in `dataDir` when given) and verifying the PID is alive
 */
export function isCliServerRunning(dataDir?: string): boolean {
	const info = readCliServerInfo(dataDir);
	if (!info) return false;

	try {
		process.kill(info.pid, 0); // Doesn't kill, just checks if process exists
		return true;
	} catch (error) {
		// EPERM means the process exists but this caller cannot signal it. This is
		// common for sandboxed read-only monitors and must not turn a reachable
		// desktop into a stale discovery result. The authenticated WebSocket
		// connection remains the authoritative reachability check.
		if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
		return false;
	}
}
