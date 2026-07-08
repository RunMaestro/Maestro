import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '../../shared/theme-types';
import type { MaestroConfig } from '../../web/utils/config';

const serviceWorkerMock = vi.hoisted(() => ({
	isOffline: vi.fn(),
	registerServiceWorker: vi.fn(),
	lastOptions: undefined as
		| {
				onSuccess?: (registration: ServiceWorkerRegistration) => void;
				onUpdate?: () => void;
				onOfflineChange?: (offline: boolean) => void;
		  }
		| undefined,
}));

const configMock = vi.hoisted(() => ({
	current: undefined as MaestroConfig | undefined,
	getMaestroConfig: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
	debug: vi.fn(),
	info: vi.fn(),
}));

const themeProviderMock = vi.hoisted(() => ({
	calls: [] as Array<{ theme?: Theme; useDevicePreference?: boolean }>,
}));

const mobileMock = vi.hoisted(() => ({
	hooks: undefined as
		| {
				useOfflineStatus: () => boolean;
				useMaestroMode: () => {
					isDashboard: boolean;
					sessionId: string | null;
					updateUrl: (sessionId: string, tabId?: string | null) => void;
				};
				useDesktopTheme: () => {
					bionifyReadingMode: boolean;
					setDesktopTheme: (theme: Theme) => void;
					setDesktopBionifyReadingMode: (enabled: boolean) => void;
				};
		  }
		| undefined,
}));

vi.mock('../../web/utils/serviceWorker', () => ({
	isOffline: serviceWorkerMock.isOffline,
	registerServiceWorker: serviceWorkerMock.registerServiceWorker,
}));

vi.mock('../../web/utils/config', () => ({
	getMaestroConfig: configMock.getMaestroConfig,
}));

vi.mock('../../web/utils/logger', () => ({
	webLogger: loggerMock,
}));

vi.mock('../../web/components/ThemeProvider', async () => {
	const React = await import('react');

	return {
		ThemeProvider: ({
			children,
			theme,
			useDevicePreference,
		}: {
			children: React.ReactNode;
			theme?: Theme;
			useDevicePreference?: boolean;
		}) => {
			themeProviderMock.calls.push({ theme, useDevicePreference });

			return React.createElement(
				'section',
				{
					'data-testid': 'theme-provider',
					'data-theme-name': theme?.name ?? 'device',
				},
				children
			);
		},
	};
});

vi.mock('../../web/mobile', async () => {
	const React = await import('react');

	const desktopTheme = {
		id: 'desktop-theme',
		name: 'Desktop Theme',
		mode: 'dark',
	} as Theme;

	return {
		default: function MockWebApp() {
			if (!mobileMock.hooks) {
				return React.createElement('div', { 'data-testid': 'mock-web-app' }, 'missing hooks');
			}

			const offline = mobileMock.hooks.useOfflineStatus();
			const mode = mobileMock.hooks.useMaestroMode();
			const desktop = mobileMock.hooks.useDesktopTheme();

			return React.createElement(
				'button',
				{
					type: 'button',
					'data-testid': 'mock-web-app',
					onClick: () => {
						desktop.setDesktopTheme(desktopTheme);
						desktop.setDesktopBionifyReadingMode(true);
						mode.updateUrl('session-next', 'tab next');
					},
				},
				`offline:${offline};mode:${
					mode.isDashboard ? 'dashboard' : mode.sessionId
				};bionify:${desktop.bionifyReadingMode}`
			);
		},
	};
});

function createConfig(overrides: Partial<MaestroConfig> = {}): MaestroConfig {
	return {
		securityToken: 'secure-token',
		sessionId: 'session-1',
		tabId: 'tab-1',
		apiBase: '/secure-token/api',
		wsUrl: '/secure-token/ws',
		...overrides,
	};
}

async function loadAppModule() {
	vi.resetModules();
	const module = await import('../../web/App');
	mobileMock.hooks = module;
	return module;
}

