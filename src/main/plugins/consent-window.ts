/**
 * Plugin consent window (main process).
 *
 * Creates the dedicated, host-owned, non-extensible window that shows a plugin's
 * permission request and collects the user's approval. It is the ONLY trusted
 * confirmer of a `ConsentMinter` prompt:
 *
 * - It loads its OWN minimal page (`consent.html`) with its OWN minimal preload
 *   (`consent-preload.js`) that exposes nothing but the consent bridge — never
 *   the main Maestro SPA or its full preload, so a plugin can neither render into
 *   it nor reach a richer IPC surface through it.
 * - It is a modal, non-resizable, menu-less child window — not an in-page modal a
 *   plugin-controlled surface could overlay or spoof.
 * - The offer (including the one-time nonce) is handed to it ONLY via
 *   `additionalArguments`, readable solely by this window's preload.
 *
 * `openConsentWindow` returns the window's `ConsentSender` (webContents id + main
 * frame routing id + url) so the confirm IPC can verify a `plugins:confirm-consent`
 * call actually came from this exact frame.
 */

import { BrowserWindow } from 'electron';
import * as path from 'path';
import type { ConsentSender } from './consent-minter';

/** One capability row shown in the consent window. */
export interface ConsentOfferItem {
	capability: string;
	risk: 'low' | 'medium' | 'high';
	scope?: string;
	reason?: string;
	/** Human-readable description (from describeCapability). */
	description: string;
}

/** The full offer handed to the consent window via additionalArguments. */
export interface ConsentOffer {
	pluginId: string;
	pluginName: string;
	nonce: string;
	offered: ConsentOfferItem[];
}

export interface OpenConsentWindowDeps {
	/** The window the consent prompt is modal to (the main window), or null. */
	parent: BrowserWindow | null;
	/** Absolute path to the dedicated consent preload (dist/main/consent-preload.js). */
	preloadPath: string;
	/** Absolute path to the dedicated consent page (dist/main/consent.html). */
	htmlPath: string;
}

export interface OpenedConsentWindow {
	window: BrowserWindow;
	sender: ConsentSender;
}

/**
 * Open the consent window for an offer and resolve once it has loaded, returning
 * the window and the frame token the confirm IPC must match. The caller owns the
 * window lifecycle (close it after confirm/cancel).
 */
export async function openConsentWindow(
	offer: ConsentOffer,
	deps: OpenConsentWindowDeps
): Promise<OpenedConsentWindow> {
	const encoded = Buffer.from(JSON.stringify(offer), 'utf-8').toString('base64');
	const window = new BrowserWindow({
		width: 460,
		height: 560,
		resizable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		autoHideMenuBar: true,
		title: 'Plugin permissions',
		backgroundColor: '#0b0b0d',
		modal: deps.parent !== null,
		...(deps.parent ? { parent: deps.parent } : {}),
		webPreferences: {
			preload: deps.preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			// Hand the offer (and its one-time nonce) ONLY to this window's preload.
			additionalArguments: [`--consent-offer=${encoded}`],
		},
	});

	// Never let the consent surface be navigated away or grow extra webContents.
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('will-navigate', (event) => event.preventDefault());

	const loaded = new Promise<void>((resolve) => {
		window.webContents.once('did-finish-load', () => resolve());
	});
	await window.loadFile(deps.htmlPath);
	await loaded;

	const frame = window.webContents.mainFrame;
	const sender: ConsentSender = {
		webContentsId: window.webContents.id,
		frameId: frame.routingId,
		url: frame.url,
	};
	return { window, sender };
}

/** Build the runtime paths for the consent surface (siblings of the main process
 * bundle in dist/main). */
export function consentSurfacePaths(dir: string): { preloadPath: string; htmlPath: string } {
	return {
		preloadPath: path.join(dir, 'consent-preload.js'),
		htmlPath: path.join(dir, 'consent.html'),
	};
}
