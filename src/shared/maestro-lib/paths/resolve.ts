/**
 * Every Maestro data path, resolved without Electron.
 *
 * Mirrors `initializeStores()` in `src/main/stores/instances.ts` and the
 * storage modules that hang off it:
 *   - sessions, groups, settings, group chats, and session images live under
 *     the SYNC directory: `customSyncPath` from `<userData>/maestro-bootstrap.json`
 *     when it is set and valid, otherwise userData;
 *   - history and `cli-server.json` stay under userData;
 *   - agent configs live under the PRODUCTION data directory, which a dev run
 *     keeps pointed at the non-dev directory so dev and prod share them.
 *
 * Read-only: nothing here creates a directory. The sync directory is chosen by
 * `resolveSyncDir` (`src/shared/syncPath.ts`), the same call the desktop's
 * rule is written against and every other `maestro-cli` command makes, so a
 * host and a one-shot command can never read different directories. That
 * includes a `customSyncPath` whose folder is missing: the desktop creates it at
 * startup, so its absence means the desktop is not using it, and the answer is
 * userData.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseJsonWithBom } from '../../jsonUtils';
import { resolveSyncDir } from '../../syncPath';
import {
	resolveProductionDataDir,
	resolveUserDataDir,
	type UserDataDirOptions,
} from './userDataDir';
import { syncPathRejection } from './syncPath';

/** The directory under the sync directory that holds one sub-directory per group chat. */
export const GROUP_CHATS_DIR_NAME = 'group-chats';

export interface ResolveMaestroPathsOptions extends UserDataDirOptions {
	/**
	 * The production data directory (agent configs). Defaults to the directory a
	 * dev run's redirect came from, see `resolveProductionDataDir`.
	 */
	productionDataPath?: string;
}

/** Which rule chose `syncDir`. */
export type SyncDirSource = 'userData' | 'customSyncPath';

export interface MaestroPaths {
	userDataDir: string;
	/** Where agent configs live; differs from `userDataDir` only in a dev run. */
	productionDataDir: string;
	bootstrapFile: string;
	syncDir: string;
	syncDirSource: SyncDirSource;
	/**
	 * Set when the bootstrap file names a `customSyncPath` that is not in use, so
	 * the stores are under userData: the path is one the desktop refuses, or its
	 * folder does not exist. The text says which.
	 */
	customSyncPathRejection?: string;
	sessionsFile: string;
	groupsFile: string;
	settingsFile: string;
	agentConfigsFile: string;
	historyDir: string;
	/** The desktop's usage database (`app.getPath('userData')/stats.db`). Local to this machine, never synced. */
	statsFile: string;
	groupChatsDir: string;
	sessionImagesDir: string;
	cliServerFile: string;
}

/**
 * The `customSyncPath` the bootstrap file names, as written, or undefined.
 *
 * Read only to explain a fallback. It decides nothing: `resolveSyncDir` has
 * already chosen the directory, and thrown on a read error worth reporting.
 */
function readCustomSyncPath(bootstrapFile: string): string | undefined {
	try {
		const bootstrap: unknown = parseJsonWithBom(fs.readFileSync(bootstrapFile, 'utf-8'));
		const customSyncPath = (bootstrap as { customSyncPath?: unknown } | null)?.customSyncPath;
		return typeof customSyncPath === 'string' && customSyncPath ? customSyncPath : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Where the synced stores are, by the shared rule. A user data path that runs
 * through a file has no bootstrap file to read, which is "no custom path".
 */
function chooseSyncDir(userDataDir: string): string {
	try {
		return resolveSyncDir(userDataDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return userDataDir;
		throw error;
	}
}

/** Why a named `customSyncPath` is not the sync directory. A complete sentence, ready to print. */
function customSyncPathFallbackReason(customSyncPath: string): string {
	const rejection = syncPathRejection(customSyncPath);
	if (rejection) return rejection;
	if (!fs.existsSync(customSyncPath)) return `Custom sync path does not exist: ${customSyncPath}`;
	return `Custom sync path was rejected: ${customSyncPath}`;
}

/**
 * Resolve every Maestro data path, honoring `customSyncPath` exactly as `resolveSyncDir` does.
 */
export function resolveMaestroPaths(options: ResolveMaestroPathsOptions = {}): MaestroPaths {
	const userDataDir = resolveUserDataDir(options);
	const productionDataDir = options.productionDataPath ?? resolveProductionDataDir(userDataDir);
	const bootstrapFile = path.join(userDataDir, 'maestro-bootstrap.json');

	const syncDir = chooseSyncDir(userDataDir);
	const customSyncPath = readCustomSyncPath(bootstrapFile);
	// The source is the custom path only when that is the directory in use.
	const syncDirSource: SyncDirSource =
		customSyncPath !== undefined && syncDir === customSyncPath && syncDir !== userDataDir
			? 'customSyncPath'
			: 'userData';
	const customSyncPathRejection =
		customSyncPath !== undefined && syncDir !== customSyncPath
			? customSyncPathFallbackReason(customSyncPath)
			: undefined;

	return {
		userDataDir,
		productionDataDir,
		bootstrapFile,
		syncDir,
		syncDirSource,
		...(customSyncPathRejection ? { customSyncPathRejection } : {}),
		sessionsFile: path.join(syncDir, 'maestro-sessions.json'),
		groupsFile: path.join(syncDir, 'maestro-groups.json'),
		settingsFile: path.join(syncDir, 'maestro-settings.json'),
		agentConfigsFile: path.join(productionDataDir, 'maestro-agent-configs.json'),
		historyDir: path.join(userDataDir, 'history'),
		statsFile: path.join(userDataDir, 'stats.db'),
		groupChatsDir: path.join(syncDir, GROUP_CHATS_DIR_NAME),
		sessionImagesDir: path.join(syncDir, 'session-images'),
		cliServerFile: path.join(userDataDir, 'cli-server.json'),
	};
}
