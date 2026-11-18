/**
 * Ask the desktop renderer to open a new AI tab on one agent and send a prompt
 * into it, and wait for its answer.
 *
 * The one main-process implementation of "new tab with prompt": the CLI's
 * `dispatch --new-tab` / `tab new --prompt` (through the web server's
 * `newAITabWithPrompt` callback) and a fired Prompt Link both come through
 * here, so they create the tab, run the turn, and report a refusal the same
 * way. The renderer side is `onRemoteNewAITabWithPrompt` in
 * `useRemoteIntegration`.
 */

import { randomUUID } from 'crypto';
import { ipcMain, type BrowserWindow } from 'electron';
import { logger } from './logger';
import { isWebContentsAvailable } from './safe-send';
import type { NewAITabWithPromptResult } from '../web-server/types';
import type { MentionRouting } from '../../shared/crossAgentContext';
import type { PianolaNewTabControl } from '../../shared/pianola/pianola-dispatch';

/** How long the renderer has to answer before the request is reported as timed out. */
export const NEW_AI_TAB_REQUEST_TIMEOUT_MS = 5000;

/**
 * The reason text for a renderer that never answered. A caller that must not
 * deliver twice (a Prompt Link) checks for it: the prompt MAY have run, so the
 * request is uncertain rather than refused.
 */
export const NEW_AI_TAB_TIMEOUT_ERROR = 'Maestro desktop did not answer in time';

/** The reason text when there is no window to ask. Nothing was delivered. */
export const NEW_AI_TAB_NO_WINDOW_ERROR = 'Maestro desktop window is not available';

/** What a caller may add to the plain request: the CLI's `dispatch` flags and Pianola's handshake. */
export interface NewAITabRequestOptions {
	/** Create the tab with no chip in the strip (see `AITab.hidden`). */
	hidden?: boolean;
	/** `dispatch --routing`: the `@mention` routing the composer strip would set. */
	mentionRouting?: MentionRouting;
	control?: PianolaNewTabControl;
}

/**
 * A result with `unknown: true` means the prompt MAY have run (the renderer did
 * not answer, or the send threw after the request left): a caller that must not
 * deliver twice treats it as uncertain, never as refused.
 */
export function requestNewAITabWithPrompt(
	getMainWindow: () => BrowserWindow | null,
	sessionId: string,
	prompt: string,
	background?: boolean,
	options: NewAITabRequestOptions = {}
): Promise<NewAITabWithPromptResult> {
	const mainWindow = getMainWindow();
	if (!mainWindow) {
		logger.warn('mainWindow is null for newAITabWithPrompt', 'WebServer');
		return Promise.resolve({ success: false, error: NEW_AI_TAB_NO_WINDOW_ERROR });
	}

	return new Promise<NewAITabWithPromptResult>((resolve) => {
		const responseChannel = `remote:newAITabWithPrompt:response:${randomUUID()}`;
		let resolved = false;

		/**
		 * Resolve the new-tab response once, accepting only the owning window's sender. Clean up its
		 * timeout/listener and normalize structured acknowledgements or the legacy boolean result.
		 */
		const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
			if (_event.sender !== mainWindow.webContents) return;
			if (resolved) return;
			resolved = true;
			clearTimeout(timeoutId);
			ipcMain.removeListener(responseChannel, handleResponse);
			// Renderer was updated to ack with
			// `{ success, tabId?, queued?, error? }`. Older renderers that
			// still send a bare boolean stay supported via the
			// `result === true` fallback.
			if (typeof result === 'object' && result !== null) {
				const r = result as {
					success?: unknown;
					tabId?: unknown;
					queued?: unknown;
					error?: unknown;
				};
				resolve({
					success: r.success === true,
					tabId: typeof r.tabId === 'string' ? r.tabId : undefined,
					...(r.queued === true ? { queued: true } : {}),
					...(typeof r.error === 'string' && r.error ? { error: r.error } : {}),
				});
			} else {
				resolve({ success: result === true });
			}
		};

		const timeoutId = setTimeout(() => {
			if (resolved) return;
			resolved = true;
			ipcMain.removeListener(responseChannel, handleResponse);
			logger.warn(`newAITabWithPrompt callback timed out for session ${sessionId}`, 'WebServer');
			resolve({ success: false, unknown: true, error: NEW_AI_TAB_TIMEOUT_ERROR });
		}, NEW_AI_TAB_REQUEST_TIMEOUT_MS);

		ipcMain.on(responseChannel, handleResponse);
		if (!isWebContentsAvailable(mainWindow)) {
			clearTimeout(timeoutId);
			logger.warn('webContents is not available for newAITabWithPrompt', 'WebServer');
			ipcMain.removeListener(responseChannel, handleResponse);
			resolve({ success: false, error: NEW_AI_TAB_NO_WINDOW_ERROR });
			return;
		}
		try {
			mainWindow.webContents.send(
				'remote:newAITabWithPrompt',
				sessionId,
				prompt,
				responseChannel,
				background,
				options.hidden,
				options.mentionRouting,
				options.control
			);
		} catch {
			clearTimeout(timeoutId);
			ipcMain.removeListener(responseChannel, handleResponse);
			resolved = true;
			resolve({ success: false, unknown: true });
		}
	});
}
