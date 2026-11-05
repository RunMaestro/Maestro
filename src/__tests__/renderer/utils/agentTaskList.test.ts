import { describe, it, expect } from 'vitest';
import {
	extractAgentTaskList,
	findLatestAgentTaskList,
	summarizeAgentTaskList,
} from '../../../renderer/utils/agentTaskList';
import type { LogEntry } from '../../../renderer/types';

describe('extractAgentTaskList', () => {
	it('extracts a Claude Code / OpenCode TodoWrite todos array', () => {
		const list = extractAgentTaskList({
			todos: [
				{ content: 'Fix lint issues', status: 'completed', activeForm: 'Fixing lint issues' },
				{ content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
				{ content: 'Build project', status: 'pending', activeForm: 'Building project' },
			],
		});

		expect(list).not.toBeNull();
		expect(list?.tasks).toHaveLength(3);
		expect(list?.completed).toBe(1);
		expect(list?.inProgress?.content).toBe('Run tests');
		expect(list?.tasks[1].activeForm).toBe('Running tests');
	});

	it('extracts a Codex update_plan plan array', () => {
		const list = extractAgentTaskList({
			plan: [
				{ step: 'Read the failing spec', status: 'completed' },
				{ step: 'Patch the parser', status: 'in_progress' },
			],
		});

		expect(list?.tasks.map((t) => t.content)).toEqual([
			'Read the failing spec',
			'Patch the parser',
		]);
		expect(list?.completed).toBe(1);
		expect(list?.inProgress?.content).toBe('Patch the parser');
	});

	it('extracts a generic tasks array with title labels', () => {
		const list = extractAgentTaskList({
			tasks: [
				{ title: 'Draft the RFC', status: 'done' },
				{ title: 'Circulate for review', status: 'pending' },
			],
		});

		expect(list?.tasks[0].status).toBe('completed');
		expect(list?.tasks[1].status).toBe('pending');
	});

	it('normalizes status spellings and unknown values', () => {
		const list = extractAgentTaskList({
			todos: [
				{ content: 'a', status: 'in-progress' },
				{ content: 'b', status: 'COMPLETE' },
				{ content: 'c', status: 'blocked' },
				{ content: 'd' },
			],
		});

		expect(list?.tasks.map((t) => t.status)).toEqual([
			'in_progress',
			'completed',
			'pending',
			'pending',
		]);
	});

	it('returns the first in-progress task when several are marked active', () => {
		const list = extractAgentTaskList({
			todos: [
				{ content: 'first', status: 'in_progress' },
				{ content: 'second', status: 'in_progress' },
			],
		});

		expect(list?.inProgress?.content).toBe('first');
	});

	it('returns null for payloads that are not checklists', () => {
		expect(extractAgentTaskList({ command: 'npm test' })).toBeNull();
		expect(extractAgentTaskList({ todos: [] })).toBeNull();
		expect(extractAgentTaskList({ todos: 'not an array' })).toBeNull();
		expect(extractAgentTaskList(null)).toBeNull();
		expect(extractAgentTaskList(undefined)).toBeNull();
		expect(extractAgentTaskList('raw string input')).toBeNull();
		expect(extractAgentTaskList([{ content: 'top level array' }])).toBeNull();
	});

	it('rejects arrays whose entries have no usable label', () => {
		// A partially-labeled list would misreport progress, so fall back to
		// generic tool rendering instead.
		expect(extractAgentTaskList({ todos: [{ content: 'ok' }, { status: 'pending' }] })).toBeNull();
		expect(extractAgentTaskList({ todos: [1, 2, 3] })).toBeNull();
	});
});

describe('summarizeAgentTaskList', () => {
	it('prefers the active task activeForm with a progress count', () => {
		const list = extractAgentTaskList({
			todos: [
				{ content: 'Fix lint issues', status: 'completed', activeForm: 'Fixing lint issues' },
				{ content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
				{ content: 'Build project', status: 'pending', activeForm: 'Building project' },
			],
		})!;

		expect(summarizeAgentTaskList(list)).toBe('Running tests (1/3)');
	});

	it('falls back to the first task when nothing is in progress', () => {
		const list = extractAgentTaskList({
			todos: [
				{ content: 'Fix lint issues', status: 'completed' },
				{ content: 'Run tests', status: 'completed' },
			],
		})!;

		expect(summarizeAgentTaskList(list)).toBe('Fix lint issues (2/2)');
	});

	it('uses the in-progress content when no activeForm is supplied', () => {
		const list = extractAgentTaskList({
			plan: [{ step: 'Patch the parser', status: 'in_progress' }],
		})!;

		expect(summarizeAgentTaskList(list)).toBe('Patch the parser (0/1)');
	});
});

describe('findLatestAgentTaskList', () => {
	const toolEntry = (id: string, input: unknown) =>
		({
			id,
			timestamp: 0,
			source: 'tool',
			text: 'TodoWrite',
			metadata: { toolState: { status: 'completed', input } },
		}) as unknown as LogEntry;

	const todos = (...statuses: string[]) => ({
		todos: statuses.map((status, i) => ({ content: `task ${i}`, status })),
	});

	it('returns the newest checklist in the log', () => {
		const latest = findLatestAgentTaskList([
			toolEntry('a', todos('in_progress', 'pending')),
			toolEntry('b', { file_path: '/tmp/x.ts' }),
			toolEntry('c', todos('completed', 'in_progress')),
		]);

		expect(latest?.entryId).toBe('c');
		expect(latest?.list.completed).toBe(1);
	});

	it('returns null when no tool call carried a checklist', () => {
		expect(findLatestAgentTaskList([toolEntry('a', { command: 'ls' })])).toBeNull();
		expect(findLatestAgentTaskList([])).toBeNull();
		expect(findLatestAgentTaskList(undefined)).toBeNull();
	});

	it('ignores non-tool entries', () => {
		const chat = { id: 'msg', timestamp: 0, source: 'ai', text: 'todos: 1. do it' } as LogEntry;
		expect(findLatestAgentTaskList([chat])).toBeNull();
	});

	it("skips a subagent's private checklist", () => {
		const nested = toolEntry('b', todos('pending', 'pending'));
		nested.metadata = { ...nested.metadata, parentToolUseId: 'task_1' };

		const latest = findLatestAgentTaskList([
			toolEntry('a', todos('in_progress', 'pending')),
			nested,
		]);

		expect(latest?.entryId).toBe('a');
	});

	it('returns null when the only checklist came from a subagent', () => {
		const nested = toolEntry('a', todos('pending'));
		nested.metadata = { ...nested.metadata, parentToolUseId: 'task_1' };

		expect(findLatestAgentTaskList([nested])).toBeNull();
	});

	// Grok ACP plans arrive as update_plan snapshots (input.plan plus planUpdate).
	describe('Grok ACP plan snapshots', () => {
		const planEntry = (id: string, plan: unknown[], providerSessionId = 'native-a') =>
			({
				id,
				timestamp: 0,
				source: 'tool',
				text: 'update_plan',
				metadata: {
					toolState: {
						status: 'completed',
						input: { plan },
						planUpdate: { reporting: 'snapshot', revision: 1, providerSessionId, turnId: 't' },
					},
				},
			}) as unknown as LogEntry;
		const step = (name: string, status: string) => ({ step: name, status });

		it('clears the plan when the newest snapshot is empty', () => {
			expect(
				findLatestAgentTaskList([planEntry('a', [step('old', 'pending')]), planEntry('b', [])])
			).toBeNull();
		});

		it('still falls back past an empty payload that is not a snapshot', () => {
			expect(
				findLatestAgentTaskList([
					planEntry('a', [step('old', 'pending')]),
					toolEntry('b', { plan: [] }),
				])?.entryId
			).toBe('a');
		});

		it('shows a newer non-empty snapshot after a clear', () => {
			const latest = findLatestAgentTaskList([
				planEntry('a', []),
				planEntry('b', [step('new', 'in_progress')]),
			]);
			expect(latest?.entryId).toBe('b');
			expect(latest?.list.inProgress?.content).toBe('new');
		});

		it('never counts cancelled or unsupported items as completed work', () => {
			const latest = findLatestAgentTaskList([
				planEntry('a', [step('x', 'cancelled'), step('y', 'unsupported'), step('z', 'completed')]),
			]);
			expect(latest?.list.completed).toBe(1);
			expect(latest?.list.tasks.map((t) => t.status)).toEqual(['pending', 'pending', 'completed']);
		});

		it("keeps each tab's plan to its own log", () => {
			const tabA = [planEntry('a1', [step('plan a', 'in_progress')], 'native-a')];
			const tabB = [planEntry('b1', [], 'native-b')];
			expect(findLatestAgentTaskList(tabA)?.list.inProgress?.content).toBe('plan a');
			expect(findLatestAgentTaskList(tabB)).toBeNull();
		});

		it('reads the same plan after the log is reloaded from storage', () => {
			const logs = [
				planEntry('a', [step('old', 'pending')]),
				planEntry('b', [step('one', 'completed'), step('two', 'in_progress')]),
			];
			const reloaded = JSON.parse(JSON.stringify(logs)) as LogEntry[];
			expect(findLatestAgentTaskList(reloaded)).toEqual(findLatestAgentTaskList(logs));
			expect(findLatestAgentTaskList(reloaded)?.entryId).toBe('b');
		});
	});
});
