import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCue, type CueActivityEntry, type CueSubscriptionInfo } from '../../../web/hooks/useCue';

const subscription: CueSubscriptionInfo = {
	id: 'sub-1',
	name: 'Daily summary',
	eventType: 'schedule',
	sessionId: 'session-1',
	sessionName: 'Agent',
	enabled: true,
	triggerCount: 2,
};

const activityEntry: CueActivityEntry = {
	id: 'activity-1',
	subscriptionId: 'sub-1',
	subscriptionName: 'Daily summary',
	eventType: 'schedule',
	sessionId: 'session-1',
	timestamp: 100,
	status: 'completed',
};

describe('useCue', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('loads subscriptions and activity when connected', async () => {
		const sendRequest = vi.fn(async (type: string) => {
			if (type === 'get_cue_subscriptions') return { subscriptions: [subscription] };
			if (type === 'get_cue_activity') return { entries: [activityEntry] };
			return {};
		});

		const { result } = renderHook(() => useCue(sendRequest as any, vi.fn(), true));

		await waitFor(() => expect(result.current.subscriptions).toEqual([subscription]));
		await waitFor(() => expect(result.current.activity).toEqual([activityEntry]));
		expect(result.current.isLoading).toBe(false);
		expect(sendRequest).toHaveBeenCalledWith('get_cue_subscriptions', undefined);
		expect(sendRequest).toHaveBeenCalledWith('get_cue_activity', {});
	});

	it('loads scoped data, toggles subscriptions, and clears state on failures', async () => {
		const sendRequest = vi.fn(async (type: string, payload?: unknown) => {
			if (type === 'get_cue_subscriptions') {
				return payload ? { subscriptions: [subscription] } : { subscriptions: [] };
			}
			if (type === 'get_cue_activity') return { entries: [activityEntry] };
			if (type === 'toggle_cue_subscription') return { success: true };
			return {};
		});
		const { result } = renderHook(() => useCue(sendRequest as any, vi.fn(), false));

		await act(async () => {
			await result.current.loadSubscriptions('session-1');
			await result.current.loadActivity('session-1', 5);
		});
		expect(result.current.subscriptions).toEqual([subscription]);
		expect(result.current.activity).toEqual([activityEntry]);
		expect(sendRequest).toHaveBeenCalledWith('get_cue_subscriptions', { sessionId: 'session-1' });
		expect(sendRequest).toHaveBeenCalledWith('get_cue_activity', {
			sessionId: 'session-1',
			limit: 5,
		});

		await act(async () => {
			await expect(result.current.toggleSubscription('sub-1', false)).resolves.toBe(true);
		});
		expect(sendRequest).toHaveBeenCalledWith('toggle_cue_subscription', {
			subscriptionId: 'sub-1',
			enabled: false,
		});

		sendRequest.mockRejectedValueOnce(new Error('offline'));
		await act(async () => {
			await result.current.loadSubscriptions();
		});
		expect(result.current.subscriptions).toEqual([]);

		sendRequest.mockRejectedValueOnce(new Error('offline'));
		await act(async () => {
			await result.current.loadActivity();
		});
		expect(result.current.activity).toEqual([]);

		sendRequest.mockRejectedValueOnce(new Error('offline'));
		await act(async () => {
			await expect(result.current.toggleSubscription('sub-1', true)).resolves.toBe(false);
		});
	});

	it('applies broadcast updates and caps activity history', () => {
		const { result } = renderHook(() => useCue(vi.fn() as any, vi.fn(), false));

		act(() => {
			result.current.handleCueSubscriptionsChanged([{ ...subscription, enabled: false }]);
		});
		expect(result.current.subscriptions[0]?.enabled).toBe(false);

		act(() => {
			for (let i = 0; i < 101; i += 1) {
				result.current.handleCueActivityEvent({
					...activityEntry,
					id: `activity-${i}`,
					timestamp: i,
				});
			}
		});

		expect(result.current.activity).toHaveLength(100);
		expect(result.current.activity[0]?.id).toBe('activity-100');
		expect(result.current.activity.at(-1)?.id).toBe('activity-1');
	});
});
