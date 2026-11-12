/**
 * Trailing-edge debounce for the main process.
 *
 * The main process has no React hooks, so the renderer's `useDebouncedCallback`
 * is unavailable here and consumers have historically hand-rolled
 * `setTimeout`/`clearTimeout` pairs (see `app-lifecycle/settings-watcher.ts`).
 * This is the shared, testable version: wrap a function and every call resets a
 * timer so the wrapped function runs only once the calls stop for `waitMs`.
 *
 * Trailing-edge only (the wrapped function runs after the quiet period, never on
 * the leading call) and the most recent arguments win. Returns a callable with
 * `cancel()` (drop any pending run) and `flush()` (run a pending call now).
 */

/** A debounced wrapper around a function of arguments `A`. */
export interface DebouncedFunction<A extends unknown[]> {
	(...args: A): void;
	/** Cancel a pending invocation without running it. */
	cancel(): void;
	/** Run a pending invocation immediately, if one is queued. */
	flush(): void;
}

/**
 * Wrap `fn` so rapid calls collapse into a single trailing call fired `waitMs`
 * after the last call. Each invocation overwrites the pending arguments, so the
 * eventual call sees the latest values.
 */
export function debounce<A extends unknown[]>(
	fn: (...args: A) => void,
	waitMs: number
): DebouncedFunction<A> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pendingArgs: A | null = null;

	const run = (): void => {
		const args = pendingArgs;
		timer = null;
		pendingArgs = null;
		if (args) fn(...args);
	};

	const debounced = ((...args: A): void => {
		pendingArgs = args;
		if (timer) clearTimeout(timer);
		timer = setTimeout(run, waitMs);
	}) as DebouncedFunction<A>;

	debounced.cancel = (): void => {
		if (timer) clearTimeout(timer);
		timer = null;
		pendingArgs = null;
	};

	debounced.flush = (): void => {
		if (timer) clearTimeout(timer);
		run();
	};

	return debounced;
}
