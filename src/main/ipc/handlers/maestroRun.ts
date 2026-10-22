/**
 * MaestroRun IPC (`maestroRun:*`).
 *
 * Thin pass-throughs to the one MaestroRunService (the CLI's WS verbs reach
 * the same instance). `maestroRun:status` is also what the renderer asks before
 * each agent spawn, to decide whether the MaestroRun system-prompt section
 * applies, so it stays reachable over the web bridge.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { getMaestroRunService } from '../../maestro-run';
import type { MaestroRunService } from '../../maestro-run';

const LOG_CONTEXT = '[MaestroRun]';

function requireService(): MaestroRunService {
	const service = getMaestroRunService();
	if (!service) throw new Error('MaestroRun is not available in this session');
	return service;
}

/**
 * Installing and granting act for the user who turned the feature on, so both
 * refuse while MaestroRun is off - the same check the CLI's WS verbs make.
 */
function requireEnabledService(): MaestroRunService {
	const service = requireService();
	if (!service.status().enabled) throw new Error('MaestroRunDisabled');
	return service;
}

function opts(operation: string) {
	return { context: LOG_CONTEXT, operation };
}

export function registerMaestroRunHandlers(): void {
	ipcMain.handle(
		'maestroRun:status',
		withIpcErrorLogging(opts('status'), async () => requireService().status())
	);
	ipcMain.handle(
		'maestroRun:refresh',
		withIpcErrorLogging(opts('refresh'), async (options?: { checkLatest?: boolean }) =>
			requireService().refresh({ checkLatest: options?.checkLatest === true })
		)
	);
	ipcMain.handle(
		'maestroRun:install',
		withIpcErrorLogging(opts('install'), async () => requireEnabledService().install())
	);
	ipcMain.handle(
		'maestroRun:requestAccess',
		withIpcErrorLogging(opts('requestAccess'), async (options?: { reveal?: boolean }) =>
			requireEnabledService().requestAccess({ reveal: options?.reveal === true })
		)
	);
	// The launcher path while it is ready, else null. Re-inspects a stale
	// status first, so this (not `status`) is what gates a system prompt.
	ipcMain.handle(
		'maestroRun:readyPath',
		withIpcErrorLogging(
			opts('readyPath'),
			async () => (await getMaestroRunService()?.readyBinaryPath()) ?? null
		)
	);
}
