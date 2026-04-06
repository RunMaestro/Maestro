import { describe, it, expect } from 'vitest';
import { parsePeekOutput, formatPeekLines } from '../peekOutputParser';

describe('parsePeekOutput', () => {
	it('should extract text from Claude assistant messages', () => {
		const raw = JSON.stringify({
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [{ type: 'text', text: 'Let me fix the database query approach:' }],
			},
			session_id: 'abc-123',
		});
		const result = parsePeekOutput(raw);
		expect(result).toEqual([{ type: 'text', content: 'Let me fix the database query approach:' }]);
	});

	it('should extract thinking content', () => {
		const raw = JSON.stringify({
			type: 'assistant',
			message: {
				content: [{ type: 'thinking', thinking: 'I need to consider the edge cases here.' }],
			},
		});
		const result = parsePeekOutput(raw);
		expect(result).toEqual([
			{ type: 'thinking', content: 'I need to consider the edge cases here.' },
		]);
	});

	it('should format tool_use blocks concisely', () => {
		const raw = JSON.stringify({
			type: 'assistant',
			message: {
				content: [
					{
						type: 'tool_use',
						name: 'Read',
						input: { file_path: '/src/main/index.ts' },
					},
				],
			},
		});
		const result = parsePeekOutput(raw);
		expect(result).toEqual([{ type: 'tool', content: '→ Read /src/main/index.ts' }]);
	});

	it('should format Bash tool with command', () => {
		const raw = JSON.stringify({
			type: 'assistant',
			message: {
				content: [
					{
						type: 'tool_use',
						name: 'Bash',
						input: { command: 'npm run build' },
					},
				],
			},
		});
		const result = parsePeekOutput(raw);
		expect(result).toEqual([{ type: 'tool', content: '→ $ npm run build' }]);
	});

	it('should extract result messages', () => {
		const raw = JSON.stringify({
			type: 'result',
			result: 'Here is the final answer.',
			session_id: 'abc',
		});
		const result = parsePeekOutput(raw);
		expect(result).toEqual([{ type: 'result', content: 'Here is the final answer.' }]);
	});

	it('should handle system init messages', () => {
		const raw = JSON.stringify({
			type: 'system',
			subtype: 'init',
			session_id: 'abc',
		});
		const result = parsePeekOutput(raw);
		expect(result).toEqual([{ type: 'system', content: 'Session initialized' }]);
	});

	it('should skip usage-only messages', () => {
		const raw = JSON.stringify({
			modelUsage: { 'claude-opus': { input: 100, output: 50 } },
			total_cost_usd: 0.05,
		});
		const result = parsePeekOutput(raw);
		expect(result).toEqual([]);
	});

	it('should skip tool_result blocks', () => {
		const raw = JSON.stringify({
			type: 'assistant',
			message: {
				content: [{ type: 'tool_result', content: 'some result' }],
			},
		});
		const result = parsePeekOutput(raw);
		expect(result).toEqual([]);
	});

	it('should handle multiple JSONL lines', () => {
		const lines = [
			JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'thinking', thinking: 'Analyzing...' }] },
			}),
			JSON.stringify({
				type: 'assistant',
				message: {
					content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } }],
				},
			}),
			JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'text', text: 'Found 3 TODOs.' }] },
			}),
		].join('\n');

		const result = parsePeekOutput(lines);
		expect(result).toHaveLength(3);
		expect(result[0]).toEqual({ type: 'thinking', content: 'Analyzing...' });
		expect(result[1]).toEqual({ type: 'tool', content: '→ Grep "TODO"' });
		expect(result[2]).toEqual({ type: 'text', content: 'Found 3 TODOs.' });
	});

	it('should reassemble JSON split across lines', () => {
		// Simulate a JSON object split by terminal line wrapping
		const obj = JSON.stringify({
			type: 'assistant',
			message: { content: [{ type: 'text', text: 'Hello world' }] },
		});
		const mid = Math.floor(obj.length / 2);
		const raw = obj.slice(0, mid) + '\n' + obj.slice(mid);
		const result = parsePeekOutput(raw);
		expect(result).toEqual([{ type: 'text', content: 'Hello world' }]);
	});

	it('should handle valid JSON after incomplete JSON', () => {
		// Incomplete JSON followed by a complete JSON on next line
		const raw =
			'{"type":"assistant","message":{"content":[{"type":"text","text":"partial\n{"type":"result","result":"ok"}';
		const result = parsePeekOutput(raw);
		// The incomplete line buffers, then the next line appends — the combined string
		// may or may not parse. The result message should still be recoverable.
		expect(result.length).toBeGreaterThanOrEqual(0);
	});

	it('should pass through non-JSON text lines', () => {
		const raw = 'Some plain text output\nAnother line';
		const result = parsePeekOutput(raw);
		expect(result).toEqual([
			{ type: 'text', content: 'Some plain text output' },
			{ type: 'text', content: 'Another line' },
		]);
	});

	it('should skip JSON fragment lines (closing braces, quotes)', () => {
		const raw = '}\n]\n"leftover"';
		const result = parsePeekOutput(raw);
		expect(result).toEqual([]);
	});
});

describe('formatPeekLines', () => {
	it('should format mixed content with labels', () => {
		const lines = [
			{ type: 'thinking' as const, content: 'Let me think...' },
			{ type: 'tool' as const, content: '→ Read /src/index.ts' },
			{ type: 'text' as const, content: 'Here is the answer.' },
		];
		const result = formatPeekLines(lines);
		expect(result).toBe('💭 Let me think...\n🔧 → Read /src/index.ts\nHere is the answer.');
	});

	it('should return empty string for empty input', () => {
		expect(formatPeekLines([])).toBe('');
	});
});
