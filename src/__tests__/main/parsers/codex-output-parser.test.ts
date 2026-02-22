import { describe, it, expect } from 'vitest';
import { CodexOutputParser } from '../../../main/parsers/codex-output-parser';

describe('CodexOutputParser', () => {
	const parser = new CodexOutputParser();

	describe('agentId', () => {
		it('should be codex', () => {
			expect(parser.agentId).toBe('codex');
		});
	});

	describe('parseJsonLine', () => {
		it('should return null for empty lines', () => {
			expect(parser.parseJsonLine('')).toBeNull();
			expect(parser.parseJsonLine('  ')).toBeNull();
			expect(parser.parseJsonLine('\n')).toBeNull();
		});

		describe('thread.started events', () => {
			it('should parse thread.started as init with thread_id as sessionId', () => {
				const line = JSON.stringify({
					type: 'thread.started',
					thread_id: '019b29f7-ff2c-78f1-8bcb-ffb434a8e802',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('init');
				expect(event?.sessionId).toBe('019b29f7-ff2c-78f1-8bcb-ffb434a8e802');
			});
		});

		describe('turn.started events', () => {
			it('should parse turn.started as system event', () => {
				const line = JSON.stringify({
					type: 'turn.started',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
			});
		});

		describe('item.completed events - reasoning', () => {
			it('should parse reasoning items as partial text', () => {
				const line = JSON.stringify({
					type: 'item.completed',
					item: {
						id: 'item_0',
						type: 'reasoning',
						text: '**Thinking about the task**\n\nI need to analyze...',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('text');
				// formatReasoningText adds \n\n before **section** markers for readability
				expect(event?.text).toBe('\n\n**Thinking about the task**\n\nI need to analyze...');
				expect(event?.isPartial).toBe(true);
			});
		});

		describe('item.completed events - agent_message', () => {
			it('should parse agent_message items as result (final response)', () => {
				const line = JSON.stringify({
					type: 'item.completed',
					item: {
						id: 'item_1',
						type: 'agent_message',
						text: 'Hello! I understand you want me to help with...',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('result');
				expect(event?.text).toBe('Hello! I understand you want me to help with...');
				expect(event?.isPartial).toBe(false);
			});
		});

		describe('item.completed events - tool_call', () => {
			it('should parse tool_call items as tool_use', () => {
				const line = JSON.stringify({
					type: 'item.completed',
					item: {
						id: 'item_2',
						type: 'tool_call',
						tool: 'shell',
						args: { command: ['ls', '-la'] },
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBe('shell');
				expect(event?.toolState).toEqual({
					status: 'running',
					input: { command: ['ls', '-la'] },
				});
			});
		});

		describe('item.completed events - tool_result', () => {
			it('should parse tool_result items with string output', () => {
				const line = JSON.stringify({
					type: 'item.completed',
					item: {
						id: 'item_3',
						type: 'tool_result',
						output: 'total 64\ndrwxr-xr-x  12 user...',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('tool_use');
				expect(event?.toolState).toEqual({
					status: 'completed',
					output: 'total 64\ndrwxr-xr-x  12 user...',
				});
			});

			it('should decode tool_result byte array output', () => {
				// Codex sometimes returns command output as byte arrays
				const byteArray = [72, 101, 108, 108, 111]; // "Hello"
				const line = JSON.stringify({
					type: 'item.completed',
					item: {
						id: 'item_4',
						type: 'tool_result',
						output: byteArray,
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('tool_use');
				expect(event?.toolState).toEqual({
					status: 'completed',
					output: 'Hello',
				});
			});
		});

		describe('turn.completed events', () => {
			it('should parse turn.completed as usage event with usage stats', () => {
				const line = JSON.stringify({
					type: 'turn.completed',
					usage: {
						input_tokens: 3492,
						output_tokens: 15,
						cached_input_tokens: 3072,
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('usage');
				expect(event?.usage?.inputTokens).toBe(3492);
				expect(event?.usage?.outputTokens).toBe(15);
				expect(event?.usage?.cacheReadTokens).toBe(3072);
			});

			it('should include reasoning_output_tokens in output total', () => {
				const line = JSON.stringify({
					type: 'turn.completed',
					usage: {
						input_tokens: 1000,
						output_tokens: 100,
						reasoning_output_tokens: 50,
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.usage?.outputTokens).toBe(150); // 100 + 50
			});

			it('should handle turn.completed without usage stats', () => {
				const line = JSON.stringify({
					type: 'turn.completed',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('usage');
				expect(event?.usage).toBeUndefined();
			});
		});

		describe('error events', () => {
			it('should parse error type messages', () => {
				const line = JSON.stringify({
					type: 'error',
					error: 'Rate limit exceeded',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('Rate limit exceeded');
			});

			it('should parse messages with error field', () => {
				const line = JSON.stringify({
					error: 'Connection failed',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('Connection failed');
			});

			it('should parse error messages with object error field', () => {
				const line = JSON.stringify({
					type: 'error',
					error: { message: 'Model not found', type: 'invalid_request_error' },
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('Model not found');
			});
		});

		describe('turn.failed events', () => {
			it('should parse turn.failed with nested error message', () => {
				const line = JSON.stringify({
					type: 'turn.failed',
					error: {
						message:
							'stream disconnected before completion: The model gpt-5.3-codex does not exist or you do not have access to it.',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('error');
				expect(event?.text).toContain('gpt-5.3-codex does not exist');
			});

			it('should parse turn.failed with string error', () => {
				const line = JSON.stringify({
					type: 'turn.failed',
					error: 'API connection lost',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('API connection lost');
			});

			it('should parse turn.failed with no error details', () => {
				const line = JSON.stringify({
					type: 'turn.failed',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('Turn failed');
			});
		});

		it('should handle invalid JSON as text', () => {
			const event = parser.parseJsonLine('not valid json');
			expect(event).not.toBeNull();
			expect(event?.type).toBe('text');
			expect(event?.text).toBe('not valid json');
		});

		it('should preserve raw message', () => {
			const original = {
				type: 'thread.started',
				thread_id: 'test-123',
			};
			const line = JSON.stringify(original);

			const event = parser.parseJsonLine(line);
			expect(event?.raw).toEqual(original);
		});
	});

	describe('isResultMessage', () => {
		it('should return true for agent_message events with text', () => {
			// agent_message items contain the actual response text and are marked as 'result'
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'agent_message', text: 'hi' },
				})
			);
			expect(event).not.toBeNull();
			expect(parser.isResultMessage(event!)).toBe(true);
		});

		it('should return false for non-result events', () => {
			const initEvent = parser.parseJsonLine(
				JSON.stringify({ type: 'thread.started', thread_id: 'test-123' })
			);
			expect(parser.isResultMessage(initEvent!)).toBe(false);

			// turn.completed is a usage event, not a result
			const usageEvent = parser.parseJsonLine(JSON.stringify({ type: 'turn.completed' }));
			expect(parser.isResultMessage(usageEvent!)).toBe(false);

			// reasoning is partial text, not a final result
			const reasoningEvent = parser.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'reasoning', text: 'thinking...' },
				})
			);
			expect(parser.isResultMessage(reasoningEvent!)).toBe(false);
		});
	});

	describe('extractSessionId', () => {
		it('should extract session ID from thread.started message', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'thread.started', thread_id: 'codex-xyz' })
			);
			expect(parser.extractSessionId(event!)).toBe('codex-xyz');
		});

		it('should return null when no session ID', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'turn.started' }));
			expect(parser.extractSessionId(event!)).toBeNull();
		});
	});

	describe('extractUsage', () => {
		it('should extract usage from turn.completed message', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'turn.completed',
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cached_input_tokens: 20,
					},
				})
			);

			const usage = parser.extractUsage(event!);
			expect(usage).not.toBeNull();
			expect(usage?.inputTokens).toBe(100);
			expect(usage?.outputTokens).toBe(50);
			expect(usage?.cacheReadTokens).toBe(20);
			expect(usage?.cacheCreationTokens).toBe(0); // Codex doesn't report this
		});

		it('should return null when no usage stats', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'thread.started', thread_id: 'test-123' })
			);
			expect(parser.extractUsage(event!)).toBeNull();
		});

		it('should handle zero tokens', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'turn.completed',
					usage: {
						input_tokens: 0,
						output_tokens: 0,
					},
				})
			);

			const usage = parser.extractUsage(event!);
			expect(usage?.inputTokens).toBe(0);
			expect(usage?.outputTokens).toBe(0);
		});
	});

	describe('extractSlashCommands', () => {
		it('should return null - Codex does not support slash commands', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'thread.started', thread_id: 'test-123' })
			);
			expect(parser.extractSlashCommands(event!)).toBeNull();
		});
	});

	describe('edge cases', () => {
		it('should handle item.completed without item.type', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'item.completed', item: {} }));
			expect(event?.type).toBe('system');
		});

		it('should handle item.completed without item', () => {
			const event = parser.parseJsonLine(JSON.stringify({ type: 'item.completed' }));
			// Should be caught by transformMessage default case
			expect(event?.type).toBe('system');
		});

		it('should handle missing text in agent_message', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'agent_message' },
				})
			);
			// agent_message is now a result type
			expect(event?.type).toBe('result');
			expect(event?.text).toBe('');
		});

		it('should handle missing args in tool_call', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'tool_call', tool: 'shell' },
				})
			);
			expect(event?.type).toBe('tool_use');
			expect(event?.toolName).toBe('shell');
			expect(event?.toolState).toEqual({
				status: 'running',
				input: undefined,
			});
		});

		it('should handle missing output in tool_result', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'tool_result' },
				})
			);
			expect(event?.type).toBe('tool_use');
			expect(event?.toolState).toEqual({
				status: 'completed',
				output: '',
			});
		});

		it('should handle unknown message types as system', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({ type: 'unknown.type', data: 'something' })
			);
			expect(event?.type).toBe('system');
		});

		it('should handle messages without type', () => {
			const event = parser.parseJsonLine(JSON.stringify({ data: 'some data' }));
			expect(event?.type).toBe('system');
		});
	});

	describe('tool name carryover', () => {
		it('should carry tool name from tool_call to subsequent tool_result', () => {
			const p = new CodexOutputParser();
			// First: tool_call with tool name
			const callLine = JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_call', tool: 'shell', args: { command: ['ls'] } },
			});
			p.parseJsonLine(callLine);

			// Then: tool_result without tool name
			const resultLine = JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_result', output: 'file1.txt\nfile2.txt' },
			});
			const event = p.parseJsonLine(resultLine);
			expect(event?.toolName).toBe('shell');
			expect(event?.toolState?.status).toBe('completed');
		});

		it('should reset lastToolName after tool_result consumption', () => {
			const p = new CodexOutputParser();
			// tool_call → tool_result (consumes name) → another tool_result (no name)
			p.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'tool_call', tool: 'shell', args: {} },
				})
			);
			p.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'tool_result', output: 'ok' },
				})
			);
			const orphan = p.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'tool_result', output: 'orphan' },
				})
			);
			expect(orphan?.toolName).toBeUndefined();
		});
	});

	describe('tool output truncation', () => {
		it('should truncate tool output exceeding 10000 chars', () => {
			const p = new CodexOutputParser();
			const longOutput = 'x'.repeat(15000);
			const line = JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_result', output: longOutput },
			});
			const event = p.parseJsonLine(line);
			expect(event?.toolState?.output).toContain('... [output truncated, 15000 chars total]');
			// The truncated output should start with 10000 'x' chars
			expect(event?.toolState?.output?.startsWith('x'.repeat(10000))).toBe(true);
		});

		it('should not truncate tool output within limit', () => {
			const p = new CodexOutputParser();
			const shortOutput = 'x'.repeat(5000);
			const line = JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_result', output: shortOutput },
			});
			const event = p.parseJsonLine(line);
			expect(event?.toolState?.output).toBe(shortOutput);
		});
	});

	describe('detectErrorFromLine', () => {
		it('should return null for empty lines', () => {
			expect(parser.detectErrorFromLine('')).toBeNull();
			expect(parser.detectErrorFromLine('   ')).toBeNull();
		});

		it('should detect authentication errors from JSON', () => {
			const line = JSON.stringify({ type: 'error', error: 'invalid api key' });
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('auth_expired');
			expect(error?.agentId).toBe('codex');
		});

		it('should detect rate limit errors from JSON', () => {
			const line = JSON.stringify({ error: 'rate limit exceeded' });
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('rate_limited');
		});

		it('should detect token exhaustion errors from JSON', () => {
			const line = JSON.stringify({ type: 'error', error: 'maximum tokens exceeded' });
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('token_exhaustion');
		});

		it('should detect errors from turn.failed JSON with object error', () => {
			const line = JSON.stringify({
				type: 'turn.failed',
				error: {
					message:
						'stream disconnected before completion: The model gpt-5.3-codex does not exist or you do not have access to it.',
				},
			});
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			// Matches "model.*does not exist" pattern in agent_crashed
			expect(error?.type).toBe('agent_crashed');
			expect(error?.agentId).toBe('codex');
			expect(error?.recoverable).toBe(true);
			expect(error?.parsedJson).toBeDefined();
		});

		it('should detect errors from turn.failed JSON with string error', () => {
			const line = JSON.stringify({
				type: 'turn.failed',
				error: 'rate limit exceeded',
			});
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('rate_limited');
			expect(error?.agentId).toBe('codex');
		});

		it('should NOT detect errors from plain text (only JSON)', () => {
			// Plain text errors should come through stderr or exit codes, not stdout
			expect(parser.detectErrorFromLine('invalid api key')).toBeNull();
			expect(parser.detectErrorFromLine('rate limit exceeded')).toBeNull();
			expect(parser.detectErrorFromLine('maximum tokens exceeded')).toBeNull();
		});

		it('should return null for non-error lines', () => {
			expect(parser.detectErrorFromLine('normal output')).toBeNull();
		});

		it('should include parsedJson on matched pattern errors', () => {
			const line = JSON.stringify({ type: 'error', error: 'rate limit exceeded' });
			const error = parser.detectErrorFromLine(line);
			expect(error?.parsedJson).toBeDefined();
		});
	});

	describe('detectErrorFromExit', () => {
		it('should return null for exit code 0', () => {
			expect(parser.detectErrorFromExit(0, '', '')).toBeNull();
		});

		it('should detect errors from stderr', () => {
			const error = parser.detectErrorFromExit(1, 'invalid api key', '');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('auth_expired');
		});

		it('should detect errors from stdout', () => {
			const error = parser.detectErrorFromExit(1, '', 'rate limit exceeded');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('rate_limited');
		});

		it('should return agent_crashed for unknown non-zero exit', () => {
			const error = parser.detectErrorFromExit(137, '', '');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('agent_crashed');
			expect(error?.message).toContain('137');
		});

		it('should include raw exit info', () => {
			const error = parser.detectErrorFromExit(1, 'error stderr', 'output stdout');
			expect(error?.raw).toEqual({
				exitCode: 1,
				stderr: 'error stderr',
				stdout: 'output stdout',
			});
		});
	});

	// ===== New wrapped format (v0.103.0+) tests =====

	describe('new wrapped format (v0.103.0+)', () => {
		describe('config and prompt echo lines', () => {
			it('should parse config echo as system event', () => {
				const line = JSON.stringify({
					provider: 'openai',
					workdir: '/home/user',
					sandbox: 'read-only',
					model: 'gpt-5-codex',
				});
				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
			});

			it('should parse prompt echo as system event', () => {
				const line = JSON.stringify({ prompt: 'Do something' });
				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
			});
		});

		describe('task_started events', () => {
			it('should parse task_started as init event without synthetic session ID', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'task_started', model_context_window: 272000 },
				});
				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('init');
				// task_started should NOT generate a synthetic session ID —
				// synthetic IDs can't be used with `codex exec resume` and silently
				// start new sessions. Real IDs come from thread.started events.
				expect(event?.sessionId).toBeUndefined();
			});
		});

		describe('agent_reasoning events', () => {
			it('should parse agent_reasoning as partial text', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'agent_reasoning', text: '**Deciding on response approach**' },
				});
				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('text');
				expect(event?.isPartial).toBe(true);
				expect(event?.text).toContain('Deciding on response approach');
			});
		});

		describe('agent_reasoning_section_break events', () => {
			it('should parse section break as system event', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'agent_reasoning_section_break' },
				});
				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
			});
		});

		describe('agent_message events', () => {
			it('should parse agent_message with message field as result', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'agent_message', message: 'Hey there! How can I help you today?' },
				});
				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('result');
				expect(event?.text).toBe('Hey there! How can I help you today?');
				expect(event?.isPartial).toBe(false);
			});

			it('should be recognized as result message by isResultMessage', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'agent_message', message: 'Hello' },
				});
				const event = parser.parseJsonLine(line)!;
				expect(parser.isResultMessage(event)).toBe(true);
			});
		});

		describe('token_count events', () => {
			it('should parse token_count with usage info as usage event', () => {
				const line = JSON.stringify({
					id: '0',
					msg: {
						type: 'token_count',
						info: {
							total_token_usage: {
								input_tokens: 3292,
								cached_input_tokens: 0,
								output_tokens: 32,
								reasoning_output_tokens: 0,
								total_tokens: 3324,
							},
							last_token_usage: {
								input_tokens: 3292,
								cached_input_tokens: 0,
								output_tokens: 32,
								reasoning_output_tokens: 0,
								total_tokens: 3324,
							},
							model_context_window: 272000,
						},
						rate_limits: {},
					},
				});
				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('usage');
				expect(event?.usage?.inputTokens).toBe(3292);
				expect(event?.usage?.outputTokens).toBe(32);
				expect(event?.usage?.cacheReadTokens).toBe(0);
			});

			it('should parse token_count with null info as usage event without stats', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'token_count', info: null, rate_limits: {} },
				});
				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('usage');
				expect(event?.usage).toBeUndefined();
			});

			it('should include reasoning_output_tokens in output total', () => {
				const line = JSON.stringify({
					id: '0',
					msg: {
						type: 'token_count',
						info: {
							last_token_usage: {
								input_tokens: 1000,
								output_tokens: 100,
								reasoning_output_tokens: 50,
							},
						},
					},
				});
				const event = parser.parseJsonLine(line);
				expect(event?.usage?.outputTokens).toBe(150);
				expect(event?.usage?.reasoningTokens).toBe(50);
			});
		});

		describe('tool events in new format', () => {
			it('should parse tool_call in wrapped format', () => {
				const p = new CodexOutputParser();
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'tool_call', tool: 'shell', args: { command: ['ls'] } },
				});
				const event = p.parseJsonLine(line);
				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBe('shell');
				expect(event?.toolState?.status).toBe('running');
			});

			it('should parse tool_result in wrapped format', () => {
				const p = new CodexOutputParser();
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'tool_result', output: 'file1.txt' },
				});
				const event = p.parseJsonLine(line);
				expect(event?.type).toBe('tool_use');
				expect(event?.toolState?.status).toBe('completed');
				expect(event?.toolState?.output).toBe('file1.txt');
			});
		});

		describe('error events in new format', () => {
			it('should detect error from wrapped format in detectErrorFromLine', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'error', error: 'rate limit exceeded' },
				});
				const error = parser.detectErrorFromLine(line);
				expect(error).not.toBeNull();
				expect(error?.type).toBe('rate_limited');
			});
		});

		describe('full session simulation', () => {
			it('should correctly parse a complete new-format session', () => {
				const p = new CodexOutputParser();
				const lines = [
					JSON.stringify({ provider: 'openai', model: 'gpt-5-codex' }),
					JSON.stringify({ prompt: 'Say hi' }),
					JSON.stringify({ id: '0', msg: { type: 'task_started', model_context_window: 272000 } }),
					JSON.stringify({ id: '0', msg: { type: 'token_count', info: null, rate_limits: {} } }),
					JSON.stringify({ id: '0', msg: { type: 'agent_reasoning_section_break' } }),
					JSON.stringify({ id: '0', msg: { type: 'agent_reasoning', text: '**Thinking**' } }),
					JSON.stringify({ id: '0', msg: { type: 'agent_message', message: 'Hello!' } }),
					JSON.stringify({
						id: '0',
						msg: {
							type: 'token_count',
							info: {
								total_token_usage: { input_tokens: 100, output_tokens: 10 },
								model_context_window: 272000,
							},
						},
					}),
				];

				const events = lines.map((l) => p.parseJsonLine(l)!);

				// Config and prompt are system
				expect(events[0].type).toBe('system');
				expect(events[1].type).toBe('system');
				// task_started is init without synthetic session ID
				expect(events[2].type).toBe('init');
				expect(events[2].sessionId).toBeUndefined();
				// First token_count (no info) is usage
				expect(events[3].type).toBe('usage');
				expect(events[3].usage).toBeUndefined();
				// Section break is system
				expect(events[4].type).toBe('system');
				// Reasoning is partial text
				expect(events[5].type).toBe('text');
				expect(events[5].isPartial).toBe(true);
				// Agent message is result
				expect(events[6].type).toBe('result');
				expect(events[6].text).toBe('Hello!');
				expect(p.isResultMessage(events[6])).toBe(true);
				// Final token_count is usage with stats
				expect(events[7].type).toBe('usage');
				expect(events[7].usage?.inputTokens).toBe(100);
			});
		});
	});
});
