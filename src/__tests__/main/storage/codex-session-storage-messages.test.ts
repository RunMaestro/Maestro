/**
 * Tests for Codex session storage readSessionMessages - specifically verifying
 * that tool calls are properly parsed with toolUse for ToolCallCard rendering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Electron app
vi.mock('electron', () => ({
	app: { getPath: () => '/tmp' },
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock sentry
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// Mock remote-fs
vi.mock('../../../main/utils/remote-fs', () => ({
	readFileRemote: vi.fn(),
	readDirRemote: vi.fn(),
	statRemote: vi.fn(),
}));

// Mock fs
vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		readdir: vi.fn(),
		stat: vi.fn(),
		access: vi.fn(),
	},
}));

import fs from 'fs/promises';
import { CodexSessionStorage } from '../../../main/storage/codex-session-storage';

/**
 * Create a realistic Codex v0.111.0 session JSONL content
 */
function createSessionContent(): string {
	const lines = [
		// Line 1: session metadata
		JSON.stringify({
			timestamp: '2026-03-08T03:10:29.069Z',
			type: 'session_meta',
			payload: {
				id: '019ccb6c-c0fd-7b70-92b7-558f514099c6',
				timestamp: '2026-03-08T03:10:28.101Z',
				cwd: 'C:\\Users\\test\\project',
				cli_version: '0.111.0',
			},
		}),
		// Line 2: user message
		JSON.stringify({
			timestamp: '2026-03-08T03:10:29.070Z',
			type: 'response_item',
			payload: {
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'Fix the bug in main.ts' }],
			},
		}),
		// Line 3: assistant message
		JSON.stringify({
			timestamp: '2026-03-08T03:10:33.000Z',
			type: 'response_item',
			payload: {
				type: 'message',
				role: 'assistant',
				content: [
					{
						type: 'output_text',
						text: "I'll review the code first.",
					},
				],
			},
		}),
		// Line 4: function_call
		JSON.stringify({
			timestamp: '2026-03-08T03:10:33.593Z',
			type: 'response_item',
			payload: {
				type: 'function_call',
				name: 'shell_command',
				arguments: '{"command":"cat main.ts","workdir":"C:\\\\Users\\\\test\\\\project"}',
				call_id: 'call_abc123',
			},
		}),
		// Line 5: function_call_output
		JSON.stringify({
			timestamp: '2026-03-08T03:10:40.169Z',
			type: 'response_item',
			payload: {
				type: 'function_call_output',
				call_id: 'call_abc123',
				output: 'Exit code: 0\nWall time: 1 seconds\nOutput:\nconst x = 1;',
			},
		}),
		// Line 6: custom_tool_call (apply_patch)
		JSON.stringify({
			timestamp: '2026-03-08T03:10:41.000Z',
			type: 'response_item',
			payload: {
				type: 'custom_tool_call',
				name: 'apply_patch',
				arguments:
					'{"patch":"--- a/main.ts\\n+++ b/main.ts\\n@@ -1 +1 @@\\n-const x = 1;\\n+const x = 2;"}',
				call_id: 'call_def456',
			},
		}),
		// Line 7: custom_tool_call_output
		JSON.stringify({
			timestamp: '2026-03-08T03:10:42.000Z',
			type: 'response_item',
			payload: {
				type: 'custom_tool_call_output',
				call_id: 'call_def456',
				output: 'Patch applied successfully',
			},
		}),
		// Line 8: final assistant message
		JSON.stringify({
			timestamp: '2026-03-08T03:10:44.000Z',
			type: 'response_item',
			payload: {
				type: 'message',
				role: 'assistant',
				content: [{ type: 'output_text', text: 'Fixed the bug.' }],
			},
		}),
	];
	return lines.join('\n');
}

