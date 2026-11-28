/**
 * Tests for useComeHome: the window starts the come-home job once, after the agents load, only in
 * the lifecycle owner, and hands the report on.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	COME_HOME_START_DELAY_MS,
	showComeHomeNotice,
	useComeHome,
} from '../../../../renderer/hooks/federation/useComeHome';
import { useNotificationStore } from '../../../../renderer/stores/notificationStore';
import { captureException } from '../../../../renderer/utils/sentry';

vi.mock('../../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

const maestro = window.maestro as unknown as Record<string, unknown>;
const report = { startedAt: 1, finishedAt: 2, agents: [] };

describe('useComeHome', () => {
	let saved: unknown;
	let comeHome: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		saved = maestro.federation;
		comeHome = vi.fn(async () => report);
		maestro.federation = { comeHome };
	});

	afterEach(() => {
		maestro.federation = saved;
		vi.useRealTimers();
	});

	it('waits for the agents to load, then starts the job once and hands on the report', async () => {
		const onReport = vi.fn();
		const { rerender } = renderHook((props) => useComeHome(props), {
			initialProps: { enabled: true, sessionsLoaded: false, onReport },
		});
		await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS * 2);
		expect(comeHome).not.toHaveBeenCalled();

		rerender({ enabled: true, sessionsLoaded: true, onReport });
		await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS);
		expect(comeHome).toHaveBeenCalledTimes(1);
		expect(onReport).toHaveBeenCalledWith(report);

		rerender({ enabled: true, sessionsLoaded: true, onReport: vi.fn() });
		await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS * 2);
		expect(comeHome).toHaveBeenCalledTimes(1);
	});

	it('a job that fails goes to Sentry and is shown, never only logged (R9)', async () => {
		useNotificationStore.setState({ toasts: [] });
		const failure = new Error('the window did not answer');
		comeHome.mockRejectedValueOnce(failure);
		const onReport = vi.fn();
		renderHook(() => useComeHome({ enabled: true, sessionsLoaded: true, onReport }));
		await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS);
		expect(onReport).not.toHaveBeenCalled();
		expect(captureException).toHaveBeenCalledWith(failure, {
			tags: { area: 'federation-come-home' },
		});
		const toasts = useNotificationStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toMatchObject({ color: 'red', dismissible: true });
		expect(toasts[0].message).toContain('the window did not answer');
	});

	it('does nothing outside the lifecycle owner', async () => {
		renderHook(() => useComeHome({ enabled: false, sessionsLoaded: true }));
		await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS * 2);
		expect(comeHome).not.toHaveBeenCalled();
	});

	it('does nothing where there is no federation API (the browser build)', async () => {
		maestro.federation = undefined;
		renderHook(() => useComeHome({ enabled: true, sessionsLoaded: true }));
		await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS * 2);
		expect(comeHome).not.toHaveBeenCalled();
	});
});

describe('showComeHomeNotice', () => {
	beforeEach(() => {
		useNotificationStore.setState({ toasts: [] });
	});

	it('shows nothing when no agent was moved', () => {
		showComeHomeNotice(report);
		expect(useNotificationStore.getState().toasts).toHaveLength(0);
	});

	it('shows one dismissible notice naming every agent, and no button', () => {
		showComeHomeNotice({
			startedAt: 1,
			finishedAt: 2,
			agents: [
				{ id: 'a1', name: 'Docs', from: 'box:h1', result: 'online', notices: [] },
				{
					id: 'a2',
					name: 'Api',
					from: 'box:h2',
					result: 'offline',
					missing: { peer: 'box', hostAgentId: 'h2', movedAt: 1 },
					notices: [],
				},
			],
		});
		const toasts = useNotificationStore.getState().toasts;
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toMatchObject({
			color: 'yellow',
			title: '2 agents moved back from their hosts',
			dismissible: true,
		});
		expect(toasts[0].message).toMatch(/"Docs" is an SSH agent again/);
		expect(toasts[0].message).toMatch(/"Api" .*still on box, as agent h2/);
		expect(toasts[0].actionUrl).toBeUndefined();
	});
});
