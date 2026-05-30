/**
 * Notification Hook for Maestro Mobile Web
 *
 * Handles notification permission requests and push notification
 * functionality for the mobile web interface.
 *
 * Features:
 * - Request notification permission on first visit
 * - Track permission state
 * - Persist permission request state to avoid repeated prompts
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { webLogger } from '../utils/logger';

/**
 * Notification event types from the server
 */
export interface NotificationEvent {
	eventType:
		| 'agent_complete'
		| 'agent_error'
		| 'autorun_complete'
		| 'autorun_task_complete'
		| 'context_warning';
	sessionId: string;
	sessionName: string;
	message: string;
	severity: 'info' | 'warning' | 'error';
}

/**
 * Notification preferences configuration
 */
export interface NotificationPreferences {
	agentComplete: boolean;
	agentError: boolean;
	autoRunComplete: boolean;
	autoRunTaskComplete: boolean;
	contextWarning: boolean;
	soundEnabled: boolean;
}

/**
 * Map from event type to preference key
 */
const EVENT_TYPE_TO_PREF: Record<
	NotificationEvent['eventType'],
	keyof Omit<NotificationPreferences, 'soundEnabled'>
> = {
	agent_complete: 'agentComplete',
	agent_error: 'agentError',
	autorun_complete: 'autoRunComplete',
	autorun_task_complete: 'autoRunTaskComplete',
	context_warning: 'contextWarning',
};

const DEFAULT_PREFERENCES: NotificationPreferences = {
	agentComplete: true,
	agentError: true,
	autoRunComplete: true,
	autoRunTaskComplete: true,
	contextWarning: true,
	soundEnabled: false,
};

const NOTIFICATION_PREFS_KEY = 'maestro-notification-prefs';

/**
 * Notification permission states
 */
export type NotificationPermission = 'default' | 'granted' | 'denied';

/**
 * Storage key for tracking if we've asked for permission before
 */
const NOTIFICATION_PROMPT_KEY = 'maestro_notification_prompted';

/**
 * Storage key for user preference (if they explicitly declined)
 */
const NOTIFICATION_DECLINED_KEY = 'maestro_notification_declined';

/**
 * Configuration options for the useNotifications hook
 */
export interface UseNotificationsOptions {
	/** Whether to automatically request permission on first visit (default: true) */
	autoRequest?: boolean;
	/** Delay in ms before showing permission prompt (default: 2000) */
	requestDelay?: number;
	/** Callback when permission is granted */
	onGranted?: () => void;
	/** Callback when permission is denied */
	onDenied?: () => void;
	/** Callback when permission state changes */
	onPermissionChange?: (permission: NotificationPermission) => void;
}

/**
 * Return type for the useNotifications hook
 */
export interface UseNotificationsReturn {
	/** Current notification permission state */
	permission: NotificationPermission;
	/** Whether notifications are supported in this browser */
	isSupported: boolean;
	/** Whether we've already prompted the user */
	hasPrompted: boolean;
	/** Whether the user explicitly declined notifications */
	hasDeclined: boolean;
	/** Request notification permission */
	requestPermission: () => Promise<NotificationPermission>;
	/** Mark as declined (user explicitly said no in our UI) */
	declineNotifications: () => void;
	/** Reset the prompt state (allows re-prompting) */
	resetPromptState: () => void;
	/** Show a notification (if permission granted) */
	showNotification: (title: string, options?: NotificationOptions) => Notification | null;
	/** Current notification preferences */
	preferences: NotificationPreferences;
	/** Update notification preferences (partial merge) */
	setPreferences: (prefs: Partial<NotificationPreferences>) => void;
	/** Handle an incoming notification event from the server */
	handleNotificationEvent: (event: NotificationEvent) => void;
}

/**
 * Check if notifications are supported
 */
