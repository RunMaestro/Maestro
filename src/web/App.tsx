/**
 * Maestro Web Interface App
 *
 * Remote control interface for mobile/tablet devices.
 * Provides session monitoring and command input from anywhere on your network.
 */

import React, {
	StrictMode,
	lazy,
	Suspense,
	useEffect,
	useState,
	useMemo,
	createContext,
	useContext,
	useCallback,
} from 'react';
import { ThemeProvider } from './components/ThemeProvider';
import { registerServiceWorker, isOffline } from './utils/serviceWorker';
import { getMaestroConfig } from './utils/config';
import type { MaestroConfig } from './utils/config';
import { webLogger } from './utils/logger';
import type { Theme } from '../shared/theme-types';

/**
 * Context for offline status
 * Provides offline state to all components in the app
 */
interface OfflineContextValue {
	isOffline: boolean;
}

const OfflineContext = createContext<OfflineContextValue>({ isOffline: false });

/**
 * Hook to access offline status
 */
export function useOfflineStatus(): boolean {
	return useContext(OfflineContext).isOffline;
}

/**
 * Context for Maestro mode (dashboard vs session)
 */
interface MaestroModeContextValue {
	/** Whether we're viewing the dashboard (all live sessions) */
	isDashboard: boolean;
	/** Whether we're viewing a specific session */
	isSession: boolean;
	/** Current session ID (if in session mode) */
	sessionId: string | null;
	/** Current tab ID from URL (if specified) */
	tabId: string | null;
	/** Security token for API/WS calls */
	securityToken: string;
	/** Navigate to dashboard */
	goToDashboard: () => void;
	/** Navigate to a specific session (optionally with a specific tab) */
	goToSession: (sessionId: string, tabId?: string | null) => void;
	/** Update URL to reflect current session and tab without navigation */
	updateUrl: (sessionId: string, tabId?: string | null) => void;
}

const MaestroModeContext = createContext<MaestroModeContextValue>({
	isDashboard: true,
	isSession: false,
	sessionId: null,
	tabId: null,
	securityToken: '',
	goToDashboard: () => {},
	goToSession: () => {},
	updateUrl: () => {},
});

/**
 * Hook to access Maestro mode context
 */
export function useMaestroMode(): MaestroModeContextValue {
	return useContext(MaestroModeContext);
}

/**
 * Context for theme updates from WebSocket
 * Allows the mobile app to update the theme when received from desktop
 */
interface ThemeUpdateContextValue {
	/** Current theme from desktop app (null if using device preference) */
	desktopTheme: Theme | null;
	/** Update the theme when received from desktop app */
	setDesktopTheme: (theme: Theme) => void;
}

const ThemeUpdateContext = createContext<ThemeUpdateContextValue>({
	desktopTheme: null,
	setDesktopTheme: () => {},
});

/**
 * Hook to access and update the desktop theme
 * Used by mobile app to set theme when received via WebSocket
 */
export function useDesktopTheme(): ThemeUpdateContextValue {
	return useContext(ThemeUpdateContext);
}

/**
 * Build the Maestro mode context based on injected config.
 */
export function createMaestroModeContextValue(config: MaestroConfig): MaestroModeContextValue {
	const baseUrl = `${window.location.origin}/${config.securityToken}`;
	const isDashboard = config.sessionId === null;

	const buildSessionUrl = (sessionId: string, tabId?: string | null) => {
		let url = `${baseUrl}/session/${sessionId}`;
		if (tabId) {
			url += `?tabId=${encodeURIComponent(tabId)}`;
		}
		return url;
	};

	return {
		isDashboard,
		isSession: !isDashboard,
		sessionId: config.sessionId,
		tabId: config.tabId,
		securityToken: config.securityToken,
		goToDashboard: () => {
			window.location.href = baseUrl;
		},
		goToSession: (sessionId: string, tabId?: string | null) => {
			window.location.href = buildSessionUrl(sessionId, tabId);
		},
		updateUrl: (sessionId: string, tabId?: string | null) => {
			const newUrl = buildSessionUrl(sessionId, tabId);
			// Only update if URL actually changed
			if (window.location.href !== newUrl) {
				window.history.replaceState({ sessionId, tabId }, '', newUrl);
			}
		},
	};
}

