/**
 * Integrity checks for src/prompts/group-chat-workflow-stage.md.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

const PROMPT_PATH = path.join(__dirname, '../../prompts/group-chat-workflow-stage.md');
const prompt = readFileSync(PROMPT_PATH, 'utf-8');

describe('group-chat-workflow-stage.md', () => {
	test('keeps delegation scoped to the current stage roster and mode', () => {
		expect(prompt).toContain('Work ONLY on the current stage.');
		expect(prompt).toMatch(/Mention only the agents listed for that stage/i);
		expect(prompt).toMatch(/parallel stage, mention all of the stage's agents together/i);
		expect(prompt).toMatch(/serial stage with a single agent, mention exactly that one agent/i);
		expect(prompt).toMatch(/Do not run ahead to later stages/i);
	});

	test('carries summaries and artifact paths into the next stage', () => {
		expect(prompt).toMatch(/Quote its summary when the handoff is prose/i);
		expect(prompt).toMatch(/pass those exact paths/i);
		expect(prompt).toMatch(/`Full output: <absolute path>`/i);
		expect(prompt).toMatch(/include that exact absolute path in each relevant `@mention`/i);
		expect(prompt).toMatch(/explicitly tell the agent to read the file/i);
		expect(prompt).toMatch(/Do not quote or copy the artifact's full contents/i);
	});

	test('uses the run directory as the escape hatch for large deliverables', () => {
		expect(prompt).toMatch(/give its agents an artifact path in the run directory/i);
		expect(prompt).toMatch(/tell them to write their full output there/i);
		expect(prompt).toMatch(/return a short summary and the completed path/i);
	});

	test('defines exact terminal directives and clean final output', () => {
		expect(prompt).toContain('```text\n!stage-complete\n```');
		expect(prompt).toContain('```text\n!stage-failed\n```');
		expect(prompt).toMatch(/two-to-four sentence handoff summary/i);
		expect(prompt).toMatch(/keep it to a few sentences and rely on those artifact paths/i);
		expect(prompt).toMatch(/Never proceed to the next stage after a failure/i);
		expect(prompt).toMatch(/final user-facing summary with no `@mentions`/i);
	});

	test('includes a worked stage turn with parallel mentions and a handoff', () => {
		expect(prompt).toContain('## Worked Example');
		expect(prompt).toContain('@Architecture Reviewer');
		expect(prompt).toContain('@Security Reviewer');
		expect(prompt).toContain('/absolute/workflow-runs/run-42/proposal/Release_Agent.md');
		expect(prompt).toContain('/absolute/workflow-runs/run-42/review/Architecture_Reviewer.md');
		expect(prompt).toContain('/absolute/workflow-runs/run-42/review/Security_Reviewer.md');
	});
});
