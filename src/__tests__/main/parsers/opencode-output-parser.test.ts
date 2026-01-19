import { describe, it, expect } from 'vitest';
import { OpenCodeOutputParser } from '../../../main/parsers/opencode-output-parser';

describe('OpenCodeOutputParser', () => {
	const parser = new OpenCodeOutputParser();

	describe('agentId', () => {
		it('should be opencode', () => {
			expect(parser.agentId).toBe('opencode');
		});
	});

	describe('parseJsonLine', () => {
		it('should return null for empty lines', () => {
			expect(parser.parseJsonLine('')).toBeNull();
			expect(parser.parseJsonLine('  ')).toBeNull();
			expect(parser.parseJsonLine('\n')).toBeNull();
		});

		it('should parse step_start messages as init', () => {
			const line = JSON.stringify({
				type: 'step_start',
				sessionID: 'oc-sess-123',
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('init');
			expect(event?.sessionId).toBe('oc-sess-123');
		});

		it('should parse text messages as partial text', () => {
			const line = JSON.stringify({
				type: 'text',
				sessionID: 'oc-sess-123',
				part: {
					text: 'Analyzing your code...',
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('text');
			expect(event?.text).toBe('Analyzing your code...');
			expect(event?.sessionId).toBe('oc-sess-123');
			expect(event?.isPartial).toBe(true);
		});

		it('should parse tool_use messages', () => {
			// Actual OpenCode format: tool name in part.tool, state in part.state
			const line = JSON.stringify({
				type: 'tool_use',
				sessionID: 'oc-sess-123',
				part: {
					tool: 'view',
					state: {
						status: 'completed',
						input: { path: '/src/index.ts' },
						output: 'file contents...',
					},
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('tool_use');
			expect(event?.toolName).toBe('view');
			expect(event?.toolState).toEqual({
				status: 'completed',
				input: { path: '/src/index.ts' },
				output: 'file contents...',
			});
			expect(event?.sessionId).toBe('oc-sess-123');
		});

		it('should parse step_finish messages with reason "stop" as result', () => {
			// Actual OpenCode format: reason and tokens in part
			const line = JSON.stringify({
				type: 'step_finish',
				sessionID: 'oc-sess-123',
				part: {
					reason: 'stop',
					cost: 0.001,
					tokens: {
						input: 500,
						output: 200,
						reasoning: 0,
						cache: { read: 100, write: 50 },
					},
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('result');
			expect(event?.sessionId).toBe('oc-sess-123');
			expect(event?.usage?.inputTokens).toBe(500);
			expect(event?.usage?.outputTokens).toBe(200);
			expect(event?.usage?.cacheReadTokens).toBe(100);
			expect(event?.usage?.cacheCreationTokens).toBe(50);
			expect(event?.usage?.costUsd).toBe(0.001);
		});

		it('should parse step_finish messages with reason "tool-calls" as system', () => {
			// step_finish with reason "tool-calls" means more work is coming
			const line = JSON.stringify({
				type: 'step_finish',
				sessionID: 'oc-sess-123',
				part: {
					reason: 'tool-calls',
					tokens: { input: 100, output: 50 },
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('system');
			expect(event?.sessionId).toBe('oc-sess-123');
		});

		it('should parse error messages', () => {
			const line = JSON.stringify({
				sessionID: 'oc-sess-123',
				error: 'Connection failed: timeout',
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('error');
			expect(event?.text).toBe('Connection failed: timeout');
			expect(event?.sessionId).toBe('oc-sess-123');
		});

		it('should handle messages with only sessionID', () => {
			const line = JSON.stringify({
				sessionID: 'oc-sess-123',
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('system');
			expect(event?.sessionId).toBe('oc-sess-123');
		});

		it('should handle invalid JSON as text', () => {
			const event = parser.parseJsonLine('not valid json');
			expect(event).not.toBeNull();
			expect(event?.type).toBe('text');
			expect(event?.text).toBe('not valid json');
		});

		it('should preserve raw message', () => {
			const original = {
				type: 'step_finish',
				sessionID: 'oc-sess-123',
				part: { reason: 'stop' },
			};
			const line = JSON.stringify(original);

			const event = parser.parseJsonLine(line);
			expect(event?.raw).toEqual(original);
		});
	});

	describe('isResultMessage', () => {
		it('should return true for step_finish events with reason "stop"', () => {
			const resultEvent = parser.parseJsonLine(
				JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } })
			);
			expect(resultEvent).not.toBeNull();
			expect(parser.isResultMessage(resultEvent!)).toBe(true);
		});

		it('should return false for step_finish events with reason "tool-calls"', () => {
			const toolCallsEvent = parser.parseJsonLine(
				JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls' } })
			);
			expect(toolCallsEvent).not.toBeNull();
			expect(parser.isResultMessage(toolCallsEvent!)).toBe(false);
		});

		it('should return false for non-result events', () => {
			const initEvent = parser.parseJsonLine(
				JSON.stringify({ type: 'step_start', sessionID: 'sess-123' })
			);
			expect(initEvent).not.toBeNull();
			expect(parser.isResultMessage(initEvent!)).toBe(false);

			const textEvent = parser.parseJsonLine(
				JSON.stringify({ type: 'text', part: { text: 'hi' } })
			);
			expect(textEvent).not.toBeNull();
			expect(parser.isResultMessage(textEvent!)).toBe(false);
		});
	});

	describe('extractSessionId', () => {
		it('should extract session ID from step_start message', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'step_start', sessionID: 'oc-xyz' })
			);
			expect(parser.extractSessionId(event!)).toBe('oc-xyz');
		});

		it('should extract session ID from step_finish message', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'step_finish', sessionID: 'oc-123', part: { reason: 'stop' } })
			);
			expect(parser.extractSessionId(event!)).toBe('oc-123');
		});

		it('should return null when no session ID', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'step_start' }));
			expect(parser.extractSessionId(event!)).toBeNull();
		});
	});

	describe('extractUsage', () => {
		it('should extract usage from step_finish message', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'step_finish',
					part: {
						reason: 'stop',
						tokens: {
							input: 100,
							output: 50,
						},
					},
				})
			);

			const usage = parser.extractUsage(event!);
			expect(usage).not.toBeNull();
			expect(usage?.inputTokens).toBe(100);
			expect(usage?.outputTokens).toBe(50);
		});

		it('should return null when no usage stats', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'step_start', sessionID: 'sess-123' })
			);
			expect(parser.extractUsage(event!)).toBeNull();
		});

		it('should handle zero tokens', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'step_finish',
					part: {
						reason: 'stop',
						tokens: {
							input: 0,
							output: 0,
						},
					},
				})
			);

			const usage = parser.extractUsage(event!);
			expect(usage?.inputTokens).toBe(0);
			expect(usage?.outputTokens).toBe(0);
		});
	});

	describe('extractSlashCommands', () => {
		it('should return null - OpenCode may not support slash commands', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'step_start', sessionID: 'sess-123' })
			);
			expect(parser.extractSlashCommands(event!)).toBeNull();
		});
	});

	describe('edge cases', () => {
		it('should handle step_finish without reason', () => {
			// step_finish without reason defaults to system event
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'step_finish', sessionID: 'sess-123', part: {} })
			);
			expect(event?.type).toBe('system');
			expect(event?.sessionId).toBe('sess-123');
		});

		it('should handle step_finish with reason "stop"', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'step_finish', sessionID: 'sess-123', part: { reason: 'stop' } })
			);
			expect(event?.type).toBe('result');
			expect(event?.sessionId).toBe('sess-123');
		});

		it('should handle missing part.text', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'text', part: {} }));
			expect(event?.type).toBe('text');
			expect(event?.text).toBe('');
		});

		it('should handle missing part entirely', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'text' }));
			expect(event?.type).toBe('text');
			expect(event?.text).toBe('');
		});

		it('should handle missing tool info', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'tool_use', part: {} }));
			expect(event?.type).toBe('tool_use');
			expect(event?.toolName).toBeUndefined();
			expect(event?.toolState).toBeUndefined();
		});

		it('should handle messages without type', () => {
			const event = parser.parseJsonLine(JSON.stringify({ data: 'some data' }));
			expect(event?.type).toBe('system');
		});
	});
});
