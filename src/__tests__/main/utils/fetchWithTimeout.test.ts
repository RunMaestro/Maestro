import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	fetchWithTimeout,
	isFetchTimeoutError,
	DEFAULT_FETCH_TIMEOUT_MS,
} from '../../../main/utils/fetchWithTimeout';

/**
 * A fetch stand-in that never resolves on its own and settles only when the
 * signal it was handed aborts. This is what a stalled socket looks like from
 * the caller's side, and it is the case a bare fetch() never escapes.
 */
function stallingFetch(): ReturnType<typeof vi.fn> {
	return vi.fn((_url: string, options: RequestInit = {}) => {
		return new Promise((_resolve, reject) => {
			const signal = options.signal;
			if (!signal) return;
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			signal.addEventListener('abort', () => reject(signal.reason));
		});
	});
}

describe('fetchWithTimeout', () => {
	const realFetch = global.fetch;

	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(() => {
		global.fetch = realFetch;
		vi.restoreAllMocks();
	});

	it('resolves with the response when the request completes inside the budget', async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		global.fetch = mockFetch as unknown as typeof fetch;

		const response = await fetchWithTimeout('https://example.com/api', {});

		expect(response.ok).toBe(true);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it('passes an AbortSignal to fetch while preserving the caller options', async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true });
		global.fetch = mockFetch as unknown as typeof fetch;

		await fetchWithTimeout('https://example.com/api', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
		});

		expect(mockFetch).toHaveBeenCalledWith(
			'https://example.com/api',
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				signal: expect.any(AbortSignal),
			})
		);
	});

	it('rejects when the budget elapses before the response arrives', async () => {
		global.fetch = stallingFetch() as unknown as typeof fetch;

		await expect(fetchWithTimeout('https://example.com/api', {}, 10)).rejects.toThrow();
	});

	it('rejects a timeout with TimeoutError, not a bare AbortError', async () => {
		global.fetch = stallingFetch() as unknown as typeof fetch;

		// The distinction is the point: a caller that retries on timeout must not
		// also retry a deliberate user cancellation.
		await expect(fetchWithTimeout('https://example.com/api', {}, 10)).rejects.toSatisfy(
			isFetchTimeoutError
		);
	});

	it('honours a caller-supplied signal instead of overwriting it', async () => {
		global.fetch = stallingFetch() as unknown as typeof fetch;

		const caller = new AbortController();
		const pending = fetchWithTimeout('https://example.com/api', { signal: caller.signal }, 60_000);
		caller.abort();

		// Overwriting options.signal would silently disable the caller's own
		// cancellation and leave this hanging for the full 60s budget.
		await expect(pending).rejects.toThrow();
	});

	it('reports a caller abort as an abort rather than a timeout', async () => {
		global.fetch = stallingFetch() as unknown as typeof fetch;

		const caller = new AbortController();
		const pending = fetchWithTimeout('https://example.com/api', { signal: caller.signal }, 60_000);
		caller.abort();

		await expect(pending).rejects.not.toSatisfy(isFetchTimeoutError);
	});

	it('clears the timer once the response lands', async () => {
		const clearSpy = vi.spyOn(global, 'clearTimeout');
		global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

		await fetchWithTimeout('https://example.com/api', {}, 60_000);

		// Left running, a 60s timer pins the closure for the full budget on every
		// call, which on a polling caller is a slow leak.
		expect(clearSpy).toHaveBeenCalled();
	});

	it('clears the timer when the request rejects', async () => {
		const clearSpy = vi.spyOn(global, 'clearTimeout');
		global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

		await expect(fetchWithTimeout('https://example.com/api', {}, 60_000)).rejects.toThrow(
			'ECONNREFUSED'
		);
		expect(clearSpy).toHaveBeenCalled();
	});

	it('resolves non-2xx responses instead of throwing, so callers still check response.ok', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;

		const response = await fetchWithTimeout('https://example.com/api');

		expect(response.ok).toBe(false);
		expect(response.status).toBe(500);
	});

	it('exposes a default budget for callers with no opinion', () => {
		expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(30_000);
	});
});

describe('isFetchTimeoutError', () => {
	it('is false for ordinary transport errors', () => {
		expect(isFetchTimeoutError(new Error('ECONNRESET'))).toBe(false);
		expect(isFetchTimeoutError(undefined)).toBe(false);
		expect(isFetchTimeoutError('TimeoutError')).toBe(false);
	});

	it('is true only for the DOMException this helper raises', () => {
		expect(isFetchTimeoutError(new DOMException('too slow', 'TimeoutError'))).toBe(true);
		expect(isFetchTimeoutError(new DOMException('cancelled', 'AbortError'))).toBe(false);
	});
});