// Lazy load the web app
// Both mobile and desktop use the same remote control interface
const WebApp = lazy(() =>
	import(/* webpackChunkName: "mobile" */ './mobile').catch(() => ({
		default: () => <PlaceholderApp />,
	}))
);

/**
 * Placeholder component shown while the actual app loads
 * or if there's an error loading the app module
 */
function PlaceholderApp() {
	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				justifyContent: 'center',
				height: '100vh',
				padding: '20px',
				textAlign: 'center',
				color: 'var(--color-text-main)',
				backgroundColor: 'var(--color-background)',
			}}
		>
			<h1 style={{ marginBottom: '16px', fontSize: '24px' }}>Maestro Web</h1>
			<p style={{ marginBottom: '8px', color: 'var(--color-text-muted)' }}>
				Remote control interface
			</p>
			<p style={{ fontSize: '14px', color: 'var(--color-text-muted)' }}>
				Connect to your Maestro desktop app to get started
			</p>
		</div>
	);
}

/**
 * Loading fallback component
 */
function LoadingFallback() {
	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				height: '100vh',
				backgroundColor: 'var(--color-background)',
			}}
		>
			<div
				style={{
					width: '40px',
					height: '40px',
					border: '3px solid var(--color-border)',
					borderTopColor: 'var(--color-accent)',
					borderRadius: '50%',
					animation: 'spin 1s linear infinite',
				}}
			/>
		</div>
	);
}

/**
 * Main App component - renders the remote control interface
 */
export function App() {
	const [offline, setOffline] = useState(isOffline());
	const [desktopTheme, setDesktopTheme] = useState<Theme | null>(null);
	const config = useMemo(() => getMaestroConfig(), []);

	const modeContextValue = useMemo(
		() => createMaestroModeContextValue(config),
		[config.securityToken, config.sessionId, config.tabId]
	);

	const handleDesktopTheme = useCallback((theme: Theme) => {
		webLogger.debug(`Desktop theme received: ${theme.name} (${theme.mode})`, 'App');
		setDesktopTheme(theme);
	}, []);

	const themeUpdateContextValue = useMemo(
		() => ({
			desktopTheme,
			setDesktopTheme: handleDesktopTheme,
		}),
		[desktopTheme, handleDesktopTheme]
	);

	// Register service worker for offline capability
	useEffect(() => {
		registerServiceWorker({
			onSuccess: (registration) => {
				webLogger.debug(`Service worker ready: ${registration.scope}`, 'App');
			},
			onUpdate: () => {
				webLogger.info('New content available, refresh recommended', 'App');
				// Could show a toast/notification here prompting user to refresh
			},
			onOfflineChange: (newOfflineStatus) => {
				webLogger.debug(`Offline status changed: ${newOfflineStatus}`, 'App');
				setOffline(newOfflineStatus);
			},
		});
	}, []);

	// Log mode info on mount
	useEffect(() => {
		webLogger.debug(
			`Mode: ${modeContextValue.isDashboard ? 'dashboard' : `session:${modeContextValue.sessionId}`}`,
			'App'
		);
	}, [modeContextValue.isDashboard, modeContextValue.sessionId]);

	return (
		<MaestroModeContext.Provider value={modeContextValue}>
			<OfflineContext.Provider value={{ isOffline: offline }}>
				<ThemeUpdateContext.Provider value={themeUpdateContextValue}>
					{/*
            Enable useDevicePreference to respect the device's dark/light mode preference.
            When no theme is provided from the desktop app via WebSocket, the web interface
            will automatically use a dark or light theme based on the user's device settings.
            Once the desktop app sends a theme (via desktopTheme), it will override the device preference.
          */}
					<ThemeProvider theme={desktopTheme || undefined} useDevicePreference>
						<Suspense fallback={<LoadingFallback />}>
							<WebApp />
						</Suspense>
					</ThemeProvider>
				</ThemeUpdateContext.Provider>
			</OfflineContext.Provider>
		</MaestroModeContext.Provider>
	);
}

export function AppRoot() {
	return (
		<StrictMode>
			<App />
		</StrictMode>
	);
}
