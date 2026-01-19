/**
 * Unread Badge Hook for Maestro Mobile Web
 *
 * Manages unread response counts and updates the app badge
 * using the Navigator Badge API (PWA feature).
 *
 * Features:
 * - Track unread response count
 * - Update app badge on home screen
 * - Persist unread state to localStorage
 * - Clear badge when user views responses
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { webLogger } from '../utils/logger';

/**
 * Storage key for persisting unread response IDs
 */
const UNREAD_RESPONSES_KEY = 'maestro_unread_responses';

/**
 * Configuration options for the useUnreadBadge hook
 */
export interface UseUnreadBadgeOptions {
	/** Callback when unread count changes */
	onCountChange?: (count: number) => void;
	/** Whether to auto-clear badge when app becomes visible (default: true) */
	autoClearOnVisible?: boolean;
}

/**
 * Return type for the useUnreadBadge hook
 */
export interface UseUnreadBadgeReturn {
	/** Current unread response count */
	unreadCount: number;
	/** Set of unread response IDs */
	unreadIds: Set<string>;
	/** Whether the Badge API is supported */
	isSupported: boolean;
	/** Add an unread response (increments badge) */
	addUnread: (responseId: string) => void;
	/** Mark a response as read */
	markRead: (responseId: string) => void;
	/** Mark all responses as read (clears badge) */
	markAllRead: () => void;
	/** Set the badge count directly */
	setBadgeCount: (count: number) => void;
	/** Clear the badge */
	clearBadge: () => void;
}

/**
 * Check if the Badge API is supported
 */
export function isBadgeApiSupported(): boolean {
	return typeof navigator !== 'undefined' && 'setAppBadge' in navigator;
}

/**
 * Load unread IDs from localStorage
 */
function loadUnreadIds(): Set<string> {
	if (typeof localStorage === 'undefined') return new Set();
	try {
		const stored = localStorage.getItem(UNREAD_RESPONSES_KEY);
		if (stored) {
			const ids = JSON.parse(stored);
			if (Array.isArray(ids)) {
				return new Set(ids);
			}
		}
	} catch (error) {
		webLogger.error('Error loading unread IDs', 'UnreadBadge', error);
	}
	return new Set();
}

/**
 * Save unread IDs to localStorage
 */
function saveUnreadIds(ids: Set<string>): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(UNREAD_RESPONSES_KEY, JSON.stringify([...ids]));
	} catch (error) {
		webLogger.error('Error saving unread IDs', 'UnreadBadge', error);
	}
}

/**
 * Hook for managing unread response badge count
 *
 * @param options - Configuration options
 * @returns Unread badge state and control functions
 */
export function useUnreadBadge(options: UseUnreadBadgeOptions = {}): UseUnreadBadgeReturn {
	const { onCountChange, autoClearOnVisible = true } = options;

	const isSupported = isBadgeApiSupported();
	const [unreadIds, setUnreadIds] = useState<Set<string>>(() => loadUnreadIds());
	const onCountChangeRef = useRef(onCountChange);
	onCountChangeRef.current = onCountChange;

	// Computed unread count
	const unreadCount = unreadIds.size;

	/**
	 * Update the app badge
	 */
	const updateBadge = useCallback(
		async (count: number) => {
			if (!isSupported) return;

			try {
				if (count > 0) {
					await navigator.setAppBadge(count);
					webLogger.debug(`Badge set to: ${count}`, 'UnreadBadge');
				} else {
					await navigator.clearAppBadge();
					webLogger.debug('Badge cleared', 'UnreadBadge');
				}
			} catch (error) {
				// Badge API may fail if not running as PWA
				webLogger.debug('Badge API unavailable', 'UnreadBadge', error);
			}
		},
		[isSupported]
	);

	/**
	 * Add an unread response
	 */
	const addUnread = useCallback((responseId: string) => {
		setUnreadIds((prev) => {
			if (prev.has(responseId)) return prev;
			const next = new Set(prev);
			next.add(responseId);
			saveUnreadIds(next);
			return next;
		});
	}, []);

	/**
	 * Mark a response as read
	 */
	const markRead = useCallback((responseId: string) => {
		setUnreadIds((prev) => {
			if (!prev.has(responseId)) return prev;
			const next = new Set(prev);
			next.delete(responseId);
			saveUnreadIds(next);
			return next;
		});
	}, []);

	/**
	 * Mark all responses as read
	 */
	const markAllRead = useCallback(() => {
		setUnreadIds(() => {
			const next = new Set<string>();
			saveUnreadIds(next);
			return next;
		});
	}, []);

	/**
	 * Set badge count directly
	 */
	const setBadgeCount = useCallback(
		async (count: number) => {
			await updateBadge(count);
		},
		[updateBadge]
	);

	/**
	 * Clear the badge
	 */
	const clearBadge = useCallback(async () => {
		await updateBadge(0);
	}, [updateBadge]);

	// Update badge when unread count changes
	useEffect(() => {
		updateBadge(unreadCount);
		onCountChangeRef.current?.(unreadCount);
	}, [unreadCount, updateBadge]);

	// Auto-clear badge when app becomes visible
	useEffect(() => {
		if (!autoClearOnVisible) return;

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				// User is looking at the app, mark all as read
				markAllRead();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
	}, [autoClearOnVisible, markAllRead]);

	return {
		unreadCount,
		unreadIds,
		isSupported,
		addUnread,
		markRead,
		markAllRead,
		setBadgeCount,
		clearBadge,
	};
}

export default useUnreadBadge;
