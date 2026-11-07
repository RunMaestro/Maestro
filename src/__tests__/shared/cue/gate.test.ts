/**
 * Tests for the shared Cue gate contract: the reply parser, the caps that keep
 * an event inside a small model context, the failure policy, and the record
 * stamped on a gated event.
 *
 * The policy is the part with consequences: a gate whose model cannot answer
 * must run (and warn) unless the subscription asked to skip, and a reply that
 * is not a verdict must never be read as a pass or a fail.
 */

import { describe, it, expect } from 'vitest';

import {
	CUE_GATE_EVENT_CAPS,
	CUE_GATE_MAX_REASON_LENGTH,
	CUE_GATE_PASS_PROBABILITY,
	CUE_GATE_PAYLOAD_KEY,
	CUE_GATE_QUESTION_ID,
	CUE_GATE_REPLY_SCHEMA,
	CUE_GATE_MAX_CONDITION_LENGTH,
	clampCueGateReason,
	compactCueGateEvent,
	cueGateCheckFromSystemOne,
	cueGateConditionProblem,
	cueGateSystemOneRequest,
	formatCueGateInput,
	parseCueGateOnUnavailable,
	parseCueGateReply,
	readCueGateRecord,
	readCueGateSetting,
	resolveCueGateDecision,
	withCueGateRecord,
	writeCueGateFields,
} from '../../../shared/cue/gate';
import { isCueRunSkipped, type CueEvent } from '../../../shared/cue';

function event(payload: Record<string, unknown> = {}): CueEvent {
	return {
		id: 'evt-1',
		type: 'github.issue',
		timestamp: '2026-10-11T12:00:00.000Z',
		triggerName: 'triage',
		payload,
	};
}

describe('CUE_GATE_REPLY_SCHEMA', () => {
	it('asks for a boolean verdict and a reason, and nothing else', () => {
		expect(CUE_GATE_REPLY_SCHEMA).toMatchObject({
			type: 'object',
			required: ['reason', 'pass'],
			additionalProperties: false,
			properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
		});
	});
});

describe('parseCueGateReply', () => {
	it('reads a verdict', () => {
		expect(parseCueGateReply({ pass: true, reason: 'Reports a crash.' })).toEqual({
			pass: true,
			reason: 'Reports a crash.',
		});
		expect(parseCueGateReply({ pass: false, reason: 'Praise only.' })).toEqual({
			pass: false,
			reason: 'Praise only.',
		});
	});

	it('keeps a verdict that came without a reason', () => {
		expect(parseCueGateReply({ pass: false })).toEqual({ pass: false, reason: '' });
	});

	it('returns null for anything that is not a verdict', () => {
		expect(parseCueGateReply(undefined)).toBeNull();
		expect(parseCueGateReply(null)).toBeNull();
		expect(parseCueGateReply('yes')).toBeNull();
		expect(parseCueGateReply([true])).toBeNull();
		expect(parseCueGateReply({ reason: 'no verdict here' })).toBeNull();
		// A string is not a boolean: "false" must not be read as truthy.
		expect(parseCueGateReply({ pass: 'false', reason: 'x' })).toBeNull();
		expect(parseCueGateReply({ pass: 1, reason: 'x' })).toBeNull();
	});

	it('flattens and bounds the reason', () => {
		const reply = parseCueGateReply({
			pass: true,
			reason: `line one\n\n  line two ${'x'.repeat(400)}`,
		});
		expect(reply?.reason.startsWith('line one line two')).toBe(true);
		expect(reply?.reason.length).toBe(CUE_GATE_MAX_REASON_LENGTH);
		expect(reply?.reason.endsWith('...')).toBe(true);
	});
});

describe('clampCueGateReason', () => {
	it('leaves a short reason alone', () => {
		expect(clampCueGateReason('  Asks for a fix.  ')).toBe('Asks for a fix.');
	});
});

