import { describe, it, expect } from 'vitest';
import {
	createCueFailureStreakTracker,
	failureStreakPayload,
	failureStreakToast,
	type CueFailureStreakRun,
} from '../../../main/cue/cue-failure-streak';
import type { CueRunStatus } from '../../../main/cue/cue-types';

function run(
	status: CueRunStatus,
	overrides: Partial<CueFailureStreakRun> = {}
): CueFailureStreakRun {
	return {
		sessionId: 'agent-1',
		sessionName: 'Pedsidian',
		subscriptionName: 'gv-sms-poll',
		status,
		stderr: status === 'completed' ? '' : 'spawn failed',
		endedAt: '2026-11-17T03:00:00.000Z',
		...overrides,
	};
}

describe('createCueFailureStreakTracker', () => {
	it('counts consecutive failures and alerts exactly once at the threshold', () => {
		const tracker = createCueFailureStreakTracker();
		expect(tracker.record(run('failed'), 3)).toBeNull();
		expect(tracker.record(run('timeout'), 3)).toBeNull();

		const alert = tracker.record(run('failed'), 3);
		expect(alert).toMatchObject({ kind: 'failing', escalated: false });
		expect(alert!.streak).toMatchObject({
			consecutiveFailures: 3,
			failing: true,
			alertThreshold: 3,
			lastStatus: 'failed',
			lastError: 'spawn failed',
		});

		// No second alert until the escalation count.
		for (let i = 4; i < 30; i++) expect(tracker.record(run('failed'), 3)).toBeNull();
		expect(tracker.list()[0].consecutiveFailures).toBe(29);
	});

	it('escalates once at ten times the threshold, then never again', () => {
		const tracker = createCueFailureStreakTracker();
		const transitions = [];
		for (let i = 0; i < 100; i++) transitions.push(tracker.record(run('failed'), 3));
		const alerts = transitions
			.map((t, i) =>
				t ? { at: i + 1, kind: t.kind, escalated: 'escalated' in t && t.escalated } : null
			)
			.filter(Boolean);
		expect(alerts).toEqual([
			{ at: 3, kind: 'failing', escalated: false },
			{ at: 30, kind: 'failing', escalated: true },
		]);
	});

	it('resets on success and reports recovery only for a streak that alerted', () => {
		const tracker = createCueFailureStreakTracker();
		tracker.record(run('failed'), 3);
		expect(tracker.record(run('completed'), 3)).toBeNull();
		expect(tracker.list()).toEqual([]);

		for (let i = 0; i < 4; i++) tracker.record(run('failed'), 3);
		const recovered = tracker.record(run('completed'), 3);
		expect(recovered).toMatchObject({ kind: 'recovered' });
		expect(recovered!.streak.consecutiveFailures).toBe(4);
		expect(tracker.list()).toEqual([]);

		// A new streak alerts again after recovery.
		tracker.record(run('failed'), 3);
		tracker.record(run('failed'), 3);
		expect(tracker.record(run('failed'), 3)).toMatchObject({ kind: 'failing', escalated: false });
	});

	it('ignores stopped runs: they neither extend nor end a streak', () => {
		const tracker = createCueFailureStreakTracker();
		tracker.record(run('failed'), 3);
		tracker.record(run('failed'), 3);
		expect(tracker.record(run('stopped'), 3)).toBeNull();
		expect(tracker.list()[0].consecutiveFailures).toBe(2);
		expect(tracker.record(run('failed'), 3)).toMatchObject({ kind: 'failing' });
	});

	it('keys streaks per agent and subscription, folding the :output phase into its run', () => {
		const tracker = createCueFailureStreakTracker();
		tracker.record(run('failed'), 3);
		tracker.record(run('failed', { subscriptionName: 'gv-sms-poll:output' }), 3);
		tracker.record(run('failed', { sessionId: 'agent-2', sessionName: 'Other' }), 3);
		tracker.record(run('failed', { subscriptionName: 'other-sub' }), 3);

		const byKey = Object.fromEntries(
			tracker.list().map((s) => [`${s.sessionId}/${s.subscriptionName}`, s.consecutiveFailures])
		);
		expect(byKey).toEqual({
			'agent-1/gv-sms-poll': 2,
			'agent-2/gv-sms-poll': 1,
			'agent-1/other-sub': 1,
		});
		expect(tracker.list('agent-2')).toHaveLength(1);
	});

	it('never marks a streak failing or alerts when the threshold is 0', () => {
		const tracker = createCueFailureStreakTracker();
		for (let i = 0; i < 40; i++) expect(tracker.record(run('failed'), 0)).toBeNull();
		expect(tracker.list()[0]).toMatchObject({ consecutiveFailures: 40, failing: false });
	});

	it('keeps first and last failure times, and collapses and caps the error text', () => {
		const tracker = createCueFailureStreakTracker();
		tracker.record(run('failed', { endedAt: '2026-11-17T01:00:00.000Z' }), 3);
		tracker.record(
			run('timeout', {
				endedAt: '2026-11-17T02:00:00.000Z',
				stderr: `line one\n\n  line two ${'x '.repeat(400)}`,
			}),
			3
		);
		const [streak] = tracker.list();
		expect(streak.firstFailedAt).toBe('2026-11-17T01:00:00.000Z');
		expect(streak.lastFailedAt).toBe('2026-11-17T02:00:00.000Z');
		expect(streak.lastStatus).toBe('timeout');
		expect(streak.lastError!.startsWith('line one line two')).toBe(true);
		expect(streak.lastError!.length).toBeLessThanOrEqual(300);
	});

	it('falls back to now for a run with an empty end time (rehydrated rows)', () => {
		const tracker = createCueFailureStreakTracker();
		tracker.record(run('failed', { endedAt: '' }), 3);
		expect(Number.isNaN(Date.parse(tracker.list()[0].firstFailedAt))).toBe(false);
	});

	it('seed rebuilds streaks silently and does not re-announce levels already reached', () => {
		const tracker = createCueFailureStreakTracker();
		tracker.seed(
			[
				...Array.from({ length: 5 }, () => run('failed')),
				run('completed', { subscriptionName: 'healthy' }),
			],
			() => 3
		);
		expect(tracker.list()).toHaveLength(1);
		expect(tracker.list()[0]).toMatchObject({ consecutiveFailures: 5, failing: true });

		// Threshold alert was already "sent" before the restart: next failure is quiet.
		expect(tracker.record(run('failed'), 3)).toBeNull();
		// Recovery is still announced, because the streak had alerted.
		expect(tracker.record(run('completed'), 3)).toMatchObject({ kind: 'recovered' });
	});

	it('seed replaces earlier state, and clearSession drops one agent only', () => {
		const tracker = createCueFailureStreakTracker();
		tracker.record(run('failed', { sessionId: 'stale' }), 3);
		tracker.seed([run('failed'), run('failed', { sessionId: 'agent-2' })], () => 3);
		expect(
			tracker
				.list()
				.map((s) => s.sessionId)
				.sort()
		).toEqual(['agent-1', 'agent-2']);

		tracker.clearSession('agent-1');
		expect(tracker.list().map((s) => s.sessionId)).toEqual(['agent-2']);
		tracker.clear();
		expect(tracker.list()).toEqual([]);
	});

	it('returns copies, so callers cannot mutate tracker state', () => {
		const tracker = createCueFailureStreakTracker();
		tracker.record(run('failed'), 3);
		tracker.list()[0].consecutiveFailures = 99;
		expect(tracker.list()[0].consecutiveFailures).toBe(1);
	});
});

