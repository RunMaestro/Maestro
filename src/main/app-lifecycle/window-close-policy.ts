/**
 * Window close policy for multi-window lifecycle.
 */

import { app } from 'electron';
import type { BrowserWindow, Event } from 'electron';
import type { QuitHandler } from './quit-handler';

export interface PrimaryWindowClosePolicyDependencies {
	getPrimaryWindow: () => BrowserWindow | null;
	quitHandler: QuitHandler;
}

/**
 * Closing the primary window means quitting the app. Route that close through
 * the normal app quit path so the existing busy-agent confirmation still runs.
 */
export function attachPrimaryWindowClosePolicy({
	getPrimaryWindow,
	quitHandler,
}: PrimaryWindowClosePolicyDependencies): void {
	const primaryWindow = getPrimaryWindow();
	if (!primaryWindow) {
		return;
	}

	primaryWindow.on('close', (event: Event) => {
		if (quitHandler.isQuitConfirmed()) {
			return;
		}

		event.preventDefault();
		app.quit();
	});
}
