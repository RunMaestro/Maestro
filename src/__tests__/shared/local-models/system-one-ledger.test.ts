/**
 * Tests for the System One decision ledger's shared vocabulary: the query
 * validator, the text a record keeps of a request, and the words a row is
 * shown in.
 */

import { describe, it, expect } from 'vitest';

import { choice, noul, score } from '../../../shared/local-models/system-one';
import {
	SYSTEM_ONE_DECISION_OUTCOMES,
	SYSTEM_ONE_LEDGER_MAX_INPUT_CHARS,
	SYSTEM_ONE_LEDGER_MAX_LIMIT,
	SYSTEM_ONE_LEDGER_OUTCOME_FILTERS,
	SYSTEM_ONE_LEDGER_OUTCOME_LABELS,
	SYSTEM_ONE_LEDGER_RETENTION_DAYS,
	SYSTEM_ONE_LEDGER_RETENTION_MS,
	describeSystemOneAnswer,
	formatSystemOneLedgerInput,
	isSystemOneDecisionOutcome,
	isSystemOneLedgerOutcomeFilter,
	isSystemOneLedgerTaskId,
	parseSystemOneLedgerQuery,
	summarizeSystemOneDecision,
	systemOneDecisionRun,
	systemOneLedgerContext,
	systemOneLedgerEngineLabel,
	systemOneLedgerTaskLabel,
	type SystemOneDecision,
} from '../../../shared/local-models/system-one-ledger';
import { LOCAL_MODEL_RUN_SOURCE_TYPES } from '../../../shared/stats-types';

// Built at run time so no secret-shaped literal sits in the source.
const SECRET = `sk-ant-api03-${'A1b2C3d4'.repeat(6)}`;

describe('the retention window', () => {
	it('is thirty days', () => {
		expect(SYSTEM_ONE_LEDGER_RETENTION_DAYS).toBe(30);
		expect(SYSTEM_ONE_LEDGER_RETENTION_MS).toBe(30 * 86_400_000);
	});
});

describe('outcomes', () => {
	it('has no timeout outcome: a timeout is a code on a failed-open or failed-closed run', () => {
		expect(SYSTEM_ONE_DECISION_OUTCOMES).toEqual([
			'ok',
			'failed-open',
			'failed-closed',
			'unavailable',
			'cancelled',
		]);
		expect(isSystemOneDecisionOutcome('timeout')).toBe(false);
	});

	it('offers timeout as a filter beside every outcome, each with a label', () => {
		expect(SYSTEM_ONE_LEDGER_OUTCOME_FILTERS).toEqual([...SYSTEM_ONE_DECISION_OUTCOMES, 'timeout']);
		expect(isSystemOneLedgerOutcomeFilter('timeout')).toBe(true);
		expect(isSystemOneLedgerOutcomeFilter('sideways')).toBe(false);
		for (const filter of SYSTEM_ONE_LEDGER_OUTCOME_FILTERS) {
			expect(SYSTEM_ONE_LEDGER_OUTCOME_LABELS[filter]).toBeTruthy();
		}
	});
});

describe('parseSystemOneLedgerQuery', () => {
	it('reads an absent query as every task, newest first', () => {
		expect(parseSystemOneLedgerQuery(undefined)).toEqual({ ok: true, query: {} });
		expect(parseSystemOneLedgerQuery(null)).toEqual({ ok: true, query: {} });
		expect(parseSystemOneLedgerQuery({})).toEqual({ ok: true, query: {} });
	});

	it('keeps a task, an outcome, a start and a limit', () => {
		expect(
			parseSystemOneLedgerQuery({ taskId: 'cue-gate', outcome: 'timeout', since: 1000, limit: 5 })
		).toEqual({
			ok: true,
			query: { taskId: 'cue-gate', outcome: 'timeout', since: 1000, limit: 5 },
		});
	});

	it("keeps an agent's verb as the source to filter by", () => {
		expect(parseSystemOneLedgerQuery({ taskId: 'agent:rank' })).toEqual({
			ok: true,
			query: { taskId: 'agent:rank' },
		});
	});

	it('drops a field it does not know, so a newer caller cannot smuggle one in', () => {
		expect(parseSystemOneLedgerQuery({ limit: 5, orderBy: 'input' })).toEqual({
			ok: true,
			query: { limit: 5 },
		});
	});

	it.each([
		['a string', 'cue-gate', /must be an object/],
		['an array', [], /must be an object/],
		['an unknown task', { taskId: 'no-such-task' }, /is not a task/],
		['an agent verb that does not exist', { taskId: 'agent:guess' }, /is not a task/],
		['the agent prefix alone', { taskId: 'agent:' }, /is not a task/],
		['an unknown outcome', { outcome: 'sideways' }, /is not an outcome/],
		['a start that is not a number', { since: '1d' }, /epoch milliseconds/],
		['a negative start', { since: -1 }, /epoch milliseconds/],
		['a limit of zero', { limit: 0 }, /whole number from 1/],
		['a fractional limit', { limit: 1.5 }, /whole number from 1/],
		['a limit past the cap', { limit: SYSTEM_ONE_LEDGER_MAX_LIMIT + 1 }, /whole number from 1/],
	])('refuses %s', (_name, raw, message) => {
		const result = parseSystemOneLedgerQuery(raw);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toMatch(message);
	});
});

