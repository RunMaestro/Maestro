import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeTransportError } from '../../shared/bridgeError';

describe('web-desktop Sentry diagnostics', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		window.maestro.logger.log = vi.fn().mockResolvedValue(undefined);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('does not report expected reconnect exceptions or messages', async () => {
		const sentry = await import('../../web-desktop/sentry-shim');
		const error = new BridgeTransportError('reconnecting', 'BRIDGE_RECONNECTING');
		sentry.captureException(error);
		sentry.captureMessage(
			'Not submitted: restoring authoritative host state. Your current work is retained.',
			'error'
		);
		expect(console.error).not.toHaveBeenCalled();
		expect(window.maestro.logger.log).not.toHaveBeenCalled();
	});

	it('deduplicates repeated failures briefly and retains distinct and later failures', async () => {
		const sentry = await import('../../web-desktop/sentry-shim');
		for (let i = 0; i < 20; i++) sentry.captureException(new Error('Unexpected owner failure'));
		expect(console.error).toHaveBeenCalledTimes(1);
		sentry.captureException(new Error('Different unexpected failure'));
		expect(console.error).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(30000);
		sentry.captureException(new Error('Unexpected owner failure'));
		expect(console.error).toHaveBeenCalledTimes(3);
	});

	it('handles asynchronous logger failure without producing another rejection', async () => {
		const sentry = await import('../../web-desktop/sentry-shim');
		vi.mocked(window.maestro.logger.log).mockRejectedValue(new Error('logger unavailable'));
		sentry.captureException(new Error('Original unexpected failure'));
		// Vitest reports any unhandled rejection from the best-effort logger as
		// a test failure; settle its microtasks before checking the original report.
		await Promise.resolve();
		await Promise.resolve();
		expect(console.error).toHaveBeenCalledOnce();
	});

	it('keeps uncertain submitted mutations visible', async () => {
		const sentry = await import('../../web-desktop/sentry-shim');
		sentry.captureException(
			new BridgeTransportError('submission unknown', 'BRIDGE_SUBMISSION_UNCERTAIN', 'unknown')
		);
		expect(console.error).toHaveBeenCalledOnce();
	});
});
