/**
 * Resolve all Maestro data paths, including sync path support.
 *
 * The desktop stores sessions, groups, settings, group chats, and session
 * images under `customSyncPath` from `<userData>/maestro-bootstrap.json`
 * when set, while history, stats.db, cue.db, and agent configs stay under
 * userData (or productionDataPath for agent configs in dev mode).
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveUserDataDir, type UserDataDirOptions } from './userDataDir';

export interface ResolveMaestroPathsOptions extends UserDataDirOptions {
	/** The production userData path (used for agent configs). Defaults to resolved userData. */
	productionDataPath?: string;
}

export interface MaestroPaths {
	userDataDir: string;
	syncDir: string;
	sessionsFile: string;
	groupsFile: string;
	settingsFile: string;
	agentConfigsFile: string;
	historyDir: string;
	groupChatsDir: string;
	sessionImagesDir: string;
	cliServerFile: string;
}

/**
 * Resolve all Maestro paths, including custom sync path if configured.
 *
 * @param options Configuration options, including overrides for testing
 * @returns Object with all path locations
 */
export function resolveMaestroPaths(options: ResolveMaestroPathsOptions = {}): MaestroPaths {
	const userDataDir = resolveUserDataDir(options);
	const productionDataPath = options.productionDataPath ?? userDataDir;

	// Read bootstrap settings to determine sync path
	let syncDir = userDataDir;
	const bootstrapPath = path.join(userDataDir, 'maestro-bootstrap.json');

	try {
		const bootstrapContent = fs.readFileSync(bootstrapPath, 'utf-8');
		const bootstrap = JSON.parse(bootstrapContent) as { customSyncPath?: string };
		if (bootstrap.customSyncPath && fs.existsSync(bootstrap.customSyncPath)) {
			const stats = fs.statSync(bootstrap.customSyncPath);
			if (stats.isDirectory()) {
				syncDir = bootstrap.customSyncPath;
			}
		}
	} catch {
		// Bootstrap file missing or invalid - use default userData
		syncDir = userDataDir;
	}

	return {
		userDataDir,
		syncDir,
		// Files under sync path (sessions, settings, groups)
		sessionsFile: path.join(syncDir, 'maestro-sessions.json'),
		groupsFile: path.join(syncDir, 'maestro-groups.json'),
		settingsFile: path.join(syncDir, 'maestro-settings.json'),
		// Agent configs ALWAYS under production path (even in dev mode)
		agentConfigsFile: path.join(productionDataPath, 'maestro-agent-configs.json'),
		// Directories
		historyDir: path.join(userDataDir, 'history'),
		groupChatsDir: path.join(syncDir, 'group-chats'),
		sessionImagesDir: path.join(syncDir, 'session-images'),
		cliServerFile: path.join(userDataDir, 'cli-server.json'),
	};
}