describe('compactCueGateEvent', () => {
	it('is compact JSON of the payload', () => {
		expect(compactCueGateEvent({ number: 12, title: 'Login fails' })).toBe(
			'{"number":12,"title":"Login fails"}'
		);
	});

	it('cuts a long string and says how much was dropped', () => {
		const body = 'a'.repeat(CUE_GATE_EVENT_CAPS.maxStringChars + 250);
		const out = JSON.parse(compactCueGateEvent({ body, title: 'kept' }));
		expect(out.body).toContain('...[250 more characters not shown]');
		expect(out.body.startsWith('a'.repeat(CUE_GATE_EVENT_CAPS.maxStringChars))).toBe(true);
		// A long field must not push the fields after it out.
		expect(out.title).toBe('kept');
	});

	it('caps list length and nesting depth', () => {
		const items = Array.from({ length: CUE_GATE_EVENT_CAPS.maxArrayItems + 5 }, (_, i) => i);
		const out = JSON.parse(
			compactCueGateEvent({ items, deep: { a: { b: { c: { d: { e: 'too deep' } } } } } })
		);
		expect(out.items).toHaveLength(CUE_GATE_EVENT_CAPS.maxArrayItems + 1);
		expect(out.items.at(-1)).toBe('...[5 more items not shown]');
		expect(JSON.stringify(out.deep)).toContain('[object not shown]');
		expect(JSON.stringify(out.deep)).not.toContain('too deep');
	});

	it('cuts the whole document to the total cap', () => {
		const payload: Record<string, unknown> = {};
		for (let i = 0; i < 20; i++) payload[`field${i}`] = 'b'.repeat(1000);
		const out = compactCueGateEvent(payload);
		expect(out.length).toBeLessThan(CUE_GATE_EVENT_CAPS.maxTotalChars + 60);
		expect(out).toMatch(/more characters not shown\]$/);
	});

	it("leaves the gate's own record out of what the model reads", () => {
		const out = compactCueGateEvent({
			title: 'x',
			[CUE_GATE_PAYLOAD_KEY]: { outcome: 'passed', reason: 'earlier verdict' },
		});
		expect(out).toBe('{"title":"x"}');
	});

	it('falls back to an empty object for a payload that cannot be serialized', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		// Depth capping breaks the cycle before JSON.stringify can throw.
		expect(() => compactCueGateEvent(cyclic)).not.toThrow();
		expect(compactCueGateEvent({ big: BigInt(1) } as unknown as Record<string, unknown>)).toBe(
			'{}'
		);
	});
});

describe('formatCueGateInput', () => {
	it('names the condition, the event type, and the event', () => {
		const text = formatCueGateInput({
			condition: '  the comment reports a bug  ',
			event: event({ title: 'Crash on save' }),
		});
		expect(text).toBe(
			[
				'Condition: the comment reports a bug',
				'',
				'Event type: github.issue',
				'Event:',
				'{"title":"Crash on save"}',
			].join('\n')
		);
	});
});

