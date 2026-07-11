import { describe, expect, it, vi } from 'vitest';

vi.mock('../../web/utils/serviceWorker', () => ({
	registerServiceWorker: vi.fn(),
}));
vi.mock('../../main/preload/index', () => ({}));
vi.mock('../../renderer/main', () => ({}));

const { bootWebDesktop, ensureWebProcess } = await import('../../web-desktop/bootstrap');

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
