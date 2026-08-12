import { describe, it, expect } from 'vitest';
import {
	extractAgentTaskList,
	summarizeAgentTaskList,
} from '../../../renderer/utils/agentTaskList';

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
