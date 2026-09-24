/**
 * The one place that reads the A Cappella Encore flag.
 *
 * A Cappella is off by default and every entry point has to agree on what "off"
 * means, because the surfaces that check it are not one system: IPC handlers,
 * the hotkey installation, the signaling adapter, the transport, and the debug
 * package collector all gate on the same flag from different processes and at
 * different moments. Five copies of `flags.aCappella === true` is five chances
 * for one of them to drift into truthiness, and a surface that disagrees with
 * the rest is a microphone or a Bonjour advert that outlives the switch.
 *
 * Deliberately strict: only the literal `true` counts. A settings file that was
 * hand-edited to `"true"` or `1` reads as OFF, which is the safe direction for a
 * feature whose "on" state opens a capture device and puts the machine on the
 * network.
 */

/**
 * The narrow slice of a settings store this needs.
 *
 * A getter and nothing else, so a caller can pass an electron-store, the IPC
 * layer's injected dependency, or a plain object in a test without any of them
 * having to satisfy a wider interface.
 */
export interface EncoreFlagStore {
	get: (key: string, defaultValue?: unknown) => unknown;
}

/** The Encore Feature flag blob, widened. Absent or malformed reads as empty. */
function readEncoreFlags(store: EncoreFlagStore): Record<string, unknown> {
	const flags = store.get('encoreFeatures', {});
	return typeof flags === 'object' && flags !== null ? (flags as Record<string, unknown>) : {};
}

/**
 * True only when `encoreFeatures.aCappella` is explicitly on.
 *
 * Read on every call rather than cached, so a toggle takes effect without a
 * restart.
 */
export function isACappellaEnabled(store: EncoreFlagStore): boolean {
	return readEncoreFlags(store).aCappella === true;
}

/**
 * The error a gated IPC handler throws when the feature is off.
 *
 * A stable string rather than a sentence: the renderer maps it, and a channel
 * that answered with prose would make the copy a wire contract.
 */
export const ACAPPELLA_DISABLED_ERROR = 'ACappellaDisabled';

/** Throw {@link ACAPPELLA_DISABLED_ERROR} unless the feature is on. */
export function requireACappellaEnabled(store: EncoreFlagStore): void {
	if (!isACappellaEnabled(store)) throw new Error(ACAPPELLA_DISABLED_ERROR);
}
