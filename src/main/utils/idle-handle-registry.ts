/**
 * Idle Handle Registry
 *
 * A keyed set of open resources (a parquet file descriptor, a SQLite
 * connection) that the renderer addresses by an opaque handle, with an idle
 * reaper that closes whatever nobody has touched for `idleMs`.
 *
 * Every lookup refreshes the entry's idle clock, so a preview tab in active
 * use never loses its handle; a tab left open overnight stops holding a
 * descriptor (or a SQLite read lock) once the window passes.
 *
 * The reaper interval runs only while something is open, and is `unref`'d so
 * it never delays app quit by the length of the idle window.
 */

export interface IdleHandleRegistryOptions<T> {
	/** Entries untouched for longer than this are closed by the reaper. */
	idleMs: number;
	/**
	 * Release the resource. Called once per entry, after it has left the
	 * registry, so a lookup racing the close sees "no longer open" rather than a
	 * half-closed resource. A rejection is swallowed: there is nothing a caller
	 * that already let go of the handle can do about it.
	 */
	release: (value: T) => void | Promise<void>;
	/** Clock seam for tests. Defaults to `Date.now`. */
	now?: () => number;
}

export interface IdleHandleRegistry<T> {
	/** Register an open resource under `handle` and start the idle clock. */
	add(handle: string, value: T): void;
	/** The resource under `handle`, refreshing its idle clock; `undefined` when closed. */
	get(handle: string): T | undefined;
	/** The first open resource matching `predicate`, refreshing its idle clock. */
	find(predicate: (value: T, handle: string) => boolean): T | undefined;
	/** Close one handle. Safe to call more than once. */
	close(handle: string): Promise<void>;
	/** Close every handle and stop the reaper. Called on app quit and by tests. */
	closeAll(): Promise<void>;
	/** How many handles are currently open. */
	readonly size: number;
}

interface Entry<T> {
	value: T;
	lastUsedAt: number;
}

export function createIdleHandleRegistry<T>(
	options: IdleHandleRegistryOptions<T>
): IdleHandleRegistry<T> {
	const { idleMs, release } = options;
	const now = options.now ?? Date.now;
	const entries = new Map<string, Entry<T>>();
	let reaperTimer: ReturnType<typeof setInterval> | null = null;

	const stopReaper = (): void => {
		if (!reaperTimer) return;
		clearInterval(reaperTimer);
		reaperTimer = null;
	};

	const close = async (handle: string): Promise<void> => {
		const entry = entries.get(handle);
		if (!entry) return;
		entries.delete(handle);
		if (entries.size === 0) stopReaper();
		try {
			await release(entry.value);
		} catch {
			// See `release`: the handle is already gone from the caller's view.
		}
	};

	const startReaper = (): void => {
		if (reaperTimer) return;
		reaperTimer = setInterval(() => {
			const cutoff = now() - idleMs;
			for (const [handle, entry] of entries) {
				if (entry.lastUsedAt < cutoff) void close(handle);
			}
		}, idleMs);
		reaperTimer.unref?.();
	};

	return {
		add(handle, value) {
			entries.set(handle, { value, lastUsedAt: now() });
			startReaper();
		},
		get(handle) {
			const entry = entries.get(handle);
			if (!entry) return undefined;
			entry.lastUsedAt = now();
			return entry.value;
		},
		find(predicate) {
			for (const [handle, entry] of entries) {
				if (predicate(entry.value, handle)) {
					entry.lastUsedAt = now();
					return entry.value;
				}
			}
			return undefined;
		},
		close,
		async closeAll() {
			await Promise.all([...entries.keys()].map((handle) => close(handle)));
			stopReaper();
		},
		get size() {
			return entries.size;
		},
	};
}
