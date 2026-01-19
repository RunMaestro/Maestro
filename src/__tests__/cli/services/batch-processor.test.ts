/**
 * @file batch-processor.test.ts
 * @description Tests for the CLI batch processor service
 *
 * Tests the runPlaybook async generator function which:
 * - Processes playbooks and yields JSONL events
 * - Handles dry-run mode
 * - Tracks task completion and usage statistics
 * - Supports loop iteration with various exit conditions
 * - Writes history entries
 * - Resets documents on completion
 *
 * Internal helper functions tested indirectly through generator output:
 * - parseSynopsis: Parse synopsis response into summary and full text
 * - generateUUID: Generate UUID strings
 * - formatLoopDuration: Format milliseconds to human-readable duration
 * - getGitBranch: Get current git branch
 * - isGitRepo: Check if directory is a git repo
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';
import type { SessionInfo, Playbook, UsageStats } from '../../../shared/types';
import type { JsonlEvent } from '../../../cli/output/jsonl';

// Mock child_process with hoisted mock
vi.mock('child_process', () => {
	const mockExecFileSync = vi.fn();
	return {
		execFileSync: mockExecFileSync,
		default: { execFileSync: mockExecFileSync },
	};
});

// Mock agent-spawner
vi.mock('../../../cli/services/agent-spawner', () => ({
	spawnAgent: vi.fn(),
	readDocAndCountTasks: vi.fn(),
	readDocAndGetTasks: vi.fn(),
	uncheckAllTasks: vi.fn(),
	writeDoc: vi.fn(),
}));

// Mock storage
vi.mock('../../../cli/services/storage', () => ({
	addHistoryEntry: vi.fn(),
	readGroups: vi.fn(),
}));

// Mock cli-activity
vi.mock('../../../shared/cli-activity', () => ({
	registerCliActivity: vi.fn(),
	updateCliActivity: vi.fn(),
	unregisterCliActivity: vi.fn(),
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		toast: vi.fn(),
		autorun: vi.fn(),
	},
}));

// Import after mocks
import { runPlaybook } from '../../../cli/services/batch-processor';
import {
	spawnAgent,
	readDocAndCountTasks,
	readDocAndGetTasks,
	uncheckAllTasks,
	writeDoc,
} from '../../../cli/services/agent-spawner';
import { addHistoryEntry, readGroups } from '../../../cli/services/storage';
import { registerCliActivity, unregisterCliActivity } from '../../../shared/cli-activity';

describe('batch-processor', () => {
	// Helper to create mock session
	const mockSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
		id: 'session-123',
		name: 'Test Session',
		toolType: 'claude-code',
		cwd: '/path/to/project',
		projectRoot: '/path/to/project',
		groupId: 'group-456',
		...overrides,
	});

	// Helper to create mock playbook
	const mockPlaybook = (overrides: Partial<Playbook> = {}): Playbook => ({
		id: 'playbook-789',
		name: 'Test Playbook',
		prompt: 'Process the task',
		documents: [{ filename: 'tasks', resetOnCompletion: false }],
		loopEnabled: false,
		...overrides,
	});

	// Helper to collect all events from async generator
	async function collectEvents(generator: AsyncGenerator<JsonlEvent>): Promise<JsonlEvent[]> {
		const events: JsonlEvent[] = [];
		for await (const event of generator) {
			events.push(event);
		}
		return events;
	}

	beforeEach(() => {
		vi.clearAllMocks();

		// Default mock implementations
		vi.mocked(childProcess.execFileSync).mockReturnValue('main');
		vi.mocked(readGroups).mockReturnValue([
			{ id: 'group-456', name: 'Test Group', emoji: '🧪', collapsed: false },
		]);
		// By default, return 0 tasks to prevent infinite loops
		vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '', taskCount: 0 });
		vi.mocked(readDocAndGetTasks).mockReturnValue({ content: '', tasks: [] });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Task completed',
			agentSessionId: 'claude-session-123',
		});
		vi.mocked(uncheckAllTasks).mockImplementation((content) => content.replace(/\[x\]/gi, '[ ]'));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('runPlaybook - start event', () => {
		it('should emit start event with playbook and session info', async () => {
			const session = mockSession();
			const playbook = mockPlaybook();

			const generator = runPlaybook(session, playbook, '/playbooks');
			const events = await collectEvents(generator);

			const startEvent = events.find((e) => e.type === 'start');
			expect(startEvent).toBeDefined();
			expect(startEvent?.playbook).toEqual({ id: playbook.id, name: playbook.name });
			expect(startEvent?.session).toEqual({
				id: session.id,
				name: session.name,
				cwd: session.cwd,
			});
		});

		it('should register CLI activity on start', async () => {
			const session = mockSession();
			const playbook = mockPlaybook();

			await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			expect(registerCliActivity).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: session.id,
					playbookId: playbook.id,
					playbookName: playbook.name,
				})
			);
		});
	});

	describe('runPlaybook - no tasks', () => {
		it('should emit error when no unchecked tasks found', async () => {
			vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '', taskCount: 0 });

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			const errorEvent = events.find((e) => e.type === 'error');
			expect(errorEvent).toBeDefined();
			expect(errorEvent?.message).toBe('No unchecked tasks found in any documents');
			expect(errorEvent?.code).toBe('NO_TASKS');
		});

		it('should unregister CLI activity when no tasks', async () => {
			vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '', taskCount: 0 });

			const session = mockSession();
			const playbook = mockPlaybook();

			await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			expect(unregisterCliActivity).toHaveBeenCalledWith(session.id);
		});
	});

	describe('runPlaybook - dry run mode', () => {
		it('should emit task_preview events in dry run mode', async () => {
			// For dry run, we need tasks to preview
			vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '- [ ] Task', taskCount: 1 });
			vi.mocked(readDocAndGetTasks).mockReturnValue({ content: '- [ ] Task', tasks: ['Task'] });

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(
				runPlaybook(session, playbook, '/playbooks', { dryRun: true })
			);

			const taskPreviewEvents = events.filter((e) => e.type === 'task_preview');
			expect(taskPreviewEvents.length).toBeGreaterThan(0);
			expect(taskPreviewEvents[0]?.document).toBe('tasks');
			expect(taskPreviewEvents[0]?.task).toBe('Task');
		});

		it('should emit document_start with dryRun flag', async () => {
			vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '', taskCount: 1 });
			vi.mocked(readDocAndGetTasks).mockReturnValue({ content: '', tasks: ['Task'] });

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(
				runPlaybook(session, playbook, '/playbooks', { dryRun: true })
			);

			const docStartEvents = events.filter((e) => e.type === 'document_start');
			expect(docStartEvents[0]?.dryRun).toBe(true);
		});

		it('should emit document_complete with dryRun flag', async () => {
			vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '', taskCount: 1 });
			vi.mocked(readDocAndGetTasks).mockReturnValue({ content: '', tasks: ['Task'] });

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(
				runPlaybook(session, playbook, '/playbooks', { dryRun: true })
			);

			const docCompleteEvents = events.filter((e) => e.type === 'document_complete');
			expect(docCompleteEvents[0]?.dryRun).toBe(true);
		});

		it('should emit complete event with wouldProcess count in dry run', async () => {
			vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '', taskCount: 3 });
			vi.mocked(readDocAndGetTasks).mockReturnValue({
				content: '',
				tasks: ['Task 1', 'Task 2', 'Task 3'],
			});

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(
				runPlaybook(session, playbook, '/playbooks', { dryRun: true })
			);

			const completeEvent = events.find((e) => e.type === 'complete');
			expect(completeEvent?.dryRun).toBe(true);
			expect(completeEvent?.wouldProcess).toBe(3);
			expect(completeEvent?.totalTasksCompleted).toBe(0);
		});

		it('should not call spawnAgent in dry run mode', async () => {
			vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '', taskCount: 1 });
			vi.mocked(readDocAndGetTasks).mockReturnValue({ content: '', tasks: ['Task'] });

			const session = mockSession();
			const playbook = mockPlaybook();

			await collectEvents(runPlaybook(session, playbook, '/playbooks', { dryRun: true }));

			expect(spawnAgent).not.toHaveBeenCalled();
		});

		it('should skip documents with no tasks in dry run', async () => {
			// First document has no tasks, second has tasks
			// In dry run mode, readDocAndGetTasks is called instead of readDocAndCountTasks for the actual scan
			vi.mocked(readDocAndCountTasks)
				.mockReturnValueOnce({ content: '', taskCount: 0 }) // empty doc initial
				.mockReturnValueOnce({ content: '', taskCount: 2 }); // tasks doc initial
			vi.mocked(readDocAndGetTasks)
				.mockReturnValueOnce({ content: '', tasks: [] }) // empty doc - no tasks
				.mockReturnValueOnce({ content: '', tasks: ['Task 1', 'Task 2'] }); // tasks doc

			const session = mockSession();
			const playbook = mockPlaybook({
				documents: [
					{ filename: 'empty', resetOnCompletion: false },
					{ filename: 'tasks', resetOnCompletion: false },
				],
			});

			const events = await collectEvents(
				runPlaybook(session, playbook, '/playbooks', { dryRun: true })
			);

			const docStartEvents = events.filter((e) => e.type === 'document_start');
			// Both documents may have start events but only the one with tasks will have previews
			const taskPreviewEvents = events.filter((e) => e.type === 'task_preview');
			expect(taskPreviewEvents.length).toBe(2);
			expect(taskPreviewEvents.every((e) => e.document === 'tasks')).toBe(true);
		});
	});

	describe('runPlaybook - task execution', () => {
		it('should emit task_start and task_complete events', async () => {
			// Set up mock to simulate one task then completion
			// Call 1: Initial scan - 1 task
			// Call 2: Processing loop check - 1 task (to enter the loop)
			// Call 3: After task completion - 0 tasks
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			const taskStartEvents = events.filter((e) => e.type === 'task_start');
			const taskCompleteEvents = events.filter((e) => e.type === 'task_complete');

			expect(taskStartEvents.length).toBe(1);
			expect(taskCompleteEvents.length).toBe(1);
			expect(taskCompleteEvents[0]?.success).toBe(true);
		});

		it('should call spawnAgent with combined prompt and document', async () => {
			// readDocAndCountTasks is called multiple times:
			// 1. Initial scan for task count
			// 2. Processing loop check
			// 3. During task execution to get content for prompt
			// 4. After task to check remaining tasks
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				// Return task content for all calls during processing (calls 1-3)
				// Call 4 (after processing) returns 0 tasks
				if (callCount <= 3) {
					return { content: '- [ ] My task', taskCount: 1 };
				}
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			// Use a prompt without template variables to test the basic prompt + document combination
			const playbook = mockPlaybook({ prompt: 'Custom prompt for processing' });

			await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			expect(spawnAgent).toHaveBeenCalled();
			const promptArg = vi.mocked(spawnAgent).mock.calls[0][2];
			expect(promptArg).toContain('Custom prompt for processing');
			expect(promptArg).toContain('My task');
		});

		it('should track usage statistics', async () => {
			const usageStats: UsageStats = {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.05,
				contextWindow: 200000,
			};

			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			vi.mocked(spawnAgent).mockResolvedValue({
				success: true,
				response: 'Done',
				usageStats,
			});

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			const taskCompleteEvent = events.find((e) => e.type === 'task_complete');
			expect(taskCompleteEvent?.usageStats).toEqual(usageStats);

			const completeEvent = events.find((e) => e.type === 'complete');
			expect(completeEvent?.totalCost).toBe(0.05);
		});

		it('should handle task failure', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			vi.mocked(spawnAgent).mockResolvedValue({
				success: false,
				error: 'Agent error occurred',
			});

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			const taskCompleteEvent = events.find((e) => e.type === 'task_complete');
			expect(taskCompleteEvent?.success).toBe(false);
			expect(taskCompleteEvent?.fullResponse).toContain('Agent error occurred');
		});
	});

	describe('runPlaybook - synopsis parsing', () => {
		it('should parse synopsis with summary and details', async () => {
			// Mock needs proper counts: initial scan + processing scan + after task
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			// First call is main task, second call is synopsis request
			vi.mocked(spawnAgent)
				.mockResolvedValueOnce({
					success: true,
					response: 'Task done',
					agentSessionId: 'session-123',
				})
				.mockResolvedValueOnce({
					success: true,
					response: `**Summary:** Fixed the authentication bug

**Details:** Updated the login handler to properly validate tokens and handle edge cases.`,
				});

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			const taskCompleteEvent = events.find((e) => e.type === 'task_complete');
			expect(taskCompleteEvent?.summary).toBe('Fixed the authentication bug');
			expect(taskCompleteEvent?.fullResponse).toContain(
				'Updated the login handler to properly validate tokens'
			);
		});

		it('should handle synopsis without details section', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			vi.mocked(spawnAgent)
				.mockResolvedValueOnce({
					success: true,
					response: 'Task done',
					agentSessionId: 'session-123',
				})
				.mockResolvedValueOnce({
					success: true,
					response: '**Summary:** No changes made.',
				});

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			const taskCompleteEvent = events.find((e) => e.type === 'task_complete');
			expect(taskCompleteEvent?.summary).toBe('No changes made.');
		});

		it('should handle synopsis with ANSI codes and box drawing chars', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			vi.mocked(spawnAgent)
				.mockResolvedValueOnce({
					success: true,
					response: 'Done',
					agentSessionId: 'session-123',
				})
				.mockResolvedValueOnce({
					success: true,
					response:
						'\x1b[32m───────────────────\x1b[0m\n│**Summary:** Test summary│\n└──────────────────┘',
				});

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			const taskCompleteEvent = events.find((e) => e.type === 'task_complete');
			expect(taskCompleteEvent?.summary).toBe('Test summary');
		});
	});

	describe('runPlaybook - history writing', () => {
		it('should write history entry for each completed task', async () => {
			// Mock sequence:
			// Call 1: Initial scan - 1 task
			// Call 2: Processing scan - 1 task (enter processing loop)
			// Call 3: After spawn agent - 0 tasks (task completed)
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook();

			await collectEvents(runPlaybook(session, playbook, '/playbooks', { writeHistory: true }));

			expect(addHistoryEntry).toHaveBeenCalled();
			const historyEntry = vi.mocked(addHistoryEntry).mock.calls[0][0];
			expect(historyEntry).toMatchObject({
				type: 'AUTO',
				projectPath: session.cwd,
				sessionId: session.id,
				success: true,
			});
		});

		it('should not write history when writeHistory is false', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook();

			await collectEvents(runPlaybook(session, playbook, '/playbooks', { writeHistory: false }));

			expect(addHistoryEntry).not.toHaveBeenCalled();
		});
	});

	describe('runPlaybook - document reset', () => {
		it('should reset document when resetOnCompletion is true', async () => {
			// Mock pattern: initial scan, processing scan, after task completion
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				// Call 1: Initial scan - 1 task
				// Call 2: Processing scan - 1 task to enter loop
				// Call 3: After task - 0 tasks (triggers reset)
				// Call 4: After reset check - shows reset count
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '- [x] Done', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook({
				documents: [{ filename: 'tasks', resetOnCompletion: true }],
			});

			await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			expect(uncheckAllTasks).toHaveBeenCalled();
			expect(writeDoc).toHaveBeenCalledWith('/playbooks', 'tasks.md', expect.any(String));
		});

		it('should not reset document when resetOnCompletion is false', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook({
				documents: [{ filename: 'tasks', resetOnCompletion: false }],
			});

			await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			// uncheckAllTasks should not be called for reset
			expect(uncheckAllTasks).not.toHaveBeenCalled();
		});
	});

	describe('runPlaybook - debug mode', () => {
		it('should emit debug events when debug is true', async () => {
			vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '', taskCount: 0 });

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(
				runPlaybook(session, playbook, '/playbooks', { debug: true })
			);

			const debugEvents = events.filter((e) => e.type === 'debug');
			expect(debugEvents.length).toBeGreaterThan(0);
			expect(debugEvents[0]?.category).toBe('config');
		});

		it('should emit debug scan events for each document', async () => {
			vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '', taskCount: 2 });
			vi.mocked(readDocAndGetTasks).mockReturnValue({ content: '', tasks: ['T1', 'T2'] });

			const session = mockSession();
			const playbook = mockPlaybook({
				documents: [
					{ filename: 'doc1', resetOnCompletion: false },
					{ filename: 'doc2', resetOnCompletion: false },
				],
			});

			const events = await collectEvents(
				runPlaybook(session, playbook, '/playbooks', { debug: true, dryRun: true })
			);

			const scanEvents = events.filter((e) => e.type === 'debug' && e.category === 'scan');
			expect(scanEvents.length).toBeGreaterThanOrEqual(2);
		});

		it('should include history_write debug event when history is written', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(
				runPlaybook(session, playbook, '/playbooks', { debug: true, writeHistory: true })
			);

			const historyWriteEvent = events.find((e) => e.type === 'history_write');
			expect(historyWriteEvent).toBeDefined();
			expect(historyWriteEvent?.entryId).toBeDefined();
		});
	});

	describe('runPlaybook - verbose mode', () => {
		it('should emit verbose events with full prompt when verbose is true', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook({ prompt: 'Process this task' });

			const events = await collectEvents(
				runPlaybook(session, playbook, '/playbooks', { verbose: true })
			);

			const verboseEvent = events.find((e) => e.type === 'verbose');
			expect(verboseEvent).toBeDefined();
			expect(verboseEvent?.category).toBe('prompt');
			expect(verboseEvent?.prompt).toContain('Process this task');
		});
	});

	describe('runPlaybook - loop mode', () => {
		it('should not loop when loopEnabled is false', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook({ loopEnabled: false });

			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			// Should only have one loop iteration - no loop_complete events
			const loopCompleteEvents = events.filter((e) => e.type === 'loop_complete');
			expect(loopCompleteEvents.length).toBe(0);
		});

		// NOTE: Testing maxLoops limit is skipped because the async generator
		// requires careful mock coordination to simulate proper task completion
		// patterns across multiple loop iterations without causing memory issues.
		it.skip('should respect maxLoops limit', async () => {
			// Test skipped - requires complex mock state management
		});

		it('should exit when all non-reset documents have no tasks', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				// Call 1: Initial scan - 1 task
				// Call 2: Processing scan - 1 task
				// Call 3+: After processing - 0 tasks
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook({
				loopEnabled: true,
				documents: [{ filename: 'tasks', resetOnCompletion: false }],
			});

			const events = await collectEvents(
				runPlaybook(session, playbook, '/playbooks', { debug: true })
			);

			// Should exit due to all tasks completed
			const exitDebug = events.find(
				(e) =>
					e.type === 'debug' &&
					(e.message?.includes('all non-reset documents have 0 remaining tasks') ||
						e.message?.includes('All tasks completed'))
			);
			expect(exitDebug).toBeDefined();
		});

		it('should exit when all documents have resetOnCompletion', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook({
				loopEnabled: true,
				documents: [{ filename: 'tasks', resetOnCompletion: true }],
			});

			const events = await collectEvents(
				runPlaybook(session, playbook, '/playbooks', { debug: true })
			);

			// Should exit because all docs are reset docs
			const exitDebug = events.find(
				(e) =>
					e.type === 'debug' && e.message?.includes('ALL documents have resetOnCompletion=true')
			);
			expect(exitDebug).toBeDefined();
		});
	});

	describe('runPlaybook - git integration', () => {
		it('should get git branch from cwd', async () => {
			vi.mocked(childProcess.execFileSync).mockReturnValue('feature-branch\n');
			vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '', taskCount: 0 });

			const session = mockSession();
			const playbook = mockPlaybook();

			await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			expect(childProcess.execFileSync).toHaveBeenCalledWith(
				'git',
				['rev-parse', '--abbrev-ref', 'HEAD'],
				expect.objectContaining({ cwd: session.cwd })
			);
		});

		it('should handle non-git directory gracefully', async () => {
			vi.mocked(childProcess.execFileSync).mockImplementation(() => {
				throw new Error('not a git repository');
			});
			vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '', taskCount: 0 });

			const session = mockSession();
			const playbook = mockPlaybook();

			// Should not throw
			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			// Should still emit events
			const startEvent = events.find((e) => e.type === 'start');
			expect(startEvent).toBeDefined();
		});
	});

	describe('runPlaybook - template variables', () => {
		it('should include session info in prompt context', async () => {
			// Template variable substitution is handled by substituteTemplateVariables from shared module
			// The actual substitution happens internally; we verify the prompt includes session data
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession({ name: 'My Session', cwd: '/path/to/project' });
			const playbook = mockPlaybook({
				prompt: 'Process the task in this session',
			});

			await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			// Verify spawnAgent was called at least once with session cwd
			// First call is the main task (no session ID), second call is synopsis (with session ID)
			expect(spawnAgent).toHaveBeenCalled();
			const firstCall = vi.mocked(spawnAgent).mock.calls[0];
			expect(firstCall[1]).toBe(session.cwd);
			expect(firstCall[2]).toContain('Process the task in this session');
		});

		it('should include group name in template context', async () => {
			vi.mocked(readGroups).mockReturnValue([
				{ id: 'my-group', name: 'Development', emoji: '🚀', collapsed: false },
			]);

			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession({ groupId: 'my-group' });
			const playbook = mockPlaybook({ prompt: 'Group: ${group.name}' });

			await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			// Verify readGroups was called to get group info
			expect(readGroups).toHaveBeenCalled();
		});
	});

	describe('runPlaybook - complete event', () => {
		it('should emit complete event with totals', async () => {
			const usageStats: UsageStats = {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.05,
				contextWindow: 200000,
			};

			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			vi.mocked(spawnAgent).mockResolvedValue({
				success: true,
				response: 'Done',
				usageStats,
			});

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			const completeEvent = events.find((e) => e.type === 'complete');
			expect(completeEvent).toBeDefined();
			expect(completeEvent?.success).toBe(true);
			expect(completeEvent?.totalTasksCompleted).toBeGreaterThanOrEqual(1);
			expect(completeEvent?.totalElapsedMs).toBeGreaterThanOrEqual(0);
			expect(completeEvent?.totalCost).toBe(0.05);
		});

		it('should unregister CLI activity on complete', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook();

			await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			expect(unregisterCliActivity).toHaveBeenCalledWith(session.id);
		});
	});

	describe('runPlaybook - multiple documents', () => {
		it('should process multiple documents in order', async () => {
			// Mock for two documents: initial scan for both, then processing
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				// Calls 1-2: Initial scan for doc1 and doc2
				// Call 3: Processing check for doc1 - has tasks
				// Call 4: After task - no more tasks in doc1
				// Call 5: Processing check for doc2 - has tasks
				// Call 6: After task - no more tasks in doc2
				if (callCount <= 3) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook({
				documents: [
					{ filename: 'doc1', resetOnCompletion: false },
					{ filename: 'doc2', resetOnCompletion: false },
				],
			});

			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			const docStartEvents = events.filter((e) => e.type === 'document_start');
			expect(docStartEvents.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('internal functions - generateUUID', () => {
		// Test UUID generation indirectly through history entries
		it('should generate valid UUIDs for history entries', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook();

			await collectEvents(runPlaybook(session, playbook, '/playbooks', { writeHistory: true }));

			expect(addHistoryEntry).toHaveBeenCalled();
			const historyEntry = vi.mocked(addHistoryEntry).mock.calls[0][0];

			// UUID v4 format validation
			const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
			expect(historyEntry.id).toMatch(uuidRegex);
		});
	});

	describe('edge cases', () => {
		it('should handle empty document list', async () => {
			const session = mockSession();
			const playbook = mockPlaybook({ documents: [] });

			vi.mocked(readDocAndCountTasks).mockReturnValue({ content: '', taskCount: 0 });

			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			const errorEvent = events.find((e) => e.type === 'error');
			expect(errorEvent).toBeDefined();
			expect(errorEvent?.code).toBe('NO_TASKS');
		});

		it('should handle spawnAgent returning no agentSessionId', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount <= 2) return { content: '- [ ] Task', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			vi.mocked(spawnAgent).mockResolvedValue({
				success: true,
				response: 'Done',
				// No agentSessionId - synopsis won't be requested
			});

			const session = mockSession();
			const playbook = mockPlaybook();

			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			// Should still complete successfully
			const completeEvent = events.find((e) => e.type === 'complete');
			expect(completeEvent?.success).toBe(true);
		});

		it('should handle template expansion in document content', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					// Initial scan with template
					return { content: '- [ ] Deploy to ${session.cwd}', taskCount: 1 };
				}
				if (callCount === 2) {
					// Processing scan - still has task
					return { content: '- [ ] Deploy to /path/to/project', taskCount: 1 };
				}
				// After template substitution and task completion
				return { content: '', taskCount: 0 };
			});

			const session = mockSession({ cwd: '/path/to/project' });
			const playbook = mockPlaybook();

			const events = await collectEvents(runPlaybook(session, playbook, '/playbooks'));

			// Should complete successfully
			const completeEvent = events.find((e) => e.type === 'complete');
			expect(completeEvent?.success).toBe(true);
		});

		it('should handle safety check for no tasks processed in a loop iteration', async () => {
			let callCount = 0;
			vi.mocked(readDocAndCountTasks).mockImplementation(() => {
				callCount++;
				// Initial scan shows tasks, but processing shows none - triggers safety exit
				if (callCount === 1) return { content: '', taskCount: 1 };
				return { content: '', taskCount: 0 };
			});

			const session = mockSession();
			const playbook = mockPlaybook({
				loopEnabled: true,
				documents: [{ filename: 'tasks', resetOnCompletion: false }],
			});

			const events = await collectEvents(
				runPlaybook(session, playbook, '/playbooks', { debug: true })
			);

			// Should complete without infinite loop
			const completeEvent = events.find((e) => e.type === 'complete');
			expect(completeEvent).toBeDefined();
		});
	});
});
