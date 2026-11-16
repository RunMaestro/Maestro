/**
 * Per-call timing marks each provider's parser reads off its live stream
 * (`AgentOutputParser.extractCallTiming`), and what a `StreamCallTimer` makes of
 * a realistic event sequence. These marks are how providers with no timed
 * transcript get token speed.
 */

import { describe, it, expect } from 'vitest';
import { ClaudeOutputParser } from '../../../main/parsers/claude-output-parser';
import { QwenOutputParser } from '../../../main/parsers/qwen-output-parser';
import { OpenCodeOutputParser } from '../../../main/parsers/opencode-output-parser';
import { PiOutputParser } from '../../../main/parsers/pi-output-parser';
import { OmpOutputParser } from '../../../main/parsers/omp-output-parser';
import { CopilotOutputParser } from '../../../main/parsers/copilot-output-parser';
import { StreamCallTimer, type CallTimingSignal } from '../../../shared/tokenSpeed';

/** Feed events to a timer one second apart (plus any extra gap) and collect the calls. */
function timeEvents(
	timing: (raw: unknown) => CallTimingSignal | null,
	events: Array<{ raw: unknown; gapMs?: number }>
) {
	const timer = new StreamCallTimer();
	let now = 1_000_000;
	const calls = [];
	for (const { raw, gapMs = 1_000 } of events) {
		now += gapMs;
		const signal = timing(raw);
		if (signal) calls.push(...timer.signal(signal, now));
	}
	calls.push(...timer.finish());
	return calls;
}

describe('Claude stream call timing (SSH-hosted Claude Code, qwen3-coder)', () => {
	const parser = new ClaudeOutputParser();
	const timing = (raw: unknown) => parser.extractCallTiming(raw);

	it('starts at init and tool results, ends at the assistant message with usage', () => {
		expect(timing({ type: 'system', subtype: 'init', session_id: 's' })).toEqual({ kind: 'start' });
		expect(timing({ type: 'user', message: { content: [] } })).toEqual({ kind: 'start' });
		expect(
			timing({
				type: 'assistant',
				message: {
					id: 'msg_1',
					model: 'claude-opus-5-5',
					usage: {
						input_tokens: 10,
						cache_creation_input_tokens: 20,
						cache_read_input_tokens: 70,
						output_tokens: 5,
					},
				},
			})
		).toEqual({
			kind: 'end',
			key: 'msg_1',
			model: 'claude-opus-5-5',
			inputTokens: 100,
			outputTokens: 5,
		});
		expect(timing({ type: 'result', usage: {} })).toBeNull();
	});

	it('ignores subagent messages and synthetic assistant messages', () => {
		expect(timing({ type: 'user', parent_tool_use_id: 'toolu_1' })).toBeNull();
		expect(
			timing({
				type: 'assistant',
				parent_tool_use_id: 'toolu_1',
				message: { id: 'm', usage: { output_tokens: 1 } },
			})
		).toBeNull();
		expect(
			timing({ type: 'assistant', message: { id: 'm', model: '<synthetic>', usage: {} } })
		).toBeNull();
	});

	it('times one call per message id across repeated content blocks', () => {
		const assistant = (outputTokens: number) => ({
			type: 'assistant',
			message: {
				id: 'msg_1',
				model: 'm',
				usage: { input_tokens: 1000, output_tokens: outputTokens },
			},
		});
		const calls = timeEvents(timing, [
			{ raw: { type: 'system', subtype: 'init' } },
			{ raw: assistant(30), gapMs: 3_000 },
			{ raw: assistant(80) },
			{ raw: { type: 'user' }, gapMs: 20_000 },
		]);
		expect(calls).toEqual([
			{ endMs: 1_005_000, durationMs: 4_000, model: 'm', inputTokens: 1000, outputTokens: 80 },
		]);
	});

	it('qwen3-coder inherits it, including its session_start init', () => {
		const qwen = new QwenOutputParser();
		expect(qwen.extractCallTiming({ type: 'system', subtype: 'session_start' })).toEqual({
			kind: 'start',
		});
	});
});

