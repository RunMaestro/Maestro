/**
 * @file signals.test.ts
 * @description Behavioral tests for the F5 AgentRunSignals producers. Deps are
 * injected in-memory fakes (a Map<string, AgentRun> + an events array). The
 * anti-signal guards are the important half of the contract:
 *   - markWaiting: running -> waiting ONLY; a NO-OP on any other status (ISC-5.7).
 *   - markWorking: waiting -> running ONLY.
 *   - markNeedsReview: -> needs_review ONLY when the run has an open finding;
 *     a clean run is a no-op (ISC-5.8).
 *   - markFixing: -> fixing ONLY when a dispatch arg is passed; without it the
 *     producer writes nothing (ISC-5.9).
 *   - every successful transition appends a status_change event.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	AgentRunSignals,
	type AgentRunSignalDeps,
	type FixDispatch,
} from '../../../main/agent-run/signals';
import type { AgentRun, AgentRunEvent, AgentRunReviewFinding } from '../../../shared/agent-run';

const TERMINAL: Record<AgentRun['status'], boolean> = {
	queued: false,
	running: false,
	waiting: false,
	needs_review: false,
	fixing: false,
	completed: true,
	failed: true,
	cancelled: true,
	merged: true,
	discarded: true,
};

interface FakeStore {
	runs: Map<string, AgentRun>;
	events: AgentRunEvent[];
	clock: { t: number };
	deps: AgentRunSignalDeps;
	seed: (run: AgentRun) => void;
}

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
	id: 'run-1',
	createdAt: 100,
	updatedAt: 100,
	provider: 'claude-code',
	status: 'running',
	sessionId: 'sess-1',
	artifacts: [],
	touchedFiles: [],
	checks: [],
	reviews: [],
	...overrides,
});

const openFinding = (
	severity: AgentRunReviewFinding['severity'] = 'high'
): AgentRunReviewFinding => ({
	severity,
	category: 'security',
	message: 'issue',
	status: 'open',
});

function makeStore(extra: Partial<AgentRunSignalDeps> = {}): FakeStore {
	const runs = new Map<string, AgentRun>();
	const events: AgentRunEvent[] = [];
	const clock = { t: 7000 };
	const deps: AgentRunSignalDeps = {
		getAgentRun: (id) => runs.get(id),
		findActiveRunBySession: (sessionId) => {
			for (const r of runs.values()) {
				if (r.sessionId === sessionId && !TERMINAL[r.status]) return r;
			}
			return undefined;
		},
		upsertAgentRun: (r) => {
			runs.set(r.id, r);
			return r;
		},
		appendAgentRunEvent: (event) => {
			events.push(event);
			return event;
		},
		now: () => clock.t,
		log: vi.fn(),
		...extra,
	};
	return {
		runs,
		events,
		clock,
		deps,
		seed: (r) => {
			runs.set(r.id, r);
		},
	};
}

describe('AgentRunSignals.markWaiting (ISC-5.7)', () => {
	let store: FakeStore;
	let signals: AgentRunSignals;

	beforeEach(() => {
		store = makeStore();
		signals = new AgentRunSignals(store.deps);
	});

	it('flips a running run to waiting and appends a status_change event', () => {
		store.seed(run({ id: 'r', status: 'running', sessionId: 's' }));
		store.clock.t = 7100;
		const updated = signals.markWaiting('s');

		expect(updated?.status).toBe('waiting');
		expect(updated?.updatedAt).toBe(7100);
		expect(store.runs.get('r')?.status).toBe('waiting');

		const evt = store.events.at(-1);
		expect(evt).toMatchObject({
			runId: 'r',
			type: 'status_change',
			status: 'waiting',
			message: 'agent awaiting user input',
		});
	});

	// The strong teeth case: queued -> waiting IS a legal lifecycle edge, so only
	// the status guard (run.status !== 'running') stops it. Drop the guard and
	// this run would flip.
	it('is a no-op on a queued run (legal edge, blocked by the running-only guard)', () => {
		store.seed(run({ id: 'q', status: 'queued', sessionId: 'sq' }));
		const updated = signals.markWaiting('sq');

		expect(updated).toBeUndefined();
		expect(store.runs.get('q')?.status).toBe('queued');
		expect(store.events).toHaveLength(0);
	});

	it('is a no-op when the session has no active run (e.g. already completed)', () => {
		store.seed(run({ id: 'done', status: 'completed', sessionId: 'sc' }));
		const updated = signals.markWaiting('sc');

		expect(updated).toBeUndefined();
		expect(store.runs.get('done')?.status).toBe('completed');
		expect(store.events).toHaveLength(0);
	});

	it('is a no-op when a completed run leaks through as the active run', () => {
		// Directly inject a completed run as "active" to prove the guard, not just
		// the store filter, refuses to flip a settled run into a false waiting.
		const leaky = makeStore({
			findActiveRunBySession: () => run({ id: 'leak', status: 'completed', sessionId: 'x' }),
		});
		const svc = new AgentRunSignals(leaky.deps);
		expect(svc.markWaiting('x')).toBeUndefined();
		expect(leaky.events).toHaveLength(0);
	});
});

describe('AgentRunSignals.markWorking', () => {
	let store: FakeStore;
	let signals: AgentRunSignals;

	beforeEach(() => {
		store = makeStore();
		signals = new AgentRunSignals(store.deps);
	});

	it('flips a waiting run to running and appends a status_change event', () => {
		store.seed(run({ id: 'r', status: 'waiting', sessionId: 's' }));
		store.clock.t = 7200;
		const updated = signals.markWorking('s');

		expect(updated?.status).toBe('running');
		expect(store.runs.get('r')?.status).toBe('running');
		expect(store.events.at(-1)).toMatchObject({
			status: 'running',
			type: 'status_change',
			message: 'agent resumed after input',
		});
	});

	// running -> running is a legal no-op transition; only the waiting-only guard
	// stops a spurious write + event here.
	it('is a no-op on an already-running run (no spurious event)', () => {
		store.seed(run({ id: 'r', status: 'running', sessionId: 's' }));
		const updated = signals.markWorking('s');

		expect(updated).toBeUndefined();
		expect(store.events).toHaveLength(0);
	});

	it('is a no-op on a queued run', () => {
		store.seed(run({ id: 'q', status: 'queued', sessionId: 'sq' }));
		expect(signals.markWorking('sq')).toBeUndefined();
		expect(store.events).toHaveLength(0);
	});
});

describe('AgentRunSignals.markNeedsReview (ISC-5.8)', () => {
	let store: FakeStore;
	let signals: AgentRunSignals;

	beforeEach(() => {
		store = makeStore();
		signals = new AgentRunSignals(store.deps);
	});

	it('flips a running run with an open finding to needs_review with an event', () => {
		store.seed(run({ id: 'r', status: 'running', reviews: [openFinding('high')] }));
		store.clock.t = 7300;
		const updated = signals.markNeedsReview('r');

		expect(updated?.status).toBe('needs_review');
		expect(store.runs.get('r')?.status).toBe('needs_review');
		expect(store.events.at(-1)).toMatchObject({
			status: 'needs_review',
			type: 'status_change',
			message: 'review found open findings',
		});
	});

	it('flips even on a low-severity open finding (any open finding qualifies)', () => {
		store.seed(run({ id: 'r', status: 'running', reviews: [openFinding('low')] }));
		expect(signals.markNeedsReview('r')?.status).toBe('needs_review');
	});

	// Teeth: running -> needs_review is a legal edge, so only the open-finding
	// guard stops a clean run from being parked in review.
	it('is a no-op on a run with zero open findings', () => {
		store.seed(run({ id: 'clean', status: 'running', reviews: [] }));
		const updated = signals.markNeedsReview('clean');

		expect(updated).toBeUndefined();
		expect(store.runs.get('clean')?.status).toBe('running');
		expect(store.events).toHaveLength(0);
	});

	it('is a no-op when every finding is already resolved (not open)', () => {
		store.seed(
			run({
				id: 'resolved',
				status: 'running',
				reviews: [
					{ severity: 'high', category: 'x', message: 'm', status: 'fixed' },
					{ severity: 'critical', category: 'y', message: 'n', status: 'dismissed' },
				],
			})
		);
		expect(signals.markNeedsReview('resolved')).toBeUndefined();
		expect(store.events).toHaveLength(0);
	});

	it('is idempotent: an already needs_review run returns the run without a new event', () => {
		store.seed(run({ id: 'nr', status: 'needs_review', reviews: [openFinding()] }));
		const updated = signals.markNeedsReview('nr');

		expect(updated?.status).toBe('needs_review');
		expect(store.events).toHaveLength(0); // no duplicate status_change
	});

	it('returns undefined for a missing run', () => {
		expect(signals.markNeedsReview('nope')).toBeUndefined();
		expect(store.events).toHaveLength(0);
	});
});

describe('AgentRunSignals.markFixing (ISC-5.9)', () => {
	let store: FakeStore;
	let signals: AgentRunSignals;

	beforeEach(() => {
		store = makeStore();
		signals = new AgentRunSignals(store.deps);
	});

	// The core ISC-5.9 guard: no dispatch -> no write, no matter the run state.
	it('writes nothing when called without a dispatch', () => {
		store.seed(run({ id: 'nr', status: 'needs_review', reviews: [openFinding()] }));
		const updated = signals.markFixing('nr');

		expect(updated).toBeUndefined();
		expect(store.runs.get('nr')?.status).toBe('needs_review');
		expect(store.events).toHaveLength(0);
	});

	it('flips to fixing with a dispatch and rides the dispatch ids on the event data', () => {
		store.seed(run({ id: 'nr', status: 'needs_review', reviews: [openFinding()] }));
		store.clock.t = 7400;
		const dispatch: FixDispatch = { agentId: 'fixer-9', sessionId: 'fix-sess', reason: 'auto-fix' };
		const updated = signals.markFixing('nr', dispatch);

		expect(updated?.status).toBe('fixing');
		expect(store.runs.get('nr')?.status).toBe('fixing');
		const evt = store.events.at(-1);
		expect(evt).toMatchObject({
			status: 'fixing',
			type: 'status_change',
			message: 'fix agent dispatched',
			data: { fixAgentId: 'fixer-9', fixSessionId: 'fix-sess', reason: 'auto-fix' },
		});
	});

	it('flips a running run to fixing with a dispatch', () => {
		store.seed(run({ id: 'r', status: 'running' }));
		expect(signals.markFixing('r', { agentId: 'f' })?.status).toBe('fixing');
	});

	it('is idempotent: an already fixing run returns the run without a new event', () => {
		store.seed(run({ id: 'fx', status: 'fixing' }));
		const updated = signals.markFixing('fx', { agentId: 'f' });

		expect(updated?.status).toBe('fixing');
		expect(store.events).toHaveLength(0);
	});

	it('returns undefined for a missing run even with a dispatch', () => {
		expect(signals.markFixing('nope', { agentId: 'f' })).toBeUndefined();
		expect(store.events).toHaveLength(0);
	});
});
