/**
 * @file plan-mode.test.ts
 * @description Tests for src/maestro-p/plan-mode.ts ExitPlanMode detection.
 *
 * Covers the read-only/plan-mode completion signal: an assistant message that
 * calls the `ExitPlanMode` tool is terminal for an interactive TUI turn (the
 * TUI parks on an approval dialog maestro-p can't answer), and its plan body is
 * carried in the tool_use input rather than a `text` block. `extractExitPlanText`
 * returns the plan body for such a message and `null` for a normal turn.
 */

import { describe, it, expect } from 'vitest';

import { extractExitPlanText } from '../../maestro-p/plan-mode';

describe('extractExitPlanText', () => {
	it('returns the plan body when the message calls ExitPlanMode', () => {
		const message = {
			stop_reason: 'tool_use',
			content: [
				{ type: 'text', text: 'Here is what I found.' },
				{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'Step 1. Do the thing.' } },
			],
		};
		expect(extractExitPlanText(message)).toBe('Step 1. Do the thing.');
	});

	it('returns an empty string when ExitPlanMode is present without a plan body', () => {
		const message = {
			content: [{ type: 'tool_use', name: 'ExitPlanMode', input: {} }],
		};
		expect(extractExitPlanText(message)).toBe('');
	});

	it('returns an empty string when the plan input is not a string', () => {
		const message = {
			content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 42 } }],
		};
		expect(extractExitPlanText(message)).toBe('');
	});

	it('returns null for a normal end_turn message with no tool calls', () => {
		const message = {
			stop_reason: 'end_turn',
			content: [{ type: 'text', text: 'Austin is in Texas.' }],
		};
		expect(extractExitPlanText(message)).toBeNull();
	});

	it('returns null for a tool_use turn that is not ExitPlanMode', () => {
		const message = {
			stop_reason: 'tool_use',
			content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } }],
		};
		expect(extractExitPlanText(message)).toBeNull();
	});

	it('finds ExitPlanMode regardless of block position', () => {
		const message = {
			content: [
				{ type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
				{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'Plan body.' } },
			],
		};
		expect(extractExitPlanText(message)).toBe('Plan body.');
	});

	it('is defensive against malformed input', () => {
		expect(extractExitPlanText(null)).toBeNull();
		expect(extractExitPlanText(undefined)).toBeNull();
		expect(extractExitPlanText('nope')).toBeNull();
		expect(extractExitPlanText({})).toBeNull();
		expect(extractExitPlanText({ content: 'not-an-array' })).toBeNull();
	});
});
