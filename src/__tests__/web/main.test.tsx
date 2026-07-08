import { beforeEach, describe, expect, it, vi } from 'vitest';

const reactDomMock = vi.hoisted(() => ({
	createRoot: vi.fn(),
	render: vi.fn(),
}));

const appMock = vi.hoisted(() => ({
	AppRoot: vi.fn(() => null),
	useDesktopTheme: vi.fn(),
	useMaestroMode: vi.fn(),
	useOfflineStatus: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
	error: vi.fn(),
}));

vi.mock('react-dom/client', () => ({
	createRoot: reactDomMock.createRoot,
}));

vi.mock('../../web/App', () => appMock);
vi.mock('../../web/utils/logger', () => ({
	webLogger: loggerMock,
}));

async function loadWebMain() {
	vi.resetModules();
	await import('../../web/main');
}

describe('web main entrypoint', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		document.body.innerHTML = '<div id="root"></div>';
		reactDomMock.createRoot.mockReturnValue({ render: reactDomMock.render });
	});

	it('mounts AppRoot into the root element', async () => {
		await loadWebMain();

		expect(reactDomMock.createRoot).toHaveBeenCalledWith(document.getElementById('root'));
		expect(reactDomMock.render).toHaveBeenCalledTimes(1);
		expect(reactDomMock.render.mock.calls[0][0]).toEqual(
			expect.objectContaining({ type: appMock.AppRoot })
		);
		expect(loggerMock.error).not.toHaveBeenCalled();
	});

	it('logs a startup error when the root element is missing', async () => {
		document.body.innerHTML = '';

		await loadWebMain();

		expect(reactDomMock.createRoot).not.toHaveBeenCalled();
		expect(loggerMock.error).toHaveBeenCalledWith('Root element not found', 'App');
	});

	it('re-exports web app hooks from the App module', async () => {
		const module = await import('../../web/main');

		expect(module.useOfflineStatus).toBe(appMock.useOfflineStatus);
		expect(module.useMaestroMode).toBe(appMock.useMaestroMode);
		expect(module.useDesktopTheme).toBe(appMock.useDesktopTheme);
	});
});
