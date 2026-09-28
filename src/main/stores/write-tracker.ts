/**
 * Internal store-write tracker.
 *
 * The settings file watcher exists to pick up EXTERNAL edits to
 * `maestro-settings.json` / `maestro-agent-configs.json` (maestro-cli, a text
 * editor, a file sync daemon). It cannot tell those apart from the app's own
 * writes on its own: both look like the same `fs.watch` event.
 *
 * Without that distinction every `settings:set` IPC call bounces back into the
 * renderer as an "external change" and triggers a full `loadAllSettings()`
 * reload. That reload is async (several IPC round trips), so anything the user
 * typed while it was in flight gets overwritten by the older on-disk snapshot -
 * the caret jumps to the end of the field and the last few characters vanish.
 * The Conductor Profile textarea (one write per keystroke) hit this constantly.
 *
 * So: stamp every write the app itself makes, and let the watcher ignore any
 * change that lands in the shadow of one.
 */

/** Store file name -> timestamp (ms) of the last write the app made itself. */
const lastInternalWriteAt = new Map<string, number>();

/**
 * How long after one of our own writes a file change is still assumed to be
 * that write landing on disk. `fs.watch` delivers within a few ms; the margin
 * covers a slow atomic rename or a busy event loop.
 */
export const INTERNAL_WRITE_SHADOW_MS = 500;

/** Record that the app just wrote `fileName` (e.g. `maestro-settings.json`). */
export function markInternalWrite(fileName: string): void {
	lastInternalWriteAt.set(fileName, Date.now());
}

/** True when the app wrote `fileName` within the last `withinMs` milliseconds. */
export function hadRecentInternalWrite(
	fileName: string,
	withinMs: number = INTERNAL_WRITE_SHADOW_MS
): boolean {
	const at = lastInternalWriteAt.get(fileName);
	return at !== undefined && Date.now() - at <= withinMs;
}

/** Test-only: forget every recorded write. */
export function resetInternalWriteTracking(): void {
	lastInternalWriteAt.clear();
}

/** electron-store methods that end up writing the backing file. */
const MUTATORS = ['set', 'delete', 'clear', 'reset'] as const;

/**
 * Patch a store instance so every mutation stamps `fileName`. Instrumenting the
 * store itself (rather than each of the ~20 call sites that write settings)
 * means new writers are covered automatically.
 *
 * The stamp is taken AFTER the underlying write returns, so it is never older
 * than the `fs.watch` event that write produces.
 */
export function trackStoreWrites<T>(store: T, fileName: string): T {
	const target = store as unknown as Record<string, unknown>;
	for (const method of MUTATORS) {
		const original = target[method];
		if (typeof original !== 'function') continue;
		const wrapped = (...args: unknown[]) => {
			try {
				return (original as (...a: unknown[]) => unknown).apply(store, args);
			} finally {
				markInternalWrite(fileName);
			}
		};
		// Own property shadows the prototype method for this instance only.
		Object.defineProperty(store, method, {
			value: wrapped,
			writable: true,
			configurable: true,
		});
	}
	return store;
}