describe('what a record is filed under', () => {
	it('is a task, or an agent verb spelled agent:<verb>', () => {
		expect(isSystemOneLedgerTaskId('cue-gate')).toBe(true);
		expect(isSystemOneLedgerTaskId('agent:yes')).toBe(true);
		expect(isSystemOneLedgerTaskId('agent:batch')).toBe(true);
		for (const other of ['agent', 'agent:', 'agent:guide', 'yes', '', 7, null, undefined]) {
			expect(isSystemOneLedgerTaskId(other)).toBe(false);
		}
	});

	it("is called by the task's label, or by the verb the agent typed", () => {
		expect(systemOneLedgerTaskLabel('cue-gate')).toBe('Cue gate');
		expect(systemOneLedgerTaskLabel('agent:rank')).toBe('Agent: rank');
	});

	it('reads a stored task a later build no longer has as its id, never as a throw', () => {
		expect(systemOneLedgerTaskLabel('retired-task' as never)).toBe('retired-task');
	});

	it('files model routing under its own task, whichever router decided', () => {
		expect(isSystemOneLedgerTaskId('model-routing')).toBe(true);
		expect(systemOneLedgerTaskLabel('model-routing')).toBe('Model routing');
	});

	it('names every engine a record can carry, the embedding router among them', () => {
		expect(systemOneLedgerEngineLabel('jev-cloud')).toBe('Jev (TypeSafe cloud)');
		expect(systemOneLedgerEngineLabel('local-judge')).toBe('Local judge, not calibrated');
		expect(systemOneLedgerEngineLabel('off')).toBe('Off');
		// Not a System One engine: it decides a routing run with no engine at all.
		expect(systemOneLedgerEngineLabel('embedding-router')).toBe('Embedding router, not calibrated');
	});
});

describe('systemOneLedgerContext', () => {
	it('uses the authoritative task label even when its questions mention another topic', () => {
		expect(
			systemOneLedgerContext({
				taskId: 'model-routing',
				input: formatSystemOneLedgerInput({
					state: 'private',
					questions: { pick: noul('Is this email urgent?') },
				}),
			})
		).toEqual({ label: 'Model routing', question: 'Is this email urgent?' });
	});

	it.each([
		['Is this email something the recipient personally needs to see?', 'Email classification'],
		['Which working session is `message` about?', 'Session routing'],
		['Does this document need a review?', 'Agent judgment'],
	])('describes an agent request from its question: %s', (question, label) => {
		expect(
			systemOneLedgerContext({
				taskId: 'agent:ask',
				input: formatSystemOneLedgerInput({ state: 'private', questions: { ask: noul(question) } }),
			})
		).toEqual({ label, question });
	});

	it('reads structured rank instructions without exposing the candidate or state', () => {
		expect(
			systemOneLedgerContext({
				taskId: 'agent:rank',
				input: formatSystemOneLedgerInput({
					state: 'PRIVATE STATE',
					questions: {
						item: noul({ question: 'Is this email relevant?', candidate: 'PRIVATE CANDIDATE' }),
					},
				}),
			})
		).toEqual({ label: 'Email classification', question: 'Is this email relevant?' });
	});

	it('keeps multiple questions and normalizes whitespace for the preview', () => {
		expect(
			systemOneLedgerContext({
				taskId: 'agent:ask',
				input: formatSystemOneLedgerInput({
					state: 'private',
					questions: {
						tab: noul('Which working\n session is this about?'),
						followup: noul('Is this a follow-up?'),
					},
				}),
			})
		).toEqual({
			label: 'Session routing',
			question: 'Which working session is this about? · Is this a follow-up?',
		});
	});

	it.each([
		undefined,
		'invalid JSON',
		'null',
		'[]',
		'{}',
		'{"questions":[]}',
		'{"questions":{"bad":null}}',
		'{"questions":{"bad":{"instructions":17}}}',
	])('handles unavailable or malformed saved questions: %s', (input) => {
		expect(systemOneLedgerContext({ taskId: 'agent:ask', input })).toEqual({
			label: 'Agent judgment',
			question: null,
		});
	});

	it('does not infer a topic from private state or an arbitrary JSON field', () => {
		expect(
			systemOneLedgerContext({
				taskId: 'agent:ask',
				input: JSON.stringify({
					state: 'Which working session? Is this email urgent?',
					questions: { ask: noul({ candidate: 'Is this email urgent?' }) },
				}),
			})
		).toEqual({ label: 'Agent judgment', question: null });
	});
});

