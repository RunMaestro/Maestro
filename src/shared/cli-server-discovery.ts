/**
 * CLI Server Discovery
 *
 * Shared module for the CLI server discovery file, used by both the Electron
 * main process (writes) and the CLI (reads) to locate the running server.
 *
 * NOTE: This file has its own `getConfigDir()` implementation (lowercase "maestro")
 * which matches the electron-store default from package.json `"name": "maestro"`.
 * See cli-activity.ts for the same pattern and rationale.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteFileSync, FileLockTimeoutError, withFileLockSync } from './crossProcessLock';
import { currentProcessIdentity, isCurrentProcess, probeProcess } from './processIdentity';

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
	 * Start-time token of `pid` (see `processIdentity.ts`), stamped by
	 * {@link writeCliServerInfo}. Lets readers tell the app that wrote this file
	 * from an unrelated process that inherited its pid after a crash. Absent
	 * from older builds and on Windows.
	 */
	startToken?: string;
}

// Get the Maestro config directory path (lowercase "maestro")
function getConfigDir(): string {
	// Allow overriding the data directory (e.g. for dev mode: maestro-dev).
	// Matches the override honored by src/cli/services/storage.ts so the CLI's
	// discovery file lookup tracks the same data directory as its session reads.
	if (process.env.MAESTRO_USER_DATA) {
		return path.resolve(process.env.MAESTRO_USER_DATA);
	}

	const platform = os.platform();
	const home = os.homedir();

	if (platform === 'darwin') {
		return path.join(home, 'Library', 'Application Support', 'maestro');
	} else if (platform === 'win32') {
		return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'maestro');
	} else {
		// Linux and others
		return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'maestro');
	}
}

const DISCOVERY_FILE = 'cli-server.json';

function getDiscoveryFilePath(): string {
	return path.join(getConfigDir(), DISCOVERY_FILE);
}

function getDiscoveryLockPath(): string {
	return `${getDiscoveryFilePath()}.lock`;
}

/**
 * Run `fn` under the discovery file's cross-process lock. The lock only orders
 * this file's writers against each other (two app processes pointed at one data
 * directory, e.g. `dev:prod-data` next to a running production app); a lock
 * that cannot be taken in time falls through to running `fn` unlocked, which is
 * still safe from torn reads because every write is an atomic rename.
 */
function withDiscoveryLock(fn: () => void): void {
	try {
		withFileLockSync(getDiscoveryLockPath(), fn);
	} catch (error) {
		if (!(error instanceof FileLockTimeoutError)) throw error;
		fn();
	}
}

/**
 * Write CLI server info atomically (unique temp file, then rename).
 *
 * The writing process's start token is stamped on automatically when `info`
 * describes the calling process.
 */
export function writeCliServerInfo(info: CliServerInfo): void {
	const own = currentProcessIdentity();
	const stamped: CliServerInfo =
		info.startToken === undefined && info.pid === own.pid && own.startToken !== undefined
			? { ...info, startToken: own.startToken }
			: info;
	withDiscoveryLock(() => {
		atomicWriteFileSync(getDiscoveryFilePath(), JSON.stringify(stamped, null, 2));
	});
}

/**
 * Read CLI server info from the discovery file
 * Returns null if the file is missing or invalid
 */
export function readCliServerInfo(): CliServerInfo | null {
	try {
		const filePath = getDiscoveryFilePath();
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
 * Delete the CLI server discovery file (called on shutdown / server stop).
 *
 * Only removes a file THIS process wrote. When two app processes share a data
 * directory, the one that quits first used to delete the survivor's discovery
 * file, leaving the CLI unable to find a server that was still running. An
 * unreadable file is removed (it points nowhere anyway).
 */
export function deleteCliServerInfo(): void {
	try {
		withDiscoveryLock(() => {
			const info = readCliServerInfo();
			if (info && !isCurrentProcess(info)) return;
			try {
				fs.unlinkSync(getDiscoveryFilePath());
			} catch {
				// File may not exist, ignore
			}
		});
	} catch {
		// Shutdown path: never let discovery cleanup throw.
	}
}

/**
 * Check if the CLI server is still running by reading the discovery file
 * and verifying the process that wrote it is alive.
 *
 * A recorded start token must also match, so a pid recycled after a crash does
 * not read as a running server. EPERM (the process exists but this caller
 * cannot signal it) counts as alive: this is common for sandboxed read-only
 * monitors and must not turn a reachable desktop into a stale discovery result.
 * The authenticated WebSocket connection remains the authoritative
 * reachability check.
 */
export function isCliServerRunning(): boolean {
	const info = readCliServerInfo();
	if (!info) return false;
	return probeProcess(info) === 'alive';
}
