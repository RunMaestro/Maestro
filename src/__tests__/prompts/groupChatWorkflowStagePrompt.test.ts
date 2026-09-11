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
		expect(prompt).toContain('artifacts/release-proposal.md');
	});

	test('defines exact terminal directives and clean final output', () => {
		expect(prompt).toContain('```text\n!stage-complete\n```');
		expect(prompt).toContain('```text\n!stage-failed\n```');
		expect(prompt).toMatch(/two-to-four sentence handoff summary/i);
		expect(prompt).toMatch(/Never proceed to the next stage after a failure/i);
		expect(prompt).toMatch(/final user-facing summary with no `@mentions`/i);
	});

	test('includes a worked stage turn with parallel mentions and a handoff', () => {
		expect(prompt).toContain('## Worked Example');
		expect(prompt).toContain('@Architecture Reviewer');
		expect(prompt).toContain('@Security Reviewer');
		expect(prompt).toContain('artifacts/architecture-review.md');
		expect(prompt).toContain('artifacts/security-review.md');
	});
});
