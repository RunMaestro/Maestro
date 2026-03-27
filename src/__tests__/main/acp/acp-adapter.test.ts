import { describe, it, expect } from 'vitest';
import {
	acpUpdateToParseEvent,
	createSessionIdEvent,
	createResultEvent,
	createErrorEvent,
} from '../../../main/acp/acp-adapter';
import type { SessionUpdate } from '../../../main/acp/types';

describe('ACP Adapter', () => {
	const testSessionId = 'test-session-123';

	describe('acpUpdateToParseEvent', () => {
		describe('agent_message_chunk', () => {
			it('should convert OpenCode format text chunk to ParsedEvent', () => {
				// OpenCode sends: { type: 'text', text: 'Hello' }
				const update = {
					agent_message_chunk: {
						content: { type: 'text', text: 'Hello, world!' },
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('Hello, world!');
				expect(event?.isPartial).toBe(true);
				expect(event?.sessionId).toBe(testSessionId);
			});

			it('should convert ACP spec format text chunk to ParsedEvent', () => {
				// ACP spec: { text: { text: 'Hello' } }
				const update = {
					agent_message_chunk: {
						content: { text: { text: 'Spec format text' } },
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('Spec format text');
			});

			it('should handle image content blocks', () => {
				const update = {
					agent_message_chunk: {
						content: { image: { data: 'base64...', mimeType: 'image/png' } },
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.text).toBe('[image]');
			});

			it('should handle resource_link content blocks', () => {
				const update = {
					agent_message_chunk: {
						content: { resource_link: { uri: 'file://test.txt', name: 'test.txt' } },
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.text).toBe('[resource: test.txt]');
			});
		});

		describe('agent_thought_chunk', () => {
			it('should convert thought chunks with [thinking] prefix', () => {
				const update = {
					agent_thought_chunk: {
						content: { type: 'text', text: 'Let me think about this...' },
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.type).toBe('text');
				expect(event?.text).toBe('[thinking] Let me think about this...');
				expect(event?.isPartial).toBe(true);
			});
		});

		describe('user_message_chunk', () => {
			it('should return null for user message chunks (not displayed)', () => {
				const update = {
					user_message_chunk: {
						content: { type: 'text', text: 'User input' },
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).toBeNull();
			});
		});

		describe('tool_call', () => {
			it('should convert tool_call to tool_use ParsedEvent', () => {
				const update = {
					tool_call: {
						toolCallId: 'tc-123',
						title: 'Read File',
						kind: 'read',
						status: 'in_progress',
						rawInput: { path: '/test/file.txt' },
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.type).toBe('tool_use');
				expect(event?.toolName).toBe('Read File');
				expect(event?.toolState).toEqual({
					id: 'tc-123',
					input: { path: '/test/file.txt' },
					status: 'running', // 'in_progress' maps to 'running'
				});
			});

			it('should map tool status correctly', () => {
				const statuses = [
					{ acp: 'pending', expected: 'pending' },
					{ acp: 'in_progress', expected: 'running' },
					{ acp: 'completed', expected: 'completed' },
					{ acp: 'failed', expected: 'error' },
				];

				for (const { acp, expected } of statuses) {
					const update = {
						tool_call: {
							toolCallId: 'tc-test',
							title: 'Test',
							status: acp,
						},
					} as unknown as SessionUpdate;

					const event = acpUpdateToParseEvent(testSessionId, update);
					const toolState = event?.toolState as { status?: string } | undefined;
					expect(toolState?.status).toBe(expected);
				}
			});
		});

		describe('tool_call_update', () => {
			it('should convert tool_call_update with output', () => {
				const update = {
					tool_call_update: {
						toolCallId: 'tc-123',
						title: 'Read File',
						status: 'completed',
						rawInput: { path: '/test/file.txt' },
						rawOutput: { content: 'file contents' },
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);
				const toolState = event?.toolState as { output?: unknown; status?: string } | undefined;

				expect(event).not.toBeNull();
				expect(event?.type).toBe('tool_use');
				expect(toolState?.output).toEqual({ content: 'file contents' });
				expect(toolState?.status).toBe('completed');
			});
		});

		describe('plan', () => {
			it('should convert plan to system message', () => {
				const update = {
					plan: {
						entries: [
							{ content: 'Read the file', status: 'completed', priority: 'high' },
							{ content: 'Analyze content', status: 'in_progress', priority: 'medium' },
							{ content: 'Write response', status: 'pending', priority: 'low' },
						],
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
				expect(event?.text).toContain('Plan:');
				expect(event?.text).toContain('[completed] Read the file');
				expect(event?.text).toContain('[in_progress] Analyze content');
				expect(event?.text).toContain('[pending] Write response');
			});
		});

		describe('available_commands_update', () => {
			it('should convert to init event with slash commands', () => {
				const update = {
					available_commands_update: {
						availableCommands: [
							{ name: '/help', description: 'Show help' },
							{ name: '/clear', description: 'Clear history' },
							{ name: '/compact', description: 'Compact mode' },
						],
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.type).toBe('init');
				expect(event?.slashCommands).toEqual(['/help', '/clear', '/compact']);
			});
		});

		describe('current_mode_update', () => {
			it('should convert mode update to system message', () => {
				const update = {
					current_mode_update: {
						currentModeId: 'code',
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
				expect(event?.text).toBe('Mode changed to: code');
				expect(event?.sessionId).toBe(testSessionId);
			});
		});

		describe('usage_update', () => {
			it('should convert usage update to usage ParsedEvent', () => {
				const update = {
					usage_update: {
						used: 5000,
						size: 128000,
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.type).toBe('usage');
				expect(event?.sessionId).toBe(testSessionId);
				expect(event?.usage).toEqual({
					inputTokens: 5000,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					contextWindow: 128000,
					costUsd: 0,
				});
			});

			it('should include USD cost when provided', () => {
				const update = {
					usage_update: {
						used: 10000,
						size: 128000,
						cost: {
							amount: 0.0125,
							currency: 'USD',
						},
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.usage?.costUsd).toBe(0.0125);
			});

			it('should set costUsd to 0 for non-USD currencies', () => {
				const update = {
					usage_update: {
						used: 10000,
						size: 128000,
						cost: {
							amount: 0.01,
							currency: 'EUR',
						},
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.usage?.costUsd).toBe(0);
			});
		});

		describe('config_option_update', () => {
			it('should convert config option update to system message', () => {
				const update = {
					config_option_update: {
						key: 'model',
						value: 'claude-3-opus',
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.type).toBe('system');
				expect(event?.text).toBe('Config updated: model = "claude-3-opus"');
				expect(event?.sessionId).toBe(testSessionId);
			});

			it('should handle complex config values', () => {
				const update = {
					config_option_update: {
						key: 'options',
						value: { streaming: true, maxTokens: 4096 },
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.text).toBe('Config updated: options = {"streaming":true,"maxTokens":4096}');
			});

			it('should handle boolean config values', () => {
				const update = {
					config_option_update: {
						key: 'verboseMode',
						value: true,
					},
				} as unknown as SessionUpdate;

				const event = acpUpdateToParseEvent(testSessionId, update);

				expect(event).not.toBeNull();
				expect(event?.text).toBe('Config updated: verboseMode = true');
			});
		});
	});

	describe('createSessionIdEvent', () => {
		it('should create an init event with sessionId', () => {
			const event = createSessionIdEvent('new-session-456');

			expect(event.type).toBe('init');
			expect(event.sessionId).toBe('new-session-456');
			expect(event.raw).toEqual({
				type: 'session_created',
				sessionId: 'new-session-456',
			});
		});
	});

	describe('createResultEvent', () => {
		it('should create a result event with usage data', () => {
			const usage = {
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
			};

			const event = createResultEvent(testSessionId, 'Task completed', 'end_turn', usage);

			expect(event.type).toBe('result');
			expect(event.text).toBe('Task completed');
			expect(event.sessionId).toBe(testSessionId);
			expect(event.usage).toEqual({
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: 0,
				contextWindow: 0,
			});
		});

		it('should create a result event without usage data', () => {
			const event = createResultEvent(testSessionId, 'Done', 'end_turn');

			expect(event.type).toBe('result');
			expect(event.text).toBe('Done');
			expect(event.usage).toBeUndefined();
		});

		it('should handle partial usage data', () => {
			const usage = {
				inputTokens: 100,
				// outputTokens missing
			};

			const event = createResultEvent(testSessionId, 'Done', 'end_turn', usage);

			expect(event.usage?.inputTokens).toBe(100);
			expect(event.usage?.outputTokens).toBe(0);
		});
	});

	describe('createErrorEvent', () => {
		it('should create an error event', () => {
			const event = createErrorEvent(testSessionId, 'Connection failed');

			expect(event.type).toBe('error');
			expect(event.text).toBe('Connection failed');
			expect(event.sessionId).toBe(testSessionId);
			expect(event.raw).toEqual({
				type: 'error',
				message: 'Connection failed',
			});
		});
	});
});
