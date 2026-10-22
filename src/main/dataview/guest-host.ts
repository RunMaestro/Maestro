/**
 * Main-process host of the DataviewJS sandbox (D4, DV-11): the isolated `<webview>` guests note scripts run
 * in. The renderer (`DataviewJsFrame`) sets only `partition` and `src` on the tag; everything that makes the
 * guest safe is forced here, through the same isolated-guest lockdown plugin panels use
 * (`src/main/utils/isolated-guest.ts`):
 *
 * - **Attachment** (`will-attach-webview`, `src/main/app-lifecycle/guest-webview-security.ts`): the partition
 *   must be a guest partition and the document exactly the guest URL (`isAllowedDataviewGuestAttachment()`),
 *   and DataviewJS must be serving (`isDataviewJsServing()`), or the guest is never created. Web preferences
 *   are forced: no Node anywhere, contextIsolation, the OS sandbox, webSecurity, and the bridge-only preload
 *   `dataview-guest-preload.js`, which exposes nothing to the page.
 * - **Session** (one in-memory session per vault root): the `dataview-guest` scheme serves the guest
 *   document and nothing else, with the D4 CSP as a header and a meta tag, and only while DataviewJS is
 *   serving; every other request is cancelled; every permission is denied.
 * - **Guest** (`did-attach-webview`): no popups, no navigation after the first document, and audio muted.
 *
 * The guest reads the vault only through its host: the index snapshot (`dataview:jsSnapshot`) and file reads
 * (`dataview:readInRoot`), both refused in main unless DataviewJS is on and the root trusted (the service).
 */

import * as fs from 'fs';
import * as path from 'path';
import { session } from 'electron';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import {
	DATAVIEW_GUEST_CSP,
	DATAVIEW_GUEST_SCHEME,
	DATAVIEW_GUEST_URL,
	isDataviewGuestPartition,
} from '../../shared/dataview/sandboxHost';
import {
	attachIsolatedGuestSecurity,
	hardenIsolatedGuestSession,
	hardenIsolatedGuestWebPreferences,
	isIsolatedGuestSession,
	isolatedGuestDocument,
	isolatedGuestNotFound,
	type IsolatedGuestContents,
	type IsolatedGuestSessionLike,
	type IsolatedGuestWebPreferences,
} from '../utils/isolated-guest';

const LOG_CONTEXT = 'DataviewGuestHost';

/** How the shared isolated-guest lockdown names these guests in its log lines. */
const GUEST_LABEL = 'Dataview guest';

/** The guest's bridge preload, built next to the main preload by scripts/build-preload.mjs. */
export const DATAVIEW_GUEST_PRELOAD_FILE = 'dataview-guest-preload.js';

/** The guest document, built from src/renderer/dataview-sandbox/ by scripts/build-preload.mjs. */
export const DATAVIEW_GUEST_DOCUMENT_FILE = 'dataview-guest.html';

/** Default deny until the Dataview IPC registration wires the service's check. */
let servingCheck: () => boolean = () => false;

/**
 * Wire the check of whether DataviewJS may run at all (the `dataview` Encore Feature and the DataviewJS
 * setting both on). Set from `registerDataviewHandlers()`, so this module, which the window manager loads,
 * never reaches into the settings store itself.
 */
export function setDataviewJsServingCheck(check: () => boolean): void {
	servingCheck = check;
}

/** Whether DataviewJS may run now. A check that throws counts as no. */
export function isDataviewJsServing(): boolean {
	try {
		return servingCheck() === true;
	} catch (error) {
		logger.warn(`Dataview guest serving check failed: ${String(error)}`, LOG_CONTEXT);
		return false;
	}
}

export interface DataviewGuestSessionOptions {
	/** The folder holding the built guest document (`dist/main`). */
	documentDir: string;
	/** Whether to serve the document now. Defaults to {@link isDataviewJsServing}, read on every load. */
	isServing?: () => boolean;
	/** Reads the document. Defaults to `fs.promises.readFile` as UTF-8. */
	readDocument?: (filePath: string) => Promise<string>;
}

/** Whether `ses` is a hardened Dataview guest session; drives the `did-attach-webview` branch. */
export function isDataviewGuestSession(ses: unknown): boolean {
	return isIsolatedGuestSession(ses, DATAVIEW_GUEST_SCHEME);
}

/** Force the locked-down web preferences of a guest, with the bridge-only guest preload. */
export function hardenDataviewGuestWebPreferences(
	webPreferences: IsolatedGuestWebPreferences,
	guestPreloadPath: string
): void {
	hardenIsolatedGuestWebPreferences(webPreferences, guestPreloadPath);
}

/**
 * Answer one request on the guest scheme: the guest document for exactly the guest URL while DataviewJS is
 * serving, a 404 for anything else. Read from disk on every load, so a rebuilt guest is picked up and a
 * setting turned off since the tag mounted is honored.
 */
export async function serveDataviewGuestDocument(
	request: { url: string },
	options: DataviewGuestSessionOptions
): Promise<Response> {
	if (request.url !== DATAVIEW_GUEST_URL) {
		logger.warn(`Refused Dataview guest request: ${request.url}`, LOG_CONTEXT);
		return isolatedGuestNotFound();
	}
	if (!(options.isServing ?? isDataviewJsServing)()) return isolatedGuestNotFound();
	const documentPath = path.join(options.documentDir, DATAVIEW_GUEST_DOCUMENT_FILE);
	try {
		const read = options.readDocument ?? ((file: string) => fs.promises.readFile(file, 'utf8'));
		return isolatedGuestDocument(await read(documentPath), DATAVIEW_GUEST_CSP);
	} catch (error) {
		logger.error(`Could not read the Dataview guest document ${documentPath}`, LOG_CONTEXT, error);
		void captureException(error, { operation: 'dataview:serveGuestDocument' });
		return isolatedGuestNotFound();
	}
}

/**
 * Harden the guest session named by `partition`, once: the guest document on the guest scheme, every other
 * request cancelled, every permission denied. Does nothing for a partition that is not a guest partition.
 */
export function hardenDataviewGuestSession(
	partition: string,
	options: DataviewGuestSessionOptions,
	sessionFactory: (partition: string) => IsolatedGuestSessionLike = (p) =>
		session.fromPartition(p) as unknown as IsolatedGuestSessionLike
): void {
	if (!isDataviewGuestPartition(partition)) return;
	hardenIsolatedGuestSession(sessionFactory(partition), {
		scheme: DATAVIEW_GUEST_SCHEME,
		label: GUEST_LABEL,
		logContext: LOG_CONTEXT,
		serve: (request) => serveDataviewGuestDocument(request, options),
	});
}

/** Guest webContents surface the guest lockdown uses (structural). */
export interface DataviewGuestContents extends IsolatedGuestContents {
	setAudioMuted?(muted: boolean): void;
}

/** Lock down an attached guest: no popups, no navigation after its first document, no sound. */
export function attachDataviewGuestSecurity(guestContents: DataviewGuestContents): void {
	attachIsolatedGuestSecurity(guestContents, { label: GUEST_LABEL, logContext: LOG_CONTEXT });
	// A note script has no business making noise (an AudioContext needs no URL, so the CSP cannot stop it).
	guestContents.setAudioMuted?.(true);
}
