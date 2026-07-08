import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryMocks = vi.hoisted(() => ({
	captureException: vi.fn(() => 'exception-event-id'),
	captureMessage: vi.fn(() => 'message-event-id'),
	addBreadcrumb: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
}));

vi.mock('@sentry/electron/main', () => sentryMocks);
vi.mock('../../main/utils/logger', () => ({
	logger: loggerMocks,
}));

async function loadSentryUtils() {
	vi.resetModules();
	return import('../../main/utils/sentry');
}

function mockMemoryUsage(overrides: Partial<NodeJS.MemoryUsage>) {
	return vi.spyOn(process, 'memoryUsage').mockReturnValue({
		rss: 150 * 1024 * 1024,
		heapTotal: 80 * 1024 * 1024,
		heapUsed: 40 * 1024 * 1024,
		external: 8 * 1024 * 1024,
		arrayBuffers: 2 * 1024 * 1024,
		...overrides,
	});
}

describe('main sentry utilities', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('lazily reports exceptions and reuses the loaded Sentry module', async () => {
		const { captureException, captureMessage } = await loadSentryUtils();
		const error = new Error('spawn failed');
		const secondError = new Error('spawn failed again');

		await captureException(error, { sessionId: 'session-1' });
		await captureException(secondError, { sessionId: 'session-2' });
		await captureMessage('Process exited', 'warning', { code: 1 });

		expect(sentryMocks.captureException).toHaveBeenNthCalledWith(1, error, {
			extra: { sessionId: 'session-1' },
		});
		expect(sentryMocks.captureException).toHaveBeenNthCalledWith(2, secondError, {
			extra: { sessionId: 'session-2' },
		});
		expect(sentryMocks.captureMessage).toHaveBeenCalledWith('Process exited', {
			level: 'warning',
			extra: { code: 1 },
		});
		expect(loggerMocks.debug).not.toHaveBeenCalled();
	});

	it('loads Sentry from captureMessage when it is the first reporting call', async () => {
		const { captureMessage } = await loadSentryUtils();

		await captureMessage('Standalone message');

		expect(sentryMocks.captureMessage).toHaveBeenCalledWith('Standalone message', {
			level: 'error',
			extra: undefined,
		});
	});

	it('logs debug fallbacks when exception or message reporting fails', async () => {
		const { captureException, captureMessage } = await loadSentryUtils();
		sentryMocks.captureException.mockImplementationOnce(() => {
			throw new Error('sentry unavailable');
		});
		sentryMocks.captureMessage.mockImplementationOnce(() => {
			throw new Error('sentry unavailable');
		});

		await captureException(new Error('boom'));
		await captureMessage('boom');

		expect(loggerMocks.debug).toHaveBeenCalledWith(
			'Sentry not available for exception reporting',
			'[Sentry]'
		);
		expect(loggerMocks.debug).toHaveBeenCalledWith(
			'Sentry not available for message reporting',
			'[Sentry]'
		);
	});

	it('adds breadcrumbs and silently ignores breadcrumb failures', async () => {
		const { addBreadcrumb } = await loadSentryUtils();

		await addBreadcrumb('ipc', 'Registered handlers', { channel: 'sessions:list' }, 'debug');
		sentryMocks.addBreadcrumb.mockImplementationOnce(() => {
			throw new Error('breadcrumb unavailable');
		});
		await addBreadcrumb('file', 'Read failed');

		expect(sentryMocks.addBreadcrumb).toHaveBeenNthCalledWith(1, {
			category: 'ipc',
			message: 'Registered handlers',
			level: 'debug',
			data: { channel: 'sessions:list' },
		});
		expect(sentryMocks.addBreadcrumb).toHaveBeenNthCalledWith(2, {
			category: 'file',
			message: 'Read failed',
			level: 'info',
			data: undefined,
		});
		expect(loggerMocks.debug).not.toHaveBeenCalled();
	});

	it('records memory breadcrumbs below the warning threshold and avoids duplicate monitors', async () => {
		vi.useFakeTimers();
		mockMemoryUsage({ heapUsed: 120 * 1024 * 1024 });
		const { startMemoryMonitoring, stopMemoryMonitoring } = await loadSentryUtils();

		startMemoryMonitoring(500, 1000);
		startMemoryMonitoring(500, 1000);
		await vi.advanceTimersByTimeAsync(1000);
		stopMemoryMonitoring();

		expect(loggerMocks.info).toHaveBeenCalledTimes(2);
		expect(loggerMocks.info).toHaveBeenNthCalledWith(
			1,
			'Memory monitoring started (threshold: 500MB, interval: 1000ms)',
			'Memory'
		);
		expect(loggerMocks.info).toHaveBeenNthCalledWith(2, 'Memory monitoring stopped', 'Memory');
		expect(loggerMocks.warn).not.toHaveBeenCalled();
		expect(sentryMocks.addBreadcrumb).toHaveBeenCalledWith({
			category: 'memory',
			message: 'Memory: 120MB heap, 150MB RSS',
			level: 'info',
			data: {
				heapUsedMB: 120,
				heapTotalMB: 80,
				rssMB: 150,
				externalMB: 8,
			},
		});
	});

	it('logs and breadcrumbs high memory usage, then ignores redundant stops', async () => {
		vi.useFakeTimers();
		mockMemoryUsage({
			rss: 900 * 1024 * 1024,
			heapTotal: 760 * 1024 * 1024,
			heapUsed: 701 * 1024 * 1024,
			external: 12 * 1024 * 1024,
		});
		const { startMemoryMonitoring, stopMemoryMonitoring } = await loadSentryUtils();

		stopMemoryMonitoring();
		startMemoryMonitoring(700, 250);
		await vi.advanceTimersByTimeAsync(250);
		stopMemoryMonitoring();
		stopMemoryMonitoring();

		expect(loggerMocks.warn).toHaveBeenCalledWith(
			'High memory usage: 701MB heap (threshold: 700MB)',
			'Memory',
			{
				heapUsedMB: 701,
				heapTotalMB: 760,
				rssMB: 900,
			}
		);
		expect(sentryMocks.addBreadcrumb).toHaveBeenCalledWith({
			category: 'memory',
			message: 'HIGH MEMORY: 701MB exceeds 700MB threshold',
			level: 'warning',
			data: {
				heapUsedMB: 701,
				heapTotalMB: 760,
				rssMB: 900,
			},
		});
		expect(loggerMocks.info).toHaveBeenCalledTimes(2);
	});
});
