import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MaestroConfig } from '../../web/utils/config';
import type { Theme } from '../../shared/theme-types';

const harness = vi.hoisted(() => {
	const state = {
		config: null as MaestroConfig | null,
		offline: false,
		registerOptions: null as {
			onSuccess: (registration: { scope: string }) => void;
			onUpdate: () => void;
			onOfflineChange: (offline: boolean) => void;
		} | null,
		registerServiceWorker: vi.fn(),
		isOffline: vi.fn(),
		loggerDebug: vi.fn(),
		loggerInfo: vi.fn(),
		hooks: {} as {
			useOfflineStatus: () => boolean;
			useMaestroMode: () => {
				isDashboard: boolean;
				isSession: boolean;
				sessionId: string | null;
				tabId: string | null;
				securityToken: string;
			};
			useDesktopTheme: () => {
				desktopTheme: Theme | null;
				setDesktopTheme: (theme: Theme) => void;
				bionifyReadingMode: boolean;
				setDesktopBionifyReadingMode: (enabled: boolean) => void;
			};
		},
	};

	state.registerServiceWorker = vi.fn((options) => {
		state.registerOptions = options;
	});
	state.isOffline = vi.fn(() => state.offline);

	return state;
});

vi.mock('../../web/utils/config', () => ({
	getMaestroConfig: () => harness.config,
}));

vi.mock('../../web/utils/serviceWorker', () => ({
	isOffline: harness.isOffline,
	registerServiceWorker: harness.registerServiceWorker,
}));

vi.mock('../../web/utils/logger', () => ({
	webLogger: {
		debug: harness.loggerDebug,
		info: harness.loggerInfo,
	},
}));

vi.mock('../../web/components/ThemeProvider', () => ({
	ThemeProvider: ({
		children,
		theme,
		useDevicePreference,
	}: {
		children: React.ReactNode;
		theme?: Theme;
		useDevicePreference?: boolean;
	}) => (
		<section
			data-testid="theme-provider"
			data-theme-name={theme?.name ?? 'device'}
			data-device-preference={String(useDevicePreference)}
		>
			{children}
		</section>
	),
}));

vi.mock('../../web/mobile', () => ({
	default: () => {
		const offline = harness.hooks.useOfflineStatus();
		const mode = harness.hooks.useMaestroMode();
		const { desktopTheme, setDesktopTheme, bionifyReadingMode, setDesktopBionifyReadingMode } =
			harness.hooks.useDesktopTheme();
		const nextTheme = {
			name: 'Desktop Blue',
			mode: 'dark',
			colors: {
				bgMain: '#000000',
				textMain: '#ffffff',
				accent: '#2563eb',
			},
		} as Theme;

		return (
			<div>
				<div data-testid="mobile-app">mobile</div>
				<div data-testid="offline-state">{String(offline)}</div>
				<div data-testid="mode-state">
					{mode.isDashboard ? 'dashboard' : `session:${mode.sessionId}:${mode.tabId ?? 'none'}`}
				</div>
				<div data-testid="security-token">{mode.securityToken}</div>
				<div data-testid="desktop-theme">{desktopTheme?.name ?? 'none'}</div>
				<div data-testid="desktop-bionify">{String(bionifyReadingMode)}</div>
				<button type="button" onClick={() => setDesktopTheme(nextTheme)}>
					push desktop theme
				</button>
				<button type="button" onClick={() => setDesktopBionifyReadingMode(true)}>
					push desktop bionify
				</button>
			</div>
		);
	},
}));

import { App, AppRoot, useDesktopTheme, useMaestroMode, useOfflineStatus } from '../../web/App';

harness.hooks = {
	useOfflineStatus,
	useMaestroMode,
	useDesktopTheme,
};

