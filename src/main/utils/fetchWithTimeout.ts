/**
 * Fetch With Timeout
 *
 * A bare `fetch()` has no timeout. A stalled socket hangs the caller forever,
 * which in the main process means an IPC handler that never settles and a
 * renderer spinner that never stops.
 *
 * This is the single canonical wrapper. Before it existed there were three
 * separate functions named `fetchWithTimeout` with three different signatures
 * (`leaderboard.ts`, `cue-telemetry.ts`, `bmad-manager.ts`), two more inline
 * `AbortController` + `setTimeout` blocks (`checkin.ts`, `detector.ts`,
 * `codex-usage-sampler.ts`), and a dozen call sites with no timeout at all.
 *
 * Do NOT add another copy. If a caller needs different behaviour, give it a
 * different `timeoutMs` or wrap this function locally, as `bmad-manager.ts`
 * does to attach its own Sentry reporting.
 */

/**
 * Default request budget. Deliberately generous: it is the backstop for
 * callers that have no opinion, not a target. Latency-sensitive callers pass
 * a shorter value (the models.dev catalog probe uses 3s, telemetry 10s).
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * `fetch()` with a request budget.
 *
 * The returned promise rejects when `timeoutMs` elapses before the response
 * headers arrive. The rejection is a `TimeoutError` rather than the plain
 * `AbortError` a caller-initiated cancel produces, so the two are
 * distinguishable at the catch site.
 *
 * A `signal` passed in `options` is honoured rather than overwritten: the
 * request aborts when either that signal or the timeout fires. Clobbering it
 * would silently disable a caller's own cancellation, which is exactly the
 * kind of bug this helper exists to prevent.
 *
 * The timeout covers the response headers, not the body. A caller that reads
 * a large body with `.json()` or `.text()` can still block after this
 * resolves.
 *
 * @param url - The URL to request
 * @param options - Standard `RequestInit`. Any `signal` here is composed with
 *   the timeout rather than replaced.
 * @param timeoutMs - Request budget in milliseconds
 * @returns The `Response`, exactly as `fetch()` would return it. Non-2xx
 *   responses resolve normally; callers still check `response.ok`.
 */
export async function fetchWithTimeout(
	url: string,
	options: RequestInit = {},
	timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort(
			new DOMException(`Request to ${url} timed out after ${timeoutMs}ms`, 'TimeoutError')
		);
	}, timeoutMs);

	// AbortSignal.any settles on whichever fires first and forwards its reason,
	// so a caller cancel stays an AbortError and a timeout stays a TimeoutError.
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		return await fetch(url, { ...options, signal });
	} finally {
		// Release the timer as soon as the response lands. Letting it run to
		// completion would pin the closure for the full budget on every call.
		clearTimeout(timeoutId);
	}
}

/**
 * True when a rejection came from this helper's timeout rather than from a
 * caller-initiated abort or a transport failure.
 */
export function isFetchTimeoutError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'TimeoutError';
}
