import { describe, expect, it } from 'vitest';
import {
	assertOneActivePlanPerProgram,
	dedupeAsk,
	briefRunsForPlans,
	derivePianolaBrief,
	type PianolaAsk,
	type PianolaProgram,
} from '../../../shared/pianola/pianola-programs';
import type { PianolaPlan } from '../../../shared/pianola/pianola-tasks';
import {
	validatePianolaProgramsFile,
	validatePianolaAsksFile,
} from '../../../shared/pianola/storage';
import type { PianolaDecisionRecord } from '../../../shared/pianola/storage';

const program: PianolaProgram = {
	id: 'product',
	title: 'Product',
	root: '/tmp/product',
	roles: {},
	charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
	status: 'active',
	createdAt: 1,
	updatedAt: 1,
};
const ask: PianolaAsk = {
	id: 'a',
	title: 'First',
	detail: 'Why?',
	severity: 'high',
	dedupeKey: 'agent:product',
	status: 'open',
	agentId: 'agent',
	programId: 'product',
	createdAt: '2026-09-30T00:00:00.000Z',
	updatedAt: '2026-09-30T00:00:00.000Z',
};
const plan: PianolaPlan = {
	id: 'p',
	programId: 'product',
	title: 'Release',
	createdAt: Date.parse('2026-09-29T00:00:00.000Z'),
	tasks: [
		{ id: 'review', title: 'Review', prompt: '', dependsOn: [], status: 'needs_review' },
		{
			id: 'failed',
			title: 'Deploy',
			prompt: '',
			dependsOn: [],
			status: 'failed',
			error: 'Check failed',
		},
		{ id: 'work', title: 'Build', prompt: '', dependsOn: [], status: 'running' },
		{ id: 'done', title: 'Verify', prompt: '', dependsOn: [], status: 'done' },
	],
};
const decision: PianolaDecisionRecord = {
	id: 'd',
	timestamp: '2026-09-30T00:00:00.000Z',
	tabId: 'tab',
	agentId: 'agent',
	classification: {
		kind: 'question',
		risk: 'high',
		topic: 'Approval',
		confidence: 'high',
		evidence: { messageId: 'm', reason: 'asked', structured: false },
	},
	decision: { action: 'escalate', matchedRuleId: null, reason: 'Needs founder' },
	dispatched: false,
	dryRun: false,
};
describe('portfolio storage validation', () => {
	it('drops malformed records independently', () => {
		expect(
			validatePianolaProgramsFile({
				programs: [
					program,
					{ ...program, id: 'bad', charter: { ...program.charter, maxAttempts: 0 } },
				],
			}).programs
		).toEqual([program]);
		expect(
			validatePianolaAsksFile({ asks: [ask, { ...ask, id: 'bad', updatedAt: 'not-a-date' }] }).asks
		).toEqual([ask]);
	});
});

describe('portfolio derivation', () => {
	it('updates an open ask by agent and program, taking the higher severity; distinct creates a separate ask', () => {
		const incoming = {
			...ask,
			id: 'b',
			title: 'Updated',
			severity: 'medium' as const,
			detail: 'Changed',
			updatedAt: '2026-10-01T00:00:00.000Z',
		};
		const merged = dedupeAsk([ask], incoming);
		expect(merged.ask).toMatchObject({
			id: 'a',
			title: 'Updated',
			severity: 'high',
			detail: 'Changed',
		});
		expect(merged.asks).toHaveLength(1);
		expect(dedupeAsk([ask], { ...incoming, severity: 'critical' }).ask.severity).toBe('critical');
		expect(dedupeAsk([ask], incoming, true).asks.map((a) => a.id)).toEqual(['a', 'b']);
	});
	it('refuses another unfinished plan in a program but accepts a replacement or completed predecessor', () => {
		expect(() => assertOneActivePlanPerProgram({ ...plan, id: 'other' }, [plan])).toThrow(
			/already has an active plan/
		);
		expect(() => assertOneActivePlanPerProgram(plan, [plan])).not.toThrow();
		expect(() =>
			assertOneActivePlanPerProgram({ ...plan, id: 'other' }, [
				{ ...plan, tasks: plan.tasks.map((task) => ({ ...task, status: 'done' as const })) },
			])
		).not.toThrow();
	});
	it('projects named check status and timestamp from the AgentRun ledger', () => {
		const completedAt = Date.parse('2026-09-30T23:00:00.000Z');
		const runs = briefRunsForPlans(
			[plan],
			[
				{
					id: 'pianola:p:done',
					updatedAt: completedAt + 1000,
					checks: [{ name: 'independent-validation', status: 'passed', completedAt }],
				},
			],
			(planId, taskId) => 'pianola:' + planId + ':' + taskId
		);
		expect(runs['p:done']).toMatchObject({
			id: 'pianola:p:done',
			completedAt: '2026-09-30T23:00:00.000Z',
			checks: [{ name: 'independent-validation', status: 'passed' }],
		});
		expect(Object.keys(runs)).toEqual(['p:done']);
	});
	it('includes open asks, review, failure, non-handoff escalations and only named passed checks', () => {
		const now = '2026-10-01T00:00:00.000Z';
		const handoff: PianolaDecisionRecord = {
			...decision,
			id: 'h',
			decision: { action: 'escalate', matchedRuleId: null, reason: 'Handed off to Pianola' },
		};
		const runs = {
			'p:done': {
				id: 'run',
				completedAt: '2026-09-30T23:00:00.000Z',
				checks: [{ name: 'build', status: 'passed' }],
			},
		};
		const first = derivePianolaBrief([program], [plan], [ask], [decision, handoff], runs, now);
		expect(first.needsMe.map((item) => item.kind)).toEqual([
			'ask',
			'needs_review',
			'failed',
			'escalation',
		]);
		expect(first.inFlight.map((item) => item.taskId)).toEqual(['work']);
		expect(first.verified).toEqual([]);
		const failedCheck = derivePianolaBrief(
			[program],
			[plan],
			[ask],
			[],
			{
				'p:done': {
					...runs['p:done'],
					checks: [
						{ name: 'independent-validation', status: 'failed' },
						{ name: 'build', status: 'passed' },
					],
				},
			},
			now
		);
		expect(failedCheck.verified).toEqual([]);
		const passed = derivePianolaBrief(
			[program],
			[plan],
			[ask],
			[decision],
			{
				'p:done': {
					...runs['p:done'],
					checks: [{ name: 'independent-validation', status: 'passed' }],
				},
			},
			now
		);
		expect(passed.verified).toEqual([
			expect.objectContaining({
				taskId: 'done',
				checkName: 'independent-validation',
				runId: 'run',
			}),
		]);
		expect(passed.programs[0]).toMatchObject({
			activePlanId: 'p',
			openAsks: 1,
			running: 1,
			verifiedLast7d: 1,
		});
	});
});
