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
import { atomicWriteFileSync, FileLockTimeoutError, withFileLockSync } from './crossProcessLock';
import { currentProcessIdentity, probeProcess } from './processIdentity';

interface CliActivityStatus {
	sessionId: string;
	playbookId: string;
	playbookName: string;
	startedAt: number;
	pid: number;
	/**
	 * Start-time token of `pid` (see `processIdentity.ts`), so a reader can tell
	 * the registering process from an unrelated one that later got the same pid.
	 * Stamped automatically when a process registers itself; absent on entries
	 * written by older builds and on Windows, which then fall back to pid checks.
	 */
	startToken?: string;
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

function getActivityLockPath(): string {
	return `${getActivityFilePath()}.lock`;
}

function isActivityRecord(value: unknown): value is CliActivityStatus {
	if (!value || typeof value !== 'object') return false;
	const a = value as Partial<CliActivityStatus>;
	return typeof a.sessionId === 'string' && typeof a.pid === 'number';
}

/**
 * Read all CLI activities
 */
function readCliActivities(): CliActivityStatus[] {
	try {
		const filePath = getActivityFilePath();
		const content = fs.readFileSync(filePath, 'utf-8');
		const data = JSON.parse(content) as CliActivityFile;
		return Array.isArray(data.activities) ? data.activities.filter(isActivityRecord) : [];
	} catch {
		return [];
	}
}

/**
 * Read-modify-write the activity file as one step across processes.
 *
 * Several `maestro-cli` runs and the desktop app (which prunes dead entries)
 * all rewrite this file. Unserialized, two writers that read the same base drop
 * each other's entry, and a reader that caught a half-written file parsed it as
 * "no activities" and then wrote that back, wiping everyone. The lock fixes the
 * first; the atomic rename fixes the second.
 *
 * If the lock cannot be taken in time (a holder frozen mid-write), the update
 * is applied unlocked rather than dropped: losing a registration would let the
 * desktop dispatch into an agent the CLI is driving, and the rename still keeps
 * the file whole.
 */
function mutateCliActivities(
	mutate: (activities: CliActivityStatus[]) => CliActivityStatus[]
): void {
	const apply = () => {
		const before = readCliActivities();
		const after = mutate(before);
		if (after === before) return;
		atomicWriteFileSync(getActivityFilePath(), JSON.stringify({ activities: after }, null, 2));
	};
	try {
		try {
			withFileLockSync(getActivityLockPath(), apply);
		} catch (error) {
			if (!(error instanceof FileLockTimeoutError)) throw error;
			console.warn(`[CLI Activity] ${error.message}; writing without the lock`);
			apply();
		}
	} catch (error) {
		console.error('[CLI Activity] Failed to write activity file:', error);
	}
}

/**
 * Register CLI activity for a session (called when playbook starts)
 */
export function registerCliActivity(status: CliActivityStatus): void {
	const own = currentProcessIdentity();
	const entry: CliActivityStatus =
		status.startToken === undefined && status.pid === own.pid && own.startToken !== undefined
			? { ...status, startToken: own.startToken }
			: status;
	mutateCliActivities((activities) => [
		// Replace any stale entry for this session
		...activities.filter((a) => a.sessionId !== entry.sessionId),
		entry,
	]);
}

/**
 * Unregister CLI activity for a session (called when playbook ends)
 */
export function unregisterCliActivity(sessionId: string): void {
	mutateCliActivities((activities) => {
		const filtered = activities.filter((a) => a.sessionId !== sessionId);
		return filtered.length === activities.length ? activities : filtered;
	});
}

/**
 * Drop exactly the entry a liveness probe proved dead. Matching on pid and
 * token as well as session id matters: between the probe and this write a new
 * CLI run may have registered the same session, and that live entry must stay.
 */
function removeDeadActivity(dead: CliActivityStatus): void {
	mutateCliActivities((activities) => {
		const filtered = activities.filter(
			(a) =>
				!(a.sessionId === dead.sessionId && a.pid === dead.pid && a.startToken === dead.startToken)
		);
		return filtered.length === activities.length ? activities : filtered;
	});
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
 * Delegates to `probeProcess`, which checks the pid AND, when the entry carries
 * a start token, that the pid still belongs to the process that registered.
 * A crashed CLI's pid being recycled used to leave its agent "busy" forever.
 *
 * - `alive` (including EPERM: the pid exists under another user) keeps the entry.
 * - `dead` (ESRCH, or a recycled pid) is the only verdict that may erase it.
 * - `unknown` reports not-busy for this call but does not mutate the file on a
 *   guess.
 */
function isActivityProcessAlive(activity: CliActivityStatus): boolean {
	const liveness = probeProcess(activity);
	if (liveness === 'alive') return true;
	if (liveness === 'dead') removeDeadActivity(activity);
	return false;
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
