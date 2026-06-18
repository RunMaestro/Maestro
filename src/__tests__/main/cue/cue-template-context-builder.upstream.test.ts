/**
 * Tests for per-source upstream output variables in the Cue Template Context Builder.
 *
 * Verifies that `perSourceOutputs` and `forwardedOutputs` in the event
 * payload produce correctly named and sanitized template context keys
 * (e.g. `output_AGENT_A`, `forwarded_AGENT_C`).
 */

import { describe, it, expect } from 'vitest';
import { buildCueTemplateContext } from '../../../main/cue/cue-template-context-builder';
import { createCueEvent } from '../../../main/cue/cue-types';
import type { CueSubscription } from '../../../main/cue/cue-types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'test-sub',
		event: 'agent.completed',
		enabled: true,
		prompt: 'test',
		...overrides,
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('cue-template-context-builder — per-source upstream output', () => {
	describe('perSourceOutputs', () => {
		it('creates output_ keys for each source in perSourceOutputs', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				perSourceOutputs: {
					'Agent A': 'output-a',
					'Agent B': 'output-b',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub(), 'run-1');

			expect(ctx.output_AGENT_A).toBe('output-a');
			expect(ctx.output_AGENT_B).toBe('output-b');
		});

		it('does not add output_ keys when perSourceOutputs is absent', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				sourceSession: 'worker',
				sourceOutput: 'done',
			});

			const ctx = buildCueTemplateContext(event, makeSub(), 'run-1');

			// No output_* keys should exist (except base fields)
			const outputKeys = Object.keys(ctx).filter((k) => k.startsWith('output_'));
			expect(outputKeys).toHaveLength(0);
		});

		it('handles empty perSourceOutputs map', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				perSourceOutputs: {},
			});

			const ctx = buildCueTemplateContext(event, makeSub(), 'run-1');

			const outputKeys = Object.keys(ctx).filter((k) => k.startsWith('output_'));
			expect(outputKeys).toHaveLength(0);
		});
	});

	describe('forwardedOutputs', () => {
		it('creates forwarded_ keys for each source in forwardedOutputs', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				forwardedOutputs: {
					'Agent C': 'forwarded-c',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub(), 'run-1');

			expect(ctx.forwarded_AGENT_C).toBe('forwarded-c');
		});

		it('does not add forwarded_ keys when forwardedOutputs is absent', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {});

			const ctx = buildCueTemplateContext(event, makeSub(), 'run-1');

			const forwardedKeys = Object.keys(ctx).filter((k) => k.startsWith('forwarded_'));
			expect(forwardedKeys).toHaveLength(0);
		});
	});

	describe('name sanitization', () => {
		it('sanitizes special characters in session names to underscores', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				perSourceOutputs: {
					'my-agent.1': 'output-special',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub(), 'run-1');

			expect(ctx.output_MY_AGENT_1).toBe('output-special');
		});

		it('sanitizes names with multiple special characters', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				perSourceOutputs: {
					'agent--with...dots': 'value',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub(), 'run-1');

			// Multiple non-alphanumeric chars collapse to a single underscore
			expect(ctx.output_AGENT_WITH_DOTS).toBe('value');
		});

		it('strips leading and trailing non-alphanumeric from sanitized names', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				perSourceOutputs: {
					'-leading-': 'val',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub(), 'run-1');

			expect(ctx.output_LEADING).toBe('val');
		});

		it('uppercases lowercase names', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				forwardedOutputs: {
					'lowercase agent': 'fwd',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub(), 'run-1');

			expect(ctx.forwarded_LOWERCASE_AGENT).toBe('fwd');
		});
	});

	describe('combined perSourceOutputs + forwardedOutputs', () => {
		it('includes both output_ and forwarded_ keys when both maps are present', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				perSourceOutputs: {
					'Agent A': 'output-a',
				},
				forwardedOutputs: {
					'Agent B': 'forwarded-b',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub(), 'run-1');

			expect(ctx.output_AGENT_A).toBe('output-a');
			expect(ctx.forwarded_AGENT_B).toBe('forwarded-b');
		});

		it('preserves base fields alongside per-source fields', () => {
			const event = createCueEvent('agent.completed', 'chain-sub', {
				sourceSession: 'Agent A',
				sourceOutput: 'combined output',
				perSourceOutputs: {
					'Agent A': 'per-source-a',
				},
			});

			const ctx = buildCueTemplateContext(event, makeSub(), 'run-1');

			// Base source fields
			expect(ctx.sourceSession).toBe('Agent A');
			expect(ctx.sourceOutput).toBe('combined output');
			// Per-source field
			expect(ctx.output_AGENT_A).toBe('per-source-a');
		});
	});
});
