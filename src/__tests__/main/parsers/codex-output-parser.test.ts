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
			expect(error?.type).toBe('unknown');
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

	// ================================================================
	// Current format tests (Codex v0.111.0+ with --json)
	// ================================================================

	describe('session_meta events', () => {
		it('should parse session_meta as init with payload.id as sessionId', () => {
			const line = JSON.stringify({
				type: 'session_meta',
				timestamp: '2026-03-08T03:10:29.069Z',
				payload: {
					id: '019ccb6c-c0fd-7b70-92b7-558f514099c6',
					cwd: '/home/user/project',
					cli_version: '0.111.0',
					model_provider: 'openai',
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('init');
			expect(event?.sessionId).toBe('019ccb6c-c0fd-7b70-92b7-558f514099c6');
		});

		it('should handle session_meta without payload', () => {
			const line = JSON.stringify({ type: 'session_meta' });
			const event = parser.parseJsonLine(line);
			// Without payload, falls through to default case
			expect(event).not.toBeNull();
			expect(event?.type).toBe('system');
		});

		it('should handle session_meta with empty payload', () => {
			const line = JSON.stringify({ type: 'session_meta', payload: {} });
			const event = parser.parseJsonLine(line);
			expect(event?.type).toBe('init');
			expect(event?.sessionId).toBeUndefined();
		});
	});

	describe('turn_context events', () => {
		it('should parse turn_context as system event', () => {
			const line = JSON.stringify({
				type: 'turn_context',
				payload: {
					model: 'gpt-5.2-codex-max',
					model_context_window: 400000,
					turn_id: 'turn-123',
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event).not.toBeNull();
			expect(event?.type).toBe('system');
		});

		it('should update internal model and context window from turn_context', () => {
			const p = new CodexOutputParser();

			// Parse a turn_context that sets model info
			p.parseJsonLine(
				JSON.stringify({
					type: 'turn_context',
					payload: {
						model: 'o3',
						model_context_window: 200000,
					},
				})
			);

			// Verify the context window is used in subsequent usage events
			const usageEvent = p.parseJsonLine(
				JSON.stringify({
					type: 'turn.completed',
					usage: { input_tokens: 100, output_tokens: 50 },
				})
			);
			expect(usageEvent?.usage?.contextWindow).toBe(200000);
		});

		it('should handle turn_context without payload', () => {
			const line = JSON.stringify({ type: 'turn_context' });
			const event = parser.parseJsonLine(line);
			expect(event?.type).toBe('system');
		});
	});

	describe('event_msg events', () => {
		describe('agent_message type', () => {
			it('should parse commentary phase as partial text', () => {
				const line = JSON.stringify({
					type: 'event_msg',
					payload: {
						type: 'agent_message',
						message: 'Looking at the code now...',
						phase: 'commentary',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('Looking at the code now...');
				expect(event?.isPartial).toBe(true);
			});

			it('should parse non-commentary agent_message as result', () => {
				const line = JSON.stringify({
					type: 'event_msg',
					payload: {
						type: 'agent_message',
						message: 'Here is the final answer.',
						phase: 'final',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('result');
				expect(event?.text).toBe('Here is the final answer.');
				expect(event?.isPartial).toBe(false);
			});

			it('should parse agent_message without phase as result', () => {
				const line = JSON.stringify({
					type: 'event_msg',
					payload: {
						type: 'agent_message',
						message: 'Done.',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('result');
				expect(event?.text).toBe('Done.');
			});

			it('should handle agent_message with empty message', () => {
				const line = JSON.stringify({
					type: 'event_msg',
					payload: {
						type: 'agent_message',
						message: '',
					},
				});

				// Empty message falls through to system event
				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});
		});

		describe('token_count type', () => {
			it('should parse token_count as usage event', () => {
				const line = JSON.stringify({
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: {
							total_token_usage: {
								input_tokens: 5000,
								output_tokens: 1000,
								cached_input_tokens: 3000,
								reasoning_output_tokens: 200,
								total_tokens: 6200,
							},
							model_context_window: 400000,
						},
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('usage');
				expect(event?.usage?.inputTokens).toBe(5000);
				expect(event?.usage?.outputTokens).toBe(1200); // 1000 + 200 reasoning
				expect(event?.usage?.cacheReadTokens).toBe(3000);
				expect(event?.usage?.cacheCreationTokens).toBe(0);
				expect(event?.usage?.contextWindow).toBe(400000);
				expect(event?.usage?.reasoningTokens).toBe(200);
			});

			it('should use cached context window when model_context_window not in payload', () => {
				const p = new CodexOutputParser();

				const event = p.parseJsonLine(
					JSON.stringify({
						type: 'event_msg',
						payload: {
							type: 'token_count',
							info: {
								total_token_usage: {
									input_tokens: 100,
									output_tokens: 50,
								},
							},
						},
					})
				);

				// Should fall back to cached context window (default model)
				expect(event?.usage?.contextWindow).toBeGreaterThan(0);
			});

			it('should handle token_count with zero values', () => {
				const line = JSON.stringify({
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: {
							total_token_usage: {
								input_tokens: 0,
								output_tokens: 0,
								cached_input_tokens: 0,
								reasoning_output_tokens: 0,
							},
						},
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.usage?.inputTokens).toBe(0);
				expect(event?.usage?.outputTokens).toBe(0);
			});

			it('should handle token_count without total_token_usage', () => {
				const line = JSON.stringify({
					type: 'event_msg',
					payload: {
						type: 'token_count',
						info: {},
					},
				});

				// No total_token_usage means it falls through to default system event
				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});
		});

		describe('other event_msg types', () => {
			it('should parse task_started as system event', () => {
				const line = JSON.stringify({
					type: 'event_msg',
					payload: {
						type: 'task_started',
						message: 'Starting task...',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});

			it('should parse user_message as system event', () => {
				const line = JSON.stringify({
					type: 'event_msg',
					payload: {
						type: 'user_message',
						message: 'User sent a message',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});

			it('should handle event_msg without payload', () => {
				const line = JSON.stringify({ type: 'event_msg' });
				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});
		});
	});

	describe('response_item events', () => {
		describe('message type', () => {
			it('should parse assistant message with output_text content', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'message',
						role: 'assistant',
						content: [{ type: 'output_text', text: 'Hello world' }],
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('result');
				expect(event?.text).toBe('Hello world');
				expect(event?.isPartial).toBe(false);
			});

			it('should parse assistant commentary as partial text', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'message',
						role: 'assistant',
						phase: 'commentary',
						content: [{ type: 'output_text', text: 'Analyzing...' }],
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('Analyzing...');
				expect(event?.isPartial).toBe(true);
			});

			it('should parse user message as system event', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'message',
						role: 'user',
						content: [{ type: 'input_text', text: 'Fix the bug' }],
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});

			it('should handle message with multiple content parts', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'message',
						role: 'assistant',
						content: [
							{ type: 'output_text', text: 'Part one.' },
							{ type: 'output_text', text: 'Part two.' },
						],
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.text).toBe('Part one. Part two.');
			});

			it('should handle message with empty content array', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'message',
						role: 'assistant',
						content: [],
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('result');
				expect(event?.text).toBe('');
			});

			it('should handle message without content', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'message',
						role: 'assistant',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.text).toBe('');
			});

			it('should filter non-text content types', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'message',
						role: 'assistant',
						content: [
							{ type: 'image', url: 'http://example.com/img.png' },
							{ type: 'output_text', text: 'Visible text' },
						],
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.text).toBe('Visible text');
			});

			it('should handle input_text and text content types', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'message',
						role: 'assistant',
						content: [
							{ type: 'input_text', text: 'Input content' },
							{ type: 'text', text: 'Plain text' },
							{ type: 'output_text', text: 'Output content' },
						],
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.text).toBe('Input content Plain text Output content');
			});
		});

		describe('function_call type', () => {
			it('should parse function_call as tool_use with running status', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'function_call',
						name: 'shell_command',
						arguments: '{"command":"ls -la"}',
						call_id: 'call_abc123',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBe('shell_command');
				expect(event?.toolState).toEqual({
					status: 'running',
					input: { command: 'ls -la' },
				});
			});

			it('should handle function_call with invalid JSON arguments', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'function_call',
						name: 'shell_command',
						arguments: 'not valid json',
						call_id: 'call_bad',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBe('shell_command');
				// Invalid JSON falls back to the raw string
				expect((event?.toolState as { input: unknown }).input).toBe('not valid json');
			});

			it('should handle function_call with empty arguments', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'function_call',
						name: 'some_tool',
						call_id: 'call_empty',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('tool_use');
				expect((event?.toolState as { input: unknown }).input).toEqual({});
			});

			it('should handle function_call without name', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'function_call',
						arguments: '{}',
						call_id: 'call_noname',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.toolName).toBe('unknown');
			});
		});

		describe('custom_tool_call type', () => {
			it('should parse custom_tool_call as tool_use', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'custom_tool_call',
						name: 'apply_patch',
						arguments: '{"patch":"--- a/file.ts"}',
						call_id: 'call_custom1',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBe('apply_patch');
			});
		});

		describe('function_call_output type', () => {
			it('should parse function_call_output as completed tool_use', () => {
				const p = new CodexOutputParser();

				// First emit a function_call to set the tool name
				p.parseJsonLine(
					JSON.stringify({
						type: 'response_item',
						payload: {
							type: 'function_call',
							name: 'shell_command',
							arguments: '{}',
							call_id: 'call_out1',
						},
					})
				);

				const event = p.parseJsonLine(
					JSON.stringify({
						type: 'response_item',
						payload: {
							type: 'function_call_output',
							call_id: 'call_out1',
							output: 'Command output here',
						},
					})
				);

				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBe('shell_command');
				expect(event?.toolState).toEqual({
					status: 'completed',
					output: 'Command output here',
				});
			});

			it('should clear tool name after function_call_output', () => {
				const p = new CodexOutputParser();

				p.parseJsonLine(
					JSON.stringify({
						type: 'response_item',
						payload: { type: 'function_call', name: 'tool_a', arguments: '{}', call_id: 'c1' },
					})
				);
				p.parseJsonLine(
					JSON.stringify({
						type: 'response_item',
						payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' },
					})
				);

				// Next output should not carry over the tool name
				const orphan = p.parseJsonLine(
					JSON.stringify({
						type: 'response_item',
						payload: { type: 'function_call_output', call_id: 'c2', output: 'orphan' },
					})
				);
				expect(orphan?.toolName).toBeUndefined();
			});

			it('should handle function_call_output with undefined output', () => {
				const p = new CodexOutputParser();
				const event = p.parseJsonLine(
					JSON.stringify({
						type: 'response_item',
						payload: { type: 'function_call_output', call_id: 'c_none' },
					})
				);
				expect(event?.toolState).toEqual({
					status: 'completed',
					output: '',
				});
			});
		});

		describe('custom_tool_call_output type', () => {
			it('should parse custom_tool_call_output as completed tool_use', () => {
				const p = new CodexOutputParser();

				p.parseJsonLine(
					JSON.stringify({
						type: 'response_item',
						payload: {
							type: 'custom_tool_call',
							name: 'apply_patch',
							arguments: '{}',
							call_id: 'call_custom_out',
						},
					})
				);

				const event = p.parseJsonLine(
					JSON.stringify({
						type: 'response_item',
						payload: {
							type: 'custom_tool_call_output',
							call_id: 'call_custom_out',
							output: 'Patch applied',
						},
					})
				);

				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBe('apply_patch');
				expect(event?.toolState).toEqual({
					status: 'completed',
					output: 'Patch applied',
				});
			});
		});

		describe('reasoning type', () => {
			it('should parse reasoning as system event', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'reasoning',
						summary: ['step 1', 'step 2'],
						encrypted_content: 'base64data...',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});
		});

		describe('unknown response_item type', () => {
			it('should parse unknown payload type as system event', () => {
				const line = JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'unknown_new_type',
						data: 'something',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});
		});

		describe('response_item without payload', () => {
			it('should fall through to default system event', () => {
				const line = JSON.stringify({ type: 'response_item' });
				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});
		});
	});

	describe('item.started events', () => {
		it('should parse command_execution as running tool_use', () => {
			const line = JSON.stringify({
				type: 'item.started',
				item: {
					type: 'command_execution',
					command: 'npm test',
					status: 'in_progress',
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event?.type).toBe('tool_use');
			expect(event?.toolName).toBe('shell');
			expect(event?.toolState).toEqual({
				status: 'running',
				input: { command: 'npm test' },
			});
		});

		it('should parse unknown item.started type as system event', () => {
			const line = JSON.stringify({
				type: 'item.started',
				item: {
					type: 'unknown_type',
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event?.type).toBe('system');
		});

		it('should handle item.started without item', () => {
			const line = JSON.stringify({ type: 'item.started' });
			const event = parser.parseJsonLine(line);
			// Falls through to default handler (no item field)
			expect(event?.type).toBe('system');
		});
	});

	describe('item.completed - command_execution events', () => {
		it('should parse completed command_execution with output', () => {
			const line = JSON.stringify({
				type: 'item.completed',
				item: {
					type: 'command_execution',
					command: 'ls -la',
					aggregated_output: 'total 64\ndrwxr-xr-x  12 user...',
					exit_code: 0,
					status: 'completed',
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event?.type).toBe('tool_use');
			expect(event?.toolName).toBe('shell');
			expect(event?.toolState).toEqual({
				status: 'completed',
				input: { command: 'ls -la' },
				output: 'total 64\ndrwxr-xr-x  12 user...',
				exitCode: 0,
			});
		});

		it('should parse failed command_execution', () => {
			const line = JSON.stringify({
				type: 'item.completed',
				item: {
					type: 'command_execution',
					command: 'bad-command',
					aggregated_output: 'command not found',
					exit_code: 127,
					status: 'failed',
				},
			});

			const event = parser.parseJsonLine(line);
			expect(event?.type).toBe('tool_use');
			const state = event?.toolState as { status: string; exitCode: number };
			expect(state.status).toBe('completed');
			expect(state.exitCode).toBe(127);
		});

		it('should parse in-progress command_execution', () => {
			const line = JSON.stringify({
				type: 'item.completed',
				item: {
					type: 'command_execution',
					command: 'long-running-task',
					status: 'in_progress',
				},
			});

			const event = parser.parseJsonLine(line);
			const state = event?.toolState as { status: string };
			expect(state.status).toBe('running');
		});

		it('should handle command_execution with null exit_code', () => {
			const line = JSON.stringify({
				type: 'item.completed',
				item: {
					type: 'command_execution',
					command: 'still-running',
					exit_code: null,
					status: 'completed',
				},
			});

			const event = parser.parseJsonLine(line);
			const state = event?.toolState as { exitCode: number | null };
			expect(state.exitCode).toBeNull();
		});
	});

	describe('parseJsonObject', () => {
		it('should parse pre-parsed objects the same as parseJsonLine', () => {
			const obj = {
				type: 'session_meta',
				payload: { id: 'test-id-123' },
			};

			const fromObject = parser.parseJsonObject(obj);
			const fromLine = parser.parseJsonLine(JSON.stringify(obj));

			expect(fromObject?.type).toBe(fromLine?.type);
			expect(fromObject?.sessionId).toBe(fromLine?.sessionId);
		});

		it('should return null for null input', () => {
			expect(parser.parseJsonObject(null)).toBeNull();
		});

		it('should return null for non-object input', () => {
			expect(parser.parseJsonObject('string')).toBeNull();
			expect(parser.parseJsonObject(42)).toBeNull();
			expect(parser.parseJsonObject(true)).toBeNull();
		});
	});

	describe('detectErrorFromParsed', () => {
		it('should detect errors from pre-parsed objects', () => {
			const obj = { type: 'error', error: 'rate limit exceeded' };
			const error = parser.detectErrorFromParsed(obj);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('rate_limited');
		});

		it('should return null for null input', () => {
			expect(parser.detectErrorFromParsed(null)).toBeNull();
		});

		it('should return null for non-object input', () => {
			expect(parser.detectErrorFromParsed('string')).toBeNull();
		});

		it('should detect turn.failed from pre-parsed objects', () => {
			const obj = {
				type: 'turn.failed',
				error: { message: 'Connection lost' },
			};
			const error = parser.detectErrorFromParsed(obj);
			expect(error).not.toBeNull();
			expect(error?.message).toBe('Connection lost');
		});
	});

	describe('tool name carryover for new format', () => {
		it('should carry tool name from function_call to function_call_output', () => {
			const p = new CodexOutputParser();

			p.parseJsonLine(
				JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'function_call',
						name: 'read_file',
						arguments: '{"path":"main.ts"}',
						call_id: 'call_rf1',
					},
				})
			);

			const result = p.parseJsonLine(
				JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'function_call_output',
						call_id: 'call_rf1',
						output: 'file contents...',
					},
				})
			);

			expect(result?.toolName).toBe('read_file');
		});

		it('should carry tool name from custom_tool_call to custom_tool_call_output', () => {
			const p = new CodexOutputParser();

			p.parseJsonLine(
				JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'custom_tool_call',
						name: 'apply_patch',
						arguments: '{}',
						call_id: 'call_ct1',
					},
				})
			);

			const result = p.parseJsonLine(
				JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'custom_tool_call_output',
						call_id: 'call_ct1',
						output: 'Patch applied',
					},
				})
			);

			expect(result?.toolName).toBe('apply_patch');
		});
	});

	describe('formatReasoningText edge cases', () => {
		it('should add line breaks before bold markdown sections', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: {
						type: 'reasoning',
						text: 'Starting **Phase 1** then **Phase 2** done',
					},
				})
			);

			expect(event?.text).toContain('\n\n**Phase 1**');
			expect(event?.text).toContain('\n\n**Phase 2**');
		});

		it('should handle empty text in reasoning', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'reasoning', text: '' },
				})
			);

			expect(event?.text).toBe('');
		});

		it('should handle text without bold markers', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'reasoning', text: 'Plain thinking text' },
				})
			);

			expect(event?.text).toBe('Plain thinking text');
		});
	});
});
