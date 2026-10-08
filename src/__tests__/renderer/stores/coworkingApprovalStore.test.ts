/**
 * Auto-decline timeout behavior for the coworking per-call approval queue.
 *
 * Contract under test (requestCoworkingApproval timeoutMs):
 *   - With a positive timeoutMs, an undecided request auto-declines exactly at
 *     the deadline: the promise resolves false AND the request is removed from
 *     the queue (its dialog is dismissed).
 *   - A user decision before the deadline cancels the pending timer, so nothing
 *     fires later and the promise resolves exactly once.
 *   - With no timeoutMs (or a non-positive one), no timer is armed and the
 *     request never auto-declines.
 *
 * browserOpNeedsConfirm policy coverage lives in
 * renderer/hooks/coworking/coworkingApproval.test.ts and is not duplicated here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	requestCoworkingApproval,
	useCoworkingApprovalStore,
} from '../../../renderer/stores/coworkingApprovalStore';

const INPUT = { agentId: 'a', sessionId: 's', title: 't', message: 'm' };

describe('requestCoworkingApproval auto-decline timeout', () => {
	beforeEach(() => {
		useCoworkingApprovalStore.setState({ queue: [] });
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('auto-declines and dismisses the dialog exactly at the deadline', async () => {
		const p = requestCoworkingApproval(INPUT, 1000);
		let settled: boolean | undefined;
		void p.then((v) => {
			settled = v;
		});

		// Armed but undecided: request is queued, promise still pending.
		expect(useCoworkingApprovalStore.getState().queue).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(1);

		// Just shy of the deadline: nothing has fired.
		vi.advanceTimersByTime(999);
		await Promise.resolve();
		expect(settled).toBeUndefined();
		expect(useCoworkingApprovalStore.getState().queue).toHaveLength(1);

		// Crossing 1000ms auto-declines and dismisses the dialog.
		vi.advanceTimersByTime(1);
		await expect(p).resolves.toBe(false);
		expect(settled).toBe(false);
		expect(useCoworkingApprovalStore.getState().queue).toHaveLength(0);
	});

	it('a decision before the deadline cancels the timer and resolves exactly once', async () => {
		const p = requestCoworkingApproval(INPUT, 1000);
		const resolutions: boolean[] = [];
		void p.then((v) => resolutions.push(v));

		expect(vi.getTimerCount()).toBe(1);

		const id = useCoworkingApprovalStore.getState().queue[0].id;
		useCoworkingApprovalStore.getState().settle(id, true);
		await expect(p).resolves.toBe(true);

		// The user's decision must have cleared the pending auto-decline timer.
		expect(vi.getTimerCount()).toBe(0);
		expect(useCoworkingApprovalStore.getState().queue).toHaveLength(0);

		// Advancing past the original deadline neither throws nor re-resolves.
		expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
		await Promise.resolve();
		expect(resolutions).toEqual([true]);
		expect(useCoworkingApprovalStore.getState().queue).toHaveLength(0);
	});

	it('never auto-declines when no timeoutMs is supplied', async () => {
		const p = requestCoworkingApproval(INPUT);
		let settled: boolean | undefined;
		void p.then((v) => {
			settled = v;
		});

		// No timer armed at all.
		expect(vi.getTimerCount()).toBe(0);

		vi.advanceTimersByTime(10 * 60 * 1000);
		await Promise.resolve();

		expect(settled).toBeUndefined();
		expect(useCoworkingApprovalStore.getState().queue).toHaveLength(1);
	});

	it('does not arm a timer for a non-positive timeoutMs', async () => {
		const p = requestCoworkingApproval(INPUT, 0);
		let settled: boolean | undefined;
		void p.then((v) => {
			settled = v;
		});

		expect(vi.getTimerCount()).toBe(0);

		vi.advanceTimersByTime(10 * 60 * 1000);
		await Promise.resolve();

		expect(settled).toBeUndefined();
		expect(useCoworkingApprovalStore.getState().queue).toHaveLength(1);
	});
});
