/**
 * useSettings hook for reading and writing settings from the web client.
 *
 * Fetches settings on mount/reconnect, listens for broadcast changes,
 * and provides typed setters for each configurable setting.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { UseWebSocketReturn, SettingsChangedMessage } from './useWebSocket';

/**
 * Web-facing settings shape (mirrors server-side WebSettings).
 */
export type WebSettings = SettingsChangedMessage['settings'];

/**
 * Setting value type for setSetting.
 */
export type SettingValue = string | number | boolean | null;

/**
 * Return value from useSettings hook.
 */
export interface UseSettingsReturn {
	settings: WebSettings | null;
	isLoading: boolean;
	setSetting: (key: string, value: SettingValue) => Promise<boolean>;
	setTheme: (themeId: string) => Promise<boolean>;
	setFontSize: (size: number) => Promise<boolean>;
	setEnterToSendAI: (value: boolean) => Promise<boolean>;
	setAutoScroll: (value: boolean) => Promise<boolean>;
	setDefaultSaveToHistory: (value: boolean) => Promise<boolean>;
	setDefaultShowThinking: (value: string) => Promise<boolean>;
	setNotificationsEnabled: (value: boolean) => Promise<boolean>;
	setAudioFeedbackEnabled: (value: boolean) => Promise<boolean>;
	setColorBlindMode: (value: string) => Promise<boolean>;
	setConductorProfile: (value: string) => Promise<boolean>;
	/** Pass Infinity for "All"; it serializes to null on the wire and desktop rehydrates it. */
	setMaxOutputLines: (value: number) => Promise<boolean>;
	/** Handler for settings_changed broadcasts — wire to onSettingsChanged in WebSocket handlers */
	handleSettingsChanged: (settings: WebSettings) => void;
}

/**
 * Map from allowlisted setting keys to their WebSettings field names.
 */
const SETTING_KEY_TO_FIELD: Record<string, keyof WebSettings> = {
	activeThemeId: 'theme',
	fontSize: 'fontSize',
	enterToSendAI: 'enterToSendAI',
	defaultSaveToHistory: 'defaultSaveToHistory',
	defaultShowThinking: 'defaultShowThinking',
	autoScroll: 'autoScroll',
	notificationsEnabled: 'notificationsEnabled',
	audioFeedbackEnabled: 'audioFeedbackEnabled',
	colorBlindMode: 'colorBlindMode',
	conductorProfile: 'conductorProfile',
	maxOutputLines: 'maxOutputLines',
};

/**
 * Hook for managing settings state and operations via WebSocket.
 *
 * @param sendRequest - WebSocket sendRequest function for request-response operations
 * @param isConnected - Whether the WebSocket is currently connected
 */
export function useSettings(
	sendRequest: UseWebSocketReturn['sendRequest'],
	isConnected: boolean
): UseSettingsReturn {
	const [settings, setSettings] = useState<WebSettings | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const hasFetchedRef = useRef(false);

	// Fetch settings on mount and when connection is established
	useEffect(() => {
		if (!isConnected) {
			hasFetchedRef.current = false;
			return;
		}
		if (hasFetchedRef.current) return;

		hasFetchedRef.current = true;
		setIsLoading(true);

		sendRequest<{ settings?: WebSettings }>('get_settings')
			.then((response) => {
				if (response.settings) {
					setSettings(response.settings);
				}
			})
			.catch(() => {
				// Settings fetch failed — will retry on reconnect
			})
			.finally(() => {
				setIsLoading(false);
			});
	}, [isConnected, sendRequest]);

	/**
	 * Update settings from a broadcast message.
	 * Intended to be wired to onSettingsChanged in the WebSocket handlers.
	 */
	const handleSettingsChanged = useCallback((newSettings: WebSettings) => {
		setSettings(newSettings);
	}, []);

	/**
	 * Set a single setting by its allowlisted key.
	 * Optimistically updates local state, rolls back on failure.
	 */
	const setSetting = useCallback(
		async (key: string, value: SettingValue): Promise<boolean> => {
			const field = SETTING_KEY_TO_FIELD[key];
			if (!field) return false;

			// Optimistic update
			const prev = settings;
			if (settings) {
				setSettings({ ...settings, [field]: value } as WebSettings);
			}

			try {
				const response = await sendRequest<{ success?: boolean }>('set_setting', { key, value });
				if (!response.success) {
					// Rollback on explicit server rejection
					if (prev) setSettings(prev);
				}
				return response.success ?? false;
			} catch {
				// Rollback on failure
				if (prev) setSettings(prev);
				return false;
			}
		},
		[sendRequest, settings]
	);

	// Typed convenience setters
	const setTheme = useCallback(
		(themeId: string) => setSetting('activeThemeId', themeId),
		[setSetting]
	);

	const setFontSize = useCallback((size: number) => setSetting('fontSize', size), [setSetting]);

	const setEnterToSendAI = useCallback(
		(value: boolean) => setSetting('enterToSendAI', value),
		[setSetting]
	);

	const setAutoScroll = useCallback(
		(value: boolean) => setSetting('autoScroll', value),
		[setSetting]
	);

	const setDefaultSaveToHistory = useCallback(
		(value: boolean) => setSetting('defaultSaveToHistory', value),
		[setSetting]
	);

	const setDefaultShowThinking = useCallback(
		(value: string) => setSetting('defaultShowThinking', value),
		[setSetting]
	);

	const setNotificationsEnabled = useCallback(
		(value: boolean) => setSetting('notificationsEnabled', value),
		[setSetting]
	);

	const setAudioFeedbackEnabled = useCallback(
		(value: boolean) => setSetting('audioFeedbackEnabled', value),
		[setSetting]
	);

	const setColorBlindMode = useCallback(
		(value: string) => setSetting('colorBlindMode', value),
		[setSetting]
	);

	const setConductorProfile = useCallback(
		(value: string) => setSetting('conductorProfile', value),
		[setSetting]
	);

	const setMaxOutputLines = useCallback(
		// Infinity ("All") serializes as null on the wire — desktop rehydrates it.
		(value: number) => setSetting('maxOutputLines', Number.isFinite(value) ? value : null),
		[setSetting]
	);

	return {
		settings,
		isLoading,
		setSetting,
		setTheme,
		setFontSize,
		setEnterToSendAI,
		setAutoScroll,
		setDefaultSaveToHistory,
		setDefaultShowThinking,
		setNotificationsEnabled,
		setAudioFeedbackEnabled,
		setColorBlindMode,
		setConductorProfile,
		setMaxOutputLines,
		handleSettingsChanged,
	};
}

export default useSettings;
