import { describe, it, expect } from 'vitest';
import { CodexOutputParser } from '../../../main/parsers/codex-output-parser';

describe('CodexOutputParser', () => {
	const parser = new CodexOutputParser();

	describe('agentId', () => {
		it('should be codex', () => {
			expect(parser.agentId).toBe('codex');
		});
	});

	// ─── OLD FORMAT TESTS (item-envelope) ───────────────────────

	describe('old format - parseJsonLine', () => {
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

	// ─── NEW FORMAT TESTS (msg-envelope) ────────────────────────

	describe('new format - parseJsonLine', () => {
		describe('task_started events', () => {
			it('should parse task_started as system event with turn.started raw type for StdoutHandler compatibility', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'task_started', model_context_window: 200000 },
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
				// Must have raw.type === 'turn.started' so StdoutHandler resets result state
				expect((event?.raw as Record<string, unknown>)?.type).toBe('turn.started');
				expect((event?.raw as Record<string, unknown>)?._originalType).toBe('task_started');
			});
		});

		describe('agent_reasoning events', () => {
			it('should parse agent_reasoning as partial text', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'agent_reasoning', text: '**Analyzing** the codebase structure' },
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('\n\n**Analyzing** the codebase structure');
				expect(event?.isPartial).toBe(true);
			});

			it('should handle empty reasoning text', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'agent_reasoning' },
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('');
				expect(event?.isPartial).toBe(true);
			});
		});

		describe('agent_reasoning_section_break events', () => {
			it('should parse as partial text with newlines', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'agent_reasoning_section_break' },
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('\n\n');
				expect(event?.isPartial).toBe(true);
			});
		});

		describe('agent_message events', () => {
			it('should parse agent_message as result using message field', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'agent_message', message: 'Here are the files in the directory.' },
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('result');
				expect(event?.text).toBe('Here are the files in the directory.');
				expect(event?.isPartial).toBe(false);
			});

			it('should handle empty message', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'agent_message' },
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('result');
				expect(event?.text).toBe('');
			});
		});

		describe('exec_command_begin events', () => {
			it('should parse as tool_use running with command array', () => {
				const line = JSON.stringify({
					id: '0',
					msg: {
						type: 'exec_command_begin',
						call_id: 'call_abc123',
						command: ['ls', '-la', '/home'],
						cwd: '/home/user/project',
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBe('ls');
				expect(event?.toolState).toEqual({
					status: 'running',
					input: {
						command: ['ls', '-la', '/home'],
						cwd: '/home/user/project',
					},
				});
			});

			it('should extract tool name from parsed_cmd if command array is missing', () => {
				const line = JSON.stringify({
					id: '0',
					msg: {
						type: 'exec_command_begin',
						call_id: 'call_xyz',
						parsed_cmd: [{ cmd: 'git', args: ['status'] }],
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.toolName).toBe('git');
			});
		});

		describe('exec_command_end events', () => {
			it('should parse as tool_use completed with output', () => {
				const p = new CodexOutputParser();

				// First: exec_command_begin to register tool name
				p.parseJsonLine(JSON.stringify({
					id: '0',
					msg: {
						type: 'exec_command_begin',
						call_id: 'call_test1',
						command: ['cat', 'file.txt'],
					},
				}));

				// Then: exec_command_end with matching call_id
				const line = JSON.stringify({
					id: '0',
					msg: {
						type: 'exec_command_end',
						call_id: 'call_test1',
						stdout: 'file contents here',
						exit_code: 0,
						duration: 0.05,
					},
				});

				const event = p.parseJsonLine(line);
				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBe('cat');
				expect(event?.toolState).toEqual({
					status: 'completed',
					output: 'file contents here',
					exitCode: 0,
				});
			});

			it('should use aggregated_output when available', () => {
				const line = JSON.stringify({
					id: '0',
					msg: {
						type: 'exec_command_end',
						call_id: 'call_agg',
						aggregated_output: 'combined output',
						stdout: 'raw stdout',
						exit_code: 0,
					},
				});

				const event = parser.parseJsonLine(line);
				expect((event?.toolState as { output: string }).output).toBe('combined output');
			});

			it('should truncate large output', () => {
				const largeOutput = 'x'.repeat(15000);
				const line = JSON.stringify({
					id: '0',
					msg: {
						type: 'exec_command_end',
						call_id: 'call_large',
						stdout: largeOutput,
						exit_code: 0,
					},
				});

				const event = parser.parseJsonLine(line);
				const output = (event?.toolState as { output: string }).output;
				expect(output.length).toBeLessThan(15000);
				expect(output).toContain('... [output truncated, 15000 chars total]');
			});
		});

		describe('exec_command_output_delta events', () => {
			it('should parse as system event (streaming chunk, ignored)', () => {
				const line = JSON.stringify({
					id: '0',
					msg: {
						type: 'exec_command_output_delta',
						call_id: 'call_delta',
						stream: 'stdout',
						chunk: 'aGVsbG8=', // base64 "hello"
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});
		});

		describe('token_count events', () => {
			it('should parse token_count with info as usage event', () => {
				const line = JSON.stringify({
					id: '0',
					msg: {
						type: 'token_count',
						info: {
							total_token_usage: {
								input_tokens: 5000,
								cached_input_tokens: 3000,
								output_tokens: 200,
								reasoning_output_tokens: 150,
								total_tokens: 5350,
							},
							model_context_window: 200000,
						},
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('usage');
				expect(event?.usage).toEqual({
					inputTokens: 5000,
					outputTokens: 350, // 200 + 150
					cacheReadTokens: 3000,
					cacheCreationTokens: 0,
					contextWindow: 200000,
					reasoningTokens: 150,
				});
			});

			it('should handle token_count without info (rate-limit only)', () => {
				const line = JSON.stringify({
					id: '0',
					msg: {
						type: 'token_count',
						info: null,
						rate_limits: { limit: 10000 },
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('usage');
				expect(event?.usage).toBeUndefined();
			});
		});

		describe('config and prompt echo lines', () => {
			it('should parse config line (no envelope) as system event', () => {
				const line = JSON.stringify({
					model: 'gpt-5-codex',
					sandbox: 'read-only',
					auto_apply_edits: true,
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});

			it('should parse prompt echo line as system event', () => {
				const line = JSON.stringify({
					prompt: 'what files are in this directory?',
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});
		});

		describe('unknown new format events', () => {
			it('should parse unknown msg types as system events', () => {
				const line = JSON.stringify({
					id: '0',
					msg: { type: 'some_future_event', data: 'whatever' },
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('system');
			});
		});
	});

	// ─── NEW FORMAT: TOOL NAME CARRYOVER BY CALL_ID ─────────────

	describe('new format - tool name carryover via call_id', () => {
		it('should carry tool name from exec_command_begin to exec_command_end by call_id', () => {
			const p = new CodexOutputParser();

			// begin with call_id
			const beginEvent = p.parseJsonLine(JSON.stringify({
				id: '0',
				msg: {
					type: 'exec_command_begin',
					call_id: 'call_001',
					command: ['git', 'status'],
				},
			}));
			expect(beginEvent?.toolName).toBe('git');

			// end with same call_id
			const endEvent = p.parseJsonLine(JSON.stringify({
				id: '0',
				msg: {
					type: 'exec_command_end',
					call_id: 'call_001',
					stdout: 'On branch main',
					exit_code: 0,
				},
			}));
			expect(endEvent?.toolName).toBe('git');
		});

		it('should handle multiple concurrent commands with different call_ids', () => {
			const p = new CodexOutputParser();

			// begin two commands
			p.parseJsonLine(JSON.stringify({
				id: '0',
				msg: { type: 'exec_command_begin', call_id: 'call_A', command: ['ls'] },
			}));
			p.parseJsonLine(JSON.stringify({
				id: '0',
				msg: { type: 'exec_command_begin', call_id: 'call_B', command: ['cat', 'file.txt'] },
			}));

			// end in reverse order
			const endB = p.parseJsonLine(JSON.stringify({
				id: '0',
				msg: { type: 'exec_command_end', call_id: 'call_B', stdout: 'contents', exit_code: 0 },
			}));
			expect(endB?.toolName).toBe('cat');

			const endA = p.parseJsonLine(JSON.stringify({
				id: '0',
				msg: { type: 'exec_command_end', call_id: 'call_A', stdout: 'file1\nfile2', exit_code: 0 },
			}));
			expect(endA?.toolName).toBe('ls');
		});

		it('should clean up call_id after exec_command_end', () => {
			const p = new CodexOutputParser();

			p.parseJsonLine(JSON.stringify({
				id: '0',
				msg: { type: 'exec_command_begin', call_id: 'call_C', command: ['echo'] },
			}));
			p.parseJsonLine(JSON.stringify({
				id: '0',
				msg: { type: 'exec_command_end', call_id: 'call_C', stdout: 'hi', exit_code: 0 },
			}));

			// Another end with same call_id should have no tool name
			const orphan = p.parseJsonLine(JSON.stringify({
				id: '0',
				msg: { type: 'exec_command_end', call_id: 'call_C', stdout: 'orphan', exit_code: 0 },
			}));
			expect(orphan?.toolName).toBeUndefined();
		});
	});

	// ─── SHARED BEHAVIOR TESTS ──────────────────────────────────

	describe('isResultMessage', () => {
		it('should return true for old-format agent_message events with text', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'agent_message', text: 'hi' },
				})
			);
			expect(event).not.toBeNull();
			expect(parser.isResultMessage(event!)).toBe(true);
		});

		it('should return true for new-format agent_message events with message', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					id: '0',
					msg: { type: 'agent_message', message: 'hi' },
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

			const usageEvent = parser.parseJsonLine(JSON.stringify({ type: 'turn.completed' }));
			expect(parser.isResultMessage(usageEvent!)).toBe(false);

			const reasoningEvent = parser.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'reasoning', text: 'thinking...' },
				})
			);
			expect(parser.isResultMessage(reasoningEvent!)).toBe(false);
		});

		it('should return false for new-format reasoning events', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					id: '0',
					msg: { type: 'agent_reasoning', text: 'thinking...' },
				})
			);
			expect(parser.isResultMessage(event!)).toBe(false);
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

		it('should return null for new format events (no session ID in new format)', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					id: '0',
					msg: { type: 'task_started', model_context_window: 200000 },
				})
			);
			expect(parser.extractSessionId(event!)).toBeNull();
		});
	});

	describe('extractUsage', () => {
		it('should extract usage from old-format turn.completed message', () => {
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
			expect(usage?.cacheCreationTokens).toBe(0);
		});

		it('should extract usage from new-format token_count message', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					id: '0',
					msg: {
						type: 'token_count',
						info: {
							total_token_usage: {
								input_tokens: 100,
								output_tokens: 50,
								cached_input_tokens: 20,
								reasoning_output_tokens: 10,
							},
							model_context_window: 200000,
						},
					},
				})
			);

			const usage = parser.extractUsage(event!);
			expect(usage).not.toBeNull();
			expect(usage?.inputTokens).toBe(100);
			expect(usage?.outputTokens).toBe(60); // 50 + 10
			expect(usage?.cacheReadTokens).toBe(20);
			expect(usage?.reasoningTokens).toBe(10);
			expect(usage?.contextWindow).toBe(200000);
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
			expect(event?.type).toBe('system');
		});

		it('should handle missing text in agent_message (old format)', () => {
			const event = parser.parseJsonLine(
				JSON.stringify({
					type: 'item.completed',
					item: { type: 'agent_message' },
				})
			);
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

	describe('detectErrorFromLine', () => {
		it('should return null for empty lines', () => {
			expect(parser.detectErrorFromLine('')).toBeNull();
			expect(parser.detectErrorFromLine('   ')).toBeNull();
		});

		it('should detect authentication errors from old-format JSON', () => {
			const line = JSON.stringify({ type: 'error', error: 'invalid api key' });
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('auth_expired');
			expect(error?.agentId).toBe('codex');
		});

		it('should detect errors from new-format msg envelope', () => {
			const line = JSON.stringify({
				id: '0',
				msg: { type: 'error', error: 'rate limit exceeded' },
			});
			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('rate_limited');
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

		it('should NOT detect errors from plain text (only JSON)', () => {
			expect(parser.detectErrorFromLine('invalid api key')).toBeNull();
			expect(parser.detectErrorFromLine('rate limit exceeded')).toBeNull();
			expect(parser.detectErrorFromLine('maximum tokens exceeded')).toBeNull();
		});

		it('should return null for non-error lines', () => {
			expect(parser.detectErrorFromLine('normal output')).toBeNull();
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

	// ─── OLD FORMAT: TOOL NAME CARRYOVER ────────────────────────

	describe('old format - tool name carryover (tool_call → tool_result)', () => {
		it('should carry tool name from tool_call to subsequent tool_result', () => {
			const p = new CodexOutputParser();

			const callEvent = p.parseJsonLine(JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_call', tool: 'shell', args: { command: ['ls'] } },
			}));
			expect(callEvent?.toolName).toBe('shell');

			const resultEvent = p.parseJsonLine(JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_result', output: 'file1.txt\nfile2.txt' },
			}));
			expect(resultEvent?.toolName).toBe('shell');
		});

		it('should reset tool name after tool_result so it does not leak to next pair', () => {
			const p = new CodexOutputParser();

			p.parseJsonLine(JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_call', tool: 'shell', args: {} },
			}));
			p.parseJsonLine(JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_result', output: 'ok' },
			}));

			const orphanResult = p.parseJsonLine(JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_result', output: 'orphan' },
			}));
			expect(orphanResult?.toolName).toBeUndefined();
		});
	});

	// ─── TOOL OUTPUT TRUNCATION ─────────────────────────────────

	describe('tool output truncation', () => {
		it('should truncate output exceeding 10,000 characters (old format)', () => {
			const p = new CodexOutputParser();
			const largeOutput = 'x'.repeat(15000);

			const event = p.parseJsonLine(JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_result', output: largeOutput },
			}));

			const output = (event?.toolState as { output: string }).output;
			expect(output.length).toBeLessThan(15000);
			expect(output).toContain('... [output truncated, 15000 chars total]');
			expect(output.startsWith('x'.repeat(10000))).toBe(true);
		});

		it('should not truncate output under 10,000 characters', () => {
			const p = new CodexOutputParser();
			const normalOutput = 'y'.repeat(9999);

			const event = p.parseJsonLine(JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_result', output: normalOutput },
			}));

			const output = (event?.toolState as { output: string }).output;
			expect(output).toBe(normalOutput);
		});

		it('should truncate byte array output exceeding limit (old format)', () => {
			const p = new CodexOutputParser();
			const byteArray = Array(15000).fill(65);

			const event = p.parseJsonLine(JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_result', output: byteArray },
			}));

			const output = (event?.toolState as { output: string }).output;
			expect(output).toContain('... [output truncated, 15000 chars total]');
		});

		it('should truncate output exceeding limit (new format)', () => {
			const p = new CodexOutputParser();
			const largeOutput = 'z'.repeat(15000);

			const event = p.parseJsonLine(JSON.stringify({
				id: '0',
				msg: {
					type: 'exec_command_end',
					call_id: 'call_trunc',
					stdout: largeOutput,
					exit_code: 0,
				},
			}));

			const output = (event?.toolState as { output: string }).output;
			expect(output.length).toBeLessThan(15000);
			expect(output).toContain('... [output truncated, 15000 chars total]');
		});
	});

	// ─── refreshConfig STATE RESET ──────────────────────────────

	describe('refreshConfig', () => {
		it('should reset old-format lastToolName', () => {
			const p = new CodexOutputParser();

			// Set up tool name carryover
			p.parseJsonLine(JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_call', tool: 'shell', args: {} },
			}));

			// Refresh should clear it
			p.refreshConfig();

			const result = p.parseJsonLine(JSON.stringify({
				type: 'item.completed',
				item: { type: 'tool_result', output: 'test' },
			}));
			expect(result?.toolName).toBeUndefined();
		});

		it('should reset new-format toolNamesByCallId', () => {
			const p = new CodexOutputParser();

			// Set up call_id tracking
			p.parseJsonLine(JSON.stringify({
				id: '0',
				msg: { type: 'exec_command_begin', call_id: 'call_reset', command: ['echo'] },
			}));

			// Refresh should clear it
			p.refreshConfig();

			const result = p.parseJsonLine(JSON.stringify({
				id: '0',
				msg: { type: 'exec_command_end', call_id: 'call_reset', stdout: 'hi', exit_code: 0 },
			}));
			expect(result?.toolName).toBeUndefined();
		});
	});

	// ─── FORMAT DETECTION ───────────────────────────────────────

	describe('format detection', () => {
		it('should correctly route old-format messages (top-level type)', () => {
			const event = parser.parseJsonLine(JSON.stringify({
				type: 'turn.started',
			}));
			expect(event?.type).toBe('system');
		});

		it('should correctly route new-format messages (msg envelope)', () => {
			const event = parser.parseJsonLine(JSON.stringify({
				id: '0',
				msg: { type: 'agent_reasoning', text: 'test' },
			}));
			expect(event?.type).toBe('text');
		});

		it('should correctly route config lines (no envelope, has model)', () => {
			const event = parser.parseJsonLine(JSON.stringify({
				model: 'gpt-5-codex',
				sandbox: 'read-only',
			}));
			expect(event?.type).toBe('system');
		});

		it('should correctly route prompt echo lines (no envelope, has prompt)', () => {
			const event = parser.parseJsonLine(JSON.stringify({
				prompt: 'hello world',
			}));
			expect(event?.type).toBe('system');
		});

		it('should handle completely unknown JSON as system event', () => {
			const event = parser.parseJsonLine(JSON.stringify({
				someRandomField: true,
			}));
			expect(event?.type).toBe('system');
		});
	});
});
