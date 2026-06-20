import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Playbook, SessionInfo, UsageStats } from '../../shared/types';
import type { JsonlEvent } from '../../cli/output/jsonl';

const mocks = vi.hoisted(() => ({
	execFileSync: vi.fn(),
	spawnAgent: vi.fn(),
	readDocAndCountTasks: vi.fn(),
	readDocAndGetTasks: vi.fn(),
	uncheckAllTasks: vi.fn(),
	writeDoc: vi.fn(),
	addHistoryEntry: vi.fn(),
	readGroups: vi.fn(),
	registerCliActivity: vi.fn(),
	unregisterCliActivity: vi.fn(),
	logger: {
		autorun: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('child_process', () => ({
	execFileSync: mocks.execFileSync,
	default: { execFileSync: mocks.execFileSync },
}));

vi.mock('../../cli/services/agent-spawner', () => ({
	spawnAgent: mocks.spawnAgent,
	readDocAndCountTasks: mocks.readDocAndCountTasks,
	readDocAndGetTasks: mocks.readDocAndGetTasks,
	uncheckAllTasks: mocks.uncheckAllTasks,
	writeDoc: mocks.writeDoc,
}));

vi.mock('../../cli/services/storage', () => ({
	addHistoryEntry: mocks.addHistoryEntry,
	getConfigDirectory: vi.fn(() => '/tmp/maestro-test-config'),
	readGroups: mocks.readGroups,
	readSettingValue: vi.fn(() => undefined),
}));

vi.mock('../../shared/cli-activity', () => ({
	registerCliActivity: mocks.registerCliActivity,
	unregisterCliActivity: mocks.unregisterCliActivity,
}));

vi.mock('../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

import { runPlaybook } from '../../cli/services/batch-processor';
import {
	readDocAndCountTasks,
	readDocAndGetTasks,
	spawnAgent,
	uncheckAllTasks,
	writeDoc,
} from '../../cli/services/agent-spawner';
import { addHistoryEntry } from '../../cli/services/storage';
import { registerCliActivity, unregisterCliActivity } from '../../shared/cli-activity';

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: 'session-alpha',
		name: 'Alpha Session',
		toolType: 'claude-code',
		cwd: '/repo/alpha',
		projectRoot: '/repo/alpha',
		groupId: 'group-alpha',
		...overrides,
	};
}

function playbook(overrides: Partial<Playbook> = {}): Playbook {
	return {
		id: 'playbook-alpha',
		name: 'Alpha Playbook',
		createdAt: 1,
		updatedAt: 1,
		documents: [{ filename: 'tasks', resetOnCompletion: false }],
		loopEnabled: false,
		prompt:
			'Process {{AGENT_NAME}} on {{GIT_BRANCH}} for {{AGENT_GROUP}} at {{DOCUMENT_PATH}} loop {{LOOP_NUMBER}}',
		...overrides,
	};
}

async function collectEvents(
	generator: AsyncGenerator<JsonlEvent>,
	maxEvents = 80
): Promise<JsonlEvent[]> {
	const events: JsonlEvent[] = [];
	for await (const event of generator) {
		events.push(event);
		if (events.length > maxEvents) {
			throw new Error(`runPlaybook emitted more than ${maxEvents} events`);
		}
	}
	return events;
}

function countSequence(sequence: Array<{ content: string; taskCount: number }>) {
	let index = 0;
	vi.mocked(readDocAndCountTasks).mockImplementation(() => {
		const value = sequence[Math.min(index, sequence.length - 1)];
		index++;
		return value;
	});
}

describe('CLI batch processor integration', () => {
	const usageStats: UsageStats = {
		inputTokens: 100,
		outputTokens: 40,
		cacheReadInputTokens: 3,
		cacheCreationInputTokens: 2,
		totalCostUsd: 0.05,
		contextWindow: 200000,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.execFileSync.mockReturnValue('feature/integration\n');
		mocks.readGroups.mockReturnValue([
			{ id: 'group-alpha', name: 'Alpha Group', emoji: 'A', collapsed: false },
		]);
		vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '', taskCount: 0 });
		vi.mocked(readDocAndGetTasks).mockReturnValue({ content: '', tasks: [] });
		vi.mocked(uncheckAllTasks).mockImplementation((content: string) =>
			content.replace(/\[x\]/gi, '[ ]')
		);
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Done',
			agentSessionId: 'agent-session-alpha',
			usageStats,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('emits start, debug, and no-task error events while unregistering CLI activity', async () => {
		const events = await collectEvents(
			runPlaybook(session(), playbook(), '/playbooks', { debug: true })
		);

		expect(events[0]).toMatchObject({
			type: 'start',
			playbook: { id: 'playbook-alpha', name: 'Alpha Playbook' },
			session: { id: 'session-alpha', name: 'Alpha Session', cwd: '/repo/alpha' },
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'debug',
				category: 'scan',
				message: 'Total unchecked tasks: 0',
			})
		);
		expect(events.at(-1)).toMatchObject({
			type: 'error',
			code: 'NO_TASKS',
			message: 'No unchecked tasks found in any documents',
		});
		expect(registerCliActivity).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 'session-alpha', playbookId: 'playbook-alpha' })
		);
		expect(unregisterCliActivity).toHaveBeenCalledWith('session-alpha');
	});

	it('previews multi-document dry runs without spawning an agent', async () => {
		vi.mocked(readDocAndCountTasks).mockImplementation((_folder, filename) => ({
			content: '',
			taskCount: filename === 'tasks' ? 2 : 0,
		}));
		vi.mocked(readDocAndGetTasks).mockImplementation((_folder, filename) => ({
			content: '',
			tasks: filename === 'tasks' ? ['First task', 'Second task'] : [],
		}));

		const events = await collectEvents(
			runPlaybook(
				session(),
				playbook({
					documents: [
						{ filename: 'empty', resetOnCompletion: false },
						{ filename: 'tasks', resetOnCompletion: false },
					],
				}),
				'/playbooks',
				{ debug: true, dryRun: true }
			)
		);

		expect(spawnAgent).not.toHaveBeenCalled();
		expect(events.filter((event) => event.type === 'task_preview')).toEqual([
			expect.objectContaining({ document: 'tasks', taskIndex: 0, task: 'First task' }),
			expect.objectContaining({ document: 'tasks', taskIndex: 1, task: 'Second task' }),
		]);
		expect(events.at(-1)).toMatchObject({
			type: 'complete',
			dryRun: true,
			wouldProcess: 2,
			totalTasksCompleted: 0,
		});
	});

	it('runs one task through template expansion, synopsis parsing, history, and completion events', async () => {
		countSequence([
			{ content: '- [ ] Fix {{DOCUMENT_NAME}} on {{GIT_BRANCH}}', taskCount: 1 },
			{ content: '- [ ] Fix {{DOCUMENT_NAME}} on {{GIT_BRANCH}}', taskCount: 1 },
			{ content: '- [ ] Fix {{DOCUMENT_NAME}} on {{GIT_BRANCH}}', taskCount: 1 },
			{ content: '- [x] Fixed tasks', taskCount: 0 },
		]);
		vi.mocked(spawnAgent)
			.mockResolvedValueOnce({
				success: true,
				response: 'Task completed',
				agentSessionId: 'agent-session-alpha',
				usageStats,
			})
			.mockResolvedValueOnce({
				success: true,
				response: '**Summary:** Auth fixed\n\n**Details:** Validated token handling.',
				usageStats: { ...usageStats, inputTokens: 10, outputTokens: 5, totalCostUsd: 0.01 },
			});

		const events = await collectEvents(
			runPlaybook(session(), playbook(), '/playbooks', { debug: true, verbose: true })
		);

		const firstPrompt = vi.mocked(spawnAgent).mock.calls[0][2];
		expect(firstPrompt).toContain('Process Alpha Session on feature/integration for Alpha Group');
		expect(firstPrompt).toContain('/playbooks/tasks.md loop 00001');
		expect(firstPrompt).toContain('Fix tasks on feature/integration');
		expect(writeDoc).toHaveBeenCalledWith(
			'/playbooks',
			'tasks.md',
			expect.stringContaining('Fix tasks on feature/integration')
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'verbose',
				category: 'prompt',
				document: 'tasks',
				taskIndex: 0,
			})
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'task_complete',
				success: true,
				summary: 'Auth fixed',
				fullResponse: expect.stringContaining('Validated token handling'),
				synopsisUsageStats: expect.objectContaining({ inputTokens: 10 }),
			})
		);
		expect(events).toContainEqual(expect.objectContaining({ type: 'history_write' }));
		expect(events.at(-1)).toMatchObject({
			type: 'complete',
			success: true,
			totalTasksCompleted: 1,
		});
		expect(events.at(-1)?.totalCost).toBeCloseTo(0.06);
		expect(addHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'AUTO',
				summary: 'Auth fixed',
				sessionId: 'session-alpha',
				success: true,
				usageStats: expect.objectContaining({ totalCostUsd: 0.060000000000000005 }),
			})
		);
	});

	it('reports task failures without synopsis or history writes when disabled', async () => {
		countSequence([
			{ content: '- [ ] Failing task', taskCount: 1 },
			{ content: '- [ ] Failing task', taskCount: 1 },
			{ content: '- [ ] Failing task', taskCount: 1 },
			{ content: '- [ ] Failing task', taskCount: 0 },
		]);
		vi.mocked(spawnAgent).mockResolvedValue({
			success: false,
			error: 'Agent failed',
		});

		const events = await collectEvents(
			runPlaybook(session(), playbook(), '/playbooks', {
				debug: true,
				skipSynopsis: true,
				writeHistory: false,
			})
		);

		expect(spawnAgent).toHaveBeenCalledTimes(1);
		expect(addHistoryEntry).not.toHaveBeenCalled();
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'task_complete',
				success: false,
				summary: '[tasks] Task failed',
				fullResponse: 'Agent failed',
			})
		);
		expect(events.at(-1)).toMatchObject({
			type: 'complete',
			success: true,
			totalTasksCompleted: 1,
			totalCost: 0,
		});
	});

	it('resets completed documents and writes loop summaries when max loops stop execution', async () => {
		countSequence([
			{ content: '- [ ] Reset me', taskCount: 1 },
			{ content: '- [ ] Reset me', taskCount: 1 },
			{ content: '- [ ] Reset me', taskCount: 1 },
			{ content: '- [x] Reset me', taskCount: 0 },
			{ content: '- [x] Reset me', taskCount: 0 },
			{ content: '- [ ] Reset me', taskCount: 1 },
		]);
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Done',
			agentSessionId: 'agent-session-alpha',
			usageStats,
		});

		const events = await collectEvents(
			runPlaybook(
				session(),
				playbook({
					documents: [{ filename: 'tasks', resetOnCompletion: true }],
					loopEnabled: true,
					maxLoops: 1,
				}),
				'/playbooks',
				{ debug: true, skipSynopsis: true }
			)
		);

		expect(uncheckAllTasks).toHaveBeenCalledWith('- [x] Reset me');
		expect(writeDoc).toHaveBeenCalledWith('/playbooks', 'tasks.md', '- [ ] Reset me');
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'debug',
				category: 'loop',
				message: 'Exiting: reached max loops (1)',
			})
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'document_complete',
				document: 'tasks',
				tasksCompleted: 1,
			})
		);
		expect(addHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({ summary: expect.stringContaining('Loop 1 (final) completed') })
		);
		expect(addHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({ summary: expect.stringContaining('Auto Run completed') })
		);
	});
});
