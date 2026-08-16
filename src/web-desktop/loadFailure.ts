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

/** Record an auto-reload attempt, tolerating disabled/absent storage. */
export function markReloadAttempt(
	now: number,
	storage: Storage | undefined = safeSessionStorage()
): void {
	if (!storage) return;
	try {
		storage.setItem(RELOAD_GUARD_KEY, String(now));
	} catch {
		// Private-mode Safari and storage-blocked embeds throw on write. Losing
		// the guard only costs us loop protection, which the cooldown already
		// bounds - never block recovery over it.
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
export function installLoadFailureHandler(): void {
	bootWindow().__maestroHandleLoadFailure = (reason: unknown) => {
		const now = Date.now();
		const action = decideLoadFailureAction(reason, {
			booted: bootWindow().__maestroBooted === true,
			now,
			lastReloadAt: readLastReloadAt(),
		});

		if (action === 'ignore') return;

		if (action === 'reload') {
			markReloadAttempt(now);
			console.warn('[web-desktop] stale asset detected, reloading to refresh the bundle', reason);
			window.location.reload();
			return;
		}

		const detail =
			(reason && ((reason as Error).stack || (reason as Error).message)) || String(reason);
		bootWindow().__maestroShowBootError?.(
			'Maestro web-desktop failed to load',
			detail,
			isStaleAssetFailure(reason)
				? 'Maestro was updated or restarted while this page was open, so parts of the app it tried to load no longer exist on the server. Reloading did not clear it - try a hard refresh (Ctrl/Cmd+Shift+R).'
				: undefined
		);
	};
}
