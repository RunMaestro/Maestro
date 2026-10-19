/**
 * Runtime context detection for the renderer.
 *
 * The same renderer code runs in three places:
 *   1. The Electron desktop app (`isWebDesktop() === false`)
 *   2. The web-desktop bundle served through the embedded web server - the
 *      default browser interface at the token root `/<token>`, with a legacy
 *      `/<token>/desktop` alias (`isWebDesktop() === true`)
 *   3. SSR/test environments where `window` may not exist
 *
 * Components use `isWebDesktop()` to hide destructive UI that assumes
 * Electron-host lifecycle - toggling the LIVE webserver off from inside
 * the bridge would kill the browser's own connection, and "Quit",
 * "Restart", and "Check for Updates" have no meaning when the user isn't
 * running the Electron binary directly.
 */

import { TAB_WINDOW_QUERY_PARAM } from '../../shared/tabWindowTypes';

let cached: boolean | null = null;

/**
 * Returns true when the renderer is running inside the web-desktop browser
 * bundle. Memoized after first call - the answer doesn't change for the
 * life of a page load.
 */
export function isWebDesktop(): boolean {
	if (cached !== null) return cached;
	if (typeof window === 'undefined') {
		cached = false;
		return cached;
	}
	// Primary signal: the server injects __MAESTRO_CONFIG__ into the page so
	// the bridge knows where to connect. Its presence is a load-bearing
	// indicator that we are NOT inside Electron. (Read via cast - the same
	// global is declared with a stricter shape elsewhere in src/web, and
	// re-augmenting it from the renderer would collide.)
	const cfg = (window as { __MAESTRO_CONFIG__?: unknown }).__MAESTRO_CONFIG__;
	if (cfg) {
		cached = true;
		return cached;
	}
	// Defensive secondary signal: serving path. The server injects
	// __MAESTRO_CONFIG__ inline before any module runs, so the primary signal
	// above covers the token-root case; this only catches the legacy
	// `/<token>/desktop` alias if config injection were ever absent.
	if (typeof window.location !== 'undefined') {
		try {
			if (/\/desktop\/?$/.test(window.location.pathname)) {
				cached = true;
				return cached;
			}
		} catch {
			/* sandboxed window.location accessors can throw - fall through */
		}
	}
	cached = false;
	return cached;
}

/** Inverse of {@link isWebDesktop}. Reads better at the call site for guards
 * like `if (isElectronDesktop()) { ... }`. */
export function isElectronDesktop(): boolean {
	return !isWebDesktop();
}

let cachedTabWindowId: string | null | undefined;

/**
 * The registry id of the tab window this renderer is, or null in every other
 * window. A tab window is an OS window the main process loads with
 * `?tabWindow=<windowId>` to hold one agent's popped-out tabs (Tab Windows,
 * `docs/agent-guides/TAB-WINDOWS.md`). This is the ONE place that query is
 * parsed; read window identity through this or {@link isTabWindow}.
 *
 * Never true in the web-desktop build: a browser client has no OS windows
 * (TW-13). An empty value is not an id, so it is not a tab window either.
 * Memoized like {@link isWebDesktop}: the answer is fixed for a page load.
 */
export function getTabWindowId(): string | null {
	if (cachedTabWindowId !== undefined) return cachedTabWindowId;
	cachedTabWindowId = readTabWindowId();
	return cachedTabWindowId;
}

function readTabWindowId(): string | null {
	if (typeof window === 'undefined' || isWebDesktop()) return null;
	try {
		const id = new URLSearchParams(window.location.search).get(TAB_WINDOW_QUERY_PARAM);
		return id ? id : null;
	} catch {
		/* sandboxed window.location accessors can throw */
		return null;
	}
}

/** True when this renderer is a tab window. See {@link getTabWindowId}. */
export function isTabWindow(): boolean {
	return getTabWindowId() !== null;
}