describe('web App shell integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		cleanup();
		window.history.replaceState({}, '', '/initial');
		configMock.current = createConfig();
		configMock.getMaestroConfig.mockImplementation(() => configMock.current);
		serviceWorkerMock.isOffline.mockReturnValue(false);
		serviceWorkerMock.lastOptions = undefined;
		serviceWorkerMock.registerServiceWorker.mockImplementation((options) => {
			serviceWorkerMock.lastOptions = options;
		});
		themeProviderMock.calls = [];
		mobileMock.hooks = undefined;
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('builds mode context URLs and exposes default hook values', async () => {
		const { createMaestroModeContextValue, useDesktopTheme, useMaestroMode, useOfflineStatus } =
			await loadAppModule();

		const { result } = renderHook(() => ({
			offline: useOfflineStatus(),
			mode: useMaestroMode(),
			theme: useDesktopTheme(),
		}));

		expect(result.current.offline).toBe(false);
		expect(result.current.mode).toEqual(
			expect.objectContaining({
				isDashboard: true,
				isSession: false,
				sessionId: null,
				tabId: null,
				securityToken: '',
			})
		);
		expect(result.current.theme).toEqual(
			expect.objectContaining({
				desktopTheme: null,
				bionifyReadingMode: false,
			})
		);
		act(() => {
			result.current.mode.goToDashboard();
			result.current.mode.goToSession('default-session');
			result.current.mode.updateUrl('default-session');
			result.current.theme.setDesktopTheme({ name: 'Default Theme' } as Theme);
			result.current.theme.setDesktopBionifyReadingMode(true);
		});

		const dashboardMode = createMaestroModeContextValue(
			createConfig({ sessionId: null, tabId: null })
		);
		expect(dashboardMode).toEqual(
			expect.objectContaining({
				isDashboard: true,
				isSession: false,
				sessionId: null,
				tabId: null,
				securityToken: 'secure-token',
			})
		);

		const replaceState = vi.spyOn(window.history, 'replaceState');
		dashboardMode.updateUrl('session-2', 'tab/2');
		expect(replaceState).toHaveBeenCalledWith(
			{ sessionId: 'session-2', tabId: 'tab/2' },
			'',
			`${window.location.origin}/secure-token/session/session-2?tabId=tab%2F2`
		);

		dashboardMode.updateUrl('session-2', 'tab/2');
		expect(replaceState).toHaveBeenCalledTimes(1);

		dashboardMode.updateUrl('session-3');
		expect(replaceState).toHaveBeenLastCalledWith(
			{ sessionId: 'session-3', tabId: undefined },
			'',
			`${window.location.origin}/secure-token/session/session-3`
		);
	});

	it('logs dashboard mode when no session is selected', async () => {
		configMock.current = createConfig({ sessionId: null, tabId: null });
		const { App } = await loadAppModule();

		render(<App />);

		expect(await screen.findByTestId('mock-web-app')).toHaveTextContent(
			'offline:false;mode:dashboard;bionify:false'
		);
		expect(loggerMock.debug).toHaveBeenCalledWith('Mode: dashboard', 'App');
	});

	it('renders app providers and reacts to service worker and desktop updates', async () => {
		const { App } = await loadAppModule();

		render(<App />);

		const mobileApp = await screen.findByTestId('mock-web-app');
		expect(mobileApp).toHaveTextContent('offline:false;mode:session-1;bionify:false');
		expect(screen.getByTestId('theme-provider')).toHaveAttribute('data-theme-name', 'device');
		expect(themeProviderMock.calls.at(-1)).toEqual({
			theme: undefined,
			useDevicePreference: true,
		});
		expect(serviceWorkerMock.registerServiceWorker).toHaveBeenCalledOnce();
		expect(loggerMock.debug).toHaveBeenCalledWith('Mode: session:session-1', 'App');

		act(() => {
			serviceWorkerMock.lastOptions?.onSuccess?.({
				scope: `${window.location.origin}/secure-token/`,
			} as ServiceWorkerRegistration);
			serviceWorkerMock.lastOptions?.onUpdate?.();
			serviceWorkerMock.lastOptions?.onOfflineChange?.(true);
		});

		expect(loggerMock.debug).toHaveBeenCalledWith(
			`Service worker ready: ${window.location.origin}/secure-token/`,
			'App'
		);
		expect(loggerMock.info).toHaveBeenCalledWith(
			'New content available, refresh recommended',
			'App'
		);
		await waitFor(() =>
			expect(screen.getByTestId('mock-web-app')).toHaveTextContent(
				'offline:true;mode:session-1;bionify:false'
			)
		);

		const replaceState = vi.spyOn(window.history, 'replaceState');
		act(() => {
			screen.getByTestId('mock-web-app').click();
		});

		await waitFor(() =>
			expect(screen.getByTestId('mock-web-app')).toHaveTextContent(
				'offline:true;mode:session-1;bionify:true'
			)
		);
		expect(screen.getByTestId('theme-provider')).toHaveAttribute(
			'data-theme-name',
			'Desktop Theme'
		);
		expect(loggerMock.debug).toHaveBeenCalledWith(
			'Desktop theme received: Desktop Theme (dark)',
			'App'
		);
		expect(loggerMock.debug).toHaveBeenCalledWith(
			'Desktop Bionify reading mode received: true',
			'App'
		);
		expect(replaceState).toHaveBeenCalledWith(
			{ sessionId: 'session-next', tabId: 'tab next' },
			'',
			`${window.location.origin}/secure-token/session/session-next?tabId=tab%20next`
		);
	});

	it('wraps App with StrictMode in AppRoot', async () => {
		const { AppRoot } = await loadAppModule();

		render(<AppRoot />);

		expect(await screen.findByTestId('mock-web-app')).toHaveTextContent(
			'offline:false;mode:session-1;bionify:false'
		);
	});
});
