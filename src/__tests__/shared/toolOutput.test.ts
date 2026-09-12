import { describe, expect, it } from 'vitest';
import {
	MAX_PERSISTED_TOOL_OUTPUT_CHARS,
	compactSessionToolOutputs,
	compactToolOutput,
} from '../../shared/toolOutput';

describe('tool output compaction', () => {
	it('bounds oversized strings and objects', () => {
		const oversized = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS + 100);

		for (const value of [oversized, { oversized }]) {
			const result = compactToolOutput(value);
			expect(result.truncated).toBe(true);
			expect(result.output).toContain('[tool output truncated');
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
});
