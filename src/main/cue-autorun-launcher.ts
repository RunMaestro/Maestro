/**
 * Desktop launcher for Cue's `action: autorun`.
 *
 * Launching an Auto Run is a renderer-owned flow (it walks the document list,
 * drives the batch processor, and can spawn a worktree child), so the main
 * process cannot start one directly. The web/CLI surface already solved this:
 * `remote:configureAutoRun` carries a launch request to the renderer and the
 * renderer answers on a one-shot response channel. This rides that same
 * channel through the shared {@link requestFromRenderer} round trip.
 *
 * It lives OUTSIDE `src/main/cue/` on purpose. The Cue engine has to stay
 * runnable without the desktop app, so it takes a launcher as a dependency
 * (`CueAutoRunLauncher`) and this module is the desktop's implementation of it.
 *
 * Unlike a notify toast, this is NOT fire-and-forget. A scheduled Auto Run
 * fires while nobody is watching, so the executor must be able to tell "the
 * renderer accepted and started the run" from "the renderer never answered" -
 * the second case has to be reported as a failure, or the one-shot subscription
 * self-destructs and the user's 6am run vanishes with nothing left to inspect.
 */

import type { BrowserWindow } from 'electron';
import type { CueAutoRunLaunchParams, CueAutoRunLaunchResult } from './cue/cue-autorun-executor';
import { isWebContentsAvailable } from './utils/safe-send';
import { logger } from './utils/logger';
import { WORKTREE_SETUP_TIMEOUT_MS } from './utils/worktree-setup-script';
import { requestFromRenderer } from './web-server/callbacks/remoteRequest';

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

/**
 * How long to wait for a launch into a worktree that does not exist yet.
 *
 * The renderer accepts only after `git worktree add` AND the parent agent's
 * setup script have finished, and the script alone is allowed
 * `WORKTREE_SETUP_TIMEOUT_MS`. Giving up sooner would report a failed launch
 * for a run that then starts anyway - and a failed scheduled run is kept on
 * disk to be re-triggered, which is how one schedule becomes two runs.
 */
export const CUE_AUTORUN_WORKTREE_LAUNCH_TIMEOUT_MS =
	CUE_AUTORUN_LAUNCH_TIMEOUT_MS + WORKTREE_SETUP_TIMEOUT_MS;

/** The acceptance budget for one launch. Exported for tests. */
export function cueAutoRunLaunchTimeoutMs(params: CueAutoRunLaunchParams): number {
	return params.worktreeTarget?.mode === 'create-new'
		? CUE_AUTORUN_WORKTREE_LAUNCH_TIMEOUT_MS
		: CUE_AUTORUN_LAUNCH_TIMEOUT_MS;
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
export async function launchCueAutoRun(
	mainWindow: BrowserWindow | null,
	params: CueAutoRunLaunchParams
): Promise<CueAutoRunLaunchResult> {
	if (!mainWindow) {
		return {
			success: false,
			error: 'desktop window not available - Auto Run can only be launched by the renderer',
		};
	}
	if (!isWebContentsAvailable(mainWindow)) {
		return { success: false, error: 'renderer webContents not available' };
	}

	const timeoutMs = cueAutoRunLaunchTimeoutMs(params);
	// A fresh object per call, so a timeout is told apart from a renderer that
	// answered with a failure of its own by identity rather than by message.
	const timedOut: CueAutoRunLaunchResult = {
		success: false,
		error: `renderer did not accept the launch within ${timeoutMs / 1000}s`,
	};
	// Everything but the agent id IS the launch request, so it is forwarded
	// whole: a run option added to `CueAutoRunLaunchParams` reaches the renderer
	// without a second list here to forget it in.
	const { sessionId, ...run } = params;
	const result = await requestFromRenderer<CueAutoRunLaunchResult>(
		mainWindow,
		'remote:configureAutoRun',
		{
			fallback: timedOut,
			parse: (raw) =>
				(raw as CueAutoRunLaunchResult | undefined) ?? {
					success: false,
					error: 'renderer returned no result',
				},
			timeoutMs,
			args: [sessionId, { ...run, launch: true }],
		}
	);
	if (result === timedOut) {
		logger.warn(`Cue Auto Run launch timed out for session ${sessionId}`, 'Cue');
	}
	return result;
}
