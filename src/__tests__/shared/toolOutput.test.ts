import { describe, expect, it } from 'vitest';
import {
	MAX_PERSISTED_TOOL_INPUT_STRING_CHARS,
	MAX_PERSISTED_TOOL_OUTPUT_CHARS,
	compactSessionToolOutputs,
	compactToolInput,
	compactToolOutput,
} from '../../shared/toolOutput';
import { MAX_PERSISTED_SESSION_LOGS } from '../../shared/deferredSessionContent';

describe('tool output compaction', () => {
	it('bounds oversized strings and objects', () => {
		const oversized = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 100);

		for (const value of [oversized, { oversized }]) {
			const result = compactToolOutput(value);
			expect(result.truncated).toBe(true);
			expect(result.output).toContain('[tool output truncated');
			expect(result.output).toHaveLength(MAX_PERSISTED_TOOL_OUTPUT_CHARS);
			expect(compactToolOutput(result.output)).toEqual({
				output: result.output,
				truncated: false,
			});
		}
	});

	it('replaces unserializable output with a persistence-safe marker', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(compactToolOutput(circular)).toEqual({
			output: '[tool output omitted: serialization failed]',
			truncated: true,
		});
	});

	it('compacts nested session tool results without mutating the session', () => {
		const output = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 100);
		const session = {
			aiTabs: [
				{
					id: 'tab-1',
					logs: [{ metadata: { toolState: { output } } }],
				},
			],
		};

		const result = compactSessionToolOutputs(session);
		expect(result.compacted).toBe(1);
		expect(result.session).not.toBe(session);
		expect(result.session.aiTabs[0].logs[0].metadata.toolState.output).toContain(
			'[tool output truncated'
		);
		expect(session.aiTabs[0].logs[0].metadata.toolState.output).toBe(output);
	});

	it('caps long strings in a tool input but keeps its shape and short fields', () => {
		const content = 'y'.repeat(MAX_PERSISTED_TOOL_INPUT_STRING_CHARS + 500);
		const input = {
			file_path: '/repo/big.ts',
			content,
			edits: [{ old_string: content, new_string: 'short' }],
			replace_all: false,
		};

		const result = compactToolInput(input);
		expect(result.truncated).toBe(true);
		const capped = result.input as typeof input;
		expect(capped.file_path).toBe('/repo/big.ts');
		expect(capped.replace_all).toBe(false);
		expect(capped.edits[0].new_string).toBe('short');
		expect(capped.content).toHaveLength(MAX_PERSISTED_TOOL_INPUT_STRING_CHARS);
		expect(capped.content).toContain('[tool input truncated, 4500 chars total]');
		expect(capped.edits[0].old_string).toHaveLength(MAX_PERSISTED_TOOL_INPUT_STRING_CHARS);
		expect(compactToolInput(capped)).toEqual({ input: capped, truncated: false });
		expect(input.content).toBe(content);

		const small = { todos: [{ content: 'Write tests', status: 'pending' }] };
		expect(compactToolInput(small)).toEqual({ input: small, truncated: false });
		expect(compactToolInput('patch')).toEqual({ input: 'patch', truncated: false });
	});

	it('compacts session tool inputs and trims a transcript past its stored tail', () => {
		const content = 'z'.repeat(MAX_PERSISTED_TOOL_INPUT_STRING_CHARS + 1);
		const logs = Array.from({ length: MAX_PERSISTED_SESSION_LOGS + 8 }, (_, i) => ({
			id: `l${i}`,
		}));
		logs.push({
			id: 'write',
			metadata: { toolState: { input: { file_path: '/a', content }, status: 'completed' } },
		} as never);
		const untouched = { id: 'small', logs: [{ id: 'only' }] };
		const session = { aiTabs: [{ id: 'big', logs }, untouched] };

		const result = compactSessionToolOutputs(session);
		const tab = result.session.aiTabs[0] as { logs: any[] };
		expect(tab.logs).toHaveLength(MAX_PERSISTED_SESSION_LOGS);
		expect(tab.logs.at(-1).id).toBe('write');
		expect(tab.logs[0].id).toBe(`l${logs.length - MAX_PERSISTED_SESSION_LOGS}`);
		expect(tab.logs.at(-1).metadata.toolState.input.file_path).toBe('/a');
		expect(tab.logs.at(-1).metadata.toolState.input.content).toContain('[tool input truncated');
		expect(tab.logs.at(-1).metadata.toolState.status).toBe('completed');
		expect(result.session.aiTabs[1]).toBe(untouched);
		expect(result.compacted).toBe(2);
		expect(session.aiTabs[0].logs).toHaveLength(MAX_PERSISTED_SESSION_LOGS + 9);

		// Already compact: same object back, so the load path skips its rewrite.
		expect(compactSessionToolOutputs(result.session)).toEqual({
			session: result.session,
			compacted: 0,
		});
	});

	it('compacts tool results in closed AI tabs kept with their logs', () => {
		const output = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 100);
		const terminal = { type: 'terminal', tab: { id: 't' }, unifiedIndex: 0, closedAt: 1 };
		const session = {
			aiTabs: [],
			unifiedClosedTabHistory: [
				{
					type: 'ai',
					tab: { id: 'closed', logs: [{ metadata: { toolState: { output } } }] },
					unifiedIndex: 0,
					closedAt: 1,
				},
				terminal,
			],
		};

		const result = compactSessionToolOutputs(session);
		expect(result.compacted).toBe(1);
		const closed = result.session.unifiedClosedTabHistory;
		expect(closed[0].tab.logs[0].metadata.toolState.output).toContain('[tool output truncated');
		expect(closed[1]).toBe(terminal);
		expect(session.unifiedClosedTabHistory[0].tab.logs[0].metadata.toolState.output).toBe(output);
	});
});
