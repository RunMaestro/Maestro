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
	/**
	 * Per-boot secret the CLI presents on its WebSocket upgrade
	 * (`CLI_SECRET_HEADER`) so the Web Login gate admits it without a session
	 * cookie. Optional: an older app did not write it, and the gate simply
	 * stays closed to the CLI on such a build when Web Login is on.
	 */
	cliSecret?: string;
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

/**
 * Owner-only permissions for the discovery file. The token in it grants full
 * control of the app, so other users on the machine must not read it. Ignored
 * on Windows, where the per-user AppData ACL does the same job.
 */
const DISCOVERY_FILE_MODE = 0o600;

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
	// `mode` only applies when the file is created, so a .tmp left over from an
	// older build keeps its old bits; chmod covers that case before the rename.
	fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2), {
		encoding: 'utf-8',
		mode: DISCOVERY_FILE_MODE,
	});
	fs.chmodSync(tmpPath, DISCOVERY_FILE_MODE);
	fs.renameSync(tmpPath, filePath);
}

/**
 * Read CLI server info from the discovery file
 * Returns null if the file is missing or invalid
 */
export function readCliServerInfo(): CliServerInfo | null {
	try {
		return parseCliServerInfo(fs.readFileSync(getDiscoveryFilePath(), 'utf-8'));
	} catch {
		return null;
	}
}

/**
 * Parse the contents of a discovery file. Returns null for anything that is
 * not valid JSON or lacks the four required fields. Separate from the read so
 * a caller with its own path (the TUI's `--doctor`) applies the same validity
 * rule as the CLI.
 */
export function parseCliServerInfo(raw: string): CliServerInfo | null {
	try {
		const data = JSON.parse(raw) as CliServerInfo;
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
 * Whether a process with this pid exists. `process.kill(pid, 0)` sends no
 * signal. EPERM means it exists but this caller cannot signal it: common for
 * sandboxed read-only monitors, and not a stale result.
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
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
	// The authenticated WebSocket connection remains the authoritative
	// reachability check; this only says the recorded process still exists.
	return info !== null && isPidAlive(info.pid);
}
