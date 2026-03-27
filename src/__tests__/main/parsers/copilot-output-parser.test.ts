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
				agentId: 'copilot',
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
				agentId: 'copilot',
			})
		);
	});
});
