/**
 * @file pianola-relearn-scheduler.test.ts
 *
 * Unit tests for the re-learn cadence host: per-tick Encore gating, job firing,
 * rejection swallowing, and the interval lifecycle.
 */

import { describe, it, expect, vi } from 'vitest';
import { PianolaRelearnScheduler } from '../../../main/pianola/pianola-relearn-scheduler';

describe('PianolaRelearnScheduler.tick', () => {
	it('is a no-op when the feature is disabled', () => {
		const runJob = vi.fn(async () => {});
		const scheduler = new PianolaRelearnScheduler({ isEnabled: () => false, runJob });
		scheduler.tick();
		expect(runJob).not.toHaveBeenCalled();
	});

	it('fires the job when the feature is enabled', () => {
		const runJob = vi.fn(async () => {});
		const scheduler = new PianolaRelearnScheduler({ isEnabled: () => true, runJob });
		scheduler.tick();
		expect(runJob).toHaveBeenCalledTimes(1);
	});

	it('swallows a rejected job so the loop survives', async () => {
		const runJob = vi.fn(async () => {
			throw new Error('boom');
		});
		const scheduler = new PianolaRelearnScheduler({ isEnabled: () => true, runJob });
		expect(() => scheduler.tick()).not.toThrow();
		// Let the rejected microtask settle; the attached catch prevents an
		// unhandled rejection from escaping.
		await Promise.resolve();
		await Promise.resolve();
		expect(runJob).toHaveBeenCalledTimes(1);
	});

	it('serializes runs: a tick while a pass is in flight is skipped, then resumes', async () => {
		let resolveJob: () => void = () => {};
		const runJob = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveJob = resolve;
				})
		);
		const scheduler = new PianolaRelearnScheduler({ isEnabled: () => true, runJob });
		scheduler.tick();
		expect(runJob).toHaveBeenCalledTimes(1);
		// A second tick while the first job is still pending must not re-fire.
		scheduler.tick();
		expect(runJob).toHaveBeenCalledTimes(1);
		// Let the first job finish and the finally clear the in-flight flag.
		resolveJob();
		await new Promise((resolve) => setTimeout(resolve, 0));
		// A later tick now fires a fresh pass.
		scheduler.tick();
		expect(runJob).toHaveBeenCalledTimes(2);
	});
});

describe('PianolaRelearnScheduler lifecycle', () => {
	it('schedules ticks on the interval and stop() clears them', async () => {
		vi.useFakeTimers();
		try {
			const runJob = vi.fn(async () => {});
			const scheduler = new PianolaRelearnScheduler({
				isEnabled: () => true,
				runJob,
				intervalMs: 1000,
			});
			scheduler.start();
			expect(runJob).not.toHaveBeenCalled();
			// advanceTimersByTimeAsync drains the microtask queue between fires, so the
			// in-flight guard clears after each completed pass (modeling the real event
			// loop) and the next cadence tick fires as expected.
			await vi.advanceTimersByTimeAsync(1000);
			expect(runJob).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(2000);
			expect(runJob).toHaveBeenCalledTimes(3);
			scheduler.stop();
			await vi.advanceTimersByTimeAsync(5000);
			expect(runJob).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it('start() is idempotent', () => {
		vi.useFakeTimers();
		try {
			const runJob = vi.fn(async () => {});
			const scheduler = new PianolaRelearnScheduler({
				isEnabled: () => true,
				runJob,
				intervalMs: 1000,
			});
			scheduler.start();
			scheduler.start();
			vi.advanceTimersByTime(1000);
			expect(runJob).toHaveBeenCalledTimes(1);
			scheduler.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});
