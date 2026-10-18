/**
 * MaestroRun - Electron wiring for the service singleton.
 *
 * Keeps `src/main/index.ts` to one call: everything Electron-specific the
 * service needs (home and userData paths, the shell, the renderer status push)
 * is resolved here.
 */

import { app, shell } from 'electron';
import { resolveEncoreFeatures } from '../../shared/encoreFeatureDefaults';
import type { MaestroRunStatus } from '../../shared/maestro-run/status';
import { execFileNoThrow } from '../utils/execFile';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { logger } from '../utils/logger';
import { initMaestroRunService } from './index';
import type { MaestroRunService } from './maestro-run-service';

const LOG_CONTEXT = '[MaestroRun]';

export interface MaestroRunAppDeps {
	settingsStore: { get: (key: string) => unknown };
	/** Broadcast to every window (main/index.ts `safeSend`). */
	safeSend: (channel: string, ...args: unknown[]) => void;
}

export function createMaestroRunForApp(deps: MaestroRunAppDeps): MaestroRunService {
	return initMaestroRunService({
		platform: process.platform,
		homeDir: app.getPath('home'),
		userDataDir: app.getPath('userData'),
		isEnabled: () => resolveEncoreFeatures(deps.settingsStore.get('encoreFeatures')).maestroRun,
		exec: execFileNoThrow,
		fetch: fetchWithTimeout,
		openExternal: (url) => shell.openExternal(url),
		showItemInFolder: (fullPath) => shell.showItemInFolder(fullPath),
		onStatusChange: (status: MaestroRunStatus) => deps.safeSend('maestroRun:statusChanged', status),
		log: (level, message) => {
			if (level === 'error') logger.error(message, LOG_CONTEXT);
			else if (level === 'warn') logger.warn(message, LOG_CONTEXT);
			else logger.info(message, LOG_CONTEXT);
		},
	});
}
