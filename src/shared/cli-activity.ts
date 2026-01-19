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

export interface CliActivityStatus {
	sessionId: string;
	playbookId: string;
	playbookName: string;
	startedAt: number;
	pid: number;
	currentTask?: string;
	currentDocument?: string;
}

export interface CliActivityFile {
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
export function readCliActivities(): CliActivityStatus[] {
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
 * Update CLI activity (e.g., current task)
 */
export function updateCliActivity(sessionId: string, updates: Partial<CliActivityStatus>): void {
	const activities = readCliActivities();
	const index = activities.findIndex((a) => a.sessionId === sessionId);
	if (index >= 0) {
		activities[index] = { ...activities[index], ...updates };
		writeCliActivities(activities);
	}
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
 * Check if a session has active CLI activity
 */
export function isSessionBusyWithCli(sessionId: string): boolean {
	const activity = getCliActivityForSession(sessionId);
	if (!activity) return false;

	// Check if the process is still running
	try {
		process.kill(activity.pid, 0); // Doesn't kill, just checks if process exists
		return true;
	} catch {
		// Process not running, clean up stale entry
		unregisterCliActivity(sessionId);
		return false;
	}
}

/**
 * Clean up stale activities (processes that are no longer running)
 */
export function cleanupStaleActivities(): void {
	const activities = readCliActivities();
	const stillRunning = activities.filter((activity) => {
		try {
			process.kill(activity.pid, 0);
			return true;
		} catch {
			return false;
		}
	});

	if (stillRunning.length !== activities.length) {
		writeCliActivities(stillRunning);
	}
}
