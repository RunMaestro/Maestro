import type { ParsedEvent } from '../../main/parsers/agent-output-parser';

export interface PiProtocolGoldenCase {
	name: string;
	line: string;
	expected: ParsedEvent | null;
}

const session = { type: 'session', id: 'protocol-session' };
const userMessage = { type: 'message_end', message: { role: 'user', content: 'hello' } };
const textChunk = {
	type: 'message_update',
	sessionId: 'protocol-session',
	assistantMessageEvent: { type: 'text_delta', delta: 'hello ' },
};
const thinkingChunk = {
	type: 'message_update',
	session_id: 'protocol-session',
	assistantMessageEvent: { type: 'thinking_delta', delta: 'considering' },
};
const usage = {
	type: 'message_end',
	sessionId: 'protocol-session',
	message: {
		role: 'assistant',
		usage: { input: 12, output: 7, cacheRead: 3, cacheWrite: 2, cost: { total: 0.01 } },
	},
};
const toolStart = {
	type: 'tool_execution_start',
	sessionId: 'protocol-session',
	toolCallId: 'tool-1',
	toolName: 'read',
	args: { path: 'README.md' },
};
const toolUpdate = {
	type: 'tool_execution_update',
	sessionId: 'protocol-session',
	toolCallId: 'tool-1',
	toolName: 'read',
	partialResult: 'first chunk',
};
const toolEnd = {
	type: 'tool_execution_end',
	sessionId: 'protocol-session',
	toolCallId: 'tool-1',
	toolName: 'read',
	result: 'contents',
	isError: false,
};
const failedToolEnd = {
	type: 'tool_execution_end',
	sessionId: 'protocol-session',
	toolCallId: 'tool-2',
	toolName: 'write',
	result: 'permission denied',
	isError: true,
};
const final = {
	type: 'agent_end',
	sessionId: 'protocol-session',
	messages: [
		{ role: 'assistant', content: [{ type: 'text', text: 'intermediate' }] },
		{ role: 'toolResult', content: [{ type: 'text', text: 'ignored' }] },
		{
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'ignored' },
				{ type: 'text', text: 'final answer' },
			],
		},
	],
};
const error = {
	type: 'message_end',
	sessionId: 'protocol-session',
	message: { role: 'assistant', errorMessage: 'invalid api key' },
};
const retry = {
	type: 'agent_end',
	sessionId: 'protocol-session',
	willRetry: true,
	messages: [{ role: 'assistant', content: 'retry output' }],
};

export const PI_PROTOCOL_GOLDEN_CASES: readonly PiProtocolGoldenCase[] = [
	{
		name: 'session init',
		line: JSON.stringify(session),
		expected: { type: 'init', sessionId: 'protocol-session', raw: session },
	},
	{
		name: 'user message',
		line: JSON.stringify(userMessage),
		expected: { type: 'system', raw: userMessage },
	},
	{
		name: 'text chunk',
		line: JSON.stringify(textChunk),
		expected: {
			type: 'text',
			text: 'hello ',
			sessionId: 'protocol-session',
			isPartial: true,
			raw: textChunk,
		},
	},
	{
		name: 'thinking chunk',
		line: JSON.stringify(thinkingChunk),
		expected: {
			type: 'text',
			text: 'considering',
			sessionId: 'protocol-session',
			isPartial: true,
			isReasoning: true,
			raw: thinkingChunk,
		},
	},
	{
		name: 'assistant usage',
		line: JSON.stringify(usage),
		expected: {
			type: 'usage',
			sessionId: 'protocol-session',
			usage: {
				inputTokens: 12,
				outputTokens: 7,
				cacheReadTokens: 3,
				cacheCreationTokens: 2,
				costUsd: 0.01,
			},
			raw: usage,
		},
	},
	{
		name: 'tool start',
		line: JSON.stringify(toolStart),
		expected: {
			type: 'tool_use',
			toolCallId: 'tool-1',
			toolName: 'read',
			toolState: { status: 'running', input: { path: 'README.md' } },
			sessionId: 'protocol-session',
			raw: toolStart,
		},
	},
	{
		name: 'tool update',
		line: JSON.stringify(toolUpdate),
		expected: {
			type: 'tool_use',
			toolCallId: 'tool-1',
			toolName: 'read',
			toolState: { status: 'running', output: 'first chunk' },
			sessionId: 'protocol-session',
			raw: toolUpdate,
		},
	},
	{
		name: 'tool completion',
		line: JSON.stringify(toolEnd),
		expected: {
			type: 'tool_use',
			toolCallId: 'tool-1',
			toolName: 'read',
			toolState: { status: 'completed', output: 'contents' },
			sessionId: 'protocol-session',
			raw: toolEnd,
		},
	},
	{
		name: 'tool failure',
		line: JSON.stringify(failedToolEnd),
		expected: {
			type: 'tool_use',
			toolCallId: 'tool-2',
			toolName: 'write',
			toolState: { status: 'failed', output: 'permission denied' },
			sessionId: 'protocol-session',
			raw: failedToolEnd,
		},
	},
	{
		name: 'authoritative final result',
		line: JSON.stringify(final),
		expected: {
			type: 'result',
			text: 'final answer',
			sessionId: 'protocol-session',
			raw: final,
		},
	},
	{
		name: 'structured error',
		line: JSON.stringify(error),
		expected: { type: 'error', text: 'invalid api key', sessionId: 'protocol-session', raw: error },
	},
	{
		name: 'automatic retry',
		line: JSON.stringify(retry),
		expected: { type: 'system', sessionId: 'protocol-session', raw: retry },
	},
	{
		name: 'malformed output',
		line: 'not json',
		expected: { type: 'text', text: 'not json', raw: 'not json' },
	},
	{ name: 'blank line', line: '  ', expected: null },
];

export const PI_PROTOCOL_EXIT_GOLDEN_CASE = {
	exitCode: 1,
	stderr: '\u001B[31mconnection refused\u001B[0m',
	stdout: '',
};

export const PI_PROTOCOL_EXIT_FALLBACK_GOLDEN_CASE = {
	exitCode: 9,
	stderr: '\u001B[31mplain failure\u001B[0m',
	stdout: 'more output',
};

export const OMP_TTSR_GOLDEN_CASES = {
	messageEnd: {
		type: 'message_end',
		message: {
			role: 'assistant',
			errorMessage: 'TTSR matched rule: ts-no-any',
			usage: { input: 10, output: 5, cost: { total: 0.01 } },
		},
	},
	agentEnd: {
		type: 'agent_end',
		messages: [
			{
				role: 'assistant',
				content: [{ type: 'text', text: 'partial' }],
				errorMessage: 'TTSR matched rules: ts-no-any, ts-no-return-type',
			},
		],
	},
	nonTtsr: {
		type: 'message_end',
		message: { role: 'assistant', errorMessage: 'TTSR matched rulebook is unavailable' },
	},
} as const;