describe('resolveCueGateDecision', () => {
	it('runs on a pass, without a warning', () => {
		expect(resolveCueGateDecision({ status: 'pass', reason: 'Reports a bug.' })).toEqual({
			run: true,
			warn: false,
			record: { outcome: 'passed', reason: 'Reports a bug.' },
		});
	});

	it('skips on a fail, without a warning', () => {
		expect(resolveCueGateDecision({ status: 'fail', reason: 'Praise only.' })).toEqual({
			run: false,
			warn: false,
			record: { outcome: 'gated', reason: 'Praise only.' },
		});
	});

	it('gives a fail with no reason a reason', () => {
		const decision = resolveCueGateDecision({ status: 'fail', reason: '' });
		expect(decision.run).toBe(false);
		expect(decision.record.reason).toMatch(/does not meet the gate condition/);
	});

	it('fails OPEN with a warning when the gate is unavailable (the default)', () => {
		const check = { status: 'unavailable', reason: 'Cue gate is off.' } as const;
		for (const decision of [
			resolveCueGateDecision(check),
			resolveCueGateDecision(check, 'run'),
			resolveCueGateDecision(check, undefined),
		]) {
			expect(decision.run).toBe(true);
			expect(decision.warn).toBe(true);
			expect(decision.record.outcome).toBe('ran-unchecked');
			expect(decision.record.reason).toContain('Cue gate is off.');
		}
	});

	it('fails closed, still with a warning, when the subscription asked to skip', () => {
		const decision = resolveCueGateDecision(
			{ status: 'unavailable', reason: 'Model not installed.' },
			'skip'
		);
		expect(decision.run).toBe(false);
		expect(decision.warn).toBe(true);
		expect(decision.record.outcome).toBe('gated');
		expect(decision.record.reason).toContain('gate_on_unavailable is "skip"');
		expect(decision.record.reason).toContain('Model not installed.');
	});

	it('never lets gate_on_unavailable override a real verdict', () => {
		expect(resolveCueGateDecision({ status: 'pass', reason: 'ok' }, 'skip').run).toBe(true);
		expect(resolveCueGateDecision({ status: 'fail', reason: 'no' }, 'run').run).toBe(false);
	});

	it("applies the task's fail policy when the subscription states none, and says whose rule it was", () => {
		const closed = resolveCueGateDecision({
			status: 'unavailable',
			reason: 'Jev did not answer.',
			onUnavailable: 'skip',
		});
		expect(closed.run).toBe(false);
		expect(closed.warn).toBe(true);
		expect(closed.record.outcome).toBe('gated');
		expect(closed.record.reason).toContain('the Cue gate task fails closed');
		expect(closed.record.reason).not.toContain('gate_on_unavailable');
		expect(closed.record.reason).toContain('Jev did not answer.');

		const open = resolveCueGateDecision({
			status: 'unavailable',
			reason: 'Jev did not answer.',
			onUnavailable: 'run',
		});
		expect(open.run).toBe(true);
		expect(open.record.outcome).toBe('ran-unchecked');
	});

	it("lets the subscription's own rule win over the task's fail policy, both ways", () => {
		const check = { status: 'unavailable', reason: 'No answer.' } as const;
		const runs = resolveCueGateDecision({ ...check, onUnavailable: 'skip' }, 'run');
		expect(runs.run).toBe(true);
		expect(runs.record.outcome).toBe('ran-unchecked');

		const skips = resolveCueGateDecision({ ...check, onUnavailable: 'run' }, 'skip');
		expect(skips.run).toBe(false);
		expect(skips.record.reason).toContain('gate_on_unavailable is "skip"');
	});
});

describe('the gate as a System One request', () => {
	const input = {
		condition: '  the comment reports a bug  ',
		event: event({ title: 'Crash on save', comments: 'It crashes every time.' }),
	};

	it('makes the event the state, as the same text a local model reads', () => {
		const { state } = cueGateSystemOneRequest(input);
		expect(state).toBe(
			'Event type: github.issue\nEvent:\n{"title":"Crash on save","comments":"It crashes every time."}'
		);
		// The local model's turn is the condition, then exactly that text.
		expect(formatCueGateInput(input)).toBe(`Condition: the comment reports a bug\n\n${state}`);
	});

	it('asks one yes or no question that carries the condition, where yes means the run proceeds', () => {
		const { questions } = cueGateSystemOneRequest(input);
		expect(Object.keys(questions)).toEqual([CUE_GATE_QUESTION_ID]);
		const question = questions[CUE_GATE_QUESTION_ID];
		expect(question.type).toBe('noul');
		expect(question.instructions).toMatch(/^Should this run proceed\?/);
		expect(question.instructions).toMatch(/the comment reports a bug$/);
		// An event that does not say enough passes, as the local model is told.
		expect(question.criteria).toEqual({
			true: expect.stringContaining('does not say enough to decide'),
			false: expect.stringContaining('does not meet the condition'),
		});
	});

	it('holds the event to the caps, so a small engine is handed no more than a local model', () => {
		const { state } = cueGateSystemOneRequest({
			condition: 'x',
			event: event({ body: 'a'.repeat(50_000) }),
		});
		expect((state as string).length).toBeLessThan(CUE_GATE_EVENT_CAPS.maxTotalChars + 200);
		expect(state).toContain('more characters not shown');
	});
});

