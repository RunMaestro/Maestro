import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	addBreadcrumb,
	captureException,
	captureMessage,
	configureSentry,
	type SentryModule,
} from '../../../main/utils/sentry';

function createSentryModule(): SentryModule {
	return {
		addBreadcrumb: vi.fn(),
		captureException: vi.fn(() => 'exception-id'),
		captureMessage: vi.fn(() => 'message-id'),
	};
}

describe('main Sentry utilities', () => {
	beforeEach(() => {
		configureSentry(false);
	});

	afterEach(() => {
		configureSentry(false);
	});

	it('keeps reporting helpers inert when crash reporting is disabled', async () => {
		await expect(addBreadcrumb('agent', 'Spawn')).resolves.toBeUndefined();
		await expect(captureException(new Error('test'))).resolves.toBeUndefined();
		await expect(captureMessage('test')).resolves.toBeUndefined();
	});

	it('uses the initialized startup module when reporting is enabled', async () => {
		const sentry = createSentryModule();
		configureSentry(true, sentry);

		const error = new Error('boom');
		await addBreadcrumb('agent', 'Spawn', { sessionId: 'session-1' });
		await captureException(error, { operation: 'spawn' });
		await captureMessage('failed', 'warning', { operation: 'spawn' });

		expect(sentry.addBreadcrumb).toHaveBeenCalledWith({
			category: 'agent',
			message: 'Spawn',
			level: 'info',
			data: { sessionId: 'session-1' },
		});
		expect(sentry.captureException).toHaveBeenCalledWith(error, {
			extra: { operation: 'spawn' },
		});
		expect(sentry.captureMessage).toHaveBeenCalledWith('failed', {
			level: 'warning',
			extra: { operation: 'spawn' },
		});
	});
});
