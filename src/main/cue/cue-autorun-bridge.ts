/**
 * Cue -> renderer Auto Run bridge.
 *
 * Launching an Auto Run is a renderer-owned flow (it walks the document list,
 * drives the batch processor, and can spawn a worktree child), so the main
 * process cannot start one directly. The web/CLI surface already solved this:
 * `remote:configureAutoRun` carries a launch request to the renderer and the
 * renderer answers on a one-shot response channel. Cue's `action: autorun`
 * runs entirely in the main process, so this helper reuses that same channel
 * rather than looping back through the WebSocket server.
 *
 * Unlike {@link emitCueNotifyToast}, this bridge is NOT fire-and-forget. A
 * scheduled Auto Run fires while nobody is watching, so the executor must be
 * able to tell "the renderer accepted and started the run" from "the renderer
 * never answered" - the second case has to be reported as a failure, or the
 * one-shot subscription self-destructs and the user's 6am run vanishes with
 * nothing left to inspect.
 */

import { randomUUID } from 'crypto';
import { BrowserWindow, ipcMain } from 'electron';
import { isWebContentsAvailable } from '../utils/safe-send';
import { logger } from '../utils/logger';

/**
 * How long to wait for the renderer to accept a launch.
 *
 * Deliberately longer than the 10s used by the web-server callbacks: those
 * answer a user who is sitting in front of a request, while this one may land
 * on a renderer that is mid-worktree-creation. The wait covers ACCEPTANCE of
 * the launch, not the run itself - the Auto Run keeps going long after this
 * resolves.
 */
export const CUE_AUTORUN_LAUNCH_TIMEOUT_MS = 30_000;

/** One document to run, in the shape `remote:configureAutoRun` expects. */
export interface CueAutoRunDocument {
	/** Absolute path, captured when the run was scheduled. */
	filename: string;
	resetOnCompletion?: boolean;
}

export interface CueAutoRunLaunchParams {
	sessionId: string;
	documents: CueAutoRunDocument[];
	prompt?: string;
	loopEnabled?: boolean;
	maxLoops?: number;
	model?: string;
	effort?: string;
}

export interface CueAutoRunLaunchResult {
	success: boolean;
	error?: string;
}

/**
 * Ask the renderer to launch an Auto Run and wait for it to accept.
 *
 * Resolves `{ success: true }` only when the renderer actually reports the
 * launch started. Every other path - no window, dead webContents, timeout, an
 * explicit renderer-side rejection - resolves `{ success: false, error }`.
 * Never rejects: the executor turns the result into a run status, and an
 * exception escaping here would bypass that.
 */
export function launchCueAutoRun(
	mainWindow: BrowserWindow | null,
	params: CueAutoRunLaunchParams
): Promise<CueAutoRunLaunchResult> {
	if (!mainWindow) {
		return Promise.resolve({
			success: false,
			error: 'desktop window not available - Auto Run can only be launched by the renderer',
		});
	}

	return new Promise((resolve) => {
		const responseChannel = `remote:configureAutoRun:response:${randomUUID()}`;
		let settled = false;

		const handleResponse = (
			_event: Electron.IpcMainEvent,
			result: CueAutoRunLaunchResult | undefined
		) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			resolve(result ?? { success: false, error: 'renderer returned no result' });
		};

		ipcMain.once(responseChannel, handleResponse);

		if (!isWebContentsAvailable(mainWindow)) {
			settled = true;
			ipcMain.removeListener(responseChannel, handleResponse);
			resolve({ success: false, error: 'renderer webContents not available' });
			return;
		}

		mainWindow.webContents.send(
			'remote:configureAutoRun',
			params.sessionId,
			{
				documents: params.documents,
				prompt: params.prompt,
				loopEnabled: params.loopEnabled,
				maxLoops: params.maxLoops,
				...(params.model && { model: params.model }),
				...(params.effort && { effort: params.effort }),
				launch: true,
			},
			responseChannel
		);

		const timeoutId = setTimeout(() => {
			if (settled) return;
			settled = true;
			ipcMain.removeListener(responseChannel, handleResponse);
			logger.warn(`Cue Auto Run launch timed out for session ${params.sessionId}`, 'Cue');
			resolve({
				success: false,
				error: `renderer did not accept the launch within ${CUE_AUTORUN_LAUNCH_TIMEOUT_MS / 1000}s`,
			});
		}, CUE_AUTORUN_LAUNCH_TIMEOUT_MS);
	});
}
