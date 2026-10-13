/**
 * Integrity checks for src/prompts/group-chat-workflow-planning.md.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';
import {
	extractWorkflowPlanBlock,
	parseWorkflowPlan,
} from '../../main/group-chat/workflow-plan-parser';

const PROMPT_PATH = path.join(__dirname, '../../prompts/group-chat-workflow-planning.md');
const prompt = readFileSync(PROMPT_PATH, 'utf-8');

describe('group-chat-workflow-planning.md', () => {
	test('keeps plan output ordered and approval-gated', () => {
		const proseIndex = prompt.indexOf('A short prose walkthrough');
		const mermaidIndex = prompt.indexOf('A `mermaid` fenced block');
		const planIndex = prompt.indexOf('A `maestro-plan` fenced block');

		expect(proseIndex).toBeGreaterThan(-1);
		expect(mermaidIndex).toBeGreaterThan(proseIndex);
		expect(planIndex).toBeGreaterThan(mermaidIndex);
		expect(prompt).toContain('Do NOT `@mention` any agent');
		expect(prompt).toContain('do NOT emit an `!autorun` directive');
		expect(prompt).toContain('Wait for the user to say go.');
	});

	test('batches plain-text clarification without a blocking input tool', () => {
		expect(prompt).toMatch(/one concise, batched round/i);
		expect(prompt).toMatch(/stage roster, stage ordering, or completion condition/i);
		expect(prompt).toContain('Do NOT call any tool that waits for user input');
	});

	test('provides a parseable three-stage example with parallel and Auto Run stages', () => {
		const body = extractWorkflowPlanBlock(prompt);
		expect(body).not.toBeNull();

		const result = parseWorkflowPlan(body!, 'prompt-example');
		expect(result).toHaveProperty('plan');
		if ('error' in result) throw new Error(result.error);

		expect(result.plan.stages).toHaveLength(3);
		expect(result.plan.stages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ mode: 'parallel' }),
				expect.objectContaining({
					autoRun: { participantName: 'Release-Bot', filename: 'Release.md' },
				}),
			])
		);
		expect(result.plan.stages.find((stage) => stage.mode === 'parallel')?.agents).toHaveLength(2);
	});

	test('caps workflows at twelve coarse stages', () => {
		expect(prompt).toMatch(/meaningful unit of work handed to one or more agents/i);
		expect(prompt).toContain('Use no more than 12 stages.');
		expect(prompt).toContain('"maxItems": 12');
	});
});
