/**
 * Tests for dynamic per-source CUE_OUTPUT_* and CUE_FORWARDED_* template
 * variable substitution in substituteTemplateVariables.
 *
 * These variables are populated from the `cue.output_<NAME>` and
 * `cue.forwarded_<NAME>` context keys produced by the template context
 * builder from perSourceOutputs/forwardedOutputs event payload maps.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	substituteTemplateVariables,
	TemplateContext,
	TemplateSessionInfo,
} from '../../shared/templateVariables';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTestSession(overrides: Partial<TemplateSessionInfo> = {}): TemplateSessionInfo {
	return {
		id: 'test-session',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/tmp/project',
		...overrides,
	};
}

function createTestContext(overrides: Partial<TemplateContext> = {}): TemplateContext {
	return {
		session: createTestSession(),
		...overrides,
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('substituteTemplateVariables — per-source upstream output', () => {
	// Pin Date so date/time variables don't interfere with assertions
	const mockDate = new Date('2026-04-15T10:00:00.000Z');

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(mockDate);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('CUE_OUTPUT_<NAME> substitution', () => {
		it('replaces {{CUE_OUTPUT_AGENT_A}} with the per-source output value', () => {
			const context = createTestContext({
				cue: {
					output_AGENT_A: 'hello from A',
				} as any,
			});

			const result = substituteTemplateVariables('Analyze: {{CUE_OUTPUT_AGENT_A}}', context);

			expect(result).toBe('Analyze: hello from A');
		});

		it('replaces multiple per-source output variables in the same template', () => {
			const context = createTestContext({
				cue: {
					output_AGENT_A: 'result-a',
					output_AGENT_B: 'result-b',
				} as any,
			});

			const result = substituteTemplateVariables(
				'A: {{CUE_OUTPUT_AGENT_A}}, B: {{CUE_OUTPUT_AGENT_B}}',
				context
			);

			expect(result).toBe('A: result-a, B: result-b');
		});
	});

	describe('CUE_FORWARDED_<NAME> substitution', () => {
		it('replaces {{CUE_FORWARDED_AGENT_B}} with the forwarded output value', () => {
			const context = createTestContext({
				cue: {
					forwarded_AGENT_B: 'fwd-from-b',
				} as any,
			});

			const result = substituteTemplateVariables('Forward: {{CUE_FORWARDED_AGENT_B}}', context);

			expect(result).toBe('Forward: fwd-from-b');
		});
	});

	describe('case insensitivity', () => {
		it('substitutes {{cue_output_agent_a}} (lowercase) with the correct value', () => {
			const context = createTestContext({
				cue: {
					output_AGENT_A: 'hello',
				} as any,
			});

			const result = substituteTemplateVariables('Result: {{cue_output_agent_a}}', context);

			expect(result).toBe('Result: hello');
		});

		it('substitutes {{Cue_Forwarded_Agent_B}} (mixed case) with the correct value', () => {
			const context = createTestContext({
				cue: {
					forwarded_AGENT_B: 'fwd',
				} as any,
			});

			const result = substituteTemplateVariables('Got: {{Cue_Forwarded_Agent_B}}', context);

			expect(result).toBe('Got: fwd');
		});
	});

	describe('no per-source outputs', () => {
		it('leaves {{CUE_OUTPUT_AGENT_X}} unreplaced when no cue context exists', () => {
			const context = createTestContext();

			const result = substituteTemplateVariables('Value: {{CUE_OUTPUT_AGENT_X}}', context);

			// No cue context → variable not in replacements map → left as-is
			expect(result).toBe('Value: {{CUE_OUTPUT_AGENT_X}}');
		});

		it('leaves {{CUE_OUTPUT_AGENT_X}} unreplaced when cue context has no matching key', () => {
			const context = createTestContext({
				cue: {
					eventType: 'agent.completed',
				},
			});

			const result = substituteTemplateVariables('Value: {{CUE_OUTPUT_AGENT_X}}', context);

			expect(result).toBe('Value: {{CUE_OUTPUT_AGENT_X}}');
		});
	});

	describe('coexistence with standard CUE variables', () => {
		it('substitutes both standard CUE_SOURCE_OUTPUT and dynamic CUE_OUTPUT_AGENT_A', () => {
			const context = createTestContext({
				cue: {
					sourceOutput: 'combined output',
					output_AGENT_A: 'individual-a',
				} as any,
			});

			const result = substituteTemplateVariables(
				'All: {{CUE_SOURCE_OUTPUT}} | Just A: {{CUE_OUTPUT_AGENT_A}}',
				context
			);

			expect(result).toBe('All: combined output | Just A: individual-a');
		});
	});
});
