/**
 * Cue → renderer notify bridge.
 *
 * The CLI's `notify_toast` WebSocket message and the renderer already share an
 * end-to-end toast pipeline: main process emits `remote:notifyToast`, the
 * preload exposes `onRemoteNotifyToast`, and `useRemoteIntegration` dispatches
 * `notifyToast(...)` on the renderer side. Cue's `action: notify` runs entirely
 * inside the main process, so this thin helper lets the executor reuse that
 * existing channel without going through the WebSocket loopback.
 */

import { BrowserWindow } from 'electron';
import { isWebContentsAvailable } from '../utils/safe-send';
import { logger } from '../utils/logger';

export type CueNotifyClickAction =
	| { kind: 'jump-session'; sessionId: string; tabId?: string }
	| { kind: 'open-file'; sessionId: string; path: string }
	| { kind: 'open-url'; url: string };

export interface CueNotifyToastParams {
	/** Owning agent (session) ID. Drives both `project` lookup in the renderer
	 *  and the default `jump-session` click target. */
	agentId: string;
	/** Toast title — typically the agent's display name or the subscription name. */
	title: string;
	/** Toast body text. */
	message: string;
	/** Sticky toast — disables auto-dismiss, requires explicit click-to-close. */
	sticky?: boolean;
	/** Override the default click intent (defaults to jump-session for the agent). */
	clickAction?: CueNotifyClickAction;
}

/**
 * Send a Cue-originated toast notification to the renderer.
 *
 * Returns `true` when the IPC send succeeded, `false` when the renderer isn't
 * available (window destroyed, webContents gone, headless boot). Failure is
 * logged but not thrown — toasts are advisory, not load-bearing.
 */
export function emitCueNotifyToast(
	mainWindow: BrowserWindow | null,
	params: CueNotifyToastParams
): boolean {
	if (!isWebContentsAvailable(mainWindow)) {
		logger.warn('mainWindow unavailable for Cue notify toast emit', 'Cue');
		return false;
	}

	const clickAction: CueNotifyClickAction = params.clickAction ?? {
		kind: 'jump-session',
		sessionId: params.agentId,
	};

	// `isWebContentsAvailable` above is a check, not a guarantee: a dispose /
	// shutdown race can still make `send()` throw synchronously. Guard it so we
	// honor the documented "logged but not thrown" contract and keep
	// `executeCueNotify()`'s never-throws behavior intact.
	try {
		mainWindow.webContents.send('remote:notifyToast', {
			title: params.title,
			message: params.message,
			color: 'theme' as const,
			dismissible: params.sticky === true,
			sessionId: params.agentId,
			clickAction,
		});
	} catch (err) {
		logger.warn('Failed to send Cue notify toast to renderer', 'Cue', err);
		return false;
	}

	return true;
}
