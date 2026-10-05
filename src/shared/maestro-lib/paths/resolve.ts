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
 * Read-only: nothing here creates a directory. The desktop creates a missing
 * sync directory on startup, so a valid `customSyncPath` is reported even when
 * it does not exist yet - that is still where the desktop will write.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseJsonWithBom } from '../../jsonUtils';
import {
	resolveProductionDataDir,
	resolveUserDataDir,
	type UserDataDirOptions,
} from './userDataDir';
import { syncPathRejection } from './syncPath';

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
	 * Set when the bootstrap file names a `customSyncPath` the desktop refuses,
	 * so it falls back to userData. The text says why.
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
 * The bootstrap file's `customSyncPath`, or undefined when there is none.
 *
 * A missing or malformed file means "no custom path", matching the desktop:
 * its store treats both as defaults. Any other read error is real and thrown.
 */
function readCustomSyncPath(bootstrapFile: string): string | undefined {
	let content: string;
	try {
		content = fs.readFileSync(bootstrapFile, 'utf-8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
		throw error;
	}

	let bootstrap: unknown;
	try {
		bootstrap = parseJsonWithBom(content);
	} catch {
		return undefined;
	}

	const customSyncPath = (bootstrap as { customSyncPath?: unknown } | null)?.customSyncPath;
	return typeof customSyncPath === 'string' && customSyncPath ? customSyncPath : undefined;
}

/**
 * Resolve every Maestro data path, honoring `customSyncPath`.
 */
export function resolveMaestroPaths(options: ResolveMaestroPathsOptions = {}): MaestroPaths {
	const userDataDir = resolveUserDataDir(options);
	const productionDataDir = options.productionDataPath ?? resolveProductionDataDir(userDataDir);
	const bootstrapFile = path.join(userDataDir, 'maestro-bootstrap.json');

	let syncDir = userDataDir;
	let syncDirSource: SyncDirSource = 'userData';
	let customSyncPathRejection: string | undefined;

	const customSyncPath = readCustomSyncPath(bootstrapFile);
	if (customSyncPath) {
		customSyncPathRejection = syncPathRejection(customSyncPath, options.platform) ?? undefined;
		if (!customSyncPathRejection) {
			syncDir = customSyncPath;
			syncDirSource = 'customSyncPath';
		}
	}

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
		groupChatsDir: path.join(syncDir, 'group-chats'),
		sessionImagesDir: path.join(syncDir, 'session-images'),
		cliServerFile: path.join(userDataDir, 'cli-server.json'),
	};
}
