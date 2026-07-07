/**
 * @file recover-runs.test.ts
 * @description Behavioral tests for recoverNonTerminalRuns (F1 / ISC-1.10).
 * Deps are injected in-memory fakes (a Map<string, AgentRun> + an events array).
 * Contracts under test:
 *   - a non-terminal run (queued/running/waiting/needs_review/fixing) whose
 *     session is NOT live is reconciled to `failed` with metadata.recoveredFrom
 *     recording the pre-crash status.
 *   - a run whose session IS live is left untouched.
 *   - a terminal run is left untouched.
 *   - the pass is idempotent: a second call recovers 0 and appends no events.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recoverNonTerminalRuns, type RecoverRunsDeps } from '../../../main/agent-run/recover-runs';
import type { AgentRun, AgentRunStatus } from '../../../shared/agent-run';

interface RecoveryEvent {
	id: string;
	runId: string;
	timestamp: number;
	type: string;
	status?: AgentRunStatus;
	message?: string;
}

interface FakeStore {
	runs: Map<string, AgentRun>;
	events: RecoveryEvent[];
	live: Set<string>;
	clock: { t: number };
	deps: RecoverRunsDeps;
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

function makeStore(): FakeStore {
	const runs = new Map<string, AgentRun>();
	const events: RecoveryEvent[] = [];
	const live = new Set<string>();
	const clock = { t: 5000 };
	const deps: RecoverRunsDeps = {
		listRuns: () => [...runs.values()],
		upsertRun: (next) => {
			runs.set(next.id, next);
			return next;
		},
		appendEvent: (event) => {
			events.push(event);
		},
		isSessionLive: (sessionId) => (sessionId ? live.has(sessionId) : false),
		now: () => clock.t,
		log: vi.fn(),
	};
	return {
		runs,
		events,
		live,
		clock,
		deps,
		seed: (r) => {
			runs.set(r.id, r);
		},
	};
}

const NON_TERMINAL: AgentRunStatus[] = ['queued', 'running', 'waiting', 'needs_review', 'fixing'];
const TERMINAL: AgentRunStatus[] = ['completed', 'failed', 'cancelled', 'merged', 'discarded'];

describe('recoverNonTerminalRuns', () => {
	let store: FakeStore;

	beforeEach(() => {
		store = makeStore();
	});

	it.each(NON_TERMINAL)(
		'reconciles a %s run with a dead session to failed with metadata.recoveredFrom',
		(status) => {
			store.seed(run({ id: `r-${status}`, status, sessionId: `sess-${status}` }));
			// session is not live (never added to store.live)
			const recovered = recoverNonTerminalRuns(store.deps);

			expect(recovered).toBe(1);
			const settled = store.runs.get(`r-${status}`)!;
			expect(settled.status).toBe('failed');
			expect(settled.metadata?.recoveredFrom).toBe(status); // original, not 'failed'
			expect(settled.metadata?.recoveredAt).toBe(5000);
			expect(settled.updatedAt).toBe(5000);

			const evt = store.events.find((e) => e.runId === `r-${status}`);
			expect(evt).toMatchObject({ type: 'status_change', status: 'failed' });
			expect(evt?.message).toContain(`recovered from ${status}`);
		}
	);

	it('leaves a run whose session is still live untouched', () => {
		store.seed(run({ id: 'live-run', status: 'running', sessionId: 'sess-live' }));
		store.live.add('sess-live');

		const recovered = recoverNonTerminalRuns(store.deps);

		expect(recovered).toBe(0);
		const unchanged = store.runs.get('live-run')!;
		expect(unchanged.status).toBe('running');
		expect(unchanged.metadata?.recoveredFrom).toBeUndefined();
		expect(store.events).toHaveLength(0);
	});

	it.each(TERMINAL)('leaves a terminal %s run untouched even with a dead session', (status) => {
		store.seed(run({ id: `term-${status}`, status, sessionId: `sess-${status}` }));

		const recovered = recoverNonTerminalRuns(store.deps);

		expect(recovered).toBe(0);
		const unchanged = store.runs.get(`term-${status}`)!;
		expect(unchanged.status).toBe(status);
		expect(unchanged.metadata?.recoveredFrom).toBeUndefined();
		expect(store.events).toHaveLength(0);
	});

	it('recovers only the dead non-terminal runs from a mixed ledger', () => {
		store.seed(run({ id: 'dead-a', status: 'running', sessionId: 'sess-dead-a' }));
		store.seed(run({ id: 'dead-b', status: 'waiting', sessionId: 'sess-dead-b' }));
		store.seed(run({ id: 'alive', status: 'running', sessionId: 'sess-alive' }));
		store.seed(run({ id: 'done', status: 'completed', sessionId: 'sess-done' }));
		store.live.add('sess-alive');

		const recovered = recoverNonTerminalRuns(store.deps);

		expect(recovered).toBe(2);
		expect(store.runs.get('dead-a')?.status).toBe('failed');
		expect(store.runs.get('dead-b')?.status).toBe('failed');
		expect(store.runs.get('alive')?.status).toBe('running');
		expect(store.runs.get('done')?.status).toBe('completed');
		expect(store.events).toHaveLength(2);
		expect(store.deps.log).toHaveBeenCalledWith(expect.any(String), 2);
	});

	it('is idempotent: a second pass recovers nothing and appends no new events', () => {
		store.seed(run({ id: 'r1', status: 'running', sessionId: 'sess-a' }));
		store.seed(run({ id: 'r2', status: 'fixing', sessionId: 'sess-b' }));

		const first = recoverNonTerminalRuns(store.deps);
		expect(first).toBe(2);
		expect(store.events).toHaveLength(2);

		const second = recoverNonTerminalRuns(store.deps);
		expect(second).toBe(0);
		expect(store.events).toHaveLength(2); // no new events
		expect(store.deps.log).toHaveBeenCalledTimes(1); // log only fires when recovered > 0
	});

	it('treats a run with no sessionId as not-live and recovers it', () => {
		store.seed(run({ id: 'orphan', status: 'running', sessionId: undefined }));
		const recovered = recoverNonTerminalRuns(store.deps);
		expect(recovered).toBe(1);
		expect(store.runs.get('orphan')?.status).toBe('failed');
	});
});
