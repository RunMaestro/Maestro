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
import { createSafeSend, isWebContentsAvailable } from '../utils/safe-send';
import { logger } from '../utils/logger';

export type CueNotifyClickAction =
	| { kind: 'jump-session'; sessionId: string; tabId?: string }
	| { kind: 'open-file'; sessionId: string; path: string }
	| { kind: 'open-url'; url: string };

export interface CueNotifyToastParams {
	/** Owning agent (session) ID. Drives both `project` lookup in the renderer
	 *  and the default `jump-session` click target. */
	agentId: string;
	/** Toast title - typically the agent's display name or the subscription name. */
	title: string;
	/** Toast body text. */
	message: string;
	/** Sticky toast - disables auto-dismiss, requires explicit click-to-close. */
	sticky?: boolean;
	/** Override the default click intent (defaults to jump-session for the agent). */
	clickAction?: CueNotifyClickAction;
}

/**
 * Send a Cue-originated toast notification to the renderer.
 *
 * Routes through `safeSend`, so the toast always fans out to web-desktop bridge
 * clients (when the Encore Feature is on and clients are connected) in addition
 * to the Electron renderer whenever the desktop window is alive. Web/mobile
 * users therefore see Cue notify toasts even when the desktop window is closed,
 * destroyed, or mid-launch.
 *
 * Returns `true` when the desktop renderer was reachable, `false` when it wasn't
 * (window destroyed, webContents gone, headless boot) or when the send threw.
 * The bridge fan-out is fire-and-forget with no delivery signal, so a `false`
 * return does not mean web clients missed the toast. Failure is logged but not
 * thrown; toasts are advisory, not load-bearing.
 */
export function emitCueNotifyToast(
	mainWindow: BrowserWindow | null,
	params: CueNotifyToastParams
): boolean {
	const clickAction: CueNotifyClickAction = params.clickAction ?? {
		kind: 'jump-session',
		sessionId: params.agentId,
	};

	const safeSend = createSafeSend(() => mainWindow);
	const desktopReachable = isWebContentsAvailable(mainWindow);

	// safeSend swallows the renderer dispose / shutdown race internally, but wrap
	// it anyway so any unexpected throw still honors the documented "logged but
	// not thrown" contract and keeps `executeCueNotify()`'s never-throws behavior
	// intact.
	try {
		safeSend('remote:notifyToast', {
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

	return desktopReachable;
}
