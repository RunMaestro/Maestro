/**
 * The lockdown of an isolated `<webview>` guest: a separate renderer process that shows content Maestro does
 * not trust, with one narrow bridge to its host. Plugin panels (`src/main/plugins/plugin-panel-host.ts`) and
 * the DataviewJS sandbox (`src/main/dataview/guest-host.ts`) both run through it, so the two surfaces cannot
 * drift apart. Each host supplies its scheme, its preload, and what its scheme serves:
 *
 * - **Web preferences** (`hardenIsolatedGuestWebPreferences`, in `will-attach-webview`): the host's own
 *   preload replaces anything the renderer named; no Node in any frame or worker; contextIsolation, the OS
 *   sandbox, and webSecurity on; no insecure content, nested webviews, or plugins.
 * - **Session** (`hardenIsolatedGuestSession`): a per-session protocol handler serves the host's documents on
 *   its scheme; `webRequest` cancels every request outside that scheme (egress denial beneath the CSP); every
 *   permission request and check is denied. Idempotent per session.
 * - **Guest** (`attachIsolatedGuestSecurity`, in `did-attach-webview`): `window.open` is denied, and every
 *   navigation, redirect, and frame navigation is prevented. The first load comes from the `src` attribute
 *   (a programmatic load that emits none of these events), so the guest lives and dies on its first document.
 *
 * The renderer only ever sets `partition` and `src` on the tag; everything above is forced here.
 */

import { withCspMetaTag } from '../../shared/cspMeta';
import { logger } from './logger';

/** Minimal structural view of Electron.Session, so hosts and tests can pass doubles. */
export interface IsolatedGuestSessionLike {
	protocol: {
		handle(
			scheme: string,
			handler: (request: { url: string }) => Response | Promise<Response>
		): void;
	};
	webRequest: {
		onBeforeRequest(
			listener: (
				details: { url: string },
				callback: (response: { cancel: boolean }) => void
			) => void
		): void;
	};
	setPermissionRequestHandler(handler: ((...args: unknown[]) => void) | null): void;
	setPermissionCheckHandler(handler: ((...args: unknown[]) => boolean) | null): void;
}

/** Webview webPreferences as mutated inside `will-attach-webview`. */
export type IsolatedGuestWebPreferences = Record<string, unknown>;

/** Guest webContents surface the lockdown uses (structural). */
export interface IsolatedGuestContents {
	session?: unknown;
	setWindowOpenHandler(handler: ({ url }: { url: string }) => { action: 'deny' }): void;
	on(
		event: 'will-navigate' | 'will-redirect' | 'will-frame-navigate',
		handler: (event: { preventDefault: () => void; url?: string }, url?: string) => void
	): void;
}

export interface IsolatedGuestSessionOptions {
	/** The scheme the session serves its documents on. Every other request is cancelled. */
	scheme: string;
	/** Answers one document request on `scheme`. Default deny: answer 404 for anything unexpected. */
	serve(request: { url: string }): Response | Promise<Response>;
	/** Names the surface in log lines ("panel", "Dataview guest"). */
	label: string;
	logContext: string;
}

/** Sessions hardened so far, with the scheme each serves; membership is what marks a session as a guest's. */
const hardenedSessions = new WeakMap<object, string>();

/**
 * Force the locked-down web preferences of an isolated guest. Runs inside `will-attach-webview`, so nothing
 * the renderer put on the `<webview>` tag survives.
 */
export function hardenIsolatedGuestWebPreferences(
	webPreferences: IsolatedGuestWebPreferences,
	preloadPath: string
): void {
	delete webPreferences.preloadURL;
	webPreferences.preload = preloadPath;
	webPreferences.nodeIntegration = false;
	webPreferences.nodeIntegrationInSubFrames = false;
	webPreferences.nodeIntegrationInWorker = false;
	webPreferences.contextIsolation = true;
	webPreferences.sandbox = true;
	webPreferences.webSecurity = true;
	webPreferences.allowRunningInsecureContent = false;
	webPreferences.webviewTag = false;
	webPreferences.plugins = false;
}

/**
 * Harden one guest session: serve the host's documents on its scheme, cancel every other request, and deny
 * every permission. Only the first call for a session installs anything; it returns false for a session that
 * was already hardened.
 */
export function hardenIsolatedGuestSession(
	ses: IsolatedGuestSessionLike,
	options: IsolatedGuestSessionOptions
): boolean {
	const key = ses as unknown as object;
	if (hardenedSessions.has(key)) return false;
	hardenedSessions.set(key, options.scheme);
	const { scheme, label, logContext } = options;

	ses.protocol.handle(scheme, (request) => options.serve(request));

	// Session-level egress denial: the only requests this session may make are its own document fetches.
	// Everything else (http, https, ws, file, other schemes) is cancelled before it leaves, whatever the CSP.
	ses.webRequest.onBeforeRequest((details, callback) => {
		const cancel = !details.url.startsWith(`${scheme}://`);
		if (cancel) logger.warn(`Blocked ${label} egress attempt: ${details.url}`, logContext);
		callback({ cancel });
	});

	// No web permission (camera, microphone, geolocation, clipboard, notifications, ...) is grantable.
	ses.setPermissionRequestHandler((...args: unknown[]) => {
		const callback = args[2];
		if (typeof callback === 'function') (callback as (granted: boolean) => void)(false);
	});
	ses.setPermissionCheckHandler(() => false);
	return true;
}

/** Whether `ses` was hardened by {@link hardenIsolatedGuestSession} to serve `scheme`. */
export function isIsolatedGuestSession(ses: unknown, scheme: string): boolean {
	return typeof ses === 'object' && ses !== null && hardenedSessions.get(ses) === scheme;
}

/** An HTML document for a guest: the CSP as a response header and as a meta tag. */
export function isolatedGuestDocument(html: string, csp: string): Response {
	return new Response(withCspMetaTag(html, csp), {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy': csp,
		},
	});
}

/** The refusal every guest scheme answers with. */
export function isolatedGuestNotFound(): Response {
	return new Response(null, { status: 404 });
}

/** Lock down an attached guest: no popups, and no navigation of any kind after its first document. */
export function attachIsolatedGuestSecurity(
	guestContents: IsolatedGuestContents,
	options: { label: string; logContext: string }
): void {
	const { label, logContext } = options;
	guestContents.setWindowOpenHandler(({ url }) => {
		logger.warn(`Blocked ${label} popup: ${url}`, logContext);
		return { action: 'deny' };
	});

	const denyNavigation = (
		eventName: string,
		event: { preventDefault: () => void; url?: string },
		url?: string
	) => {
		event.preventDefault();
		logger.warn(`Blocked ${label} ${eventName}: ${url ?? event.url ?? '<unknown>'}`, logContext);
	};

	guestContents.on('will-navigate', (event, url) => denyNavigation('will-navigate', event, url));
	guestContents.on('will-redirect', (event, url) => denyNavigation('will-redirect', event, url));
	guestContents.on('will-frame-navigate', (event) => denyNavigation('will-frame-navigate', event));
}