describe('cueGateCheckFromSystemOne', () => {
	const answer = (probability: number) => ({
		[CUE_GATE_QUESTION_ID]: { type: 'noul' as const, probability },
	});

	it('passes at or above the midpoint and fails below it, naming the engine that answered', () => {
		expect(cueGateCheckFromSystemOne(answer(0.93), 'Jev (TypeSafe cloud)')).toEqual({
			status: 'pass',
			reason: 'Jev (TypeSafe cloud): yes, 93% that the run should proceed.',
		});
		expect(cueGateCheckFromSystemOne(answer(0.12), 'OpenJev at gpu.lan:8000')).toEqual({
			status: 'fail',
			reason: 'OpenJev at gpu.lan:8000: no, 12% that the run should proceed.',
		});
		expect(cueGateCheckFromSystemOne(answer(CUE_GATE_PASS_PROBABILITY), 'Jev')?.status).toBe(
			'pass'
		);
		expect(cueGateCheckFromSystemOne(answer(0.499), 'Jev')?.status).toBe('fail');
	});

	it('keeps "not calibrated" in the reason of a local judge answer', () => {
		const check = cueGateCheckFromSystemOne(
			answer(0.8),
			'Local judge (Qwen3.5 4B), not calibrated'
		);
		expect(check?.reason).toContain('not calibrated');
	});

	it('is no verdict when the answers hold no yes or no for the question', () => {
		expect(cueGateCheckFromSystemOne({}, 'Jev')).toBeNull();
		expect(
			cueGateCheckFromSystemOne(
				{ [CUE_GATE_QUESTION_ID]: { type: 'choice', choice: 'yes' } },
				'Jev'
			)
		).toBeNull();
		expect(
			cueGateCheckFromSystemOne({ other: { type: 'noul', probability: 0.9 } }, 'Jev')
		).toBeNull();
	});

	it('bounds the reason kept on the event', () => {
		const check = cueGateCheckFromSystemOne(answer(0.9), 'E'.repeat(400));
		expect(check?.reason.length).toBeLessThanOrEqual(CUE_GATE_MAX_REASON_LENGTH);
	});
});

describe('gate record on an event', () => {
	it('stamps a copy and reads it back', () => {
		const original = event({ title: 'x' });
		const stamped = withCueGateRecord(original, { outcome: 'gated', reason: 'Praise only.' });

		expect(original.payload).toEqual({ title: 'x' });
		expect(stamped.id).toBe(original.id);
		expect(stamped.payload.title).toBe('x');
		expect(readCueGateRecord(stamped.payload)).toEqual({
			outcome: 'gated',
			reason: 'Praise only.',
		});
	});

	it('survives a JSON round trip, which is how cue_events stores it', () => {
		const stamped = withCueGateRecord(event(), { outcome: 'ran-unchecked', reason: 'Off.' });
		const restored = JSON.parse(JSON.stringify(stamped.payload));
		expect(readCueGateRecord(restored)).toEqual({ outcome: 'ran-unchecked', reason: 'Off.' });
	});

	it('reads nothing from an event no gate touched, or from a malformed record', () => {
		expect(readCueGateRecord(undefined)).toBeNull();
		expect(readCueGateRecord({})).toBeNull();
		expect(readCueGateRecord({ gate: 'yes' })).toBeNull();
		expect(readCueGateRecord({ gate: { outcome: 'maybe', reason: 'x' } })).toBeNull();
		expect(readCueGateRecord({ gate: { outcome: 'passed' } })).toEqual({
			outcome: 'passed',
			reason: '',
		});
	});
});

