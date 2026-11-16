/**
 * The CLI's way to the Federation settings conflicts (`maestro-cli federation conflicts`,
 * `federation resolve`): they live in the window that runs the settings sync, so main asks it.
 *
 * The window is the main window (the lifecycle owner runs the sync). Without one, or when it does
 * not answer in time, the call fails with a message that says so; nothing is guessed.
 */

import type { BrowserWindow } from 'electron';
import { requestFromRenderer } from '../web-server/callbacks/remoteRequest';
import {
	HOSTED_SETTINGS_REQUEST_CHANNEL,
	type HostedSettingsReply,
	type HostedSettingsRequest,
} from '../../shared/federationCommands';

const NO_WINDOW: HostedSettingsReply = {
	success: false,
	error: 'The Maestro window that keeps hosted agents in step is not open.',
};

let getWindow: (() => BrowserWindow | null) | null = null;

/** Wired once at boot by the Federation IPC registration, which holds the main window getter. */
export function setHostedSettingsWindow(getter: (() => BrowserWindow | null) | null): void {
	getWindow = getter;
}

/** Ask the window for the conflicts, or to settle one. */
export async function requestHostedSettings(
	request: HostedSettingsRequest
): Promise<HostedSettingsReply> {
	const win = getWindow?.();
	if (!win || win.isDestroyed()) return NO_WINDOW;
	return requestFromRenderer<HostedSettingsReply>(win, HOSTED_SETTINGS_REQUEST_CHANNEL, {
		fallback: { success: false, error: 'The Maestro window did not answer in time.' },
		parse: (raw) =>
			raw && typeof raw === 'object'
				? (raw as HostedSettingsReply)
				: { success: false, error: 'The Maestro window answered with nothing.' },
		timeoutMs: 5000,
		args: [request],
	});
}
