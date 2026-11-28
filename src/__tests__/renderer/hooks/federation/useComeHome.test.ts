/**
 * Tests for useComeHome: the window starts the come-home job after the agents load, and again when
 * hosting turns off, only in the lifecycle owner, and hands the report on.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	COME_HOME_START_DELAY_MS,
	showComeHomeNotice,
	useComeHome,
} from '../../../../renderer/hooks/federation/useComeHome';
import { useNotificationStore } from '../../../../renderer/stores/notificationStore';
import { useFederationAutoStore } from '../../../../renderer/stores/federationAutoStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { COME_HOME_RETRY_INTERVAL_MS } from '../../../../shared/federationComeHome';
import { captureException } from '../../../../renderer/utils/sentry';

vi.mock('../../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

const maestro = window.maestro as unknown as Record<string, unknown>;
const report = { startedAt: 1, finishedAt: 2, agents: [] };

describe('useComeHome', () => {
	let saved: unknown;
	let comeHome: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		useFederationAutoStore.getState().setComeHomeReport(null);
		saved = maestro.federation;
		comeHome = vi.fn(async () => report);
		maestro.federation = { comeHome };
	});

	afterEach(() => {
		maestro.federation = saved;
		useSettingsStore.setState({ federationHostedAgents: false });
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

	describe('the hold never lasts forever (R3)', () => {
		const stuck = {
			startedAt: 1,
			finishedAt: 2,
			agents: [
				{
					id: 'a1',
					name: 'Docs',
					from: 'box:h1',
					result: 'failed' as const,
					reason: 'This machine could not restore it: timed out.',
					notices: [],
				},
			],
		};
		const home = {
			startedAt: 3,
			finishedAt: 4,
			agents: [{ ...stuck.agents[0], result: 'online' as const, reason: undefined }],
		};

		it('runs again every 5 minutes while an agent is still moved, and stops once it is home', async () => {
			comeHome
				.mockResolvedValueOnce(stuck)
				.mockResolvedValueOnce(stuck)
				.mockResolvedValueOnce(home);
			const onReport = vi.fn();
			renderHook(() => useComeHome({ enabled: true, sessionsLoaded: true, onReport }));
			await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS);
			expect(comeHome).toHaveBeenCalledTimes(1);
			// The queued cards read why from the store.
			expect(useFederationAutoStore.getState().comeHomeReport).toBe(stuck);

			await vi.advanceTimersByTimeAsync(COME_HOME_RETRY_INTERVAL_MS);
			expect(comeHome).toHaveBeenCalledTimes(2);
			// A retry that changed nothing is not told again.
			expect(onReport).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(COME_HOME_RETRY_INTERVAL_MS);
			expect(comeHome).toHaveBeenCalledTimes(3);
			expect(onReport).toHaveBeenLastCalledWith(home);
			expect(useFederationAutoStore.getState().comeHomeReport).toBe(home);

			// Every agent is home: no timer is left (I6).
			await vi.advanceTimersByTimeAsync(COME_HOME_RETRY_INTERVAL_MS * 3);
			expect(comeHome).toHaveBeenCalledTimes(3);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('a job that fails is shown once and tried again', async () => {
			useNotificationStore.setState({ toasts: [] });
			comeHome
				.mockRejectedValueOnce(new Error('no window'))
				.mockRejectedValueOnce(new Error('no window'))
				.mockResolvedValueOnce(report);
			renderHook(() => useComeHome({ enabled: true, sessionsLoaded: true }));
			await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS);
			await vi.advanceTimersByTimeAsync(COME_HOME_RETRY_INTERVAL_MS * 2);
			expect(comeHome).toHaveBeenCalledTimes(3);
			expect(useNotificationStore.getState().toasts).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('the retry ends with the window', async () => {
			comeHome.mockResolvedValue(stuck);
			const { unmount } = renderHook(() => useComeHome({ enabled: true, sessionsLoaded: true }));
			await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS);
			unmount();
			await vi.advanceTimersByTimeAsync(COME_HOME_RETRY_INTERVAL_MS * 2);
			expect(comeHome).toHaveBeenCalledTimes(1);
		});
	});

	describe('hosting turned off later, and an owner that goes away (#2195)', () => {
		const stuck = {
			startedAt: 1,
			finishedAt: 2,
			agents: [
				{
					id: 'a1',
					name: 'Docs',
					from: 'box:h1',
					result: 'failed' as const,
					reason: 'timed out',
					notices: [],
				},
			],
		};

		it('runs nothing while hosting is on, and runs once it is turned off', async () => {
			useSettingsStore.setState({ federationHostedAgents: true });
			renderHook(() => useComeHome({ enabled: true, sessionsLoaded: true }));
			await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS * 2);
			expect(comeHome).not.toHaveBeenCalled();

			useSettingsStore.setState({ federationHostedAgents: false });
			await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS);
			expect(comeHome).toHaveBeenCalledTimes(1);
		});

		it('turning hosting on stops the retries', async () => {
			comeHome.mockResolvedValue(stuck);
			renderHook(() => useComeHome({ enabled: true, sessionsLoaded: true }));
			await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS);
			expect(comeHome).toHaveBeenCalledTimes(1);
			useSettingsStore.setState({ federationHostedAgents: true });
			await vi.advanceTimersByTimeAsync(COME_HOME_RETRY_INTERVAL_MS * 2);
			expect(comeHome).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('an answer that arrives after the window unmounted announces nothing and schedules nothing', async () => {
			let answer: (value: typeof stuck) => void = () => {};
			comeHome.mockImplementationOnce(
				() => new Promise<typeof stuck>((resolve) => (answer = resolve))
			);
			const onReport = vi.fn();
			const { unmount } = renderHook(() =>
				useComeHome({ enabled: true, sessionsLoaded: true, onReport })
			);
			await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS);
			unmount();
			answer(stuck);
			await vi.advanceTimersByTimeAsync(COME_HOME_RETRY_INTERVAL_MS * 2);
			expect(onReport).not.toHaveBeenCalled();
			expect(comeHome).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('a failure that arrives after the window lost the lifecycle is not shown and not retried', async () => {
			useNotificationStore.setState({ toasts: [] });
			let fail: (error: Error) => void = () => {};
			comeHome.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
			const { rerender } = renderHook((props) => useComeHome(props), {
				initialProps: { enabled: true, sessionsLoaded: true },
			});
			await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS);
			rerender({ enabled: false, sessionsLoaded: true });
			fail(new Error('no window'));
			await vi.advanceTimersByTimeAsync(COME_HOME_RETRY_INTERVAL_MS * 2);
			expect(useNotificationStore.getState().toasts).toHaveLength(0);
			expect(comeHome).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe('a window that does not run the job still knows why messages wait (#2195)', () => {
		const older = { startedAt: 1, finishedAt: 2, agents: [] };
		const newer = { startedAt: 3, finishedAt: 4, agents: [] };

		it("keeps main's pushed report, and reads the last one when it opens", async () => {
			let push: (report: typeof newer) => void = () => {};
			const unsubscribe = vi.fn();
			maestro.federation = {
				comeHome,
				lastComeHomeReport: vi.fn(async () => older),
				onComeHomeReport: vi.fn((handler: typeof push) => {
					push = handler;
					return unsubscribe;
				}),
			};
			const { unmount } = renderHook(() => useComeHome({ enabled: false, sessionsLoaded: true }));
			await vi.advanceTimersByTimeAsync(0);
			expect(useFederationAutoStore.getState().comeHomeReport).toBe(older);
			push(newer);
			expect(useFederationAutoStore.getState().comeHomeReport).toBe(newer);
			// Not the owner: it never runs the job itself.
			await vi.advanceTimersByTimeAsync(COME_HOME_START_DELAY_MS * 2);
			expect(comeHome).not.toHaveBeenCalled();
			unmount();
			expect(unsubscribe).toHaveBeenCalled();
		});

		it('a read that answers after a newer push does not replace it', async () => {
			let answer: (report: typeof older) => void = () => {};
			let push: (report: typeof newer) => void = () => {};
			maestro.federation = {
				comeHome,
				lastComeHomeReport: vi.fn(() => new Promise((resolve) => (answer = resolve))),
				onComeHomeReport: vi.fn((handler: typeof push) => {
					push = handler;
					return () => {};
				}),
			};
			renderHook(() => useComeHome({ enabled: false, sessionsLoaded: true }));
			push(newer);
			answer(older);
			await vi.advanceTimersByTimeAsync(0);
			expect(useFederationAutoStore.getState().comeHomeReport).toBe(newer);
		});
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
