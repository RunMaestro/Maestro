import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { fetchWithTimeout } from '../fetchWithTimeout';

describe('fetchWithTimeout', () => {
	let mockFetch: Mock;

	beforeEach(() => {
		vi.useFakeTimers();
		mockFetch = vi.fn();
		vi.stubGlobal('fetch', mockFetch);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('returns successful responses and preserves request options', async () => {
		const response = new Response('accepted', { status: 202 });
		mockFetch.mockResolvedValue(response);

		await expect(
			fetchWithTimeout(
				'http://127.0.0.1:8787/telemetry',
				{
					method: 'POST',
					headers: { 'X-Request-Id': 'request-1' },
					body: 'payload',
				},
				1_000
			)
		).resolves.toBe(response);

		expect(mockFetch).toHaveBeenCalledWith(
			'http://127.0.0.1:8787/telemetry',
			expect.objectContaining({
				method: 'POST',
				headers: { 'X-Request-Id': 'request-1' },
				body: 'payload',
				signal: expect.any(AbortSignal),
			})
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('returns HTTP error responses unchanged', async () => {
		const response = new Response('unavailable', { status: 503 });
		mockFetch.mockResolvedValue(response);

		await expect(fetchWithTimeout('http://127.0.0.1:8787/status', {}, 1_000)).resolves.toBe(
			response
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('rejects when the timeout aborts the request and clears its timer', async () => {
		const timeoutError = new Error('Aborted');
		timeoutError.name = 'AbortError';
		mockFetch.mockImplementation((_input: string, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(timeoutError), { once: true });
			});
		});

		const request = fetchWithTimeout('http://127.0.0.1:8787/slow', {}, 50);
		const rejection = expect(request).rejects.toBe(timeoutError);
		await vi.advanceTimersByTimeAsync(50);

		await rejection;
		expect(vi.getTimerCount()).toBe(0);
	});

	it('forwards caller aborts through a composed signal and clears its timer', async () => {
		const caller = new AbortController();
		const callerAbort = new Error('caller cancelled');
		callerAbort.name = 'AbortError';
		let receivedSignal: AbortSignal | undefined;
		mockFetch.mockImplementation((_input: string, init?: RequestInit) => {
			const signal = init?.signal;
			receivedSignal = signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				if (!signal) {
					reject(new Error('fetch signal was not supplied'));
					return;
				}
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				signal.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		});

		const request = fetchWithTimeout(
			'http://127.0.0.1:8787/cancellable',
			{ signal: caller.signal },
			1_000
		);
		const rejection = expect(request).rejects.toBe(callerAbort);
		caller.abort(callerAbort);

		await rejection;
		expect(receivedSignal).not.toBe(caller.signal);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('preserves network failures and clears its timer', async () => {
		const networkError = new TypeError('ECONNREFUSED');
		mockFetch.mockRejectedValue(networkError);

		await expect(fetchWithTimeout('http://127.0.0.1:8787/offline', {}, 1_000)).rejects.toBe(
			networkError
		);
		expect(vi.getTimerCount()).toBe(0);
	});
});
