/**
 * @file pianola-watcher.test.ts
 * @description Tests for the dependency-injected watch iteration.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	runWatchIteration,
	initialWatchState,
	type WatchDeps,
	type WatchTarget,
} from '../../../shared/pianola/pianola-watcher';
import type { PianolaMessage, PianolaRule } from '../../../shared/pianola/types';
import type { PianolaDecisionRecord } from '../../../shared/pianola/storage';

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
	const dispatch = vi.fn(async () => ({
		success: true as boolean,
		error: undefined as string | undefined,
	}));
	const deps: WatchDeps = {
		readRules: () => [],
		dispatch,
		recordDecision: (r) => records.push(r),
		now: () => '2026-01-01T00:00:00.000Z',
		genId: () => 'decision-id',
		log: () => {},
		...over,
	};
	return { deps, records, dispatch };
}

const target: WatchTarget = { tabId: 'tab-1', agentId: 'agent-1' };

describe('runWatchIteration', () => {
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
		expect(result.decision).toBeNull();
		expect(records).toHaveLength(0);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('auto-answers a low-risk question matched by a rule and records it dispatched', async () => {
		const { deps, records, dispatch } = makeDeps({ readRules: () => [autoAnswerRule()] });
		const { result } = await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		expect(result.decision?.action).toBe('auto_answer');
		expect(dispatch).toHaveBeenCalledWith(target, 'Use tabs.');
		expect(records[0].dispatched).toBe(true);
		expect(records[0].dryRun).toBe(false);
	});

	it('does not dispatch in dry-run mode but still records the decision', async () => {
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
		expect(records[0].dispatched).toBe(false);
		expect(records[0].dryRun).toBe(true);
	});

	it('escalates and records when no rule matches', async () => {
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

	it('records a dispatch failure on the audit entry', async () => {
		const dispatch = vi.fn(async () => ({ success: false, error: 'session busy' }));
		const { deps, records } = makeDeps({ readRules: () => [autoAnswerRule()], dispatch });
		await runWatchIteration(
			[assistant('Should I name it count or total?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		expect(records[0].dispatched).toBe(false);
		expect(records[0].error).toBe('session busy');
	});

	it('does not re-handle the same prompt on the next iteration', async () => {
		const { deps, records } = makeDeps();
		const messages = [assistant('Should I deploy to production?')];

		const first = await runWatchIteration(messages, target, initialWatchState(), deps, {
			dryRun: false,
		});
		expect(first.result.acted).toBe(true);
		expect(records).toHaveLength(1);

		const second = await runWatchIteration(messages, target, first.state, deps, { dryRun: false });
		expect(second.result.acted).toBe(false);
		expect(second.result.skipped).toContain('already handled');
		expect(records).toHaveLength(1); // no new record
	});

	it('handles a fresh prompt after the previous one was handled', async () => {
		const { deps, records } = makeDeps();
		const first = await runWatchIteration(
			[assistant('Should I deploy to production?')],
			target,
			initialWatchState(),
			deps,
			{ dryRun: false }
		);
		const second = await runWatchIteration(
			[assistant('Should I publish the release?')],
			target,
			first.state,
			deps,
			{ dryRun: false }
		);
		expect(second.result.acted).toBe(true);
		expect(records).toHaveLength(2);
	});
});
