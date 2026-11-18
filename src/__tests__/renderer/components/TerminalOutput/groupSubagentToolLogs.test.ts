import { describe, it, expect } from 'vitest';
import {
	groupSubagentToolLogs,
	parentLogIdFor,
} from '../../../../renderer/components/TerminalOutput/utils/groupSubagentToolLogs';
import type { LogEntry } from '../../../../renderer/types';
import { subagentToolCallId } from '../../../../shared/maestro-lib/turns/turn-events';

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

// Grok children reported by session lineage: the tool-execution events main
// emits (subagentToolCallOf / subagentDisplayParentOf), recorded by the listener's merge
// rule. Synthetic, never native evidence.
describe('groupSubagentToolLogs with Grok Subagent entries (synthetic)', () => {
	type ToolEvent = {
		toolName: string;
		toolCallId: string;
		parentToolUseId?: string;
		state: Record<string, unknown>;
	};
	const childToolId = (child: string, id: string) =>
		`grok-child-tool:${JSON.stringify([child, id])}`;
	const entry = (child: string, status: string, extra: Record<string, unknown> = {}) => ({
		toolName: 'Subagent',
		toolCallId: subagentToolCallId(child),
		state: {
			status,
			input: { childSessionId: child },
			outcome: status === 'failed' ? 'unknown' : status,
			lifecycle: status === 'running' ? 'spawned' : 'finished',
			unavailable: ['parentToolCallId', 'cost', 'parentTurnId'],
			...extra,
		},
	});
	const childTool = (child: string, id: string, status: string): ToolEvent => ({
		toolName: 'Bash',
		toolCallId: childToolId(child, id),
		parentToolUseId: subagentToolCallId(child),
		state: { status, providerToolCallId: id },
	});
	/** The merge rule of useAgentToolExecutionListener: one log per call id, state merged. */
	function record(events: ToolEvent[]): LogEntry[] {
		const logs: LogEntry[] = [];
		for (const [index, event] of events.entries()) {
			const id = `tool-${event.toolCallId}`;
			const at = logs.findIndex((l) => l.id === id);
			if (at < 0) {
				logs.push({
					id,
					timestamp: index,
					source: 'tool',
					text: event.toolName,
					metadata: {
						toolState: event.state as never,
						...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
					},
				});
				continue;
			}
			const existing = logs[at];
			const parent = event.parentToolUseId ?? existing.metadata?.parentToolUseId;
			logs[at] = {
				...existing,
				metadata: {
					...existing.metadata,
					toolState: { ...existing.metadata?.toolState, ...event.state } as never,
					...(parent ? { parentToolUseId: parent } : {}),
				},
			};
		}
		return logs;
	}
	const ids = (logs: LogEntry[] | undefined) => logs?.map((l) => l.id);

	const overlapping: ToolEvent[] = [
		entry('child-a', 'running'),
		entry('child-b', 'running'),
		{ toolName: 'Read', toolCallId: 'call_1', state: { status: 'running' } },
		childTool('child-a', 'call_1', 'running'),
		childTool('child-b', 'call_1', 'running'),
		childTool('child-b', 'call_1', 'completed'),
		childTool('child-a', 'call_2', 'running'),
		childTool('child-a', 'call_1', 'failed'),
		entry('child-b', 'completed', { output: 'B result' }),
		entry('child-a', 'failed', {
			lifecycle: 'closed-with-parent',
			output: 'Subagent closed with the parent turn; its outcome was not reported.',
		}),
	];

	it('nests overlapping children under their own entries, never a sibling', () => {
		const { logs, childrenByParentId } = groupSubagentToolLogs(record(overlapping));
		const a = `tool-${subagentToolCallId('child-a')}`;
		const b = `tool-${subagentToolCallId('child-b')}`;
		expect(ids(logs)).toEqual([a, b, 'tool-call_1']);
		expect(ids(childrenByParentId.get(a))).toEqual([
			`tool-${childToolId('child-a', 'call_1')}`,
			`tool-${childToolId('child-a', 'call_2')}`,
		]);
		expect(ids(childrenByParentId.get(b))).toEqual([`tool-${childToolId('child-b', 'call_1')}`]);
		expect(childrenByParentId.get(a)?.[0].metadata?.toolState?.status).toBe('failed');
		expect(logs[0].metadata?.toolState).toMatchObject({
			status: 'failed',
			lifecycle: 'closed-with-parent',
		});
	});

	it('rebuilds the same grouping, ids and states from a reloaded transcript', () => {
		const live = record(overlapping);
		const reloaded: LogEntry[] = JSON.parse(JSON.stringify(live));
		const before = groupSubagentToolLogs(live);
		const after = groupSubagentToolLogs(reloaded);
		expect(ids(after.logs)).toEqual(ids(before.logs));
		expect([...after.childrenByParentId.keys()]).toEqual([...before.childrenByParentId.keys()]);
		for (const [parent, children] of before.childrenByParentId)
			expect(after.childrenByParentId.get(parent)).toEqual(children);
		expect(after.logs).toEqual(before.logs);
	});

	it('keeps a child whose entry is missing flat instead of adopting it elsewhere', () => {
		// child-b's entry was trimmed or never admitted; child-a's entry is present.
		const { logs, childrenByParentId } = groupSubagentToolLogs(
			record([entry('child-a', 'running'), childTool('child-b', 'call_1', 'running')])
		);
		expect(ids(logs)).toEqual([
			`tool-${subagentToolCallId('child-a')}`,
			`tool-${childToolId('child-b', 'call_1')}`,
		]);
		expect(childrenByParentId.size).toBe(0);
	});

	it('never nests a top-level child entry under a Task it was not reported to come from', () => {
		const { logs, childrenByParentId } = groupSubagentToolLogs(
			record([
				{ toolName: 'Task', toolCallId: 'task_1', state: { status: 'running' } },
				entry('child-a', 'running'),
				childTool('child-a', 'call_1', 'running'),
			])
		);
		expect(ids(logs)).toEqual(['tool-task_1', `tool-${subagentToolCallId('child-a')}`]);
		expect(childrenByParentId.has('tool-task_1')).toBe(false);
	});

	it('nests a grandchild entry under its parent child and keeps its own tools visible', () => {
		const grandchild = {
			...entry('grandchild', 'running'),
			parentToolUseId: subagentToolCallId('child-a'),
		};
		const { logs, childrenByParentId } = groupSubagentToolLogs(
			record([
				entry('child-a', 'running'),
				grandchild,
				childTool('grandchild', 'call_1', 'running'),
			])
		);
		const a = `tool-${subagentToolCallId('child-a')}`;
		expect(ids(childrenByParentId.get(a))).toEqual([`tool-${subagentToolCallId('grandchild')}`]);
		expect(ids(logs)).toEqual([a, `tool-${childToolId('grandchild', 'call_1')}`]);
	});

	it('adds nothing to an entry the provider did not report', () => {
		const live = record(overlapping);
		const snapshot = JSON.parse(JSON.stringify(live));
		const { logs, childrenByParentId } = groupSubagentToolLogs(live);
		expect(live).toEqual(snapshot);
		const all = [...logs, ...[...childrenByParentId.values()].flat()];
		for (const log of all.filter((l) => l.text === 'Subagent')) {
			expect(log.metadata?.parentToolUseId).toBeUndefined();
			expect(log.metadata?.toolState).not.toHaveProperty('cost');
			expect((log.metadata?.toolState as Record<string, unknown>).unavailable).toEqual([
				'parentToolCallId',
				'cost',
				'parentTurnId',
			]);
		}
	});
});
