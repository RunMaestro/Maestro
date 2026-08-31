/**
 * Load-failure classification and recovery for the web-desktop bundle.
 *
 * The bundle's JS/CSS chunks are content-hashed, so every Maestro rebuild
 * changes their filenames. A browser tab left open across a restart still holds
 * the *old* module graph: modules already fetched keep working, but the first
 * lazily-imported chunk the user reaches (opening a modal, resuming a session,
 * previewing a file) resolves to a hash the server no longer has on disk. The
 * import rejects with the browser's "failed to fetch dynamically imported
 * module" TypeError.
 *
 * Two things used to go wrong at that point:
 *
 * 1. Nothing recovered. The user had to know to hard-refresh.
 * 2. The rejection reached the boot error handler in index.html, which wiped
 *    #root and blamed the network ("If this device is on a different Wi-Fi
 *    network..."). That handler exists for failures that stop the bundle from
 *    booting at all, but it was never scoped to boot, so it also tore down a
 *    perfectly healthy running app and misattributed a 404 as Wi-Fi isolation.
 *
 * This module decides what to do instead: reload once to pick up the current
 * asset manifest, and otherwise stay out of the running app's way so its React
 * error boundary can handle the failure in-place.
 */

import { formatShortcutKeysFor } from '../shared/shortcutKeys';

/**
 * sessionStorage key holding the timestamp of the last automatic reload.
 * sessionStorage (not localStorage) so the guard is per-tab and disappears when
 * the tab closes.
 */
const RELOAD_GUARD_KEY = 'maestro:stale-asset-reload-at';

/**
 * Refuse to auto-reload twice in quick succession. A stale-asset reload lands on
 * a fresh manifest and should not fail the same way again; if it somehow does,
 * reloading in a loop would leave the user staring at a flickering page with no
 * way to read the error. After the cooldown a genuinely new stale-asset failure
 * (another rebuild, hours later, in the same long-lived tab) can still recover
 * on its own.
 */
export const RELOAD_COOLDOWN_MS = 30_000;

/**
 * The same underlying failure - a module URL that no longer resolves - is
 * reported with different wording per engine, and none of them expose a
 * structured error code. Matching on message text is the only option.
 */
const STALE_ASSET_PATTERNS: RegExp[] = [
	// Chromium / Edge
	/failed to fetch dynamically imported module/i,
	// Firefox
	/error loading dynamically imported module/i,
	// Safari / WebKit
	/importing a module script failed/i,
	// Vite's preload helper, when a CSS chunk referenced by a lazy route is gone
	/unable to preload css/i,
];

/** What the caller should do about a load failure. */
export type LoadFailureAction =
	/** Stale hashed asset - reload to pick up the current manifest. */
	| 'reload'
	/** Render the full-page boot error surface. */
	| 'show-error'
	/** Leave it alone; the running app's error boundary owns this one. */
	| 'ignore';

export interface LoadFailureContext {
	/** True once the renderer has mounted (see `markBooted`). */
	booted: boolean;
	/** Current time in ms. */
	now: number;
	/** Timestamp of the last automatic reload in this tab, or 0 if none. */
	lastReloadAt: number;
}

/**
 * Extract a comparable message from whatever a rejection or error event carries.
 * Rejection reasons are not guaranteed to be Errors.
 */
function messageOf(reason: unknown): string {
	if (typeof reason === 'string') return reason;
	if (reason instanceof Error) return reason.message;
	if (reason && typeof reason === 'object') {
		const message = (reason as { message?: unknown }).message;
		if (typeof message === 'string') return message;
	}
	return String(reason);
}

/**
 * The most useful text to show a user about a failure: a stack when there is
 * one, else a message, else whatever the reason stringifies to. Rejection
 * reasons are not guaranteed to be Errors, so every branch is checked rather
 * than cast - `reason && reason.stack || String(reason)` types as `{} | string`
 * under `unknown` and is not assignable to the string parameter it feeds.
 */
function detailOf(reason: unknown): string {
	if (reason instanceof Error) return reason.stack || reason.message;
	if (reason && typeof reason === 'object') {
		const { stack, message } = reason as { stack?: unknown; message?: unknown };
		if (typeof stack === 'string' && stack) return stack;
		if (typeof message === 'string' && message) return message;
	}
	return String(reason);
}

/**
 * True when the failure looks like a hashed chunk that no longer exists on the
 * server, rather than a real connectivity problem or an app-level bug.
 */
