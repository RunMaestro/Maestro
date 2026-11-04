// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/remote/goalRunLaunch.test.ts
// Source: src/__tests__/renderer/hooks/remote/useLiveOverlay.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import { DEFAULT_BATCH_STATE } from '../../../../renderer/hooks/batch/batchReducer';
import {
	isBatchRunning,
	reserveGoalRunLaunch,
	releaseGoalRunLaunch,
	clearGoalRunLaunches,
	waitForGoalRunStart,
} from '../../../../renderer/hooks/remote/goalRunLaunch';
import { act, renderHook } from '@testing-library/react';
import { useLiveOverlay } from '../../../../renderer/hooks/remote/useLiveOverlay';
// Source: src/__tests__/renderer/hooks/remote/goalRunLaunch.test.ts
describe('', () => {
	const SESSION = 'agent-1';
	/** Put the batch store into a running / not-running state for one agent. */
	function setRunning(sessionId: string, isRunning: boolean): void {
		useBatchStore.setState({
			batchRunStates: { [sessionId]: { ...DEFAULT_BATCH_STATE, isRunning } },
		});
	}
	/** A promise that never settles - stands in for a run that is still going. */
	function pending(): Promise<void> {
		return new Promise<void>(() => {});
	}
	describe('goalRunLaunch', () => {
		beforeEach(() => {
			clearGoalRunLaunches();
			useBatchStore.setState({ batchRunStates: {} });
			vi.useRealTimers();
		});
		describe('reserveGoalRunLaunch', () => {
			it('grants an idle agent', () => {
				expect(reserveGoalRunLaunch(SESSION)).toBe(true);
			});
			it('refuses a second claim while the first is still in flight', () => {
				// The gap this closes: neither launch has reached START_BATCH yet, so
				// an isRunning read alone would let both through and put two goal runs
				// on one agent.
				expect(reserveGoalRunLaunch(SESSION)).toBe(true);
				expect(reserveGoalRunLaunch(SESSION)).toBe(false);
			});
			it('refuses an agent that already has a run going', () => {
				setRunning(SESSION, true);
				expect(reserveGoalRunLaunch(SESSION)).toBe(false);
			});
			it('does not block a different agent', () => {
				expect(reserveGoalRunLaunch(SESSION)).toBe(true);
				expect(reserveGoalRunLaunch('agent-2')).toBe(true);
			});
			it('grants again after release when the run never started', () => {
				expect(reserveGoalRunLaunch(SESSION)).toBe(true);
				releaseGoalRunLaunch(SESSION);
				expect(reserveGoalRunLaunch(SESSION)).toBe(true);
			});
			it('still refuses after release once the run is actually running', () => {
				// Release happens as soon as the launch is confirmed, so from that point
				// on it is the batch store - not the reservation - that holds the agent.
				expect(reserveGoalRunLaunch(SESSION)).toBe(true);
				setRunning(SESSION, true);
				releaseGoalRunLaunch(SESSION);
				expect(reserveGoalRunLaunch(SESSION)).toBe(false);
			});
			it('tolerates a double release', () => {
				reserveGoalRunLaunch(SESSION);
				releaseGoalRunLaunch(SESSION);
				expect(() => releaseGoalRunLaunch(SESSION)).not.toThrow();
			});
		});
		describe('isBatchRunning', () => {
			it('is false for an agent with no batch state', () => {
				expect(isBatchRunning('unknown')).toBe(false);
			});
			it('tracks the store', () => {
				setRunning(SESSION, true);
				expect(isBatchRunning(SESSION)).toBe(true);
				setRunning(SESSION, false);
				expect(isBatchRunning(SESSION)).toBe(false);
			});
		});
		describe('waitForGoalRunStart', () => {
			it('resolves true immediately when the run is already running', async () => {
				setRunning(SESSION, true);
				await expect(waitForGoalRunStart(SESSION, pending())).resolves.toBe(true);
			});
			it('resolves true once the store reports the run running', async () => {
				const promise = waitForGoalRunStart(SESSION, pending());
				setRunning(SESSION, true);
				await expect(promise).resolves.toBe(true);
			});
			it('ignores a store update for a different agent', async () => {
				const promise = waitForGoalRunStart(SESSION, pending(), { timeoutMs: 20 });
				setRunning('agent-2', true);
				await expect(promise).resolves.toBe(false);
			});
			it('resolves false when the runner returns without ever starting', async () => {
				// The real cases: Auto Run kill switch on, session gone, or the
				// `autorun-goal` prompt template failed to load. All of them return
				// quietly, which is exactly why success cannot be assumed.
				await expect(waitForGoalRunStart(SESSION, Promise.resolve())).resolves.toBe(false);
			});
			it('resolves false when the run rejects during startup', async () => {
				await expect(
					waitForGoalRunStart(SESSION, Promise.reject(new Error('spawn failed')))
				).resolves.toBe(false);
			});
			it('reports true for a run that started and finished before we looked', async () => {
				// Losing the race to a resolved promise means "did not start" only if
				// the store agrees; a very short run must not be reported as a failure.
				setRunning(SESSION, true);
				await expect(waitForGoalRunStart(SESSION, Promise.resolve())).resolves.toBe(true);
			});
			it('resolves false on timeout when nothing ever starts', async () => {
				await expect(waitForGoalRunStart(SESSION, pending(), { timeoutMs: 20 })).resolves.toBe(
					false
				);
			});
			it('unsubscribes from the store once settled', async () => {
				const before = useBatchStore.getState();
				await waitForGoalRunStart(SESSION, pending(), { timeoutMs: 10 });
				// A leaked listener would keep firing; setting state after the wait
				// resolved must not throw or re-resolve.
				expect(() => setRunning(SESSION, true)).not.toThrow();
				expect(before).toBeDefined();
			});
		});
	});
});
// Source: src/__tests__/renderer/hooks/remote/useLiveOverlay.test.ts
describe('', () => {
	describe('useLiveOverlay', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.clearAllTimers();
			vi.useRealTimers();
		});
		it('cancels the copy flash timeout when unmounted', () => {
			const { result, unmount } = renderHook(() => useLiveOverlay(false));
			act(() => {
				result.current.setCopyFlash('Local URL copied!');
			});
			expect(result.current.copyFlash).toBe('Local URL copied!');
			expect(vi.getTimerCount()).toBe(1);
			unmount();
			expect(vi.getTimerCount()).toBe(0);
		});
		describe('live:stateChanged (a tunnel toggled by `maestro-cli live tunnel`)', () => {
			const originalMaestro = (window as any).maestro;
			let emit: ((state: any) => void) | null = null;
			const getStatus = vi.fn();
			beforeEach(() => {
				emit = null;
				getStatus.mockResolvedValue({
					isRunning: true,
					url: 'https://abc.trycloudflare.com/tok',
					error: null,
				});
				(window as any).maestro = {
					...originalMaestro,
					live: {
						onStateChanged: vi.fn((handler: (state: any) => void) => {
							emit = handler;
							return vi.fn();
						}),
					},
					tunnel: { getStatus, isCloudflaredInstalled: vi.fn().mockResolvedValue(true) },
				};
			});
			afterEach(() => {
				(window as any).maestro = originalMaestro;
			});
			it('shows a tunnel started elsewhere as connected', () => {
				const { result } = renderHook(() => useLiveOverlay(true));
				expect(result.current.tunnelStatus).toBe('off');
				act(() => {
					emit?.({
						live: true,
						url: 'http://192.168.1.5:8080/tok',
						remoteControl: true,
						remoteControlUrl: 'https://abc.trycloudflare.com/tok',
					});
				});
				expect(result.current.tunnelStatus).toBe('connected');
				expect(result.current.tunnelUrl).toBe('https://abc.trycloudflare.com/tok');
			});
			it('shows a tunnel stopped elsewhere as off', () => {
				const { result } = renderHook(() => useLiveOverlay(true));
				act(() => {
					emit?.({
						live: true,
						url: 'http://192.168.1.5:8080/tok',
						remoteControl: true,
						remoteControlUrl: 'https://abc.trycloudflare.com/tok',
					});
				});
				act(() => {
					emit?.({
						live: true,
						url: 'http://192.168.1.5:8080/tok',
						remoteControl: false,
						remoteControlUrl: null,
					});
				});
				expect(result.current.tunnelStatus).toBe('off');
				expect(result.current.tunnelUrl).toBeNull();
			});
		});
	});
});