describe('web App rendering', () => {
	beforeEach(() => {
		harness.config = {
			securityToken: 'token-render',
			sessionId: null,
			tabId: null,
			apiBase: '/token-render/api',
			wsUrl: '/token-render/ws',
		};
		harness.offline = false;
		harness.registerOptions = null;
		harness.registerServiceWorker.mockClear();
		harness.isOffline.mockClear();
		harness.loggerDebug.mockClear();
		harness.loggerInfo.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('provides dashboard mode and responds to service-worker status callbacks', async () => {
		render(<App />);

		expect(await screen.findByTestId('mobile-app')).toBeInTheDocument();
		expect(screen.getByTestId('theme-provider')).toHaveAttribute('data-device-preference', 'true');
		expect(screen.getByTestId('mode-state')).toHaveTextContent('dashboard');
		expect(screen.getByTestId('security-token')).toHaveTextContent('token-render');
		expect(screen.getByTestId('offline-state')).toHaveTextContent('false');
		expect(harness.registerServiceWorker).toHaveBeenCalledTimes(1);

		act(() => {
			harness.registerOptions?.onSuccess({ scope: '/token-render/sw.js' });
			harness.registerOptions?.onUpdate();
			harness.registerOptions?.onOfflineChange(true);
		});

		await waitFor(() => expect(screen.getByTestId('offline-state')).toHaveTextContent('true'));
		expect(harness.loggerDebug).toHaveBeenCalledWith(
			'Service worker ready: /token-render/sw.js',
			'App'
		);
		expect(harness.loggerDebug).toHaveBeenCalledWith('Offline status changed: true', 'App');
		expect(harness.loggerInfo).toHaveBeenCalledWith(
			'New content available, refresh recommended',
			'App'
		);
	});

	it('provides session mode and applies a desktop theme update', async () => {
		harness.config = {
			securityToken: 'token-session',
			sessionId: 'session-123',
			tabId: 'tab-456',
			apiBase: '/token-session/api',
			wsUrl: '/token-session/ws',
		};

		render(<App />);

		expect(await screen.findByTestId('mode-state')).toHaveTextContent(
			'session:session-123:tab-456'
		);
		expect(harness.loggerDebug).toHaveBeenCalledWith('Mode: session:session-123', 'App');

		fireEvent.click(screen.getByRole('button', { name: 'push desktop theme' }));

		expect(screen.getByTestId('desktop-theme')).toHaveTextContent('Desktop Blue');
		expect(screen.getByTestId('theme-provider')).toHaveAttribute('data-theme-name', 'Desktop Blue');
		expect(harness.loggerDebug).toHaveBeenCalledWith(
			'Desktop theme received: Desktop Blue (dark)',
			'App'
		);

		fireEvent.click(screen.getByRole('button', { name: 'push desktop bionify' }));

		expect(screen.getByTestId('desktop-bionify')).toHaveTextContent('true');
		expect(harness.loggerDebug).toHaveBeenCalledWith(
			'Desktop Bionify reading mode received: true',
			'App'
		);
	});

	it('renders through AppRoot', async () => {
		render(<AppRoot />);

		expect(await screen.findByTestId('mobile-app')).toBeInTheDocument();
	});

	it('provides inert defaults when hooks are used without providers', () => {
		const defaultTheme = {
			name: 'Default Theme',
			mode: 'light',
			colors: {
				bgMain: '#ffffff',
				textMain: '#000000',
				accent: '#2563eb',
			},
		} as Theme;

		function DefaultContextConsumer() {
			const mode = useMaestroMode();
			const { desktopTheme, setDesktopTheme, bionifyReadingMode, setDesktopBionifyReadingMode } =
				useDesktopTheme();

			return (
				<div>
					<div data-testid="default-mode">{mode.isDashboard ? 'dashboard' : 'session'}</div>
					<div data-testid="default-token">{mode.securityToken || 'empty'}</div>
					<div data-testid="default-theme">{desktopTheme?.name ?? 'none'}</div>
					<div data-testid="default-bionify">{String(bionifyReadingMode)}</div>
					<button type="button" onClick={mode.goToDashboard}>
						default dashboard
					</button>
					<button type="button" onClick={() => mode.goToSession('session-default')}>
						default session
					</button>
					<button type="button" onClick={() => mode.updateUrl('session-default')}>
						default update
					</button>
					<button type="button" onClick={() => setDesktopTheme(defaultTheme)}>
						default theme
					</button>
					<button type="button" onClick={() => setDesktopBionifyReadingMode(true)}>
						default bionify
					</button>
				</div>
			);
		}

		render(<DefaultContextConsumer />);

		expect(screen.getByTestId('default-mode')).toHaveTextContent('dashboard');
		expect(screen.getByTestId('default-token')).toHaveTextContent('empty');
		expect(screen.getByTestId('default-theme')).toHaveTextContent('none');
		expect(screen.getByTestId('default-bionify')).toHaveTextContent('false');

		fireEvent.click(screen.getByRole('button', { name: 'default dashboard' }));
		fireEvent.click(screen.getByRole('button', { name: 'default session' }));
		fireEvent.click(screen.getByRole('button', { name: 'default update' }));
		fireEvent.click(screen.getByRole('button', { name: 'default theme' }));
		fireEvent.click(screen.getByRole('button', { name: 'default bionify' }));

		expect(screen.getByTestId('default-theme')).toHaveTextContent('none');
		expect(screen.getByTestId('default-bionify')).toHaveTextContent('false');
	});
});
