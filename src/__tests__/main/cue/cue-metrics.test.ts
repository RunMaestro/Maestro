import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCueMetrics, type CueMetricsCollector } from '../../../main/cue/cue-metrics';

describe('cue-metrics', () => {
	let metrics: CueMetricsCollector;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
		metrics = createCueMetrics();
	});

	afterEach(() => {
		// Restore real timers so other suites aren't polluted.
		vi.useRealTimers();
	});

	describe('snapshot', () => {
		it('returns all counters zeroed on construction', () => {
			const snap = metrics.snapshot();
			expect(snap.runsStarted).toBe(0);
			expect(snap.runsCompleted).toBe(0);
			expect(snap.runsFailed).toBe(0);
			expect(snap.runsTimedOut).toBe(0);
			expect(snap.runsStopped).toBe(0);
			expect(snap.eventsDropped).toBe(0);
			expect(snap.queueRestored).toBe(0);
			expect(snap.fanInTimeouts).toBe(0);
			expect(snap.fanInCompletions).toBe(0);
			expect(snap.githubPollErrors).toBe(0);
			expect(snap.rateLimitBackoffs).toBe(0);
			expect(snap.configReloads).toBe(0);
			expect(snap.pathTraversalsBlocked).toBe(0);
			expect(snap.heartbeatFailures).toBe(0);
		});

		it('records startedAt as construction time', () => {
			expect(metrics.snapshot().startedAt).toBe(new Date('2026-04-21T10:00:00Z').getTime());
		});

		it('returns a fresh object each call (no shared reference)', () => {
			const a = metrics.snapshot();
			const b = metrics.snapshot();
			expect(a).not.toBe(b);
			a.runsStarted = 999;
			expect(metrics.snapshot().runsStarted).toBe(0);
		});
	});

	describe('increment', () => {
		it('bumps the targeted key by 1 by default', () => {
			metrics.increment('runsStarted');
			expect(metrics.snapshot().runsStarted).toBe(1);
		});

		it('bumps the targeted key by an explicit amount', () => {
			metrics.increment('eventsDropped', 5);
			expect(metrics.snapshot().eventsDropped).toBe(5);
		});

		it('accumulates across multiple calls', () => {
			metrics.increment('runsCompleted');
			metrics.increment('runsCompleted');
			metrics.increment('runsCompleted', 3);
			expect(metrics.snapshot().runsCompleted).toBe(5);
		});

		it('independent keys do not cross-contaminate', () => {
			metrics.increment('runsStarted', 2);
			metrics.increment('runsFailed', 7);
			const snap = metrics.snapshot();
			expect(snap.runsStarted).toBe(2);
			expect(snap.runsFailed).toBe(7);
			expect(snap.runsCompleted).toBe(0);
		});

		it('accepts zero and negative increments (decrement semantics)', () => {
			metrics.increment('runsStarted', 5);
			metrics.increment('runsStarted', -2);
			metrics.increment('runsStarted', 0);
			expect(metrics.snapshot().runsStarted).toBe(3);
		});
	});

	describe('reset', () => {
		it('returns all counters to zero', () => {
			metrics.increment('runsStarted', 10);
			metrics.increment('eventsDropped', 5);
			metrics.reset();
			const snap = metrics.snapshot();
			expect(snap.runsStarted).toBe(0);
			expect(snap.eventsDropped).toBe(0);
		});

		it('updates startedAt to the reset time', () => {
			vi.setSystemTime(new Date('2026-04-21T11:00:00Z'));
			metrics.reset();
			expect(metrics.snapshot().startedAt).toBe(new Date('2026-04-21T11:00:00Z').getTime());
		});

		it('allows fresh increments after reset', () => {
			metrics.increment('runsStarted', 10);
			metrics.reset();
			metrics.increment('runsStarted');
			expect(metrics.snapshot().runsStarted).toBe(1);
		});
	});
});
