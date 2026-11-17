/**
 * The CLI's way to the Federation state that lives in the main window (`maestro-cli federation
 * conflicts|resolve|agents|add`): the hosted agents' settings conflicts live with the window's
 * settings sync, and the Left Bar's agents (the rows that point at hosted agents) live in the
 * window's session store, so main asks it.
 *
 * The window is the main window (the lifecycle owner runs the sync). Without one, or when it does
 * not answer in time, the call fails with a message that says so; nothing is guessed.
 */

import type { BrowserWindow } from 'electron';
import { requestFromRenderer } from '../web-server/callbacks/remoteRequest';
import {
	FEDERATION_WINDOW_REQUEST_CHANNEL,
	type FederationWindowReply,
	type FederationWindowRequest,
} from '../../shared/federationCommands';

const NO_WINDOW: FederationWindowReply = {
	success: false,
	error: 'The main Maestro window is not open.',
};

let getWindow: (() => BrowserWindow | null) | null = null;

/** Wired once at boot by the Federation IPC registration, which holds the main window getter. */
export function setFederationWindow(getter: (() => BrowserWindow | null) | null): void {
	getWindow = getter;
}

/** Ask the main window one Federation question. */
export async function requestFederationWindow(
	request: FederationWindowRequest
): Promise<FederationWindowReply> {
	const win = getWindow?.();
	if (!win || win.isDestroyed()) return NO_WINDOW;
	return requestFromRenderer<FederationWindowReply>(win, FEDERATION_WINDOW_REQUEST_CHANNEL, {
		fallback: { success: false, error: 'The Maestro window did not answer in time.' },
		parse: (raw) =>
			raw && typeof raw === 'object'
				? (raw as FederationWindowReply)
				: { success: false, error: 'The Maestro window answered with nothing.' },
		timeoutMs: 10_000,
		args: [request],
	});
}