describe('formatSystemOneLedgerInput', () => {
	it('keeps the state and the questions as JSON', () => {
		const questions = { proceed: noul('Should this run proceed?') };

		const kept = JSON.parse(formatSystemOneLedgerInput({ state: 'A comment.', questions }));

		expect(kept).toEqual({ state: 'A comment.', questions });
	});

	it('removes a secret from the state and from a question before it is kept', () => {
		const text = formatSystemOneLedgerInput({
			state: { comment: `my key is ${SECRET}` },
			questions: { leak: noul(`Does the text hold ${SECRET}?`) },
		});

		expect(text).not.toContain(SECRET);
		expect(JSON.parse(text).state.comment).toContain('my key is');
	});

	it('cuts a state too long to keep whole, marks it, and keeps the questions', () => {
		const questions = { proceed: noul('Should this run proceed?') };

		const kept = JSON.parse(
			formatSystemOneLedgerInput({
				state: 'x'.repeat(SYSTEM_ONE_LEDGER_MAX_INPUT_CHARS * 2),
				questions,
			})
		);

		expect(kept.truncated).toBe(true);
		expect(kept.state).toHaveLength(SYSTEM_ONE_LEDGER_MAX_INPUT_CHARS);
		expect(kept.questions).toEqual(questions);
	});

	it('cuts a long JSON state as text', () => {
		const kept = JSON.parse(
			formatSystemOneLedgerInput({
				state: { items: Array.from({ length: 5000 }, (_, i) => `item ${i}`) },
				questions: { proceed: noul('Proceed?') },
			})
		);

		expect(kept.truncated).toBe(true);
		expect(typeof kept.state).toBe('string');
		expect(kept.state.startsWith('{"items":["item 0"')).toBe(true);
	});
});

describe('describeSystemOneAnswer', () => {
	it('says yes or no with P(yes)', () => {
		expect(describeSystemOneAnswer({ type: 'noul', probability: 0.93 })).toBe('yes (0.93)');
		expect(describeSystemOneAnswer({ type: 'noul', probability: 0.08 })).toBe('no (0.08)');
		expect(describeSystemOneAnswer({ type: 'noul', probability: 0.5 })).toBe('yes (0.50)');
	});

	it('names the option, with the confidence when the engine reports one', () => {
		expect(describeSystemOneAnswer({ type: 'choice', choice: 'bug', confidence: 0.81 })).toBe(
			'bug (0.81)'
		);
		// The local judge names one option and no distribution.
		expect(describeSystemOneAnswer({ type: 'choice', choice: 'bug' })).toBe('bug');
	});

	it('gives a score as a level, whole or between two', () => {
		expect(describeSystemOneAnswer({ type: 'score', score: 2 })).toBe('level 2');
		expect(describeSystemOneAnswer({ type: 'score', score: 2.4 })).toBe('level 2.40');
	});
});

describe('summarizeSystemOneDecision', () => {
	it('leaves out the id of a single question', () => {
		expect(
			summarizeSystemOneDecision({
				outcome: 'ok',
				answers: { proceed: { type: 'noul', probability: 0.93 } },
			})
		).toBe('yes (0.93)');
	});

	it('keys several answers by question id', () => {
		expect(
			summarizeSystemOneDecision({
				outcome: 'ok',
				answers: {
					kind: { type: 'choice', choice: 'bug', confidence: 0.81 },
					severity: { type: 'score', score: 3 },
				},
			})
		).toBe('kind: bug (0.81), severity: level 3');
	});

	it('says why there was no answer, or the outcome when no code was kept', () => {
		expect(summarizeSystemOneDecision({ outcome: 'failed-open', code: 'timeout' })).toBe('timeout');
		expect(summarizeSystemOneDecision({ outcome: 'failed-closed', code: 'off' })).toBe('off');
		expect(summarizeSystemOneDecision({ outcome: 'unavailable' })).toBe('unavailable');
	});
});