describe('isCueRunSkipped', () => {
	it('is true only for the status that records a skipped event', () => {
		expect(isCueRunSkipped('gated')).toBe(true);
		for (const status of ['running', 'completed', 'failed', 'timeout', 'stopped']) {
			expect(isCueRunSkipped(status)).toBe(false);
		}
	});
});

describe('authoring a gate', () => {
	it('narrows a policy and refuses anything that is not one', () => {
		expect(parseCueGateOnUnavailable('run')).toBe('run');
		expect(parseCueGateOnUnavailable('skip')).toBe('skip');
		expect(parseCueGateOnUnavailable('SKIP')).toBeNull();
		expect(parseCueGateOnUnavailable(true)).toBeNull();
		expect(parseCueGateOnUnavailable(undefined)).toBeNull();
	});

	it('refuses a blank condition and one past the length the validator accepts', () => {
		expect(cueGateConditionProblem('the comment reports a bug')).toBeNull();
		expect(cueGateConditionProblem('   ')).toMatch(/needs a condition/);
		expect(cueGateConditionProblem('x'.repeat(CUE_GATE_MAX_CONDITION_LENGTH))).toBeNull();
		expect(cueGateConditionProblem('x'.repeat(CUE_GATE_MAX_CONDITION_LENGTH + 1))).toMatch(
			/at most 1000 characters/
		);
	});

	it('writes a trimmed condition, and the policy only when it is not the default', () => {
		const record: Record<string, unknown> = { name: 'triage' };
		writeCueGateFields(record, { condition: '  reports a bug  ', onUnavailable: 'skip' });
		expect(record).toEqual({ name: 'triage', gate: 'reports a bug', gate_on_unavailable: 'skip' });

		// The default is not spelled out, and a stale policy does not survive:
		// `triggerGroupKey` compares the keys as written.
		writeCueGateFields(record, { condition: 'reports a bug', onUnavailable: 'run' });
		expect(record).toEqual({ name: 'triage', gate: 'reports a bug' });
		writeCueGateFields(record, { condition: 'asks for a change' });
		expect(record).toEqual({ name: 'triage', gate: 'asks for a change' });
	});

	it('removes both keys, and leaves the rest of the record alone', () => {
		const record: Record<string, unknown> = {
			name: 'triage',
			gate: 'reports a bug',
			gate_on_unavailable: 'skip',
		};
		writeCueGateFields(record, null);
		expect(record).toEqual({ name: 'triage' });
	});

	it('throws on a condition that cannot be saved, without touching the record', () => {
		const record: Record<string, unknown> = { name: 'triage', gate: 'reports a bug' };
		expect(() => writeCueGateFields(record, { condition: ' ' })).toThrow(/needs a condition/);
		expect(record).toEqual({ name: 'triage', gate: 'reports a bug' });
	});

	it('reads a gate back, and reads nothing from a blank or missing one', () => {
		expect(readCueGateSetting({ gate: ' reports a bug ', gate_on_unavailable: 'skip' })).toEqual({
			condition: 'reports a bug',
			onUnavailable: 'skip',
		});
		expect(readCueGateSetting({ gate: 'reports a bug' })).toEqual({ condition: 'reports a bug' });
		// A policy that is not one is dropped, not passed through.
		expect(readCueGateSetting({ gate: 'reports a bug', gate_on_unavailable: 'maybe' })).toEqual({
			condition: 'reports a bug',
		});
		expect(readCueGateSetting({ gate: '   ' })).toBeNull();
		expect(readCueGateSetting({ gate_on_unavailable: 'skip' })).toBeNull();
		expect(readCueGateSetting({ gate: 42 })).toBeNull();
	});
});
