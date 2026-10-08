import { describe, expect, it, vi } from 'vitest';

vi.mock('../../web/utils/serviceWorker', () => ({
	registerServiceWorker: vi.fn(),
}));
vi.mock('../../main/preload/index', () => ({}));
vi.mock('../../renderer/main', () => ({}));

const { bootWebDesktop, ensureWebProcess, reportBootFailure } =
	await import('../../web-desktop/bootstrap');

describe('web-desktop bootstrap process shim', () => {
	it('supplies an empty argv array before evaluating the shared preload', async () => {
		const browserWindow = {
			process: {
				env: { NODE_ENV: 'production' },
				versions: { electron: '0.0.0-web', chrome: '0.0.0', node: '0.0.0' },
				platform: 'linux',
			},
		} as Window;
		const preload = vi.fn(async () => {
			expect(browserWindow.process?.argv).toEqual([]);
		});
		const renderer = vi.fn(async () => {});

		await bootWebDesktop(browserWindow, { preload, renderer });

		expect(preload).toHaveBeenCalledOnce();
		expect(renderer).toHaveBeenCalledOnce();
	});

	it('creates the complete process shim when the browser has no process', () => {
		const browserWindow = {} as Window;

		ensureWebProcess(browserWindow);

		expect(browserWindow.process).toMatchObject({
			env: { NODE_ENV: 'production' },
			versions: { electron: '0.0.0-web', chrome: '0.0.0', node: '0.0.0' },
			argv: [],
		});
		expect(['darwin', 'win32', 'linux']).toContain(browserWindow.process?.platform);
	});

	it('preserves existing browser launch arguments', () => {
		const browserWindow = {
			process: {
				env: {},
				versions: {},
				platform: 'linux',
				argv: ['--maestro-cli-path=/tmp/maestro-cli'],
			},
		} as Window;

		ensureWebProcess(browserWindow);

		expect(browserWindow.process?.argv).toEqual(['--maestro-cli-path=/tmp/maestro-cli']);
	});
});

describe('web-desktop boot failure reporting', () => {
	// A module that failed to fetch for a moment (a Cloudflare quick tunnel
	// answering 429 while several tabs reload) used to go straight to the error
	// screen, so the user had to refresh by hand. It must reach the load-failure
	// policy, which reloads once for exactly that case.
	it('hands the failure to the load-failure policy when it is installed', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const handle = vi.fn();
		const showBootError = vi.fn();
		const target = {
			__maestroHandleLoadFailure: handle,
			__maestroShowBootError: showBootError,
		} as unknown as Window;
		const err = new TypeError('Importing a module script failed.');

		reportBootFailure(target, err);

		expect(handle).toHaveBeenCalledWith(err);
		expect(showBootError).not.toHaveBeenCalled();
	});

	it('falls back to the inline error surface when the policy never installed', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const showBootError = vi.fn();
		const target = { __maestroShowBootError: showBootError } as unknown as Window;

		reportBootFailure(target, new Error('boom'));

		expect(showBootError).toHaveBeenCalledWith(
			'Maestro web-desktop failed to load',
			expect.stringContaining('boom')
		);
	});
});
