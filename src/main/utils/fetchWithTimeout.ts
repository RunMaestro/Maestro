/**
 * Fetch with a deadline while preserving an optional caller cancellation signal.
 *
 * HTTP responses and fetch rejections are returned unchanged; callers retain
 * ownership of their existing response and error policies.
 */
export async function fetchWithTimeout(
	input: string | URL | Request,
	options: RequestInit,
	timeoutMs: number
): Promise<Response> {
	const timeoutController = new AbortController();
	const signal = options.signal
		? AbortSignal.any([options.signal, timeoutController.signal])
		: timeoutController.signal;
	const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

	try {
		return await fetch(input, { ...options, signal });
	} finally {
		clearTimeout(timeoutId);
	}
}