export function isStaleAssetFailure(reason: unknown): boolean {
	const message = messageOf(reason);
	return STALE_ASSET_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Decide how to handle a load failure. Pure so the policy can be unit-tested
 * without a DOM, sessionStorage, or a real reload.
 */
export function decideLoadFailureAction(
	reason: unknown,
	{ booted, now, lastReloadAt }: LoadFailureContext
): LoadFailureAction {
	if (isStaleAssetFailure(reason)) {
		// Within the cooldown the reload clearly did not help, so stop looping
		// and let the user see what actually happened.
		if (lastReloadAt > 0 && now - lastReloadAt < RELOAD_COOLDOWN_MS) {
			return 'show-error';
		}
		return 'reload';
	}

	// Past boot, an unrelated rejection is an app-level bug. Tearing down #root
	// would destroy the user's running session over something the in-app error
	// boundary can report far better, and often over something recoverable.
	return booted ? 'ignore' : 'show-error';
}

/** Read the last auto-reload timestamp, tolerating disabled/absent storage. */
export function readLastReloadAt(storage: Storage | undefined = safeSessionStorage()): number {
	if (!storage) return 0;
	try {
		const raw = storage.getItem(RELOAD_GUARD_KEY);
		const parsed = raw ? Number.parseInt(raw, 10) : 0;
		return Number.isFinite(parsed) ? parsed : 0;
	} catch {
		return 0;
	}
}

/**
 * Record an auto-reload attempt. Returns false when the guard could not be
 * persisted (storage absent, or private-mode Safari / a storage-blocked embed
 * throwing on write).
 *
 * The caller MUST honor a false result by not reloading. The cooldown is not an
 * independent bound - it is read back out of this exact key, so a guard that
 * never lands means `readLastReloadAt` returns 0 forever, every stale failure
 * looks like the first one, and the tab reloads without end. That is worse than
 * the failure it is trying to recover from: the user never gets to read the
 * error, and the page never stops flickering.
 */
export function markReloadAttempt(
	now: number,
	storage: Storage | undefined = safeSessionStorage()
): boolean {
	if (!storage) return false;
	try {
		storage.setItem(RELOAD_GUARD_KEY, String(now));
		return true;
	} catch {
		return false;
	}
}

/**
 * Access sessionStorage without throwing in contexts that block it entirely
 * (some privacy modes throw on property access, not just on read/write).
 */
function safeSessionStorage(): Storage | undefined {
	try {
		return window.sessionStorage;
	} catch {
		return undefined;
	}
}

/**
 * The hard-refresh hint, with the modifier keys of the machine the BROWSER is
 * running on. That is not necessarily the machine running Maestro - a phone or
 * a Linux laptop can be pointed at a Mac host - so the platform is read from
 * the user agent here rather than from anything the server reports, the same
 * way `bootstrap.ts` derives its `process.platform` shim.
 */
function staleAssetHint(): string {
	const isMac = navigator.userAgent.includes('Mac');
	const shortcut = formatShortcutKeysFor(['Meta', 'Shift', 'R'], isMac);
	return (
		'Maestro was updated or restarted while this page was open, so parts of the app it ' +
		'tried to load no longer exist on the server. Reloading did not clear it - try a hard ' +
		`refresh (${shortcut}).`
	);
}

/**
 * Shape of the hooks index.html's inline bootstrap script publishes on window.
 * The inline script owns the DOM error surface because it has to work even when
 * the entry module never parses; this module owns the policy.
 */
interface BootErrorWindow {
	__maestroShowBootError?: (title: string, detail: string, hint?: string) => void;
	__maestroHandleLoadFailure?: (reason: unknown) => void;
	__maestroBooted?: boolean;
}

function bootWindow(): BootErrorWindow {
	return window as unknown as BootErrorWindow;
}

/**
 * Mark the renderer as mounted. After this point a load failure no longer wipes
 * the page - see `decideLoadFailureAction`.
 */
export function markBooted(): void {
	bootWindow().__maestroBooted = true;
}

/**
 * Install the policy handler that index.html's listeners delegate to.
 *
 * The listeners themselves stay inline in index.html: they must be registered
 * before the entry module is even parsed, so they can report a SyntaxError in
 * the bundle itself. This function only replaces their *decision*, and only
 * once the bundle is running.
 */
/**
 * Vite's own signal for a chunk that no longer resolves. It covers the case the
 * two inline listeners cannot: a lazy import the app awaits and handles itself
 * never becomes an unhandled rejection, and never fires `error` either, so
 * neither inline listener ever sees it.
 *
 * Declared at module scope rather than inline so `addEventListener` receives the
 * same reference on every call and dedupes it - installing twice must not make
 * one failure reload twice.
 */
function onVitePreloadError(event: Event): void {
	const payload = (event as Event & { payload?: unknown }).payload;
	// Tell Vite the failure is handled so it does not also rethrow it.
	if (isStaleAssetFailure(payload)) event.preventDefault();
	bootWindow().__maestroHandleLoadFailure?.(payload);
}

export function installLoadFailureHandler(): void {
	window.addEventListener('vite:preloadError', onVitePreloadError);

	bootWindow().__maestroHandleLoadFailure = (reason: unknown) => {
		const now = Date.now();
		const action = decideLoadFailureAction(reason, {
			booted: bootWindow().__maestroBooted === true,
			now,
			lastReloadAt: readLastReloadAt(),
		});

		if (action === 'ignore') return;

		// Only reload if the loop guard was actually written. Without it the
		// cooldown can never fire and the tab would reload forever.
		if (action === 'reload' && markReloadAttempt(now)) {
			console.warn('[web-desktop] stale asset detected, reloading to refresh the bundle', reason);
			window.location.reload();
			return;
		}

		bootWindow().__maestroShowBootError?.(
			'Maestro web-desktop failed to load',
			detailOf(reason),
			isStaleAssetFailure(reason) ? staleAssetHint() : undefined
		);
	};
}