// The builders are the vocabulary a kept input is written in; a sanity check
// that the three types survive the round trip the ledger makes.
describe('a kept input and the three question types', () => {
	it('round-trips noul, choice and score', () => {
		const questions = {
			proceed: noul('Proceed?'),
			kind: choice('Which kind?', { bug: 'A defect', feature: 'A request' }),
			severity: score('How severe?', ['Cosmetic', 'Annoying', 'Blocking']),
		};

		expect(JSON.parse(formatSystemOneLedgerInput({ state: 'text', questions })).questions).toEqual(
			questions
		);
	});
});

describe('systemOneDecisionRun: the usage record a decision leaves', () => {
	const answered: SystemOneDecision = {
		taskId: 'cue-gate',
		engine: 'jev-cloud',
		model: 'jev-1.13.0',
		questionIds: ['proceed'],
		answers: { proceed: { type: 'noul', probability: 0.93 } },
		outcome: 'ok',
		startedAt: 1_790_000_000_000,
		latencyMs: 241.6,
		usage: { inputTokens: 412, outputTokens: 3 },
		costUsd: 0.0000173,
		agentId: 'agent-1',
		tabId: 'tab-2',
		input: '{"state":"the diff"}',
	};
	const unanswered: SystemOneDecision = {
		taskId: 'model-routing',
		engine: 'openjev',
		questionIds: ['tier', 'effort'],
		outcome: 'failed-open',
		code: 'timeout',
		startedAt: 1_790_000_000_500,
		latencyMs: 400,
	};

	it('files a request a remote engine answered under the system-one source', () => {
		expect(LOCAL_MODEL_RUN_SOURCE_TYPES).toContain('system-one');
		expect(systemOneDecisionRun(answered)).toEqual({
			taskId: 'cue-gate',
			sourceType: 'system-one',
			modelId: 'jev-1.13.0',
			// The engine's id goes where an endpoint's id goes.
			endpointId: 'jev-cloud',
			agentId: 'agent-1',
			startedAt: 1_790_000_000_000,
			durationMs: 241.6,
			outcome: 'ok',
			tokensIn: 412,
			tokensOut: 3,
		});
	});

	it("carries no text, no answers and no cost: those are the ledger's", () => {
		const run = systemOneDecisionRun(answered);

		expect(JSON.stringify(run)).not.toContain('the diff');
		expect(JSON.stringify(run)).not.toContain('proceed');
		expect(run).not.toHaveProperty('costUsd');
		expect(run).not.toHaveProperty('tabId');
	});

	it('names the engine as the model when no answer named one', () => {
		expect(systemOneDecisionRun(unanswered)).toEqual({
			taskId: 'model-routing',
			sourceType: 'system-one',
			modelId: 'openjev',
			endpointId: 'openjev',
			startedAt: 1_790_000_000_500,
			durationMs: 400,
			outcome: 'error',
			errorCode: 'timeout',
		});
	});

	it('reads the three no-answer outcomes as an error, and keeps the other two', () => {
		const outcomeOf = (outcome: SystemOneDecision['outcome']) =>
			systemOneDecisionRun({ ...unanswered, outcome })?.outcome;

		expect(outcomeOf('failed-open')).toBe('error');
		expect(outcomeOf('failed-closed')).toBe('error');
		expect(outcomeOf('unavailable')).toBe('error');
		expect(outcomeOf('cancelled')).toBe('cancelled');
		expect(systemOneDecisionRun(answered)?.outcome).toBe('ok');
		// Every decision outcome maps; none is left to fall through as itself.
		for (const outcome of SYSTEM_ONE_DECISION_OUTCOMES) {
			expect(['ok', 'error', 'cancelled']).toContain(outcomeOf(outcome));
		}
	});

	it('gives an answered run no error code, whatever the record carries', () => {
		expect(systemOneDecisionRun({ ...answered, code: 'timeout' })).not.toHaveProperty('errorCode');
	});

	it("files an agent's own request under its verb", () => {
		expect(systemOneDecisionRun({ ...answered, taskId: 'agent:rank' })?.taskId).toBe('agent:rank');
	});

	it('leaves the agent out when the caller knew none', () => {
		expect(systemOneDecisionRun(unanswered)).not.toHaveProperty('agentId');
	});

	it('is not a run when a local router decided: the task router filed that model run', () => {
		expect(systemOneDecisionRun({ ...answered, engine: 'local-judge' })).toBeNull();
		expect(systemOneDecisionRun({ ...answered, engine: 'embedding-router' })).toBeNull();
	});

	it('is not a run when nothing was sent', () => {
		expect(systemOneDecisionRun({ ...unanswered, engine: 'off', code: 'off' })).toBeNull();
		expect(systemOneDecisionRun({ ...answered, cached: true })).toBeNull();
	});
});
