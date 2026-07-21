import { describe, it, expect } from 'vitest';
import {
	groupSubagentToolLogs,
	parentLogIdFor,
} from '../../../../renderer/components/TerminalOutput/utils/groupSubagentToolLogs';
import type { LogEntry } from '../../../../renderer/types';

const toolLog = (
	toolCallId: string,
	text: string,
	overrides: { parentToolUseId?: string; status?: 'running' | 'completed' | 'failed' } = {}
): LogEntry => ({
	id: `tool-${toolCallId}`,
	timestamp: 1,
	source: 'tool',
	text,
	metadata: {
		toolState: { status: overrides.status ?? 'running' },
		...(overrides.parentToolUseId ? { parentToolUseId: overrides.parentToolUseId } : {}),
	},
});

const textLog = (id: string, text: string): LogEntry => ({
	id,
	timestamp: 1,
	source: 'ai',
	text,
});

describe('groupSubagentToolLogs', () => {
	it('nests subagent tool logs under the spawning Task entry', () => {
		const logs = [
			toolLog('task_1', 'Task'),
			toolLog('child_a', 'Grep', { parentToolUseId: 'task_1' }),
			toolLog('child_b', 'Read', { parentToolUseId: 'task_1' }),
		];

		const { logs: flat, childrenByParentId } = groupSubagentToolLogs(logs);

		expect(flat.map((l) => l.id)).toEqual(['tool-task_1']);
		expect(childrenByParentId.get('tool-task_1')?.map((l) => l.text)).toEqual(['Grep', 'Read']);
	});

	it('preserves child order under the parent', () => {
		const logs = [
			toolLog('task_1', 'Task'),
			toolLog('c1', 'One', { parentToolUseId: 'task_1' }),
			toolLog('c2', 'Two', { parentToolUseId: 'task_1' }),
			toolLog('c3', 'Three', { parentToolUseId: 'task_1' }),
		];

		const { childrenByParentId } = groupSubagentToolLogs(logs);
		expect(childrenByParentId.get('tool-task_1')?.map((l) => l.text)).toEqual([
			'One',
			'Two',
			'Three',
		]);
	});

	it('keeps orphans flat when the parent is not in the log', () => {
		const logs = [toolLog('child_a', 'Grep', { parentToolUseId: 'trimmed_away' })];

		const { logs: flat, childrenByParentId } = groupSubagentToolLogs(logs);

		expect(flat.map((l) => l.id)).toEqual(['tool-child_a']);
		expect(childrenByParentId.size).toBe(0);
	});

	it('does not adopt when the parent id resolves to a non-tool entry', () => {
		const logs = [
			textLog('tool-task_1', 'not a tool entry'),
			toolLog('child_a', 'Grep', { parentToolUseId: 'task_1' }),
		];

		const { logs: flat, childrenByParentId } = groupSubagentToolLogs(logs);

		expect(flat).toHaveLength(2);
		expect(childrenByParentId.size).toBe(0);
	});

	it('returns the input array untouched when no entry has a parent id', () => {
		const logs = [textLog('a', 'hello'), toolLog('t1', 'Read'), textLog('b', 'bye')];

		const { logs: flat, childrenByParentId } = groupSubagentToolLogs(logs);

		expect(flat).toBe(logs);
		expect(childrenByParentId.size).toBe(0);
	});

	it('leaves interleaved non-tool entries in place', () => {
		const logs = [
			textLog('a', 'thinking'),
			toolLog('task_1', 'Task'),
			toolLog('child_a', 'Grep', { parentToolUseId: 'task_1' }),
			textLog('b', 'done'),
		];

		const { logs: flat } = groupSubagentToolLogs(logs);
		expect(flat.map((l) => l.id)).toEqual(['a', 'tool-task_1', 'b']);
	});

	it('never drops an entry that points at itself', () => {
		const logs = [toolLog('self', 'Weird', { parentToolUseId: 'self' })];

		const { logs: flat, childrenByParentId } = groupSubagentToolLogs(logs);

		expect(flat).toHaveLength(1);
		expect(childrenByParentId.size).toBe(0);
	});

	it('groups children under multiple distinct parents', () => {
		const logs = [
			toolLog('task_1', 'Task'),
			toolLog('task_2', 'Task'),
			toolLog('c1', 'Grep', { parentToolUseId: 'task_1' }),
			toolLog('c2', 'Read', { parentToolUseId: 'task_2' }),
		];

		const { logs: flat, childrenByParentId } = groupSubagentToolLogs(logs);

		expect(flat).toHaveLength(2);
		expect(childrenByParentId.get('tool-task_1')?.map((l) => l.text)).toEqual(['Grep']);
		expect(childrenByParentId.get('tool-task_2')?.map((l) => l.text)).toEqual(['Read']);
	});

	it('adopts a child that arrives before its parent in the array', () => {
		// Ordering is not guaranteed if a subagent event is processed first.
		const logs = [toolLog('c1', 'Grep', { parentToolUseId: 'task_1' }), toolLog('task_1', 'Task')];

		const { logs: flat, childrenByParentId } = groupSubagentToolLogs(logs);

		expect(flat.map((l) => l.id)).toEqual(['tool-task_1']);
		expect(childrenByParentId.get('tool-task_1')).toHaveLength(1);
	});

	it('derives the parent log id from the tool call id', () => {
		expect(parentLogIdFor('toolu_123')).toBe('tool-toolu_123');
	});

	it('keeps a grandchild flat rather than adopting it under an adopted child', () => {
		// LogItem renders adopted children flat (no recursion), so a grandchild
		// must not be pulled out of the flat list under an already-adopted child -
		// it would then never render. It stays top-level (visible) instead.
		const logs = [
			toolLog('task_1', 'Task'),
			toolLog('child_1', 'Task', { parentToolUseId: 'task_1' }),
			toolLog('grand_1', 'Read', { parentToolUseId: 'child_1' }),
		];

		const { logs: flat, childrenByParentId } = groupSubagentToolLogs(logs);

		// child_1 is adopted under task_1; grand_1 stays in the flat list.
		expect(flat.map((l) => l.id)).toEqual(['tool-task_1', 'tool-grand_1']);
		expect(childrenByParentId.get('tool-task_1')?.map((l) => l.id)).toEqual(['tool-child_1']);
		expect(childrenByParentId.has('tool-child_1')).toBe(false);
	});
});
