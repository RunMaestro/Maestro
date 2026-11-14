/**
 * @file cue-gate.test.ts
 * @description The Cue gate evaluator: what it asks the task router, and how
 * every router verdict becomes a gate check. It only ever reports a check; the
 * run-or-skip policy belongs to the dispatch service, so nothing here may
 * decide a run, and nothing may fall back to an agent.
 *
 * Assigned to System One, the gate is asked there FIRST and the model path is
 * never reached: an engine that gives no answer is `unavailable` with what the
 * fail policy said, not a reason to ask a model.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `PROMPT:${id}`),
}));

vi.mock('../../../main/local-models/task-router', () => ({
	runLocalTask: vi.fn(),
	runSystemOneTask: vi.fn(),
}));

import { evaluateCueGate, CUE_GATE_TIMEOUT_MS } from '../../../main/local-models/cue-gate';
import { runLocalTask, runSystemOneTask } from '../../../main/local-models/task-router';
import { CUE_GATE_QUESTION_ID, CUE_GATE_REPLY_SCHEMA } from '../../../shared/cue/gate';
import type { CueEvent } from '../../../shared/cue';

const SOURCE = { type: 'local', modelId: 'qwen3-1.7b' } as const;

const EVENT: CueEvent = {
	id: 'evt-1',
	type: 'github.issue',
	timestamp: '2026-10-11T12:00:00.000Z',
	triggerName: 'triage',
	payload: { number: 7, title: 'Crash on save', comments: 'It crashes every time.' },
};

const REQUEST = {
	condition: 'the comment reports a bug',
	event: EVENT,
	subscriptionName: 'triage',
};

function ok(json: unknown, text = JSON.stringify(json)) {
	return { status: 'ok' as const, text, json, source: SOURCE, durationMs: 120 };
}

describe('evaluateCueGate', () => {
	beforeEach(() => {
		vi.mocked(runLocalTask).mockReset();
		// Any assignment but System One: the model path below is the whole story.
		vi.mocked(runSystemOneTask).mockReset().mockResolvedValue({ status: 'not-assigned' });
	});

	it('asks the cue-gate task with the gate prompt, the reply schema, and a timeout', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(ok({ reason: 'Reports a crash.', pass: true }));

		await evaluateCueGate(REQUEST);

		expect(runLocalTask).toHaveBeenCalledTimes(1);
		const [taskId, input] = vi.mocked(runLocalTask).mock.calls[0];
		expect(taskId).toBe('cue-gate');
		expect(input.system).toBe('PROMPT:cue-gate-local');
		expect(input.jsonSchema).toBe(CUE_GATE_REPLY_SCHEMA);
		expect(input.prompt).toContain('Condition: the comment reports a bug');
		expect(input.prompt).toContain('Event type: github.issue');
		expect(input.prompt).toContain('"title":"Crash on save"');
		expect(input.signal).toBeInstanceOf(AbortSignal);
		expect(CUE_GATE_TIMEOUT_MS).toBeGreaterThan(0);
	});

	it('reports a pass', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(ok({ reason: 'Reports a crash.', pass: true }));
		await expect(evaluateCueGate(REQUEST)).resolves.toEqual({
			status: 'pass',
			reason: 'Reports a crash.',
		});
	});

	it('reports a fail', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(ok({ reason: 'Praise only.', pass: false }));
		await expect(evaluateCueGate(REQUEST)).resolves.toEqual({
			status: 'fail',
			reason: 'Praise only.',
		});
	});

	it('is unavailable, not a pass or a fail, when the reply is not a verdict', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(ok(undefined, 'Sure, I think it should run.'));
		const check = await evaluateCueGate(REQUEST);
		expect(check.status).toBe('unavailable');
		expect(check.reason).toMatch(/did not return a yes or no/);
	});

	it('is unavailable when the task is off, naming where to assign it', async () => {
		vi.mocked(runLocalTask).mockResolvedValue({ status: 'off' });
		const check = await evaluateCueGate(REQUEST);
		expect(check.status).toBe('unavailable');
		expect(check.reason).toMatch(/Cue gate is off/);
		expect(check.reason).toMatch(/Settings > Models > System One/);
	});

	it('is unavailable with the router reason when the assigned model cannot run', async () => {
		vi.mocked(runLocalTask).mockResolvedValue({
			status: 'unavailable',
			source: SOURCE,
			reason: 'qwen3-1.7b is not downloaded. Download it in Settings > Local Models.',
			code: 'model-not-installed',
		});
		await expect(evaluateCueGate(REQUEST)).resolves.toEqual({
			status: 'unavailable',
			reason: 'qwen3-1.7b is not downloaded. Download it in Settings > Local Models.',
		});
	});

	it('is unavailable when the model times out', async () => {
		vi.mocked(runLocalTask).mockResolvedValue({ status: 'cancelled', source: SOURCE });
		const check = await evaluateCueGate(REQUEST);
		expect(check.status).toBe('unavailable');
		expect(check.reason).toMatch(/took too long/);
	});

	it('is unavailable, with no agent path, for a hand-edited Utility Agent assignment', async () => {
		vi.mocked(runLocalTask).mockResolvedValue({ status: 'use-utility-agent' });
		const check = await evaluateCueGate(REQUEST);
		expect(check.status).toBe('unavailable');
		expect(check.reason).toMatch(/cannot run on the Utility Agent/);
	});

	it('lets an unclassified engine failure propagate to its caller', async () => {
		vi.mocked(runLocalTask).mockRejectedValue(new Error('engine bug'));
		await expect(evaluateCueGate(REQUEST)).rejects.toThrow('engine bug');
	});
});

describe('evaluateCueGate on System One', () => {
	const JEV = 'Jev (TypeSafe cloud)';

	function answered(probability: number) {
		return {
			status: 'ok' as const,
			engine: 'jev-cloud' as const,
			engineLabel: JEV,
			model: 'jev-1.13.0',
			answers: { [CUE_GATE_QUESTION_ID]: { type: 'noul' as const, probability } },
			usage: { inputTokens: 120, outputTokens: 1 },
			costUsd: 0.000005,
			latencyMs: 240,
			calibrated: true,
			redacted: false,
		};
	}

	function noAnswer(status: 'failed-open' | 'failed-closed' | 'unavailable') {
		return {
			status,
			engine: 'jev-cloud' as const,
			engineLabel: JEV,
			code: 'timeout' as const,
			reason: `${JEV} did not answer within 1500 ms.`,
		};
	}

	beforeEach(() => {
		vi.mocked(runLocalTask).mockReset();
		vi.mocked(runSystemOneTask).mockReset();
	});

	it("hands the engine the gate's condition and event, and never reaches a model", async () => {
		vi.mocked(runSystemOneTask).mockResolvedValue(answered(0.93));

		await evaluateCueGate(REQUEST);

		expect(runSystemOneTask).toHaveBeenCalledTimes(1);
		expect(runSystemOneTask).toHaveBeenCalledWith(
			'cue-gate',
			{ condition: REQUEST.condition, event: EVENT },
			{}
		);
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it('passes on a yes and fails on a no, with the engine named in the reason', async () => {
		vi.mocked(runSystemOneTask).mockResolvedValue(answered(0.93));
		await expect(evaluateCueGate(REQUEST)).resolves.toEqual({
			status: 'pass',
			reason: `${JEV}: yes, 93% that the run should proceed.`,
		});

		vi.mocked(runSystemOneTask).mockResolvedValue(answered(0.08));
		await expect(evaluateCueGate(REQUEST)).resolves.toEqual({
			status: 'fail',
			reason: `${JEV}: no, 8% that the run should proceed.`,
		});
	});

	it('carries the fail policy on the check when the engine gives no answer, and asks no model', async () => {
		vi.mocked(runSystemOneTask).mockResolvedValue(noAnswer('failed-open'));
		await expect(evaluateCueGate(REQUEST)).resolves.toEqual({
			status: 'unavailable',
			reason: `${JEV} did not answer within 1500 ms.`,
			onUnavailable: 'run',
		});

		vi.mocked(runSystemOneTask).mockResolvedValue(noAnswer('failed-closed'));
		await expect(evaluateCueGate(REQUEST)).resolves.toEqual({
			status: 'unavailable',
			reason: `${JEV} did not answer within 1500 ms.`,
			onUnavailable: 'skip',
		});
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it("applies the subscription's own rule in place of the task's fail policy", async () => {
		vi.mocked(runSystemOneTask).mockResolvedValue(noAnswer('failed-closed'));

		await evaluateCueGate({ ...REQUEST, onUnavailable: 'skip' });
		expect(vi.mocked(runSystemOneTask).mock.calls[0][2]).toEqual({ failPolicy: 'closed' });

		await evaluateCueGate({ ...REQUEST, onUnavailable: 'run' });
		expect(vi.mocked(runSystemOneTask).mock.calls[1][2]).toEqual({ failPolicy: 'open' });
	});

	it('names the agent that owns the subscription, for the decision record', async () => {
		vi.mocked(runSystemOneTask).mockResolvedValue(answered(0.93));

		await evaluateCueGate({ ...REQUEST, agentId: 'agent-1' });

		expect(vi.mocked(runSystemOneTask).mock.calls[0][2]).toEqual({ agentId: 'agent-1' });
	});

	it('is unavailable, not a pass or a fail, when the answers hold no yes or no', async () => {
		vi.mocked(runSystemOneTask).mockResolvedValue({ ...answered(0.9), answers: {} });
		await expect(evaluateCueGate(REQUEST)).resolves.toEqual({
			status: 'unavailable',
			reason: `${JEV} did not answer the gate's question.`,
		});
	});

	it('is unavailable when the engine was stopped before it answered', async () => {
		vi.mocked(runSystemOneTask).mockResolvedValue({
			status: 'cancelled',
			engine: 'jev-cloud',
			engineLabel: JEV,
		});
		const check = await evaluateCueGate(REQUEST);
		expect(check.status).toBe('unavailable');
		expect(check.reason).toContain(JEV);
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it('lets an unclassified engine failure propagate to its caller', async () => {
		vi.mocked(runSystemOneTask).mockRejectedValue(new Error('engine bug'));
		await expect(evaluateCueGate(REQUEST)).rejects.toThrow('engine bug');
	});
});
