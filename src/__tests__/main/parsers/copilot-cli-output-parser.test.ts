import { describe, it, expect, beforeEach } from 'vitest';
import { CopilotCliOutputParser } from '../../../main/parsers/copilot-cli-output-parser';

describe('CopilotCliOutputParser', () => {
	let parser: CopilotCliOutputParser;

	beforeEach(() => {
		parser = new CopilotCliOutputParser();
	});

	describe('agentId', () => {
		it('should be copilot-cli', () => {
			expect(parser.agentId).toBe('copilot-cli');
		});
	});

	describe('parseJsonLine', () => {
		it('should return null for empty lines', () => {
			expect(parser.parseJsonLine('')).toBeNull();
			expect(parser.parseJsonLine('  ')).toBeNull();
			expect(parser.parseJsonLine('\n')).toBeNull();
		});

		it('should return text event for non-JSON lines', () => {
			const event = parser.parseJsonLine('not json at all');
			expect(event).not.toBeNull();
			expect(event?.type).toBe('text');
			expect(event?.text).toBe('not json at all');
		});

		// ================================================================
		// Session lifecycle events
		// ================================================================

		describe('session.mcp_server_status_changed', () => {
			it('should parse as system event', () => {
				const line = JSON.stringify({
					type: 'session.mcp_server_status_changed',
					data: { serverName: 'github-mcp-server', status: 'connected' },
					id: 'abc-123',
					timestamp: '2026-04-01T03:03:44.200Z',
					ephemeral: true,
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
			});
		});

		describe('session.mcp_servers_loaded', () => {
			it('should parse as system event', () => {
				const line = JSON.stringify({
					type: 'session.mcp_servers_loaded',
					data: {
						servers: [
							{ name: 'github-mcp-server', status: 'connected', source: 'builtin' },
							{ name: 'playwright', status: 'connected' },
						],
					},
					id: 'def-456',
					timestamp: '2026-04-01T03:03:49.778Z',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
			});
		});

		describe('session.tools_updated', () => {
			it('should parse as init event (contains model)', () => {
				const line = JSON.stringify({
					type: 'session.tools_updated',
					data: { model: 'claude-opus-4.6-1m' },
					id: 'ghi-789',
					timestamp: '2026-04-01T03:03:52.075Z',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('init');
			});
		});

		// ================================================================
		// User message echo
		// ================================================================

		describe('user.message', () => {
			it('should parse as system event (not displayed)', () => {
				const line = JSON.stringify({
					type: 'user.message',
					data: {
						content: 'Say hello in one sentence',
						transformedContent: 'Say hello in one sentence',
						attachments: [],
						interactionId: '963470f1-14f0-4a2f-a7a1-917b13892952',
					},
					id: '5e0d517d-b4e9-4b12-a014-4af6eab9606c',
					timestamp: '2026-04-01T03:03:52.077Z',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
			});
		});

		// ================================================================
		// Assistant turn lifecycle
		// ================================================================

		describe('assistant.turn_start', () => {
			it('should parse as system event', () => {
				const line = JSON.stringify({
					type: 'assistant.turn_start',
					data: {
						turnId: '0',
						interactionId: '963470f1-14f0-4a2f-a7a1-917b13892952',
					},
					id: 'acef7a61-aa5b-418b-9043-fdfd548a2d4f',
					timestamp: '2026-04-01T03:03:52.092Z',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
			});
		});

		describe('assistant.turn_end', () => {
			it('should parse as system event', () => {
				const line = JSON.stringify({
					type: 'assistant.turn_end',
					data: { turnId: '0' },
					id: '7cddec97-2495-494f-a680-18382f957161',
					timestamp: '2026-04-01T03:03:56.131Z',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
			});
		});

		// ================================================================
		// Streaming text (assistant.message_delta)
		// ================================================================

		describe('assistant.message_delta', () => {
			it('should parse as partial text event', () => {
				const line = JSON.stringify({
					type: 'assistant.message_delta',
					data: {
						messageId: 'edaf687e-8934-45ff-929a-4ddc9cf241fc',
						deltaContent: 'Hello! I am',
					},
					id: '7b8c16ea-cd07-40ed-802b-b193a2b1b1ca',
					timestamp: '2026-04-01T03:03:56.124Z',
					ephemeral: true,
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('Hello! I am');
				expect(event?.isPartial).toBe(true);
			});

			it('should handle empty deltaContent', () => {
				const line = JSON.stringify({
					type: 'assistant.message_delta',
					data: { messageId: 'msg-1', deltaContent: '' },
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('');
				expect(event?.isPartial).toBe(true);
			});
		});

		// ================================================================
		// Complete assistant message
		// ================================================================

		describe('assistant.message', () => {
			it('should parse text-only message as result', () => {
				const line = JSON.stringify({
					type: 'assistant.message',
					data: {
						messageId: 'a23033e4-755f-4283-bc2e-310c9f2ad770',
						content: 'The version number is **0.15.3**.',
						toolRequests: [],
						interactionId: '762eb3c4-f8ed-418b-96f6-cb9c1c97b71b',
						outputTokens: 14,
					},
					id: 'd48a39ac-d6ae-45c3-b423-5e7bd7d036fa',
					timestamp: '2026-04-01T03:05:27.795Z',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('result');
				expect(event?.text).toBe('The version number is **0.15.3**.');
				expect(event?.isPartial).toBe(false);
			});

			it('should parse tool-request-only message as tool_use with blocks', () => {
				const line = JSON.stringify({
					type: 'assistant.message',
					data: {
						messageId: '1edb98ee-0bf8-4996-be03-5cb9ed4abe39',
						content: '',
						toolRequests: [
							{
								toolCallId: 'tooluse_abc123',
								name: 'view',
								arguments: { path: '/package.json', view_range: [1, 5] },
								type: 'function',
							},
						],
						interactionId: '762eb3c4-f8ed-418b-96f6-cb9c1c97b71b',
						outputTokens: 126,
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('tool_use');
				expect(event?.toolUseBlocks).toHaveLength(1);
				expect(event?.toolUseBlocks?.[0].name).toBe('view');
				expect(event?.toolUseBlocks?.[0].id).toBe('tooluse_abc123');
				expect(event?.toolUseBlocks?.[0].input).toEqual({
					path: '/package.json',
					view_range: [1, 5],
				});
			});

			it('should parse message with both text and tool requests', () => {
				const line = JSON.stringify({
					type: 'assistant.message',
					data: {
						messageId: 'msg-mixed',
						content: 'Let me check that file for you.',
						toolRequests: [
							{
								toolCallId: 'tooluse_xyz',
								name: 'view',
								arguments: { path: '/src/index.ts' },
								type: 'function',
							},
						],
						outputTokens: 50,
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('Let me check that file for you.');
				expect(event?.toolUseBlocks).toHaveLength(1);
			});

			it('should accumulate outputTokens across messages and reset on result', () => {
				// Send two messages with outputTokens
				parser.parseJsonLine(
					JSON.stringify({
						type: 'assistant.message',
						data: {
							content: '',
							toolRequests: [{ toolCallId: 't1', name: 'view', arguments: {} }],
							outputTokens: 100,
						},
					})
				);
				parser.parseJsonLine(
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'Done.', toolRequests: [], outputTokens: 50 },
					})
				);

				// The result event should have accumulated tokens
				const resultEvent = parser.parseJsonLine(
					JSON.stringify({
						type: 'result',
						sessionId: 'test-session',
						exitCode: 0,
						usage: { premiumRequests: 1 },
					})
				);

				expect(resultEvent?.type).toBe('usage');
				expect(resultEvent?.usage?.outputTokens).toBe(150); // 100 + 50

				// After result, tokens should be reset for next session
				const nextResult = parser.parseJsonLine(
					JSON.stringify({
						type: 'result',
						sessionId: 'test-session-2',
						exitCode: 0,
					})
				);
				expect(nextResult?.usage?.outputTokens).toBe(0); // reset
			});
		});

		// ================================================================
		// Tool execution events
		// ================================================================

		describe('tool.execution_start', () => {
			it('should parse as tool_use with running status', () => {
				const line = JSON.stringify({
					type: 'tool.execution_start',
					data: {
						toolCallId: 'tooluse_fYPm7zJkdgOTL9KKwAPj5n',
						toolName: 'view',
						arguments: { path: 'C:\\maestro\\Maestro\\package.json', view_range: [1, 5] },
					},
					id: '98e359ea-a94e-465f-9fca-5fd553514779',
					timestamp: '2026-04-01T03:05:24.135Z',
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBe('view');
				expect(event?.toolState).toEqual({
					status: 'running',
					input: { path: 'C:\\maestro\\Maestro\\package.json', view_range: [1, 5] },
				});
			});
		});

		describe('tool.execution_complete', () => {
			it('should parse as tool_use with completed status', () => {
				const line = JSON.stringify({
					type: 'tool.execution_complete',
					data: {
						toolCallId: 'tooluse_fYPm7zJkdgOTL9KKwAPj5n',
						toolName: 'view',
						model: 'claude-opus-4.6',
						success: true,
						result: {
							content: '1. {\n2. "name": "maestro",\n3. "version": "0.15.3"',
							detailedContent: 'diff output...',
						},
						toolTelemetry: {},
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBe('view');
				expect(event?.toolState).toEqual({
					status: 'completed',
					output: '1. {\n2. "name": "maestro",\n3. "version": "0.15.3"',
					success: true,
				});
			});

			it('should truncate very long tool output', () => {
				const longOutput = 'x'.repeat(15000);
				const line = JSON.stringify({
					type: 'tool.execution_complete',
					data: {
						toolCallId: 'tc1',
						toolName: 'bash',
						success: true,
						result: { content: longOutput },
					},
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('tool_use');
				const output = (event?.toolState as { output: string })?.output;
				expect(output.length).toBeLessThan(longOutput.length);
				expect(output).toContain('[output truncated');
			});
		});

		// ================================================================
		// Result event (session completion)
		// ================================================================

		describe('result', () => {
			it('should parse as usage event with sessionId and report tokens even without usage field', () => {
				// First accumulate some tokens
				parser.parseJsonLine(
					JSON.stringify({
						type: 'assistant.message',
						data: { content: 'Hello', toolRequests: [], outputTokens: 10 },
					})
				);

				const line = JSON.stringify({
					type: 'result',
					timestamp: '2026-04-01T03:03:56.134Z',
					sessionId: '18353c52-1a96-4ce6-ab90-1b99310f746f',
					exitCode: 0,
					// No usage field — tokens should still be reported
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('usage');
				expect(event?.sessionId).toBe('18353c52-1a96-4ce6-ab90-1b99310f746f');
				expect(event?.usage).not.toBeNull();
				expect(event?.usage?.outputTokens).toBe(10);
			});
		});

		// ================================================================
		// Error events
		// ================================================================

		describe('error events', () => {
			it('should parse events with error field', () => {
				const line = JSON.stringify({
					type: 'error',
					error: { message: 'Authentication failed', type: 'auth_error' },
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('Authentication failed');
			});

			it('should parse error as string', () => {
				const line = JSON.stringify({
					type: 'error',
					error: 'Rate limited',
				});

				const event = parser.parseJsonLine(line);
				expect(event?.type).toBe('error');
				expect(event?.text).toBe('Rate limited');
			});
		});

		// ================================================================
		// Unknown event types
		// ================================================================

		describe('unknown events', () => {
			it('should preserve unknown types as system events', () => {
				const line = JSON.stringify({
					type: 'some.future.event',
					data: { foo: 'bar' },
				});

				const event = parser.parseJsonLine(line);
				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
			});
		});
	});

	// ================================================================
	// Helper methods
	// ================================================================

	describe('isResultMessage', () => {
		it('should return true for result events with text', () => {
			expect(parser.isResultMessage({ type: 'result', text: 'Hello!' })).toBe(true);
		});

		it('should return false for result events without text', () => {
			expect(parser.isResultMessage({ type: 'result' })).toBe(false);
			expect(parser.isResultMessage({ type: 'result', text: '' })).toBe(false);
		});

		it('should return false for non-result events', () => {
			expect(parser.isResultMessage({ type: 'text', text: 'Hello!' })).toBe(false);
		});
	});

	describe('extractSessionId', () => {
		it('should extract sessionId from event', () => {
			expect(parser.extractSessionId({ type: 'usage', sessionId: 'abc-123' })).toBe('abc-123');
		});

		it('should return null when no sessionId', () => {
			expect(parser.extractSessionId({ type: 'text', text: 'hello' })).toBeNull();
		});
	});

	describe('extractUsage', () => {
		it('should extract usage from event', () => {
			const usage = { inputTokens: 100, outputTokens: 50 };
			expect(parser.extractUsage({ type: 'usage', usage })).toEqual(usage);
		});

		it('should return null when no usage', () => {
			expect(parser.extractUsage({ type: 'text' })).toBeNull();
		});
	});

	describe('extractSlashCommands', () => {
		it('should return null (slash commands not in JSON output)', () => {
			expect(parser.extractSlashCommands({ type: 'init' })).toBeNull();
		});
	});

	// ================================================================
	// Error detection
	// ================================================================

	describe('detectErrorFromLine', () => {
		it('should detect auth errors from JSON', () => {
			const line = JSON.stringify({
				type: 'error',
				error: { message: 'not authenticated' },
			});

			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('auth_expired');
			expect(error?.agentId).toBe('copilot-cli');
		});

		it('should detect rate limit errors', () => {
			const line = JSON.stringify({
				type: 'error',
				error: 'rate limit exceeded',
			});

			const error = parser.detectErrorFromLine(line);
			expect(error).not.toBeNull();
			expect(error?.type).toBe('rate_limited');
		});

		it('should detect errors from plain text (non-JSON)', () => {
			const error = parser.detectErrorFromLine('copilot: command not found');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('agent_crashed');
		});

		it('should return null for non-error lines', () => {
			expect(parser.detectErrorFromLine('')).toBeNull();
			expect(
				parser.detectErrorFromLine(JSON.stringify({ type: 'assistant.turn_start' }))
			).toBeNull();
		});
	});

	describe('detectErrorFromParsed', () => {
		it('should detect error from parsed JSON', () => {
			const error = parser.detectErrorFromParsed({
				type: 'error',
				error: { message: 'unauthorized' },
			});

			expect(error).not.toBeNull();
			expect(error?.type).toBe('auth_expired');
		});

		it('should return null for non-error objects', () => {
			expect(parser.detectErrorFromParsed({ type: 'assistant.message' })).toBeNull();
			expect(parser.detectErrorFromParsed(null)).toBeNull();
			expect(parser.detectErrorFromParsed('string')).toBeNull();
		});
	});

	describe('detectErrorFromExit', () => {
		it('should return null for exit code 0', () => {
			expect(parser.detectErrorFromExit(0, '', '')).toBeNull();
		});

		it('should detect agent crash for non-zero exit', () => {
			const error = parser.detectErrorFromExit(1, 'some error', '');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('agent_crashed');
			expect(error?.message).toContain('exited with code 1');
		});

		it('should detect auth errors from stderr', () => {
			const error = parser.detectErrorFromExit(1, 'not authenticated', '');
			expect(error).not.toBeNull();
			expect(error?.type).toBe('auth_expired');
		});
	});

	// ================================================================
	// End-to-end: full session simulation
	// ================================================================

	describe('full session simulation', () => {
		it('should correctly parse a complete simple session', () => {
			const lines = [
				JSON.stringify({
					type: 'session.mcp_server_status_changed',
					data: { serverName: 'github-mcp-server', status: 'connected' },
					ephemeral: true,
				}),
				JSON.stringify({
					type: 'session.mcp_servers_loaded',
					data: { servers: [] },
					ephemeral: true,
				}),
				JSON.stringify({ type: 'session.tools_updated', data: { model: 'claude-opus-4.6' } }),
				JSON.stringify({ type: 'user.message', data: { content: 'Say hello' } }),
				JSON.stringify({ type: 'assistant.turn_start', data: { turnId: '0' } }),
				JSON.stringify({
					type: 'assistant.message_delta',
					data: { deltaContent: 'Hello' },
					ephemeral: true,
				}),
				JSON.stringify({
					type: 'assistant.message_delta',
					data: { deltaContent: ' world!' },
					ephemeral: true,
				}),
				JSON.stringify({
					type: 'assistant.message',
					data: { content: 'Hello world!', toolRequests: [], outputTokens: 5 },
				}),
				JSON.stringify({ type: 'assistant.turn_end', data: { turnId: '0' } }),
				JSON.stringify({
					type: 'result',
					sessionId: 'test-session-id',
					exitCode: 0,
					usage: { premiumRequests: 1 },
				}),
			];

			const events = lines.map((l) => parser.parseJsonLine(l)).filter((e) => e !== null);

			// Should have 10 events
			expect(events).toHaveLength(10);

			// Check event types in order
			expect(events[0].type).toBe('system'); // mcp status
			expect(events[1].type).toBe('system'); // mcp loaded
			expect(events[2].type).toBe('init'); // tools updated
			expect(events[3].type).toBe('system'); // user message echo
			expect(events[4].type).toBe('system'); // turn start
			expect(events[5].type).toBe('text'); // delta "Hello"
			expect(events[6].type).toBe('text'); // delta " world!"
			expect(events[7].type).toBe('result'); // final message
			expect(events[8].type).toBe('system'); // turn end
			expect(events[9].type).toBe('usage'); // result with sessionId

			// Verify streaming deltas
			expect(events[5].text).toBe('Hello');
			expect(events[5].isPartial).toBe(true);
			expect(events[6].text).toBe(' world!');

			// Verify result message
			expect(events[7].text).toBe('Hello world!');
			expect(events[7].isPartial).toBe(false);

			// Verify session ID from result
			expect(events[9].sessionId).toBe('test-session-id');
		});

		it('should correctly parse a session with tool use', () => {
			const lines = [
				JSON.stringify({ type: 'session.tools_updated', data: { model: 'claude-opus-4.6' } }),
				JSON.stringify({ type: 'assistant.turn_start', data: { turnId: '0' } }),
				// Tool request message (no text content)
				JSON.stringify({
					type: 'assistant.message',
					data: {
						content: '',
						toolRequests: [
							{ toolCallId: 'tc1', name: 'view', arguments: { path: '/package.json' } },
						],
						outputTokens: 100,
					},
				}),
				// Tool execution
				JSON.stringify({
					type: 'tool.execution_start',
					data: { toolCallId: 'tc1', toolName: 'view', arguments: { path: '/package.json' } },
				}),
				JSON.stringify({
					type: 'tool.execution_complete',
					data: {
						toolCallId: 'tc1',
						toolName: 'view',
						success: true,
						result: { content: '{"name":"maestro"}' },
					},
				}),
				// Final response
				JSON.stringify({
					type: 'assistant.message',
					data: { content: 'The package is named maestro.', toolRequests: [], outputTokens: 20 },
				}),
				JSON.stringify({ type: 'assistant.turn_end', data: { turnId: '0' } }),
				JSON.stringify({
					type: 'result',
					sessionId: 'sess-456',
					exitCode: 0,
					usage: { premiumRequests: 2 },
				}),
			];

			const events = lines.map((l) => parser.parseJsonLine(l)).filter((e) => e !== null);

			// Find tool events
			const toolEvents = events.filter((e) => e.type === 'tool_use');
			expect(toolEvents).toHaveLength(3); // tool request + start + complete

			// Verify tool request from assistant.message
			expect(toolEvents[0].toolUseBlocks).toHaveLength(1);
			expect(toolEvents[0].toolUseBlocks?.[0].name).toBe('view');

			// Verify tool start
			expect(toolEvents[1].toolName).toBe('view');
			expect((toolEvents[1].toolState as { status: string }).status).toBe('running');

			// Verify tool complete
			expect(toolEvents[2].toolName).toBe('view');
			expect((toolEvents[2].toolState as { status: string }).status).toBe('completed');

			// Verify final result
			const resultEvents = events.filter((e) => e.type === 'result');
			expect(resultEvents).toHaveLength(1);
			expect(resultEvents[0].text).toBe('The package is named maestro.');

			// Verify accumulated tokens
			const usageEvent = events.find((e) => e.type === 'usage');
			expect(usageEvent?.usage?.outputTokens).toBe(120); // 100 + 20
		});
	});
});