describe('CodexSessionStorage - readSessionMessages', () => {
	let storage: CodexSessionStorage;

	beforeEach(() => {
		storage = new CodexSessionStorage();
		vi.clearAllMocks();
	});

	it('should parse function_call entries with toolUse', async () => {
		const content = createSessionContent();

		// Mock findSessionFile to return a path
		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/test.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'test-session', {
			offset: 0,
			limit: 50,
		});

		expect(result.messages.length).toBeGreaterThan(0);

		// Find the shell_command tool call message
		const shellMsg = result.messages.find((m) => m.content === 'Tool: shell_command');
		expect(shellMsg).toBeDefined();
		expect(shellMsg!.toolUse).toBeDefined();
		expect(Array.isArray(shellMsg!.toolUse)).toBe(true);

		const toolUseArr = shellMsg!.toolUse as any[];
		expect(toolUseArr.length).toBe(1);
		expect(toolUseArr[0].tool).toBe('shell_command');
		expect(toolUseArr[0].state).toBeDefined();
		expect(toolUseArr[0].state.status).toBe('completed');
		expect(toolUseArr[0].state.input).toBeDefined();
		expect(toolUseArr[0].state.output).toBe(
			'Exit code: 0\nWall time: 1 seconds\nOutput:\nconst x = 1;'
		);
	});

	it('should parse custom_tool_call entries with toolUse', async () => {
		const content = createSessionContent();

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/test.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'test-session', {
			offset: 0,
			limit: 50,
		});

		const patchMsg = result.messages.find((m) => m.content === 'Tool: apply_patch');
		expect(patchMsg).toBeDefined();
		expect(patchMsg!.toolUse).toBeDefined();

		const toolUseArr = patchMsg!.toolUse as any[];
		expect(toolUseArr[0].tool).toBe('apply_patch');
		expect(toolUseArr[0].state.output).toBe('Patch applied successfully');
	});

	it('should NOT create messages for function_call_output entries', async () => {
		const content = createSessionContent();

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/test.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'test-session', {
			offset: 0,
			limit: 50,
		});

		// Should have: user msg, assistant msg, shell_command tool, apply_patch tool, final assistant msg = 5
		expect(result.messages.length).toBe(5);

		// Verify no message contains raw output text as content
		const outputMsg = result.messages.find((m) => m.content.includes('Exit code:'));
		expect(outputMsg).toBeUndefined();
	});

	it('should render plain text messages without toolUse', async () => {
		const content = createSessionContent();

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/test.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'test-session', {
			offset: 0,
			limit: 50,
		});

		const textMsg = result.messages.find((m) => m.content === "I'll review the code first.");
		expect(textMsg).toBeDefined();
		expect(textMsg!.toolUse).toBeUndefined();
	});

	it('toolUse array entries should satisfy ToolCallCard interface', async () => {
		const content = createSessionContent();

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/test.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'test-session', {
			offset: 0,
			limit: 50,
		});

		// Check all messages with toolUse
		for (const msg of result.messages) {
			if (msg.toolUse) {
				const arr = msg.toolUse as any[];
				expect(Array.isArray(arr)).toBe(true);
				expect(arr.length).toBeGreaterThan(0);

				for (const entry of arr) {
					// Must have 'tool' or 'name' for getToolName()
					expect(entry.tool || entry.name).toBeTruthy();
					// Must have state for ToolCallCard rendering
					expect(entry.state).toBeDefined();
					expect(entry.state.status).toBeDefined();
				}
			}
		}
	});

	it('should handle function_call_output with no matching call_id', async () => {
		const lines = [
			JSON.stringify({
				timestamp: '2026-03-08T03:10:29.069Z',
				type: 'session_meta',
				payload: {
					id: 'orphan-test-session',
					timestamp: '2026-03-08T03:10:28.101Z',
					cwd: 'C:\\Users\\test\\project',
				},
			}),
			// Output without a preceding tool call
			JSON.stringify({
				timestamp: '2026-03-08T03:10:40.000Z',
				type: 'response_item',
				payload: {
					type: 'function_call_output',
					call_id: 'call_nonexistent',
					output: 'Orphaned output text',
				},
			}),
		];
		const content = lines.join('\n');

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/orphan.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'orphan-session', {
			offset: 0,
			limit: 50,
		});

		// Should create a standalone message with the output text
		const orphanMsg = result.messages.find((m) => m.content === 'Orphaned output text');
		expect(orphanMsg).toBeDefined();
		expect(orphanMsg!.toolUse).toBeUndefined();
	});

	it('should handle empty session file', async () => {
		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/empty.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue('');

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'empty-session', {
			offset: 0,
			limit: 50,
		});

		expect(result.messages).toEqual([]);
		expect(result.total).toBe(0);
	});

	it('should handle session file with only malformed JSON lines', async () => {
		const content = 'not json line 1\nalso not json\n{broken json';

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/bad.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'bad-session', {
			offset: 0,
			limit: 50,
		});

		// Malformed lines should be silently skipped
		expect(result.messages).toEqual([]);
		expect(result.total).toBe(0);
	});

	it('should handle legacy item.completed tool_call and tool_result entries', async () => {
		const lines = [
			JSON.stringify({
				timestamp: '2026-03-08T03:10:29.069Z',
				type: 'session_meta',
				payload: {
					id: 'legacy-test',
					timestamp: '2026-03-08T03:10:28.101Z',
					cwd: 'C:\\Users\\test\\project',
				},
			}),
			JSON.stringify({
				timestamp: '2026-03-08T03:10:33.000Z',
				type: 'item.completed',
				item: {
					id: 'item_tool1',
					type: 'tool_call',
					tool: 'shell',
					args: { command: ['echo', 'hello'] },
				},
			}),
			JSON.stringify({
				timestamp: '2026-03-08T03:10:34.000Z',
				type: 'item.completed',
				item: {
					id: 'item_result1',
					type: 'tool_result',
					output: 'hello',
				},
			}),
		];
		const content = lines.join('\n');

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/legacy.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages('C:\\Users\\test\\project', 'legacy-session', {
			offset: 0,
			limit: 50,
		});

		// Should have tool_call message and tool_result message
		const toolMsg = result.messages.find((m) => m.content === 'Tool: shell');
		expect(toolMsg).toBeDefined();
		expect(toolMsg!.toolUse).toBeDefined();

		const resultMsg = result.messages.find((m) => m.content === 'hello');
		expect(resultMsg).toBeDefined();
	});

	it('should handle function_call_output with empty output string', async () => {
		const lines = [
			JSON.stringify({
				timestamp: '2026-03-08T03:10:29.069Z',
				type: 'session_meta',
				payload: {
					id: 'empty-output-test',
					cwd: 'C:\\Users\\test\\project',
				},
			}),
			JSON.stringify({
				timestamp: '2026-03-08T03:10:33.000Z',
				type: 'response_item',
				payload: {
					type: 'function_call',
					name: 'write_file',
					arguments: '{"path":"test.txt"}',
					call_id: 'call_empty_out',
				},
			}),
			JSON.stringify({
				timestamp: '2026-03-08T03:10:34.000Z',
				type: 'response_item',
				payload: {
					type: 'function_call_output',
					call_id: 'call_empty_out',
					output: '',
				},
			}),
		];
		const content = lines.join('\n');

		vi.spyOn(storage as any, 'findSessionFile').mockResolvedValue(
			'/home/user/.codex/sessions/2026/03/08/empty-out.jsonl'
		);
		vi.mocked(fs.readFile).mockResolvedValue(content);

		const result = await storage.readSessionMessages(
			'C:\\Users\\test\\project',
			'empty-output-session',
			{ offset: 0, limit: 50 }
		);

		// The tool call should exist and have its output merged (even if empty)
		const toolMsg = result.messages.find((m) => m.content === 'Tool: write_file');
		expect(toolMsg).toBeDefined();
		const toolUseArr = toolMsg!.toolUse as any[];
		expect(toolUseArr[0].state.status).toBe('completed');
		expect(toolUseArr[0].state.output).toBe('');
	});
});
