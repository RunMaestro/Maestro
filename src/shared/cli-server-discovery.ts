/**
 * CLI Server Discovery
 *
 * Shared module for publishing the Electron app's CLI IPC server location.
 * Used by the desktop app to write connection details and by the CLI to read them.
 *
 * NOTE: This file has its own `getConfigDir()` implementation (lowercase "maestro")
 * which matches the electron-store default from package.json `"name": "maestro"`.
 * This mirrors src/shared/cli-activity.ts so CLI state files live in the same
 * config directory.
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

// Get the Maestro config directory path
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

const CLI_SERVER_FILE = 'cli-server.json';

function getCliServerFilePath(): string {
	return path.join(getConfigDir(), CLI_SERVER_FILE);
}

function isValidCliServerInfo(data: unknown): data is CliServerInfo {
	if (!data || typeof data !== 'object') return false;

	const info = data as Partial<CliServerInfo>;
	return (
		typeof info.port === 'number' &&
		Number.isInteger(info.port) &&
		info.port > 0 &&
		info.port <= 65535 &&
		typeof info.token === 'string' &&
		info.token.length > 0 &&
		typeof info.pid === 'number' &&
		Number.isInteger(info.pid) &&
		info.pid > 0 &&
		typeof info.startedAt === 'number' &&
		Number.isInteger(info.startedAt) &&
		info.startedAt >= 0
	);
}

/**
 * Write CLI server discovery info atomically.
 */
export function writeCliServerInfo(info: CliServerInfo): void {
	try {
		const filePath = getCliServerFilePath();
		const tmpPath = `${filePath}.tmp`;
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		} else {
			const stats = fs.statSync(dir);
			if ((stats.mode & 0o077) !== 0) {
				fs.chmodSync(dir, 0o700);
			}
		}
		fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2), {
			encoding: 'utf-8',
			mode: 0o600,
		});
		fs.chmodSync(tmpPath, 0o600);
		fs.renameSync(tmpPath, filePath);
		fs.chmodSync(filePath, 0o600);
	} catch (error) {
		console.error('[CLI Server Discovery] Failed to write discovery file:', error);
	}
}

/**
 * Read CLI server discovery info.
 */
export function readCliServerInfo(): CliServerInfo | null {
	try {
		const filePath = getCliServerFilePath();
		const content = fs.readFileSync(filePath, 'utf-8');
		const data = JSON.parse(content);
		return isValidCliServerInfo(data) ? data : null;
	} catch {
		return null;
	}
}

/**
 * Delete CLI server discovery info.
 */
export function deleteCliServerInfo(): void {
	try {
		const filePath = getCliServerFilePath();
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath);
		}
	} catch (error) {
		console.error('[CLI Server Discovery] Failed to delete discovery file:', error);
	}
}

/**
 * Check if the discovered CLI server process is still running.
 */
export function isCliServerRunning(): boolean {
	const info = readCliServerInfo();
	if (!info) return false;

	try {
		process.kill(info.pid, 0); // Doesn't kill, just checks if process exists
		return true;
	} catch {
		deleteCliServerInfo();
		return false;
	}
}