describe('failureStreakPayload / failureStreakToast', () => {
	function failingTransition(escalated: boolean) {
		const tracker = createCueFailureStreakTracker();
		const count = escalated ? 30 : 3;
		let last = null;
		for (let i = 0; i < count; i++) last = tracker.record(run('failed'), 3) ?? last;
		return last!;
	}

	it('builds a subscriptionFailing payload naming the subscription and agent', () => {
		expect(failureStreakPayload(failingTransition(false))).toEqual({
			type: 'subscriptionFailing',
			sessionId: 'agent-1',
			sessionName: 'Pedsidian',
			subscriptionName: 'gv-sms-poll',
			consecutiveFailures: 3,
			threshold: 3,
			escalated: false,
			lastError: 'spawn failed',
		});
	});

	it('turns a failing payload into a sticky red toast that names subscription and agent', () => {
		const toast = failureStreakToast(failureStreakPayload(failingTransition(false)));
		expect(toast).toMatchObject({ agentId: 'agent-1', color: 'red', sticky: true });
		expect(toast!.title).toBe('Cue subscription failing: gv-sms-poll');
		expect(toast!.message).toContain('"gv-sms-poll" on Pedsidian failed 3 runs in a row.');
		expect(toast!.message).toContain('Last error: spawn failed');
	});

	it('titles the escalation differently', () => {
		const toast = failureStreakToast(failureStreakPayload(failingTransition(true)));
		expect(toast!.title).toBe('Cue subscription still failing: gv-sms-poll');
		expect(toast!.message).toContain('failed 30 runs in a row');
	});

	it('turns recovery into a green, self-dismissing toast', () => {
		const tracker = createCueFailureStreakTracker();
		for (let i = 0; i < 3; i++) tracker.record(run('failed'), 3);
		const payload = failureStreakPayload(tracker.record(run('completed'), 3)!);
		expect(payload).toEqual({
			type: 'subscriptionRecovered',
			sessionId: 'agent-1',
			sessionName: 'Pedsidian',
			subscriptionName: 'gv-sms-poll',
			consecutiveFailures: 3,
		});
		const toast = failureStreakToast(payload);
		expect(toast).toMatchObject({ color: 'green', agentId: 'agent-1' });
		expect(toast!.sticky).toBeUndefined();
		expect(toast!.message).toContain('succeeded after 3 failed runs');
	});

	it('returns null for any other payload', () => {
		expect(failureStreakToast(undefined)).toBeNull();
		expect(failureStreakToast({ type: 'engineStarted' })).toBeNull();
	});
});
