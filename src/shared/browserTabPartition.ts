/**
 * Canonical browser-tab partition matchers, shared by the main-process gates
 * (webview attach in window-manager.ts, clearSessionData in browser-session.ts)
 * and the renderer minting/persistence helpers (browserTabPersistence.ts).
 *
 * Both consumers MUST validate against the FULL minted shape (not just a prefix)
 * so the webview-attach gate and the destructive clearSessionData gate agree on
 * exactly which partitions belong to embedded Maestro browser tabs. Anything
 * else (the default session, unrelated persist: partitions, malformed keys) is
 * rejected so a misbehaving caller cannot attach to or wipe unrelated storage.
 *
 * Minted shapes (see browserTabPersistence.ts, whose sanitizer emits
 * [A-Za-z0-9_-]):
 *  - persistent: `persist:maestro-browser-session-<sanitized session id>`
 *  - ephemeral : `maestro-ephemeral-<sanitized session id>-<random8 lowercase alnum>`
 */

/** Persistent (on-disk) browser-tab partition, e.g. `persist:maestro-browser-session-abc`. */
export const PERSISTENT_BROWSER_TAB_PARTITION_PATTERN =
	/^persist:maestro-browser-session-[A-Za-z0-9_-]+$/;

/** Ephemeral (in-memory / incognito) browser-tab partition, e.g. `maestro-ephemeral-abc-1a2b3c4d`. */
export const EPHEMERAL_BROWSER_TAB_PARTITION_PATTERN =
	/^maestro-ephemeral-[A-Za-z0-9_-]+-[a-z0-9]{8}$/;

/**
 * True only for a partition minted for an embedded Maestro browser tab
 * (persistent or ephemeral). Gates both webview attachment and the destructive
 * clearSessionData handler so the two agree on exactly which partitions count.
 */
export function isAllowedBrowserTabPartition(partition: string): boolean {
	return (
		PERSISTENT_BROWSER_TAB_PARTITION_PATTERN.test(partition) ||
		EPHEMERAL_BROWSER_TAB_PARTITION_PATTERN.test(partition)
	);
}
