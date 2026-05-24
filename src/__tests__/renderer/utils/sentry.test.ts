import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureException, captureMessage } from '../../../renderer/utils/sentry';

vi.mock('@sentry/electron/renderer', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

describe('renderer sentry utilities', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('forwards exceptions with capture context', async () => {
		const Sentry = await import('@sentry/electron/renderer');
		const error = new Error('boom');
		const context = { extra: { operation: 'test' } };

		captureException(error, context);

		expect(Sentry.captureException).toHaveBeenCalledWith(error, context);
	});

	it('forwards messages with capture context', async () => {
		const Sentry = await import('@sentry/electron/renderer');
		const context = { level: 'warning' as const, extra: { feature: 'coverage' } };

		captureMessage('message', context);

		expect(Sentry.captureMessage).toHaveBeenCalledWith('message', context);
	});
});
