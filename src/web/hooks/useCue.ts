/**
 * useCue hook for Cue automation management in the web interface.
 *
 * Provides Cue subscription listing, toggling, and activity viewing
 * with real-time updates via WebSocket broadcasts.
 */

import { useState, useCallback, useEffect } from 'react';
import type { UseWebSocketReturn } from './useWebSocket';

/** Web-specific Cue subscription metadata (simplified from engine types) */
export interface CueSubscriptionInfo {
	id: string;
	name: string;
	eventType: string;
	pattern?: string;
	schedule?: string;
	sessionId: string;
	sessionName: string;
	enabled: boolean;
	lastTriggered?: number;
	triggerCount: number;
}

/** Web-specific Cue activity log entry (simplified from engine types) */
export interface CueActivityEntry {
	id: string;
	subscriptionId: string;
	subscriptionName: string;
	eventType: string;
	sessionId: string;
	timestamp: number;
	status: 'triggered' | 'running' | 'completed' | 'failed';
	result?: string;
	duration?: number;
}

/**
 * Return value from useCue hook.
 */
export interface UseCueReturn {
	/** All known Cue subscriptions */
	subscriptions: CueSubscriptionInfo[];
	/** Recent Cue activity entries (most recent first) */
	activity: CueActivityEntry[];
	/** Whether data is being loaded */
	isLoading: boolean;
	/** Load subscriptions from the server */
	loadSubscriptions: (sessionId?: string) => Promise<void>;
	/** Toggle a subscription's enabled state */
	toggleSubscription: (subscriptionId: string, enabled: boolean) => Promise<boolean>;
	/** Load activity entries from the server */
	loadActivity: (sessionId?: string, limit?: number) => Promise<void>;
	/** Handle incoming Cue activity broadcast */
	handleCueActivityEvent: (entry: CueActivityEntry) => void;
	/** Handle incoming Cue subscriptions changed broadcast */
	handleCueSubscriptionsChanged: (subscriptions: CueSubscriptionInfo[]) => void;
}

const MAX_ACTIVITY_ENTRIES = 100;

/**
 * Hook for managing Cue automation state and operations.
 *
 * @param sendRequest - WebSocket sendRequest function for request-response operations
 * @param send - WebSocket send function for fire-and-forget messages
 * @param isConnected - Whether the WebSocket is connected
 */
export function useCue(
	sendRequest: UseWebSocketReturn['sendRequest'],
	_send: UseWebSocketReturn['send'],
	isConnected: boolean
): UseCueReturn {
	const [subscriptions, setSubscriptions] = useState<CueSubscriptionInfo[]>([]);
	const [activity, setActivity] = useState<CueActivityEntry[]>([]);
	const [isLoading, setIsLoading] = useState(false);

	const loadSubscriptions = useCallback(
		async (sessionId?: string) => {
			setIsLoading(true);
			try {
				const response = await sendRequest<{ subscriptions?: CueSubscriptionInfo[] }>(
					'get_cue_subscriptions',
					sessionId ? { sessionId } : undefined
				);
				setSubscriptions(response.subscriptions ?? []);
			} catch {
				setSubscriptions([]);
			} finally {
				setIsLoading(false);
			}
		},
		[sendRequest]
	);

	const toggleSubscription = useCallback(
		async (subscriptionId: string, enabled: boolean): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('toggle_cue_subscription', {
					subscriptionId,
					enabled,
				});
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	const loadActivity = useCallback(
		async (sessionId?: string, limit?: number) => {
			setIsLoading(true);
			try {
				const response = await sendRequest<{ entries?: CueActivityEntry[] }>('get_cue_activity', {
					...(sessionId ? { sessionId } : {}),
					...(limit ? { limit } : {}),
				});
				setActivity(response.entries ?? []);
			} catch {
				setActivity([]);
			} finally {
				setIsLoading(false);
			}
		},
		[sendRequest]
	);

	const handleCueActivityEvent = useCallback((entry: CueActivityEntry) => {
		setActivity((prev) => {
			const updated = [entry, ...prev];
			return updated.length > MAX_ACTIVITY_ENTRIES
				? updated.slice(0, MAX_ACTIVITY_ENTRIES)
				: updated;
		});
	}, []);

	const handleCueSubscriptionsChanged = useCallback((subs: CueSubscriptionInfo[]) => {
		setSubscriptions(subs);
	}, []);

	// Auto-load on mount when connected
	useEffect(() => {
		if (isConnected) {
			loadSubscriptions();
			loadActivity();
		}
	}, [isConnected, loadSubscriptions, loadActivity]);

	return {
		subscriptions,
		activity,
		isLoading,
		loadSubscriptions,
		toggleSubscription,
		loadActivity,
		handleCueActivityEvent,
		handleCueSubscriptionsChanged,
	};
}

export default useCue;
