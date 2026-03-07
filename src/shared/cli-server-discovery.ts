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
}

// Get the Maestro config directory path (lowercase "maestro")
function getConfigDir(): string {
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
