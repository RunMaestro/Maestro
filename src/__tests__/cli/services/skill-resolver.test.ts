import { describe, expect, it } from 'vitest';
import { buildSkillPromptBlock, type ResolvedSkill } from '../../../cli/services/skill-resolver';

function makeSkill(overrides: Partial<ResolvedSkill> = {}): ResolvedSkill {
	return {
		name: 'code-review',
		source: 'project',
		filePath: '/tmp/.claude/skills/code-review/SKILL.md',
		description: 'Review existing patterns before editing.',
		instructions: 'Inspect the existing code paths first.\nKeep edits narrow.\nRun focused tests.',
		...overrides,
	};
}

describe('skill-resolver', () => {
	describe('buildSkillPromptBlock', () => {
		it('builds compact skill briefs without source or path metadata', () => {
			const block = buildSkillPromptBlock([makeSkill()], 'brief');

			expect(block).toContain('## Skill Briefs');
			expect(block).toContain(
				'- code-review: Review existing patterns before editing. Inspect the existing code paths first. Keep edits narrow. Run focused tests.'
			);
			expect(block).not.toContain('Source:');
			expect(block).not.toContain('Path:');
			expect(block).not.toContain('/tmp/.claude/skills/code-review/SKILL.md');
		});

		it('keeps full mode free of source-path prompt noise', () => {
			const block = buildSkillPromptBlock(
				[
					makeSkill({
						instructions: '# Heading\n\nDetailed instruction one.\n\nDetailed instruction two.',
					}),
				],
				'full'
			);

			expect(block).toContain('## Project Skills');
			expect(block).toContain('### code-review');
			expect(block).toContain('Detailed instruction one.');
			expect(block).not.toContain('Source:');
			expect(block).not.toContain('Path:');
		});

		it('truncates oversized briefs and enforces an overall skill budget', () => {
			const repeatedInstruction = Array.from(
				{ length: 30 },
				(_, index) =>
					`Step ${index + 1} explains a long skill rule that should not all fit in the Auto Run prompt budget.`
			).join('\n');
			const block = buildSkillPromptBlock(
				[
					makeSkill({
						name: 'code-review',
						instructions: repeatedInstruction,
					}),
					makeSkill({
						name: 'test-gen',
						filePath: '/tmp/.claude/skills/test-gen/SKILL.md',
						description: 'Generate narrowly scoped tests.',
						instructions: repeatedInstruction,
					}),
					makeSkill({
						name: 'bug-hunt',
						filePath: '/tmp/.claude/skills/bug-hunt/SKILL.md',
						description: 'Look for regressions before shipping.',
						instructions: repeatedInstruction,
					}),
					makeSkill({
						name: 'perf-check',
						filePath: '/tmp/.claude/skills/perf-check/SKILL.md',
						description: 'Watch for unnecessary token expansion.',
						instructions: repeatedInstruction,
					}),
					makeSkill({
						name: 'doc-sync',
						filePath: '/tmp/.claude/skills/doc-sync/SKILL.md',
						description: 'Keep docs aligned with the implementation.',
						instructions: repeatedInstruction,
					}),
					makeSkill({
						name: 'ship-small',
						filePath: '/tmp/.claude/skills/ship-small/SKILL.md',
						description: 'Prefer the smallest viable change.',
						instructions: repeatedInstruction,
					}),
				],
				'brief'
			);

			expect(block).toContain('[Additional skill guidance truncated for Auto Run budget]');
			expect(block.length).toBeLessThanOrEqual(1024);
			expect(block).not.toContain('Step 30 explains a long skill rule');
		});
	});
});
