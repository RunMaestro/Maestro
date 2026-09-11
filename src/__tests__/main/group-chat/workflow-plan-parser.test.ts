/**
 * @file workflow-plan-parser.test.ts
 * @description Unit tests for Group Chat workflow plan extraction, validation, and rendering.
 */

import { describe, expect, it } from 'vitest';
import {
	extractStageDirective,
	extractWorkflowPlanBlock,
	parseWorkflowPlan,
	renderWorkflowPlanSummary,
	stripStageDirectives,
} from '../../../main/group-chat/workflow-plan-parser';
import { MAX_WORKFLOW_STAGES } from '../../../shared/group-chat-workflow-types';

function validBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		title: 'Release workflow',
		stages: [
			{
				name: 'Implement',
				agents: ['Build Bot'],
				instruction: 'Implement the approved change.',
				expects: 'A tested patch',
			},
		],
		...overrides,
	});
}

function parseValid(body = validBody()) {
	const result = parseWorkflowPlan(body, 'run-123');
	expect(result).toHaveProperty('plan');
	if ('error' in result) throw new Error(result.error);
	return result.plan;
}

describe('workflow-plan-parser', () => {
	describe('stage directives', () => {
		it.each([
			['!stage-complete\nBuilt and tested the feature.', 'complete'],
			['   !stage-failed\nThe dependency is unavailable.', 'failed'],
			['**!stage-complete**\nReview passed.', 'complete'],
			['\t__!stage-failed__\nReview failed.', 'failed'],
		])('extracts %s', (text, kind) => {
			expect(extractStageDirective(text)).toEqual({
				kind,
				body: text.split('\n').slice(1).join('\n'),
			});
		});

		it('extracts a directive at the start of a later line', () => {
			expect(
				extractStageDirective('Review is finished.\n!stage-complete\nPass the patch to QA.')
			).toEqual({
				kind: 'complete',
				body: 'Pass the patch to QA.',
			});
		});

		it('supports CRLF directive lines', () => {
			expect(extractStageDirective('Intro\r\n!stage-complete\r\nHandoff')).toEqual({
				kind: 'complete',
				body: 'Handoff',
			});
		});

		it('does not match absent, inline, or extended directives', () => {
			expect(extractStageDirective('No directive here.')).toBeNull();
			expect(extractStageDirective('Result: !stage-complete')).toBeNull();
			expect(extractStageDirective('!stage-complete later')).toBeNull();
		});

		it('strips only directive lines and keeps handoff prose', () => {
			const text = [
				'Review is finished.',
				' **!stage-complete** ',
				'The tested patch is ready for QA.',
			].join('\n');

			expect(stripStageDirectives(text)).toBe(
				'Review is finished.\n\nThe tested patch is ready for QA.'
			);
		});
	});

	describe('extractWorkflowPlanBlock', () => {
		it('returns null when no plan block is present', () => {
			expect(extractWorkflowPlanBlock('A normal moderator response.')).toBeNull();
		});

		it('accepts indented CRLF fences', () => {
			const text = 'Before\r\n  ```maestro-plan\r\n  {"stages": []}\r\n  ```\r\nAfter';
			expect(extractWorkflowPlanBlock(text)).toBe('{"stages": []}');
		});

		it('takes only the first plan block', () => {
			const text = [
				'```maestro-plan',
				'{"title":"first"}',
				'```',
				'```maestro-plan',
				'{"title":"second"}',
				'```',
			].join('\n');
			expect(extractWorkflowPlanBlock(text)).toBe('{"title":"first"}');
		});
	});

	describe('parseWorkflowPlan', () => {
		it('returns a human-readable error for malformed JSON', () => {
			const result = parseWorkflowPlan('{not json}', 'run-123');
			expect(result).toHaveProperty('error');
			if ('error' in result) expect(result.error).toContain('not valid JSON');
		});

		it('rejects an empty stage list', () => {
			expect(parseWorkflowPlan(validBody({ stages: [] }), 'run-123')).toEqual({
				error: 'Workflow plan must contain at least one stage.',
			});
		});

		it('rejects more than the maximum number of stages', () => {
			const stages = Array.from({ length: MAX_WORKFLOW_STAGES + 1 }, (_, index) => ({
				name: `Stage ${index + 1}`,
				agents: ['Agent'],
				instruction: 'Work',
			}));
			const result = parseWorkflowPlan(validBody({ stages }), 'run-123');
			expect(result).toEqual({
				error: `Workflow plan cannot contain more than ${MAX_WORKFLOW_STAGES} stages.`,
			});
		});

		it('rejects a stage with no instruction', () => {
			const result = parseWorkflowPlan(
				validBody({ stages: [{ name: 'Build', agents: ['Agent'] }] }),
				'run-123'
			);
			expect(result).toEqual({
				error: 'Stage 1 must have a non-empty "instruction".',
			});
		});

		it('normalizes agent names and derives parallel mode', () => {
			const plan = parseValid(
				validBody({
					stages: [
						{
							name: 'Review',
							agents: ['Agent One', 'Agent Two [Linux]'],
							mode: 'parallel',
							instruction: 'Review the patch.',
						},
					],
				})
			);
			expect(plan.stages[0].agents).toEqual(['Agent-One', 'Agent-Two-Linux']);
			expect(plan.stages[0].mode).toBe('parallel');
		});

		it('uses serial mode unless multiple agents explicitly run in parallel', () => {
			const plan = parseValid(
				validBody({
					stages: [
						{
							name: 'Review',
							agents: ['Agent One'],
							mode: 'parallel',
							instruction: 'Review the patch.',
						},
					],
				})
			);
			expect(plan.stages[0].mode).toBe('serial');
		});

		it('backfills omitted stage ids while preserving supplied ids', () => {
			const plan = parseValid(
				validBody({
					stages: [
						{ name: 'Plan', agents: ['A'], instruction: 'Plan it.' },
						{ id: 'ship', name: 'Ship', agents: ['B'], instruction: 'Ship it.' },
					],
				})
			);
			expect(plan.stages.map((stage) => stage.id)).toEqual(['stage-1', 'ship']);
		});

		it('accepts and normalizes an autoRun-only stage', () => {
			const plan = parseValid(
				validBody({
					stages: [
						{
							name: 'Automate',
							instruction: 'Run the playbook.',
							autoRun: { participantName: 'Release Bot', filename: 'Release.md' },
						},
					],
				})
			);
			expect(plan.stages[0]).toMatchObject({
				agents: [],
				autoRun: { participantName: 'Release-Bot', filename: 'Release.md' },
			});
		});
	});

	describe('renderWorkflowPlanSummary', () => {
		it('renders stage details and a well-formed Mermaid chain', () => {
			const plan = parseValid(
				validBody({
					stages: [
						{
							name: 'Plan',
							agents: ['Planner'],
							instruction: 'Draft a plan.',
							expects: 'A written plan',
						},
						{
							name: 'Build',
							agents: ['Builder'],
							instruction: 'Build it.',
						},
					],
				})
			);
			const summary = renderWorkflowPlanSummary(plan);
			expect(summary).toContain('1. **Plan** (@Planner)');
			expect(summary).toContain('Produces: A written plan');
			expect(summary).toContain('2. **Build** (@Builder)');
			expect(summary).toContain('```mermaid\nflowchart LR');
			expect(summary).toContain('stage_1 --> stage_2');
			expect(summary.endsWith('```')).toBe(true);
		});

		it('branches parallel agents and rejoins before the next stage', () => {
			const plan = parseValid(
				validBody({
					stages: [
						{
							name: 'Review',
							agents: ['Agent A', 'Agent B'],
							mode: 'parallel',
							instruction: 'Review.',
						},
						{ name: 'Merge', agents: ['Lead'], instruction: 'Merge findings.' },
					],
				})
			);
			const summary = renderWorkflowPlanSummary(plan);
			expect(summary).toContain('stage_1 --> stage_1_agent_1');
			expect(summary).toContain('stage_1 --> stage_1_agent_2');
			expect(summary).toContain('stage_1_agent_1 --> stage_1_join');
			expect(summary).toContain('stage_1_agent_2 --> stage_1_join');
			expect(summary).toContain('stage_1_join --> stage_2');
			expect(summary).not.toContain('\tstage_1 --> stage_2');
		});

		it('strips quotes, brackets, and newlines from Mermaid stage names', () => {
			const plan = parseValid(
				validBody({
					stages: [
						{
							name: 'Review [the] "patch"\nnow',
							agents: ['Reviewer'],
							instruction: 'Review.',
						},
					],
				})
			);
			const mermaid = renderWorkflowPlanSummary(plan).split('```mermaid')[1];
			expect(mermaid).toContain('1. Review the patch now');
			expect(mermaid).not.toContain('[the]');
			expect(mermaid).not.toContain('"patch"');
		});
	});
});
