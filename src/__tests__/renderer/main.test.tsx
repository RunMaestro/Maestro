import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

const reactDomMock = vi.hoisted(() => ({
	createRoot: vi.fn(),
	render: vi.fn(),
}));

const sentryMock = vi.hoisted(() => ({
	captureException: vi.fn(),
	init: vi.fn(),
	setTag: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
	error: vi.fn(),
}));

vi.mock('react-dom/client', () => ({
	createRoot: reactDomMock.createRoot,
	default: {
		createRoot: reactDomMock.createRoot,
	},
}));

vi.mock('@sentry/electron/renderer', () => sentryMock);
vi.mock('../../renderer/wdyr', () => ({}));
vi.mock('../../renderer/App', () => ({ default: () => null }));
vi.mock('../../renderer/components/ErrorBoundary', () => ({
	ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../renderer/contexts/LayerStackContext', () => ({
	LayerStackProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../renderer/components/Wizard', () => ({
	WizardProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../renderer/utils/logger', () => ({
	logger: loggerMock,
}));

describe('renderer main entrypoint', () => {
	const originalNodeEnv = process.env.NODE_ENV;
	const originalSettingsGet = window.maestro.settings.get;
	const eventHandlers = new Map<string, Array<(event: Event) => void>>();
	const settingsGet = vi.fn();

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.stubGlobal('__APP_VERSION__', '1.2.3');
		document.body.innerHTML = '<div id="root"></div>';
		reactDomMock.createRoot.mockReturnValue({ render: reactDomMock.render });
		eventHandlers.clear();
		vi.spyOn(window, 'addEventListener').mockImplementation((type, handler) => {
			const handlers = eventHandlers.get(type) ?? [];
			handlers.push(handler as (event: Event) => void);
			eventHandlers.set(type, handlers);
		});
		window.maestro.settings.get = settingsGet;
		process.env.NODE_ENV = 'test';
	});

	afterEach(() => {
		window.maestro.settings.get = originalSettingsGet;
		process.env.NODE_ENV = originalNodeEnv;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	async function loadMain({
		crashReportingEnabled = true,
		nodeEnv = 'test',
		version = '1.2.3',
		settingsError,
		settingsReturnsUndefined = false,
	}: {
		crashReportingEnabled?: boolean;
		nodeEnv?: string;
		version?: string;
		settingsError?: Error;
		settingsReturnsUndefined?: boolean;
	} = {}) {
		process.env.NODE_ENV = nodeEnv;
		vi.stubGlobal('__APP_VERSION__', version);
		if (settingsError) {
			settingsGet.mockRejectedValue(settingsError);
		} else if (settingsReturnsUndefined) {
			settingsGet.mockResolvedValue(undefined);
		} else {
			settingsGet.mockResolvedValue(crashReportingEnabled);
		}

		await import('../../renderer/main');
	}

	function emitWindowEvent(type: string, event: Event) {
		for (const handler of eventHandlers.get(type) ?? []) {
			handler(event);
		}
	}

	it('initializes Sentry for enabled non-development crash reporting and renders the app tree', async () => {
		await loadMain({ version: '2.0.0-RC.1' });

		await waitFor(() => expect(sentryMock.init).toHaveBeenCalledTimes(1));
		expect(sentryMock.init).toHaveBeenCalledWith(
			expect.objectContaining({
				release: '2.0.0-RC.1',
				tracesSampleRate: 0,
				beforeSend: expect.any(Function),
			})
		);
		expect(sentryMock.setTag).toHaveBeenCalledWith('channel', 'rc');
		expect(reactDomMock.createRoot).toHaveBeenCalledWith(document.getElementById('root'));
		expect(reactDomMock.render).toHaveBeenCalledTimes(1);

		const beforeSend = sentryMock.init.mock.calls[0][0].beforeSend as (event: {
			user?: Record<string, string>;
		}) => unknown;
		const event = { user: { id: 'user-1', email: 'me@example.com', ip_address: '127.0.0.1' } };
		expect(beforeSend(event)).toBe(event);
		expect(event.user).toEqual({ id: 'user-1' });
		const anonymousEvent = {};
		expect(beforeSend(anonymousEvent)).toBe(anonymousEvent);
	});

	it('tags stable releases when the version is not an RC', async () => {
		await loadMain({ version: '2.0.0' });

		await waitFor(() => expect(sentryMock.setTag).toHaveBeenCalledWith('channel', 'stable'));
	});

	it('defaults crash reporting to enabled when the setting is missing', async () => {
		await loadMain({ settingsReturnsUndefined: true });

		await waitFor(() => expect(sentryMock.init).toHaveBeenCalledTimes(1));
	});

	it('skips renderer Sentry initialization when disabled, in development, or settings are unavailable', async () => {
		await loadMain({ crashReportingEnabled: false });
		await Promise.resolve();
		expect(sentryMock.init).not.toHaveBeenCalled();

		vi.clearAllMocks();
		vi.resetModules();
		await loadMain({ nodeEnv: 'development' });
		await Promise.resolve();
		expect(sentryMock.init).not.toHaveBeenCalled();

		vi.clearAllMocks();
		vi.resetModules();
		await loadMain({ settingsError: new Error('settings unavailable') });
		await Promise.resolve();
		expect(sentryMock.init).not.toHaveBeenCalled();
	});

	it('logs and captures uncaught errors while preventing default handling', async () => {
		await loadMain();
		const error = new Error('renderer exploded');
		const preventDefault = vi.fn();

		emitWindowEvent('error', {
			message: 'renderer exploded',
			filename: 'App.tsx',
			lineno: 10,
			colno: 20,
			error,
			preventDefault,
		} as unknown as ErrorEvent);

		expect(loggerMock.error).toHaveBeenCalledWith(
			'Uncaught Error: renderer exploded',
			'UncaughtError',
			{
				filename: 'App.tsx',
				lineno: 10,
				colno: 20,
				error: error.stack,
			}
		);
		expect(sentryMock.captureException).toHaveBeenCalledWith(error, {
			extra: {
				filename: 'App.tsx',
				lineno: 10,
				colno: 20,
			},
		});
		expect(preventDefault).toHaveBeenCalledTimes(1);
	});

	it('prevents default error handling without capturing when no error object exists', async () => {
		await loadMain();
		const preventDefault = vi.fn();
		sentryMock.captureException.mockClear();

		emitWindowEvent('error', {
			message: 'script failed',
			filename: 'preload.js',
			lineno: 1,
			colno: 2,
			error: undefined,
			preventDefault,
		} as unknown as ErrorEvent);

		expect(loggerMock.error).toHaveBeenCalledWith(
			'Uncaught Error: script failed',
			'UncaughtError',
			{
				filename: 'preload.js',
				lineno: 1,
				colno: 2,
				error: 'undefined',
			}
		);
		expect(sentryMock.captureException).not.toHaveBeenCalled();
		expect(preventDefault).toHaveBeenCalledTimes(1);
	});

	it('logs and captures unhandled promise rejections with Error and empty reasons', async () => {
		await loadMain();
		const reason = new Error('async failed');
		const firstPreventDefault = vi.fn();
		const secondPreventDefault = vi.fn();
		sentryMock.captureException.mockClear();

		emitWindowEvent('unhandledrejection', {
			reason,
			preventDefault: firstPreventDefault,
		} as unknown as PromiseRejectionEvent);

		expect(loggerMock.error).toHaveBeenCalledWith(
			'Unhandled Promise Rejection: async failed',
			'UnhandledRejection',
			{
				reason,
				stack: reason.stack,
			}
		);
		expect(sentryMock.captureException).toHaveBeenCalledWith(reason, {
			extra: { type: 'unhandledrejection' },
		});
		expect(firstPreventDefault).toHaveBeenCalledTimes(1);

		emitWindowEvent('unhandledrejection', {
			reason: null,
			preventDefault: secondPreventDefault,
		} as unknown as PromiseRejectionEvent);

		expect(loggerMock.error).toHaveBeenCalledWith(
			'Unhandled Promise Rejection: null',
			'UnhandledRejection',
			{
				reason: null,
				stack: undefined,
			}
		);
		expect(sentryMock.captureException).toHaveBeenLastCalledWith(expect.any(Error), {
			extra: { type: 'unhandledrejection' },
		});
		expect(secondPreventDefault).toHaveBeenCalledTimes(1);
	});
});