describe('OpenCode stream call timing', () => {
	const parser = new OpenCodeOutputParser();
	const timing = (raw: unknown) => parser.extractCallTiming(raw);
	const stepFinish = (reason: string) => ({
		type: 'step_finish',
		part: {
			reason,
			tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 800, write: 100 } },
		},
	});

	it('times a tool-free step from step_start to step_finish', () => {
		const calls = timeEvents(timing, [
			{ raw: { type: 'step_start' } },
			{ raw: { type: 'text', part: { text: 'hi' } } },
			{ raw: stepFinish('stop'), gapMs: 2_000 },
		]);
		expect(calls).toEqual([
			expect.objectContaining({ durationMs: 3_000, inputTokens: 1000, outputTokens: 50 }),
		]);
	});

	it('discards a step that ran a tool, whose window includes the tool run', () => {
		const calls = timeEvents(timing, [
			{ raw: { type: 'step_start' } },
			{ raw: { type: 'tool_use', part: { tool: 'bash' } } },
			{ raw: stepFinish('tool-calls'), gapMs: 30_000 },
		]);
		expect(calls).toEqual([]);
	});
});

describe('Pi and Oh My Pi stream call timing', () => {
	const assistantEnd = {
		type: 'message_end',
		message: {
			role: 'assistant',
			model: 'gpt-5.5',
			usage: { input: 200, output: 60, cacheRead: 700, cacheWrite: 100 },
		},
	};

	for (const [name, parser] of [
		['pi', new PiOutputParser()],
		['omp', new OmpOutputParser()],
	] as const) {
		it(`${name}: starts at turn_start and tool results, ends at the assistant message_end`, () => {
			const timing = (raw: unknown) => parser.extractCallTiming(raw);
			expect(timing({ type: 'turn_start' })).toEqual({ kind: 'start' });
			expect(timing({ type: 'tool_execution_end' })).toEqual({ kind: 'start' });
			expect(timing({ type: 'message_end', message: { role: 'user' } })).toEqual({
				kind: 'start',
			});
			expect(timing(assistantEnd)).toEqual({
				kind: 'end',
				model: 'gpt-5.5',
				inputTokens: 1000,
				outputTokens: 60,
			});
			expect(timing({ type: 'message_update' })).toBeNull();

			const calls = timeEvents(timing, [
				{ raw: { type: 'turn_start' } },
				{ raw: assistantEnd, gapMs: 5_000 },
				{ raw: { type: 'tool_execution_start' } },
				{ raw: { type: 'tool_execution_end' }, gapMs: 60_000 },
				{ raw: assistantEnd, gapMs: 2_000 },
			]);
			// Tool time (60s) lands in neither call.
			expect(calls.map((c) => c.durationMs)).toEqual([5_000, 2_000]);
		});
	}
});

describe('Copilot CLI stream call timing', () => {
	const parser = new CopilotOutputParser();
	const timing = (raw: unknown) => parser.extractCallTiming(raw);

	it('measures output speed only, from turn start to the assistant message', () => {
		expect(timing({ type: 'assistant.turn_start' })).toEqual({ kind: 'start' });
		expect(timing({ type: 'tool.execution_complete' })).toEqual({ kind: 'start' });
		expect(timing({ type: 'assistant.message', data: { outputTokens: 120 } })).toEqual({
			kind: 'end',
			inputTokens: 0,
			outputTokens: 120,
		});
	});

	it('ignores subagent replies and messages without a token count', () => {
		expect(
			timing({ type: 'assistant.message', data: { outputTokens: 5, parentToolCallId: 't1' } })
		).toBeNull();
		expect(timing({ type: 'assistant.message', data: {} })).toBeNull();
	});
});
