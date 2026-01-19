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

import { useState, useEffect, useCallback } from 'react';
import { webLogger } from '../utils/logger';

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
	};
}

export default useNotifications;
