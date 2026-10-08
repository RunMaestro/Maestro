/**
 * Cue Bundle IPC Handlers
 *
 * Transport for the Cue modal's Bundles tab. Each handler delegates to
 * `cue-bundle-service.ts`, which the WebSocket bridge also calls for
 * `maestro-cli bundle export|import` while the app runs.
 *
 * This module also owns the app context those functions take: the data
 * paths, the live agents, and the round trip that hands imported agents to
 * the renderer, which owns them.
 */

import { randomUUID } from 'crypto';
import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import type Store from 'electron-store';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { getProductionDataPath } from '../../stores/getters';
import type { SessionsData } from '../../stores/types';
import type { SessionInfo } from '../../../shared/types';
import {
	exportBundleFromApp,
	importBundleIntoApp,
	inspectBundle,
	type CueBundleAppContext,
	type CueBundleExportOutcome,
	type CueBundleExportRequest,
	type CueBundleImportOutcome,
	type CueBundleImportRequest,
	type CueBundleInspectOutcome,
} from '../../cue-bundle-service';

const LOG_CONTEXT = '[CueBundle]';

/** Main -> renderer: add these agents, answer on the response channel. */
export const CUE_BUNDLE_APPLY_AGENTS_CHANNEL = 'cueBundle:applyAgents';

/** How long the renderer has to add the agents before the import rolls back. */
const APPLY_AGENTS_TIMEOUT_MS = 60_000;

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export interface CueBundleHandlerDependencies {
	sessionsStore: Store<SessionsData>;
	getMainWindow: () => BrowserWindow | null;
}

let appContext: CueBundleAppContext | null = null;

/**
 * The running app's bundle context, for the WebSocket bridge. Null until the
 * IPC handlers are registered.
 */
export function getCueBundleAppContext(): CueBundleAppContext | null {
	return appContext;
}

/** Ask the renderer to add and update agents, and wait for it to confirm. */
function applyAgentsInRenderer(
	getMainWindow: () => BrowserWindow | null,
	change: { created: SessionInfo[]; updated: SessionInfo[] }
): Promise<void> {
	if (change.created.length === 0 && change.updated.length === 0) return Promise.resolve();
	const mainWindow = getMainWindow();
	if (!mainWindow || !isWebContentsAvailable(mainWindow)) {
		return Promise.reject(new Error('The Maestro window is not open to add the agents'));
	}
	return new Promise((resolve, reject) => {
		const responseChannel = `${CUE_BUNDLE_APPLY_AGENTS_CHANNEL}:response:${randomUUID()}`;
		const handleResponse = (_event: unknown, result: { ok?: boolean; error?: string } | null) => {
			clearTimeout(timer);
			if (result?.ok) resolve();
			else reject(new Error(result?.error || 'The Maestro window could not add the agents'));
		};
		const timer = setTimeout(() => {
			ipcMain.removeListener(responseChannel, handleResponse);
			reject(new Error('The Maestro window did not confirm the agents in time'));
		}, APPLY_AGENTS_TIMEOUT_MS);
		ipcMain.once(responseChannel, handleResponse);
		mainWindow.webContents.send(CUE_BUNDLE_APPLY_AGENTS_CHANNEL, change, responseChannel);
	});
}

export function registerCueBundleHandlers(deps: CueBundleHandlerDependencies): void {
	const { sessionsStore, getMainWindow } = deps;

	appContext = {
		dataDir: app.getPath('userData'),
		agentConfigsDir: getProductionDataPath(),
		version: app.getVersion(),
		getSessions: () => sessionsStore.get('sessions', []) as SessionInfo[],
		applyAgents: (change) => applyAgentsInRenderer(getMainWindow, change),
	};
	const ctx = appContext;

	ipcMain.handle(
		'cueBundle:export',
		withIpcErrorLogging(
			handlerOpts('export'),
			async (request: CueBundleExportRequest): Promise<CueBundleExportOutcome> =>
				exportBundleFromApp(ctx, request)
		)
	);

	ipcMain.handle(
		'cueBundle:chooseFile',
		withIpcErrorLogging(handlerOpts('chooseFile'), async (): Promise<string | null> => {
			const mainWindow = getMainWindow();
			if (!mainWindow || mainWindow.isDestroyed()) return null;
			const result = await dialog.showOpenDialog(mainWindow, {
				properties: ['openFile'],
				title: 'Import a Maestro Bundle',
				filters: [{ name: 'Maestro bundle', extensions: ['zip'] }],
			});
			return result.canceled ? null : (result.filePaths[0] ?? null);
		})
	);

	ipcMain.handle(
		'cueBundle:inspect',
		withIpcErrorLogging(
			handlerOpts('inspect'),
			async (args: { bundlePath: string }): Promise<CueBundleInspectOutcome> =>
				inspectBundle(args.bundlePath, ctx.version)
		)
	);

	ipcMain.handle(
		'cueBundle:import',
		withIpcErrorLogging(
			handlerOpts('import'),
			async (request: CueBundleImportRequest): Promise<CueBundleImportOutcome> =>
				importBundleIntoApp(ctx, request)
		)
	);
}
