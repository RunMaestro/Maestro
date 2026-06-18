/**
 * @file output-parser.test.ts
 * @description Unit tests for group chat output parsing utilities.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the parsers module before importing the output-parser
vi.mock('../../../main/parsers', () => ({
	getOutputParser: vi.fn(),
}));

// Mock the logger to avoid console noise
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		warn: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
	},
}));

import {
	extractTextGeneric,
	extractTextFromAgentOutput,
	extractTextFromStreamJson,
} from '../../../main/group-chat/output-parser';
import { getOutputParser } from '../../../main/parsers';

describe('group-chat/output-parser', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('extractTextGeneric', () => {
		it('should return raw output if not JSONL format', () => {
			const plainText = 'This is plain text output';
			expect(extractTextGeneric(plainText)).toBe(plainText);
		});

		it('should extract result field from JSON', () => {
			const jsonOutput = '{"result": "This is the result"}';
			expect(extractTextGeneric(jsonOutput)).toBe('This is the result');
		});

		it('should extract text field from JSON', () => {
			const jsonOutput = '{"text": "Some text content"}';
			expect(extractTextGeneric(jsonOutput)).toBe('Some text content');
		});

		it('should extract part.text field from JSON', () => {
			const jsonOutput = '{"part": {"text": "Nested text content"}}';
			expect(extractTextGeneric(jsonOutput)).toBe('Nested text content');
		});

		it('should extract message.content field from JSON', () => {
			const jsonOutput = '{"message": {"content": "Message content"}}';
			expect(extractTextGeneric(jsonOutput)).toBe('Message content');
		});

		it('should handle multiple JSONL lines', () => {
			const jsonlOutput = ['{"text": "Line 1"}', '{"text": "Line 2"}', '{"text": "Line 3"}'].join(
				'\n'
			);
			expect(extractTextGeneric(jsonlOutput)).toBe('Line 1\nLine 2\nLine 3');
		});

		it('should prefer result over text parts', () => {
			const jsonlOutput = [
				'{"text": "Streaming part 1"}',
				'{"text": "Streaming part 2"}',
				'{"result": "Final result"}',
			].join('\n');
			// result should be returned immediately when found
			expect(extractTextGeneric(jsonlOutput)).toBe('Final result');
		});

		it('should handle empty lines in JSONL', () => {
			const jsonlOutput = ['{"text": "Line 1"}', '', '{"text": "Line 2"}'].join('\n');
			expect(extractTextGeneric(jsonlOutput)).toBe('Line 1\nLine 2');
		});

		it('should skip lines with session_id when in JSON context', () => {
			// Note: The first non-empty line must start with '{' for JSONL processing
			// If first line doesn't start with '{', raw output is returned as-is
			const jsonlOutput = [
				'{"text": "Actual content"}',
				'session_id: abc123', // This line would be skipped in the catch block
			].join('\n');
			expect(extractTextGeneric(jsonlOutput)).toBe('Actual content');
		});

		it('should return raw output if first line is not JSON', () => {
			const rawOutput = ['session_id: abc123', '{"text": "Actual content"}'].join('\n');
			// When first non-empty line doesn't start with '{', returns raw output
			expect(extractTextGeneric(rawOutput)).toBe(rawOutput);
		});

		it('should handle invalid JSON gracefully', () => {
			const mixedOutput = [
				'{"text": "Valid JSON"}',
				'This is not JSON',
				'{"text": "More valid JSON"}',
			].join('\n');
			// Invalid JSON lines that don't start with '{' are included as content
			// Lines starting with '{' that fail to parse are skipped
			const result = extractTextGeneric(mixedOutput);
			expect(result).toContain('Valid JSON');
			expect(result).toContain('More valid JSON');
		});

		it('should handle non-string message.content', () => {
			const jsonOutput = '{"message": {"content": 123}}';
			// Should not include non-string content
			expect(extractTextGeneric(jsonOutput)).toBe('');
		});
	});

	describe('extractTextFromAgentOutput', () => {
		it('should use generic extraction when no parser found', () => {
			vi.mocked(getOutputParser).mockReturnValue(null);
			const output = '{"result": "Generic result"}';
			expect(extractTextFromAgentOutput(output, 'unknown-agent')).toBe('Generic result');
		});

		it('should return raw output if not JSONL format', () => {
			const mockParser = {
				parseJsonLine: vi.fn(),
			};
			vi.mocked(getOutputParser).mockReturnValue(mockParser as any);

			const plainText = 'Plain text output';
			expect(extractTextFromAgentOutput(plainText, 'claude-code')).toBe(plainText);
			expect(mockParser.parseJsonLine).not.toHaveBeenCalled();
		});

		it('should use parser to extract result events', () => {
			const mockParser = {
				parseJsonLine: vi.fn((line: string) => {
					const parsed = JSON.parse(line);
					if (parsed.type === 'result') {
						return { type: 'result', text: parsed.result };
					}
					return null;
				}),
			};
			vi.mocked(getOutputParser).mockReturnValue(mockParser as any);

			const jsonlOutput = '{"type": "result", "result": "Final answer"}';
			expect(extractTextFromAgentOutput(jsonlOutput, 'claude-code')).toBe('Final answer');
		});

		it('should concatenate text events when no result', () => {
			const mockParser = {
				parseJsonLine: vi.fn((line: string) => {
					try {
						const parsed = JSON.parse(line);
						if (parsed.type === 'text') {
							return { type: 'text', text: parsed.text };
						}
					} catch {
						return null;
					}
					return null;
				}),
			};
			vi.mocked(getOutputParser).mockReturnValue(mockParser as any);

			const jsonlOutput = [
				'{"type": "text", "text": "Part 1"}',
				'{"type": "text", "text": "Part 2"}',
			].join('\n');
			expect(extractTextFromAgentOutput(jsonlOutput, 'claude-code')).toBe('Part 1\nPart 2');
		});

		it('should prefer result over text events', () => {
			const mockParser = {
				parseJsonLine: vi.fn((line: string) => {
					try {
						const parsed = JSON.parse(line);
						if (parsed.type === 'result') {
							return { type: 'result', text: parsed.result };
						}
						if (parsed.type === 'text') {
							return { type: 'text', text: parsed.text };
						}
					} catch {
						return null;
					}
					return null;
				}),
			};
			vi.mocked(getOutputParser).mockReturnValue(mockParser as any);

			const jsonlOutput = [
				'{"type": "text", "text": "Streaming..."}',
				'{"type": "result", "result": "Complete result"}',
			].join('\n');
			expect(extractTextFromAgentOutput(jsonlOutput, 'claude-code')).toBe('Complete result');
		});

		it('should skip lines that parser returns null for', () => {
			const mockParser = {
				parseJsonLine: vi.fn((line: string) => {
					try {
						const parsed = JSON.parse(line);
						if (parsed.type === 'text') {
							return { type: 'text', text: parsed.text };
						}
					} catch {
						return null;
					}
					return null; // Skip other event types
				}),
			};
			vi.mocked(getOutputParser).mockReturnValue(mockParser as any);

			const jsonlOutput = [
				'{"type": "system", "data": "ignored"}',
				'{"type": "text", "text": "Visible content"}',
				'{"type": "tool", "name": "ignored"}',
			].join('\n');
			expect(extractTextFromAgentOutput(jsonlOutput, 'claude-code')).toBe('Visible content');
		});
	});

	describe('extractTextFromStreamJson', () => {
		it('should use agent-specific extraction when agentType provided', () => {
			const mockParser = {
				parseJsonLine: vi.fn((line: string) => {
					const parsed = JSON.parse(line);
					return { type: 'result', text: parsed.result };
				}),
			};
			vi.mocked(getOutputParser).mockReturnValue(mockParser as any);

			const output = '{"result": "Agent result"}';
			expect(extractTextFromStreamJson(output, 'claude-code')).toBe('Agent result');
			expect(getOutputParser).toHaveBeenCalledWith('claude-code');
		});

		it('should use generic extraction when no agentType', () => {
			const output = '{"result": "Generic result"}';
			expect(extractTextFromStreamJson(output)).toBe('Generic result');
			expect(getOutputParser).not.toHaveBeenCalled();
		});

		it('should use generic extraction when agentType is undefined', () => {
			const output = '{"text": "Some text"}';
			expect(extractTextFromStreamJson(output, undefined)).toBe('Some text');
			expect(getOutputParser).not.toHaveBeenCalled();
		});
	});
});
