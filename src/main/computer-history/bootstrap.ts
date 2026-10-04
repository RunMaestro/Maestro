/**
 * Computer History - Electron wiring for the service singleton.
 *
 * Keeps `src/main/index.ts` to one call: everything Electron-specific the
 * service needs (userData, the macOS accessibility check, Maestro's own pids,
 * the renderer status push, the consult route for digests) is resolved here.
 */

import { app, systemPreferences, type BrowserWindow } from 'electron';
import { resolveEncoreFeatures } from '../../shared/encoreFeatureDefaults';
import { logger } from '../utils/logger';
import { createDigestConsult } from './digest-consult';
import { initComputerHistoryService } from './index';
import type { ComputerHistoryService } from './computer-history-service';
import type { ComputerHistoryStatus } from '../../shared/computer-history/status';

const LOG_CONTEXT = '[ComputerHistory]';

export interface ComputerHistoryAppDeps {
	settingsStore: { get: (key: string) => unknown };
	/** Broadcast to every window (main/index.ts `safeSend`). */
	safeSend: (channel: string, ...args: unknown[]) => void;
	getWindowForSession: (sessionId: string) => BrowserWindow | null;
}

/** Maestro's own process ids: main plus every renderer/helper Electron runs. */
function maestroPids(): number[] {
	const pids = new Set<number>([process.pid]);
	try {
		for (const metric of app.getAppMetrics()) pids.add(metric.pid);
	} catch {
		// Before ready there are no metrics; the main pid is enough.
	}
	return [...pids];
}

export function createComputerHistoryForApp(deps: ComputerHistoryAppDeps): ComputerHistoryService {
	const digestConsult = createDigestConsult(deps.getWindowForSession);
	return initComputerHistoryService({
		userDataDir: app.getPath('userData'),
		isEnabled: () =>
			resolveEncoreFeatures(deps.settingsStore.get('encoreFeatures')).computerHistory,
		isMacAccessibilityTrusted:
			process.platform === 'darwin'
				? (prompt) => systemPreferences.isTrustedAccessibilityClient(prompt)
				: undefined,
		getBlockPids: maestroPids,
		onStatusChange: (status: ComputerHistoryStatus) =>
			deps.safeSend('computerHistory:statusChanged', status),
		getConsult: () => digestConsult,
		log: (level, message) => {
			if (level === 'error') logger.error(message, LOG_CONTEXT);
			else if (level === 'warn') logger.warn(message, LOG_CONTEXT);
			else logger.info(message, LOG_CONTEXT);
		},
	});
}
