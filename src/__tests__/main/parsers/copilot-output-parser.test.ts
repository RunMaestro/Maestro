import { describe, it, expect } from 'vitest';
import { CopilotOutputParser } from '../../../main/parsers/copilot-output-parser';

describe('CopilotOutputParser', () => {
	it('parses final assistant messages as result events', () => {
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'assistant.message',
			data: {
				content: 'DONE',
				phase: 'final_answer',
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'result',
				text: 'DONE',
			})
		);
		expect(event && parser.isResultMessage(event)).toBe(true);
	});

	it('treats tool-only final assistant messages as result events', () => {
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'assistant.message',
			data: {
				content: '',
				phase: 'final_answer',
				toolRequests: [
					{
						toolCallId: 'call_123',
						name: 'view',
						arguments: { path: '/tmp/project' },
					},
				],
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'result',
				toolUseBlocks: [
					{
						name: 'view',
						id: 'call_123',
						input: { path: '/tmp/project' },
					},
				],
			})
		);
		expect(event && parser.isResultMessage(event)).toBe(true);
	});

	it('tracks tool request metadata from commentary messages for later tool completion events', () => {
		const parser = new CopilotOutputParser();

		const commentaryEvent = parser.parseJsonObject({
			type: 'assistant.message',
			data: {
				content: '',
				phase: 'commentary',
				toolRequests: [
					{
						toolCallId: 'call_123',
						name: 'view',
						arguments: { path: '/tmp/project' },
					},
				],
			},
		});

		expect(commentaryEvent).toEqual(
			expect.objectContaining({
				type: 'text',
				text: '',
			})
		);

		const completionEvent = parser.parseJsonObject({
			type: 'tool.execution_complete',
			data: {
				toolCallId: 'call_123',
				success: true,
				result: {
					content: 'README.md',
				},
			},
		});

		expect(completionEvent).toEqual(
			expect.objectContaining({
				type: 'tool_use',
				toolName: 'view',
				toolState: {
					status: 'completed',
					output: 'README.md',
				},
			})
		);
	});

	it('does not treat a subagent final_answer (parentToolCallId set) as the parent result', () => {
		// Subagents reply via the parent's events.jsonl with parentToolCallId set.
		// If we surfaced them as 'result', StdoutHandler would set resultEmitted on
		// the FIRST subagent reply and the parent's real conclusion would never
		// reach the UI. They are downgraded to 'system' instead.
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'assistant.message',
			data: {
				content: 'main | abc123 fix something | dirty=0',
				phase: 'final_answer',
				toolRequests: [],
				parentToolCallId: 'call_subagent_xyz',
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'system',
			})
		);
		expect(event && parser.isResultMessage(event)).toBe(false);
	});

	it('does not treat a structural subagent final answer (no phase + parentToolCallId) as the parent result', () => {
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'assistant.message',
			data: {
				content: 'subagent summary text',
				toolRequests: [],
				parentToolCallId: 'call_subagent_xyz',
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'system',
			})
		);
		expect(event && parser.isResultMessage(event)).toBe(false);
	});

	it('recognizes modern Copilot final messages by structure (no phase field)', () => {
		// Regression: Copilot CLI ≥ 1.0.35 does not emit `phase: 'final_answer'`.
		// The final assistant message is identified structurally by non-empty
		// content + empty toolRequests. The parser must still emit it as a
		// result so StdoutHandler flushes the response; previously this was
		// dropped as a 'system' event when deltas had preceded it, leaving the
		// UI to rely on possibly-incomplete accumulated deltas.
		const parser = new CopilotOutputParser();

		parser.parseJsonObject({ type: 'assistant.turn_start' });
		parser.parseJsonObject({
			type: 'assistant.message_delta',
			data: { deltaContent: 'Here is the' },
		});
		parser.parseJsonObject({
			type: 'assistant.message_delta',
			data: { deltaContent: ' answer.' },
		});

		const event = parser.parseJsonObject({
			type: 'assistant.message',
			data: {
				content: 'Here is the full canonical answer.',
				toolRequests: [],
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'result',
				text: 'Here is the full canonical answer.',
			})
		);
		expect(event && parser.isResultMessage(event)).toBe(true);
	});

	it('treats intermediate tool-call messages (empty content + tools) as text with tool blocks', () => {
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'assistant.message',
			data: {
				content: '',
				toolRequests: [{ toolCallId: 'call_1', name: 'bash', arguments: { command: 'ls' } }],
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'text',
				text: '',
				toolUseBlocks: [{ name: 'bash', id: 'call_1', input: { command: 'ls' } }],
			})
		);
		expect(event && parser.isResultMessage(event)).toBe(false);
	});

	it('parses assistant message deltas as partial text events', () => {
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'assistant.message_delta',
			data: {
				deltaContent: 'OK',
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'text',
				text: 'OK',
				isPartial: true,
			})
		);
	});

	it('drops assistant.message_delta events from delegated subagents (parentToolCallId set)', () => {
		// Without this filter, subagent deltas race the parent's deltas in the
		// stdout stream and StdoutHandler's `streamedText` accumulator interleaves
		// them character-by-character, producing garbled text like "Stri Since the
		// indexercter" (parent "Strict … indexer" merged with subagent "Since the …").
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'assistant.message_delta',
			data: {
				deltaContent: 'subagent narration that must not bleed into parent stream',
				parentToolCallId: 'call_subagent_xyz',
			},
		});

		expect(event).toBeNull();
	});

	it('drops assistant.reasoning_delta events from delegated subagents (parentToolCallId set)', () => {
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'assistant.reasoning_delta',
			data: {
				deltaContent: 'subagent thinking that must not pollute parent thinking',
				parentToolCallId: 'call_subagent_xyz',
			},
		});

		expect(event).toBeNull();
	});

	it('drops assistant.reasoning summary events from delegated subagents (parentToolCallId set)', () => {
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'assistant.reasoning',
			data: {
				content: 'subagent reasoning summary that must not bleed in',
				parentToolCallId: 'call_subagent_xyz',
			},
		});

		expect(event).toBeNull();
	});

	it('skips assistant reasoning summary when deltas already streamed the content', () => {
		const parser = new CopilotOutputParser();

		// Simulate a turn with reasoning deltas first
		parser.parseJsonObject({ type: 'assistant.turn_start' });
		parser.parseJsonObject({
			type: 'assistant.reasoning_delta',
			data: { deltaContent: 'Thinking through the repository structure...' },
		});

		// The summary should be skipped since deltas already delivered the content
		const event = parser.parseJsonObject({
			type: 'assistant.reasoning',
			data: {
				content: 'Thinking through the repository structure...',
			},
		});

		expect(event).toBeNull();
	});

	it('uses assistant reasoning content when no deltas preceded it', () => {
		const parser = new CopilotOutputParser();

		parser.parseJsonObject({ type: 'assistant.turn_start' });

		const event = parser.parseJsonObject({
			type: 'assistant.reasoning',
			data: {
				content: 'Thinking through the repository structure...',
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'text',
				text: 'Thinking through the repository structure...',
				isPartial: true,
			})
		);
	});

	it('parses assistant reasoning delta events as partial text events', () => {
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'assistant.reasoning_delta',
			data: {
				deltaContent: 'Thinking live...',
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'text',
				text: 'Thinking live...',
				isPartial: true,
			})
		);
	});

	it('tracks tool execution start and completion by toolCallId', () => {
		const parser = new CopilotOutputParser();

		const startEvent = parser.parseJsonObject({
			type: 'tool.execution_start',
			data: {
				toolCallId: 'call_123',
				toolName: 'view',
				arguments: { path: '/tmp/project' },
			},
		});

		expect(startEvent).toEqual(
			expect.objectContaining({
				type: 'tool_use',
				toolName: 'view',
				toolCallId: 'call_123',
				toolState: {
					status: 'running',
					input: { path: '/tmp/project' },
				},
			})
		);

		const completeEvent = parser.parseJsonObject({
			type: 'tool.execution_complete',
			data: {
				toolCallId: 'call_123',
				success: true,
				result: {
					content: 'README.md',
				},
			},
		});

		expect(completeEvent).toEqual(
			expect.objectContaining({
				type: 'tool_use',
				toolName: 'view',
				toolCallId: 'call_123',
				toolState: {
					status: 'completed',
					output: 'README.md',
				},
			})
		);
	});

	it('treats failed tool execution as tool state, not a top-level agent error', () => {
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'tool.execution_complete',
			data: {
				toolCallId: 'call_123',
				toolName: 'read_bash',
				success: false,
				error:
					'Invalid shell ID: $SHELL_2. Please supply a valid shell ID to read output from. <no active shell sessions>',
			},
		});

		const error = parser.detectErrorFromParsed({
			type: 'tool.execution_complete',
			data: {
				toolCallId: 'call_123',
				toolName: 'read_bash',
				success: false,
				error:
					'Invalid shell ID: $SHELL_2. Please supply a valid shell ID to read output from. <no active shell sessions>',
			},
		});

		expect(event).toEqual(
			expect.objectContaining({
				type: 'tool_use',
				toolCallId: 'call_123',
				toolState: {
					status: 'failed',
					output:
						'Invalid shell ID: $SHELL_2. Please supply a valid shell ID to read output from. <no active shell sessions>',
				},
			})
		);
		expect(error).toBeNull();
	});

	it('extracts session ids from result events', () => {
		const parser = new CopilotOutputParser();
		const event = parser.parseJsonObject({
			type: 'result',
			sessionId: '8654632e-5527-4b25-8994-66b1be2c6cc8',
			exitCode: 0,
		});

		expect(event?.type).toBe('result');
		expect(event && parser.extractSessionId(event)).toBe('8654632e-5527-4b25-8994-66b1be2c6cc8');
	});

	it('detects structured error events', () => {
		const parser = new CopilotOutputParser();
		const error = parser.detectErrorFromParsed({
			type: 'error',
			error: { message: 'Authentication expired. Please run /login.' },
		});

		expect(error).toEqual(
			expect.objectContaining({
				agentId: 'copilot-cli',
				message: expect.any(String),
			})
		);
	});

	it('does not treat reasoning message content as an agent error', () => {
		const parser = new CopilotOutputParser();
		const error = parser.detectErrorFromParsed({
			type: 'assistant.reasoning',
			data: {
				message: 'Thinking through the repository structure...',
			},
		});

		expect(error).toBeNull();
	});

	it('attaches per-turn output token usage from assistant.message events', () => {
		// Copilot CLI ≥1.0.39 reports outputTokens directly on the final
		// assistant.message. Without this, the context window UI shows 0/0%.
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'assistant.message',
			data: {
				content: 'Hello!',
				toolRequests: [],
				outputTokens: 5,
			},
		});

		expect(event?.type).toBe('result');
		expect(event && parser.extractUsage(event)).toEqual({
			inputTokens: 0,
			outputTokens: 5,
		});
	});

	it('attaches output token usage on intermediate tool-call messages too', () => {
		// Tool-call assistant.messages also report outputTokens - capture them
		// so per-turn usage isn't dropped on multi-turn responses.
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'assistant.message',
			data: {
				content: '',
				toolRequests: [{ toolCallId: 'call_1', name: 'bash', arguments: { command: 'ls' } }],
				outputTokens: 12,
			},
		});

		expect(event?.type).toBe('text');
		expect(event && parser.extractUsage(event)).toEqual({
			inputTokens: 0,
			outputTokens: 12,
		});
	});

	it('does not emit a usage object when outputTokens is missing or zero', () => {
		const parser = new CopilotOutputParser();

		const noField = parser.parseJsonObject({
			type: 'assistant.message',
			data: { content: 'Hello!', toolRequests: [] },
		});
		expect(noField && parser.extractUsage(noField)).toBeNull();

		const zero = parser.parseJsonObject({
			type: 'assistant.message',
			data: { content: 'Hello!', toolRequests: [], outputTokens: 0 },
		});
		expect(zero && parser.extractUsage(zero)).toBeNull();
	});

	it('reports per-turn outputTokens on every assistant.message in a multi-turn run', () => {
		// Verified against Copilot CLI 1.0.39 and 1.0.43: a tool-using response
		// emits multiple assistant.message events, each with its own outputTokens.
		// StdoutHandler doesn't delta-normalize copilot-cli, so the renderer sums
		// these into the running total. The parser's job is to surface every value.
		const parser = new CopilotOutputParser();

		const toolTurn = parser.parseJsonObject({
			type: 'assistant.message',
			data: {
				content: '',
				toolRequests: [{ toolCallId: 'call_1', name: 'bash', arguments: { command: 'ls' } }],
				outputTokens: 178,
			},
		});
		const finalTurn = parser.parseJsonObject({
			type: 'assistant.message',
			data: { content: 'Done.', toolRequests: [], outputTokens: 35 },
		});

		expect(toolTurn && parser.extractUsage(toolTurn)).toEqual({
			inputTokens: 0,
			outputTokens: 178,
		});
		expect(finalTurn && parser.extractUsage(finalTurn)).toEqual({
			inputTokens: 0,
			outputTokens: 35,
		});
	});

	it('extracts modelMetrics usage from session.shutdown events (legacy ≤1.0.5)', () => {
		const parser = new CopilotOutputParser();

		const event = parser.parseJsonObject({
			type: 'session.shutdown',
			data: {
				modelMetrics: {
					'claude-sonnet-4.6': {
						usage: {
							inputTokens: 100,
							outputTokens: 50,
							cacheReadTokens: 800,
							cacheWriteTokens: 200,
						},
					},
				},
			},
		});

		expect(event && parser.extractUsage(event)).toEqual({
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 800,
			cacheCreationTokens: 200,
		});
	});

	it('maps no-tty interactive launch failures to a clearer crash message', () => {
		const parser = new CopilotOutputParser();
		const error = parser.detectErrorFromExit(
			1,
			'No prompt provided. Run in an interactive terminal or provide a prompt with -p or via standard in.',
			''
		);

		expect(error).toEqual(
			expect.objectContaining({
				type: 'agent_crashed',
				message: expect.stringContaining('require PTY mode'),
				agentId: 'copilot-cli',
			})
		);
	});
});
