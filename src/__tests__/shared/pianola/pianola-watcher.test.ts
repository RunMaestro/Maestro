/**
 * @file pianola-watcher.test.ts
 * @description Tests for the dependency-injected watch iteration, including the
 * audit-before-dispatch and bounded-retry safety invariants.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	runWatchIteration,
	initialWatchState,
	MAX_DISPATCH_ATTEMPTS,
	type WatchDeps,
	type WatchState,
	type WatchTarget,
} from '../../../shared/pianola/pianola-watcher';
import type { PianolaMessage, PianolaRule } from '../../../shared/pianola/types';
import type { PianolaDecisionRecord, PianolaProfileEntry } from '../../../shared/pianola/storage';

let seq = 0;
function assistant(content: string): PianolaMessage {
	seq += 1;
	return {
		id: `m${seq}`,
		role: 'assistant',
		source: 'ai',
		content,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
	};
}

function autoAnswerRule(): PianolaRule {
	return {
		id: 'rule-1',
		enabled: true,
		scope: 'global',
		match: { maxRisk: 'low', kinds: ['question'] },
		action: 'auto_answer',
		answer: 'Use tabs.',
		priority: 1,
		createdAt: 1,
		updatedAt: 1,
	};
}

function makeDeps(over: Partial<WatchDeps> = {}): {
	deps: WatchDeps;
	records: PianolaDecisionRecord[];
	dispatch: ReturnType<typeof vi.fn>;
} {
	const records: PianolaDecisionRecord[] = [];
	let idCounter = 0;
	const dispatch = vi.fn(async () => ({
		success: true as boolean,
		error: undefined as string | undefined,
	}));
	const deps: WatchDeps = {
		readRules: () => [],
		dispatch,
		recordDecision: (r) => records.push(r),
		now: () => '2026-01-01T00:00:00.000Z',
		genId: () => {
			idCounter += 1;
			return `decision-${idCounter}`;
		},
		log: () => {},
		...over,
	};
	return { deps, records, dispatch };
}

function escalateRule(): PianolaRule {
	return {
		id: 'rule-esc',
		enabled: true,
		scope: 'global',
		match: { kinds: ['question'] },
		action: 'escalate',
		priority: 1,
		createdAt: 1,
		updatedAt: 1,
	};
}

function profileEntry(): PianolaProfileEntry {
	return {
		profile: 'Auto-approves tests, builds, reads. Cautious about deletes and prod.',
		updatedAt: 1,
		pairCount: 10,
	};
}

/** Wire the optional handoff deps so the thought-based path is active. */
function withHandoff(
	over: Partial<WatchDeps> = {},
	profile: PianolaProfileEntry | null = profileEntry()
): {
	deps: WatchDeps;
	records: PianolaDecisionRecord[];
	requestJudgment: ReturnType<typeof vi.fn>;
} {
	const requestJudgment = vi.fn(async () => ({
		success: true as boolean,
		error: undefined as string | undefined,
	}));
	const base = makeDeps({
		resolveProfile: () => profile,
		requestJudgment,
		...over,
	});
	return { deps: base.deps, records: base.records, requestJudgment };
}

const target: WatchTarget = { tabId: 'tab-1', agentId: 'agent-1' };

