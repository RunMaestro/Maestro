/**
 * CLI Activity Status
 *
 * Shared module for tracking when CLI is actively running tasks on a session.
 * Used to sync state between CLI and desktop app.
 *
 * NOTE: This file has its own `getConfigDir()` implementation (lowercase "maestro")
 * which matches the electron-store default from package.json `"name": "maestro"`.
 * The CLI storage.ts uses "Maestro" (capitalized) which is inconsistent.
 * This module uses lowercase to be consistent with the Electron app.
 *
 * Duplicated implementations:
 * - cli/services/storage.ts → getConfigDir() uses "Maestro" (capitalized)
 * - main/group-chat/group-chat-storage.ts → getConfigDir() uses electron-store
 * - shared/cli-activity.ts → getConfigDir() uses "maestro" (lowercase)
 *
 * These are kept separate to avoid cross-module dependencies and maintain
 * compatibility with existing data directories.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface CliActivityStatus {
	sessionId: string;
	playbookId: string;
	playbookName: string;
	startedAt: number;
	pid: number;
	currentTask?: string;
	currentDocument?: string;
}

interface CliActivityFile {
	activities: CliActivityStatus[];
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

const ACTIVITY_FILE = 'cli-activity.json';

function getActivityFilePath(): string {
	return path.join(getConfigDir(), ACTIVITY_FILE);
}

/**
 * Read all CLI activities
 */
function readCliActivities(): CliActivityStatus[] {
	try {
		const filePath = getActivityFilePath();
		const content = fs.readFileSync(filePath, 'utf-8');
		const data = JSON.parse(content) as CliActivityFile;
		return data.activities || [];
	} catch {
		return [];
	}
}

/**
 * Write CLI activities
 */
function writeCliActivities(activities: CliActivityStatus[]): void {
	try {
		const filePath = getActivityFilePath();
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(filePath, JSON.stringify({ activities }, null, 2), 'utf-8');
	} catch (error) {
		console.error('[CLI Activity] Failed to write activity file:', error);
	}
}

/**
 * Register CLI activity for a session (called when playbook starts)
 */
export function registerCliActivity(status: CliActivityStatus): void {
	const activities = readCliActivities();
	// Remove any stale entry for this session
	const filtered = activities.filter((a) => a.sessionId !== status.sessionId);
	filtered.push(status);
	writeCliActivities(filtered);
}

/**
 * Unregister CLI activity for a session (called when playbook ends)
 */
export function unregisterCliActivity(sessionId: string): void {
	const activities = readCliActivities();
	const filtered = activities.filter((a) => a.sessionId !== sessionId);
	writeCliActivities(filtered);
}

/**
 * Get CLI activity for a specific session
 */
export function getCliActivityForSession(sessionId: string): CliActivityStatus | undefined {
	const activities = readCliActivities();
	return activities.find((a) => a.sessionId === sessionId);
}

/**
 * Is the process behind a recorded activity still alive?
 *
 * `process.kill(pid, 0)` sends no signal; it only reports whether the caller
 * could. The distinction between its failure modes is the whole point:
 *
 * - EPERM means the pid EXISTS but belongs to another user or sits outside this
 *   caller's signal permission. That is evidence of life, not death, and it is
 *   the normal answer for a sandboxed read-only monitor.
 * - ESRCH is the only code that proves the process is gone, and therefore the
 *   only one that may erase the shared activity entry.
 * - Anything else is an unexplained probe failure. Report not-busy for this
 *   call, but do not mutate the file on a guess.
 */
function isActivityProcessAlive(activity: CliActivityStatus): boolean {
	try {
		process.kill(activity.pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'EPERM') return true;
		if (code === 'ESRCH') unregisterCliActivity(activity.sessionId);
		return false;
	}
}

/**
 * Check if a session has active CLI activity
 */
export function isSessionBusyWithCli(sessionId: string): boolean {
	const activity = getCliActivityForSession(sessionId);
	if (!activity) return false;
	return isActivityProcessAlive(activity);
}

/**
 * Session ids with a live CLI process, resolved in ONE read of the activity
 * file.
 *
 * `isSessionBusyWithCli` re-reads and re-parses that file on every call, which
 * is fine for a one-off check but not for a caller looping over every agent -
 * the desktop session listing did exactly that, turning one WebSocket request
 * into N synchronous reads of the same file.
 */
export function getSessionIdsBusyWithCli(): Set<string> {
	const busy = new Set<string>();
	for (const activity of readCliActivities()) {
		if (isActivityProcessAlive(activity)) busy.add(activity.sessionId);
	}
	return busy;
}
