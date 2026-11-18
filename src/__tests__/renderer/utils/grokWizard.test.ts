import { describe, it, expect } from 'vitest';
import {
	extractGrokTextFromJsonl,
	getGrokTextDelta,
	GROK_WIZARD_DISCOVERY_ARGS,
	GROK_WIZARD_GENERATION_ARGS,
	readGrokWizardOutput,
} from '../../../renderer/utils/grokWizard';

describe('grokWizard helpers', () => {
	describe('GROK_WIZARD_DISCOVERY_ARGS', () => {
		it('bounds discovery separately from generation and leaves permissions to spawn', () => {
			expect(GROK_WIZARD_DISCOVERY_ARGS).toEqual(['--max-turns', '8', '--no-subagents']);
			expect(GROK_WIZARD_GENERATION_ARGS).toEqual(['--max-turns', '32', '--no-subagents']);
			expect(GROK_WIZARD_DISCOVERY_ARGS).not.toContain('--always-approve');
			expect(GROK_WIZARD_DISCOVERY_ARGS).not.toContain('--permission-mode');
			expect(GROK_WIZARD_DISCOVERY_ARGS).not.toContain('plan');
		});
	});

	describe('getGrokTextDelta', () => {
		it('returns text data only', () => {
			expect(getGrokTextDelta({ type: 'text', data: 'hello' })).toBe('hello');
			expect(getGrokTextDelta({ type: 'thought', data: 'thinking' })).toBeNull();
			expect(getGrokTextDelta({ type: 'text', data: '' })).toBeNull();
			expect(getGrokTextDelta({ type: 'text', data: 42 })).toBeNull();
			expect(getGrokTextDelta(null)).toBeNull();
		});
	});

	describe('extractGrokTextFromJsonl', () => {
		it('joins text deltas and skips thought', () => {
			const lines = [
				'{"type":"thought","data":"planning"}',
				'{"type":"text","data":"{\\"ready\\":"}',
				'{"type":"text","data":"true}"}',
				'{"type":"end","sessionId":"abc"}',
				'not-json',
				'',
			];
			expect(extractGrokTextFromJsonl(lines)).toBe('{"ready":true}');
		});

		it('returns null when no text deltas are present', () => {
			expect(extractGrokTextFromJsonl(['{"type":"thought","data":"x"}'])).toBeNull();
			expect(extractGrokTextFromJsonl([])).toBeNull();
		});
	});

	describe('readGrokWizardOutput', () => {
		it.each(['EndTurn', 'end_turn'])(
			'accepts complete %s streams without reasoning or tools',
			(stopReason) => {
				const answer = '{"confidence":90,"ready":true,"message":"Plan ready"}';
				const output = [
					{ type: 'thought', data: 'Do not publish this plan' },
					{ type: 'text', data: answer.slice(0, 25) },
					{ type: 'tool_call', toolCallId: 'read', toolName: 'read_file' },
					{
						type: 'tool_call_update',
						toolCallId: 'read',
						status: 'completed',
						content: [{ type: 'text', text: 'Private tool result' }],
					},
					{ type: 'text', data: answer.slice(25) },
					{ type: 'end', stopReason, sessionId: 'synthetic-native-id' },
				]
					.map((event) => JSON.stringify(event))
					.join('\n');
				expect(readGrokWizardOutput(output)).toEqual({ text: answer, error: undefined });
			}
		);

		it.each([
			{ type: 'end', stopReason: 'cancelled' },
			{ type: 'end', stopReason: 'refusal' },
			{ type: 'end', stopReason: 'max_tokens' },
			{ type: 'end', stopReason: 'max_turn_requests' },
			{ type: 'max_turns_reached' },
			{ type: 'end', stopReason: 'error' },
			{ type: 'end', stopReason: 'unknown' },
			{ type: 'end' },
			{ type: 'end', stopReason: 42 },
			{ type: 'end', stopReason: 'end_turn', structured_output_error: 'schema failed' },
			{ type: 'end', stopReason: 'end_turn', error: { message: 'denied' } },
			{ type: 'error', message: 'Permission denied' },
		])('never completes partial text after %j, even with a later success', (terminal) => {
			const output = [
				JSON.stringify({ type: 'text', data: 'Partial plan' }),
				JSON.stringify(terminal),
				'{"type":"end","stopReason":"end_turn"}',
			].join('\n');
			expect(readGrokWizardOutput(output)).toEqual({ text: '', error: expect.any(String) });
		});

		it.each([
			'{"type":"text","data":"Partial plan"}',
			'{"type":"text","data":"Partial plan"}\n{"type":"end",',
			'{"type":"text","data":"Partial plan"}\n[]\n{"type":"end","stopReason":"end_turn"}',
		])('rejects absent or malformed completion: %s', (output) => {
			expect(readGrokWizardOutput(output)).toEqual({ text: '', error: expect.any(String) });
		});

		it('allows a partial preview without certifying completion or exposing thought', () => {
			const output = '{"type":"thought","data":"Hidden"}\n{"type":"text","data":"Preview"}';
			expect(readGrokWizardOutput(output, false)).toEqual({ text: 'Preview' });
			expect(readGrokWizardOutput(output)).toEqual({ text: '', error: expect.any(String) });
			expect(readGrokWizardOutput('{"type":"thought","data":"Hidden"}', false)).toEqual({
				text: '',
			});
		});

		it('keeps a successful thought-only stream empty instead of falling back to raw JSONL', () => {
			expect(
				readGrokWizardOutput(
					'{"type":"thought","data":"Plan"}\n{"type":"end","stopReason":"end_turn"}'
				)
			).toEqual({ text: '', error: undefined });
		});

		it('preserves normalized Markdown, embedded JSON examples and the full long answer', () => {
			const answer =
				'# Plan\n```json\n{"type":"error","message":"example"}\n```\n' +
				'Task detail\n'.repeat(10000) +
				'END OF PLAN';
			expect(readGrokWizardOutput(answer)).toEqual({ text: answer });
			const stream = [
				JSON.stringify({ type: 'text', data: answer }),
				'{"type":"end","stopReason":"end_turn"}',
			].join('\n');
			expect(readGrokWizardOutput(stream)).toEqual({ text: answer, error: undefined });
		});
	});
});