describe('runWatchIteration - basics', () => {
	it('does nothing for a non-actionable transcript', async () => {
		const { deps, records, dispatch } = makeDeps();
		const { result } = await runWatchIteration(
			[assistant('All tests pass and the build is green.')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		expect(result.acted).toBe(false);
		expect(records).toHaveLength(0);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('escalates and records once when no rule matches', async () => {
		const { deps, records, dispatch } = makeDeps();
		const { result } = await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		expect(result.decision?.action).toBe('escalate');
		expect(dispatch).not.toHaveBeenCalled();
		expect(records).toHaveLength(1);
	});

	it('dry-run never dispatches but records the decision', async () => {
		const { deps, records, dispatch } = makeDeps({ readRules: () => [autoAnswerRule()] });
		const { result } = await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: true }
		);
		expect(result.decision?.action).toBe('auto_answer');
		expect(dispatch).not.toHaveBeenCalled();
		expect(records).toHaveLength(1);
		expect(records[0].dryRun).toBe(true);
		expect(records[0].dispatched).toBe(false);
	});
});

describe('runWatchIteration - auto-answer dispatch', () => {
	it('writes an audit record before dispatching, then an outcome record', async () => {
		const order: string[] = [];
		const dispatch = vi.fn(async () => {
			order.push('dispatch');
			return { success: true, error: undefined };
		});
		const { deps, records } = makeDeps({
			readRules: () => [autoAnswerRule()],
			dispatch,
			recordDecision: () => order.push('record'),
		});
		await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		// Audit (intent) must be persisted before the message is sent.
		expect(order).toEqual(['record', 'dispatch', 'record']);
		void records;
		expect(dispatch).toHaveBeenCalledWith(target, 'Use tabs.');
	});

	it('records intent and a dispatched outcome under one id', async () => {
		const { deps, records } = makeDeps({ readRules: () => [autoAnswerRule()] });
		const { result } = await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		expect(records).toHaveLength(2);
		expect(records[0].id).toBe(records[1].id); // same id, folded by readers
		expect(records[0].dispatched).toBe(false); // intent
		expect(records[1].dispatched).toBe(true); // outcome
		expect(result.dispatched).toBe(true);
	});

	it('does not dispatch if the pre-dispatch audit write fails (fails closed)', async () => {
		const dispatch = vi.fn(async () => ({ success: true, error: undefined }));
		const deps = makeDeps({
			readRules: () => [autoAnswerRule()],
			dispatch,
			recordDecision: () => {
				throw new Error('disk full');
			},
		}).deps;
		await expect(
			runWatchIteration(
				[assistant('Should I name it count or total?')],
				target,
				initialWatchState(),
				deps,
				{
					dryRun: false,
				}
			)
		).rejects.toThrow('disk full');
		expect(dispatch).not.toHaveBeenCalled();
	});
});

describe('runWatchIteration - dedup and retry', () => {
	it('does not re-handle the same prompt after a successful decision', async () => {
		const { deps, records } = makeDeps();
		const messages = [assistant('Should I deploy to production?')];
		const first = await runWatchIteration(messages, target, initialWatchState(), deps, {
			dryRun: false,
		});
		expect(first.result.acted).toBe(true);
		const second = await runWatchIteration(messages, target, first.state, deps, { dryRun: false });
		expect(second.result.acted).toBe(false);
		expect(second.result.skipped).toContain('already handled');
		expect(records).toHaveLength(1);
	});

	it('retries a failed dispatch on subsequent polls, then gives up at the cap', async () => {
		const dispatch = vi.fn(async () => ({ success: false, error: 'session busy' }));
		const { deps } = makeDeps({ readRules: () => [autoAnswerRule()], dispatch });
		const messages = [assistant('Should I name it count or total?')];

		let state: WatchState = initialWatchState();
		// First MAX-1 failures keep retrying (cursor not advanced).
		for (let attempt = 1; attempt < MAX_DISPATCH_ATTEMPTS; attempt += 1) {
			const out = await runWatchIteration(messages, target, state, deps, { dryRun: false });
			state = out.state;
			expect(state.lastHandledMessageId).toBeNull();
			expect(state.pendingRetry?.attempts).toBe(attempt);
		}
		// The capping attempt gives up: cursor advances, retry cleared.
		const final = await runWatchIteration(messages, target, state, deps, { dryRun: false });
		expect(final.state.pendingRetry).toBeNull();
		expect(final.state.lastHandledMessageId).toBe('m' + seq);
		expect(dispatch).toHaveBeenCalledTimes(MAX_DISPATCH_ATTEMPTS);

		// After giving up, the same prompt is skipped.
		const skipped = await runWatchIteration(messages, target, final.state, deps, { dryRun: false });
		expect(skipped.result.skipped).toContain('already handled');
		expect(dispatch).toHaveBeenCalledTimes(MAX_DISPATCH_ATTEMPTS);
	});

	it('records the dispatch error on the outcome entry', async () => {
		const dispatch = vi.fn(async () => ({ success: false, error: 'session busy' }));
		const { deps, records } = makeDeps({ readRules: () => [autoAnswerRule()], dispatch });
		await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		const outcome = records[records.length - 1];
		expect(outcome.dispatched).toBe(false);
		expect(outcome.error).toBe('session busy');
	});
});

describe('runWatchIteration - thought-based handoff', () => {
	it('hands an uncovered, non-high-risk ask to Pianola when a profile exists', async () => {
		const { deps, requestJudgment } = withHandoff();
		const { result } = await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		expect(result.handoff).toBe(true);
		expect(result.decision?.action).toBe('escalate');
		expect(requestJudgment).toHaveBeenCalledTimes(1);
		const req = requestJudgment.mock.calls[0][0];
		expect(req.profile).toEqual(profileEntry());
		expect(req.promptText).toContain('count or total');
	});

	it('marks the prompt handled so it is not handed off again', async () => {
		const { deps, requestJudgment } = withHandoff();
		const messages = [assistant('Should I name it count or total?')];
		const first = await runWatchIteration(messages, target, initialWatchState(), deps, {
			dryRun: false,
		});
		const second = await runWatchIteration(messages, target, first.state, deps, { dryRun: false });
		expect(second.result.skipped).toContain('already handled');
		expect(requestJudgment).toHaveBeenCalledTimes(1);
	});

	it('records intent before the handoff side effect, then an outcome (one id)', async () => {
		const order: string[] = [];
		const requestJudgment = vi.fn(async () => {
			order.push('handoff');
			return { success: true, error: undefined };
		});
		const records: PianolaDecisionRecord[] = [];
		const { deps } = makeDeps({
			resolveProfile: () => profileEntry(),
			requestJudgment,
			recordDecision: (r) => {
				order.push('record');
				records.push(r);
			},
		});
		await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		expect(order).toEqual(['record', 'handoff', 'record']);
		expect(records).toHaveLength(2);
		expect(records[0].id).toBe(records[1].id);
		expect(records[1].dispatched).toBe(false); // a handoff never answers the watched tab
	});

	it('records the handoff error on the outcome entry when delivery fails', async () => {
		const requestJudgment = vi.fn(async () => ({ success: false, error: 'pianola busy' }));
		const { deps, records } = withHandoff({ requestJudgment });
		const { result } = await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		expect(result.handoff).toBe(true);
		expect(records[records.length - 1].error).toBe('pianola busy');
	});

	it('does NOT hand off a high-risk ask; it escalates to the user', async () => {
		const { deps, records, requestJudgment } = withHandoff();
		const { result } = await runWatchIteration(
			[assistant('Should I deploy to production?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		expect(result.handoff).toBeFalsy();
		expect(result.decision?.action).toBe('escalate');
		expect(requestJudgment).not.toHaveBeenCalled();
		expect(records).toHaveLength(1);
	});

	it('does NOT hand off when no profile exists; it escalates to the user', async () => {
		const { deps, records, requestJudgment } = withHandoff({}, null);
		const { result } = await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		expect(result.handoff).toBeFalsy();
		expect(requestJudgment).not.toHaveBeenCalled();
		expect(records).toHaveLength(1);
	});

	it('does NOT hand off when a rule already covers the ask (matchedRuleId set)', async () => {
		const { deps, requestJudgment } = withHandoff({ readRules: () => [escalateRule()] });
		const { result } = await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		expect(result.handoff).toBeFalsy();
		expect(result.decision?.matchedRuleId).toBe('rule-esc');
		expect(requestJudgment).not.toHaveBeenCalled();
	});

	it('does NOT hand off on a dry run', async () => {
		const { deps, requestJudgment } = withHandoff();
		const { result } = await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: true }
		);
		expect(result.handoff).toBeFalsy();
		expect(requestJudgment).not.toHaveBeenCalled();
	});

	it('stays purely rule-driven when handoff deps are not wired', async () => {
		const { deps, records, dispatch } = makeDeps();
		const { result } = await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		expect(result.handoff).toBeFalsy();
		expect(result.decision?.action).toBe('escalate');
		expect(dispatch).not.toHaveBeenCalled();
		expect(records).toHaveLength(1);
	});
});