export function isNotificationSupported(): boolean {
	return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Get the current notification permission
 */
export function getNotificationPermission(): NotificationPermission {
	if (!isNotificationSupported()) return 'denied';
	return Notification.permission as NotificationPermission;
}

/**
 * Hook for managing notification permissions and displaying notifications
 *
 * @param options - Configuration options
 * @returns Notification state and control functions
 */
export function useNotifications(options: UseNotificationsOptions = {}): UseNotificationsReturn {
	const {
		autoRequest = true,
		requestDelay = 2000,
		onGranted,
		onDenied,
		onPermissionChange,
	} = options;

	const isSupported = isNotificationSupported();

	const [permission, setPermission] = useState<NotificationPermission>(getNotificationPermission());

	const [hasPrompted, setHasPrompted] = useState<boolean>(() => {
		if (typeof localStorage === 'undefined') return false;
		return localStorage.getItem(NOTIFICATION_PROMPT_KEY) === 'true';
	});

	const [hasDeclined, setHasDeclined] = useState<boolean>(() => {
		if (typeof localStorage === 'undefined') return false;
		return localStorage.getItem(NOTIFICATION_DECLINED_KEY) === 'true';
	});

	/**
	 * Request notification permission from the user
	 */
	const requestPermission = useCallback(async (): Promise<NotificationPermission> => {
		if (!isSupported) {
			webLogger.debug('Notifications not supported in this browser', 'Notifications');
			return 'denied';
		}

		// Mark that we've prompted the user
		setHasPrompted(true);
		localStorage.setItem(NOTIFICATION_PROMPT_KEY, 'true');

		try {
			const result = await Notification.requestPermission();
			const newPermission = result as NotificationPermission;

			setPermission(newPermission);
			onPermissionChange?.(newPermission);

			if (newPermission === 'granted') {
				webLogger.debug('Permission granted', 'Notifications');
				onGranted?.();
			} else if (newPermission === 'denied') {
				webLogger.debug('Permission denied', 'Notifications');
				onDenied?.();
			}

			return newPermission;
		} catch (error) {
			webLogger.error('Error requesting permission', 'Notifications', error);
			return 'denied';
		}
	}, [isSupported, onGranted, onDenied, onPermissionChange]);

	/**
	 * Mark notifications as explicitly declined by user (via our UI)
	 */
	const declineNotifications = useCallback(() => {
		setHasDeclined(true);
		setHasPrompted(true);
		localStorage.setItem(NOTIFICATION_DECLINED_KEY, 'true');
		localStorage.setItem(NOTIFICATION_PROMPT_KEY, 'true');
		webLogger.debug('User declined via UI', 'Notifications');
	}, []);

	/**
	 * Reset the prompt state to allow re-prompting
	 */
	const resetPromptState = useCallback(() => {
		setHasPrompted(false);
		setHasDeclined(false);
		localStorage.removeItem(NOTIFICATION_PROMPT_KEY);
		localStorage.removeItem(NOTIFICATION_DECLINED_KEY);
		webLogger.debug('Prompt state reset', 'Notifications');
	}, []);

	/**
	 * Show a notification (if permission is granted)
	 */
	const showNotification = useCallback(
		(title: string, options?: NotificationOptions): Notification | null => {
			if (!isSupported || permission !== 'granted') {
				webLogger.debug(`Cannot show notification, permission: ${permission}`, 'Notifications');
				return null;
			}

			try {
				const notification = new Notification(title, {
					icon: '/maestro-icon-192.png',
					badge: '/maestro-icon-192.png',
					...options,
				});

				return notification;
			} catch (error) {
				webLogger.error('Error showing notification', 'Notifications', error);
				return null;
			}
		},
		[isSupported, permission]
	);

	// Auto-request permission on first visit after a delay
	useEffect(() => {
		if (!autoRequest || !isSupported) return;

		// Don't prompt if already prompted or explicitly declined
		if (hasPrompted || hasDeclined) return;

		// Don't prompt if already granted or denied at browser level
		if (permission !== 'default') return;

		// Wait for the specified delay before prompting
		const timer = setTimeout(() => {
			webLogger.debug('Auto-requesting permission after delay', 'Notifications');
			requestPermission();
		}, requestDelay);

		return () => clearTimeout(timer);
	}, [
		autoRequest,
		isSupported,
		hasPrompted,
		hasDeclined,
		permission,
		requestDelay,
		requestPermission,
	]);

	// Notification preferences state — persisted to localStorage
	const [preferences, setPreferencesState] = useState<NotificationPreferences>(() => {
		if (typeof localStorage === 'undefined') return DEFAULT_PREFERENCES;
		try {
			const stored = localStorage.getItem(NOTIFICATION_PREFS_KEY);
			if (stored) {
				return { ...DEFAULT_PREFERENCES, ...JSON.parse(stored) };
			}
		} catch {
			// Ignore parse errors
		}
		return DEFAULT_PREFERENCES;
	});

	const setPreferences = useCallback((prefs: Partial<NotificationPreferences>) => {
		setPreferencesState((prev) => {
			const merged = { ...prev, ...prefs };
			try {
				localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(merged));
			} catch {
				// Ignore storage errors
			}
			return merged;
		});
	}, []);

	// Keep a ref to preferences so handleNotificationEvent always has current values
	const preferencesRef = useRef(preferences);
	preferencesRef.current = preferences;

	// Keep a ref to showNotification so handleNotificationEvent doesn't need it as a dep
	const showNotificationRef = useRef(showNotification);
	showNotificationRef.current = showNotification;

	/**
	 * Play a short notification beep using Web Audio API
	 */
	const playNotificationSound = useCallback(() => {
		try {
			const ctx = new AudioContext();
			const oscillator = ctx.createOscillator();
			const gainNode = ctx.createGain();

			oscillator.connect(gainNode);
			gainNode.connect(ctx.destination);

			oscillator.type = 'sine';
			oscillator.frequency.setValueAtTime(800, ctx.currentTime);
			gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
			gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);

			oscillator.start(ctx.currentTime);
			oscillator.stop(ctx.currentTime + 0.2);

			// Clean up after sound completes
			oscillator.onended = () => ctx.close();
		} catch {
			// Audio not available
		}
	}, []);

	/**
	 * Handle an incoming notification event from the server
	 */
	const handleNotificationEvent = useCallback(
		(event: NotificationEvent) => {
			const prefs = preferencesRef.current;
			const prefKey = EVENT_TYPE_TO_PREF[event.eventType];

			// Check if this event type is enabled
			if (!prefKey || !prefs[prefKey]) return;

			// Check if we have permission
			if (getNotificationPermission() !== 'granted') return;

			const notification = showNotificationRef.current(event.sessionName, {
				body: event.message,
				tag: `maestro-${event.eventType}-${event.sessionId}`,
				icon: '/icon-192.png',
			});

			if (notification) {
				notification.onclick = () => {
					window.focus();
					window.dispatchEvent(
						new CustomEvent('maestro-notification-click', {
							detail: { sessionId: event.sessionId },
						})
					);
				};
			}

			if (prefs.soundEnabled) {
				playNotificationSound();
			}
		},
		[playNotificationSound]
	);

	// Listen for permission changes (e.g., user changes in browser settings)
	useEffect(() => {
		if (!isSupported) return;

		// Check permission periodically (some browsers don't have an event for this)
		const checkPermission = () => {
			const currentPermission = getNotificationPermission();
			if (currentPermission !== permission) {
				setPermission(currentPermission);
				onPermissionChange?.(currentPermission);
			}
		};

		// Check on visibility change (user may have changed settings in another tab)
		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				checkPermission();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
	}, [isSupported, permission, onPermissionChange]);

	return {
		permission,
		isSupported,
		hasPrompted,
		hasDeclined,
		requestPermission,
		declineNotifications,
		resetPromptState,
		showNotification,
		preferences,
		setPreferences,
		handleNotificationEvent,
	};
}

export default useNotifications;
