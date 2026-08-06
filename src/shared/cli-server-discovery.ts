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
const OWNER_READ_WRITE = 0o600;
const OWNER_DIRECTORY = 0o700;

function getDiscoveryFilePath(): string {
	return path.join(getConfigDir(), DISCOVERY_FILE);
}

function ensurePrivateConfigDir(dir: string): void {
	const stats = fs.statSync(dir);
	if ((stats.mode & 0o077) !== 0) {
		fs.chmodSync(dir, OWNER_DIRECTORY);
	}
}

function isValidCliServerInfo(data: CliServerInfo): boolean {
	return (
		Number.isInteger(data.port) &&
		data.port > 0 &&
		data.port <= 65535 &&
		typeof data.token === 'string' &&
		data.token.length > 0 &&
		Number.isInteger(data.pid) &&
		data.pid > 0 &&
		Number.isInteger(data.startedAt) &&
		data.startedAt >= 0 &&
		(data.version === undefined || typeof data.version === 'string')
	);
}

/**
 * Write CLI server info atomically (write to .tmp then rename)
 */
export function writeCliServerInfo(info: CliServerInfo): void {
	const filePath = getDiscoveryFilePath();
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true, mode: OWNER_DIRECTORY });
	}
	ensurePrivateConfigDir(dir);
	const tmpPath = filePath + '.tmp';
	fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2), {
		encoding: 'utf-8',
		mode: OWNER_READ_WRITE,
	});
	fs.chmodSync(tmpPath, OWNER_READ_WRITE);
	fs.renameSync(tmpPath, filePath);
	fs.chmodSync(filePath, OWNER_READ_WRITE);
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
		return isValidCliServerInfo(data) ? data : null;
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
 * and verifying the PID is alive
 */
export function isCliServerRunning(): boolean {
	const info = readCliServerInfo();
	if (!info) return false;

	try {
		process.kill(info.pid, 0); // Doesn't kill, just checks if process exists
		return true;
	} catch {
		return false;
	}
}
