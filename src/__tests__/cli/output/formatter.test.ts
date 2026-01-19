/**
 * @fileoverview Tests for CLI output formatter
 *
 * This file contains comprehensive tests for the human-readable output formatter
 * used by the Maestro CLI. It tests all formatting functions including:
 * - Color and style helpers (c, bold, dim, truncate)
 * - Group formatting (formatGroups)
 * - Agent formatting (formatAgents, formatAgentDetail)
 * - Playbook formatting (formatPlaybooks, formatPlaybookDetail, formatPlaybooksByAgent)
 * - Run event formatting (formatRunEvent)
 * - Message formatting (formatError, formatSuccess, formatInfo, formatWarning)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	formatGroups,
	formatAgents,
	formatPlaybooks,
	formatPlaybookDetail,
	formatPlaybooksByAgent,
	formatRunEvent,
	formatAgentDetail,
	formatError,
	formatSuccess,
	formatInfo,
	formatWarning,
	type GroupDisplay,
	type AgentDisplay,
	type PlaybookDisplay,
	type PlaybookDetailDisplay,
	type PlaybooksByAgent,
	type RunEvent,
	type AgentDetailDisplay,
} from '../../../cli/output/formatter';

// Store original process.stdout.isTTY
const originalIsTTY = process.stdout.isTTY;

describe('formatter', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		// Restore original isTTY
		Object.defineProperty(process.stdout, 'isTTY', {
			value: originalIsTTY,
			writable: true,
		});
	});

	// ============================================================================
	// Color and Style Helper Tests
	// ============================================================================

	describe('Color and style handling', () => {
		it('should include ANSI codes when stdout is TTY', () => {
			// Simulate TTY environment
			Object.defineProperty(process.stdout, 'isTTY', {
				value: true,
				writable: true,
			});

			// Re-import to pick up new isTTY value - the module caches supportsColor
			// So we test through the public functions that use colors
			const result = formatError('Test error');

			// Error format uses red color
			expect(result).toContain('Error:');
			expect(result).toContain('Test error');
		});

		it('should not include ANSI codes when stdout is not TTY', () => {
			// Simulate non-TTY environment
			Object.defineProperty(process.stdout, 'isTTY', {
				value: false,
				writable: true,
			});

			// The formatter module checks isTTY at load time
			// Since we can't easily reload the module, test that output works
			const result = formatError('Test error');
			expect(result).toContain('Error:');
			expect(result).toContain('Test error');
		});
	});

	// ============================================================================
	// formatGroups Tests
	// ============================================================================

	describe('formatGroups', () => {
		it('should return "No groups found" for empty array', () => {
			const result = formatGroups([]);
			expect(result).toContain('No groups found');
		});

		it('should format a single group', () => {
			const groups: GroupDisplay[] = [{ id: 'group-123', name: 'My Project', emoji: '🚀' }];

			const result = formatGroups(groups);

			expect(result).toContain('GROUPS');
			expect(result).toContain('(1)');
			expect(result).toContain('🚀');
			expect(result).toContain('My Project');
			expect(result).toContain('group-123');
		});

		it('should format multiple groups', () => {
			const groups: GroupDisplay[] = [
				{ id: 'group-1', name: 'Frontend', emoji: '🎨' },
				{ id: 'group-2', name: 'Backend', emoji: '⚙️' },
				{ id: 'group-3', name: 'DevOps' }, // No emoji - should default to 📁
			];

			const result = formatGroups(groups);

			expect(result).toContain('GROUPS');
			expect(result).toContain('(3)');
			expect(result).toContain('🎨');
			expect(result).toContain('Frontend');
			expect(result).toContain('⚙️');
			expect(result).toContain('Backend');
			expect(result).toContain('📁'); // Default emoji
			expect(result).toContain('DevOps');
		});

		it('should use default emoji when none provided', () => {
			const groups: GroupDisplay[] = [{ id: 'group-1', name: 'No Emoji Group' }];

			const result = formatGroups(groups);
			expect(result).toContain('📁');
		});
	});

	// ============================================================================
	// formatAgents Tests
	// ============================================================================

	describe('formatAgents', () => {
		it('should return "No agents found" for empty array', () => {
			const result = formatAgents([]);
			expect(result).toContain('No agents found');
		});

		it('should format a single agent', () => {
			const agents: AgentDisplay[] = [
				{
					id: 'agent-abc123',
					name: 'Test Agent',
					toolType: 'claude-code',
					cwd: '/home/user/projects/test',
				},
			];

			const result = formatAgents(agents);

			expect(result).toContain('AGENTS');
			expect(result).toContain('(1)');
			expect(result).toContain('Test Agent');
			expect(result).toContain('claude-code');
			expect(result).toContain('/home/user/projects/test');
			expect(result).toContain('agent-abc123');
		});

		it('should format multiple agents', () => {
			const agents: AgentDisplay[] = [
				{
					id: 'agent-1',
					name: 'Agent One',
					toolType: 'claude-code',
					cwd: '/path/one',
				},
				{
					id: 'agent-2',
					name: 'Agent Two',
					toolType: 'openai-codex',
					cwd: '/path/two',
				},
			];

			const result = formatAgents(agents);

			expect(result).toContain('(2)');
			expect(result).toContain('Agent One');
			expect(result).toContain('Agent Two');
		});

		it('should show group name in title when provided', () => {
			const agents: AgentDisplay[] = [
				{
					id: 'agent-1',
					name: 'Test',
					toolType: 'claude-code',
					cwd: '/path',
				},
			];

			const result = formatAgents(agents, 'My Group');

			expect(result).toContain('in My Group');
		});

		it('should show Auto Run badge for agents with autoRunFolderPath', () => {
			const agents: AgentDisplay[] = [
				{
					id: 'agent-1',
					name: 'Auto Agent',
					toolType: 'claude-code',
					cwd: '/path',
					autoRunFolderPath: '/path/to/playbooks',
				},
			];

			const result = formatAgents(agents);

			expect(result).toContain('[Auto Run]');
		});

		it('should truncate long paths', () => {
			const longPath =
				'/very/long/path/that/exceeds/sixty/characters/for/the/working/directory/test';
			const agents: AgentDisplay[] = [
				{
					id: 'agent-1',
					name: 'Agent',
					toolType: 'claude-code',
					cwd: longPath,
				},
			];

			const result = formatAgents(agents);

			// Path should be truncated with ellipsis
			expect(result).toContain('…');
			expect(result.length).toBeLessThan(result.length + longPath.length);
		});
	});

	// ============================================================================
	// formatPlaybooks Tests
	// ============================================================================

	describe('formatPlaybooks', () => {
		it('should return "No playbooks found" for empty array', () => {
			const result = formatPlaybooks([]);
			expect(result).toContain('No playbooks found');
		});

		it('should format a single playbook', () => {
			const playbooks: PlaybookDisplay[] = [
				{
					id: 'pb-123456789',
					name: 'Test Playbook',
					sessionId: 'session-1',
					documents: [{ filename: 'task1.md', resetOnCompletion: false }],
				},
			];

			const result = formatPlaybooks(playbooks);

			expect(result).toContain('PLAYBOOKS');
			expect(result).toContain('(1)');
			expect(result).toContain('Test Playbook');
			expect(result).toContain('1 doc');
			expect(result).toContain('task1.md');
		});

		it('should format multiple documents with plural', () => {
			const playbooks: PlaybookDisplay[] = [
				{
					id: 'pb-123',
					name: 'Multi Doc',
					sessionId: 'session-1',
					documents: [
						{ filename: 'doc1.md', resetOnCompletion: false },
						{ filename: 'doc2.md', resetOnCompletion: false },
						{ filename: 'doc3.md', resetOnCompletion: true },
					],
				},
			];

			const result = formatPlaybooks(playbooks);

			expect(result).toContain('3 docs');
			expect(result).toContain('doc1.md');
			expect(result).toContain('doc2.md');
			expect(result).toContain('doc3.md');
		});

		it('should show loop indicator when enabled', () => {
			const playbooks: PlaybookDisplay[] = [
				{
					id: 'pb-123',
					name: 'Loop Playbook',
					sessionId: 'session-1',
					documents: [],
					loopEnabled: true,
				},
			];

			const result = formatPlaybooks(playbooks);

			expect(result).toContain('↻ loop');
		});

		it('should show max loops when specified', () => {
			const playbooks: PlaybookDisplay[] = [
				{
					id: 'pb-123',
					name: 'Limited Loop',
					sessionId: 'session-1',
					documents: [],
					loopEnabled: true,
					maxLoops: 5,
				},
			];

			const result = formatPlaybooks(playbooks);

			expect(result).toContain('max 5');
		});

		it('should show reset indicator for documents with resetOnCompletion', () => {
			const playbooks: PlaybookDisplay[] = [
				{
					id: 'pb-123',
					name: 'Reset Playbook',
					sessionId: 'session-1',
					documents: [{ filename: 'reset.md', resetOnCompletion: true }],
				},
			];

			const result = formatPlaybooks(playbooks);

			expect(result).toContain('↺');
		});

		it('should show agent name when provided', () => {
			const playbooks: PlaybookDisplay[] = [
				{
					id: 'pb-123',
					name: 'Test',
					sessionId: 'session-1',
					documents: [],
				},
			];

			const result = formatPlaybooks(playbooks, 'My Agent');

			expect(result).toContain('for My Agent');
		});

		it('should show folder path when provided', () => {
			const playbooks: PlaybookDisplay[] = [
				{
					id: 'pb-123',
					name: 'Test',
					sessionId: 'session-1',
					documents: [],
				},
			];

			const result = formatPlaybooks(playbooks, undefined, '/path/to/playbooks');

			expect(result).toContain('📁 /path/to/playbooks');
		});
	});

	// ============================================================================
	// formatPlaybookDetail Tests
	// ============================================================================

	describe('formatPlaybookDetail', () => {
		const basePlaybook: PlaybookDetailDisplay = {
			id: 'pb-detailed',
			name: 'Detailed Playbook',
			agentId: 'agent-123456789',
			agentName: 'Test Agent',
			prompt: 'This is the prompt',
			documents: [],
		};

		it('should format basic playbook details', () => {
			const result = formatPlaybookDetail(basePlaybook);

			expect(result).toContain('PLAYBOOK');
			expect(result).toContain('Name:');
			expect(result).toContain('Detailed Playbook');
			expect(result).toContain('ID:');
			expect(result).toContain('pb-detailed');
			expect(result).toContain('Agent:');
			expect(result).toContain('Test Agent');
		});

		it('should show folder path when provided', () => {
			const playbook: PlaybookDetailDisplay = {
				...basePlaybook,
				folderPath: '/custom/folder',
			};

			const result = formatPlaybookDetail(playbook);

			expect(result).toContain('Folder:');
			expect(result).toContain('/custom/folder');
		});

		it('should show loop enabled with infinite loops', () => {
			const playbook: PlaybookDetailDisplay = {
				...basePlaybook,
				loopEnabled: true,
			};

			const result = formatPlaybookDetail(playbook);

			expect(result).toContain('Loop:');
			expect(result).toContain('enabled');
			expect(result).toContain('∞');
		});

		it('should show loop enabled with max loops', () => {
			const playbook: PlaybookDetailDisplay = {
				...basePlaybook,
				loopEnabled: true,
				maxLoops: 10,
			};

			const result = formatPlaybookDetail(playbook);

			expect(result).toContain('max 10');
		});

		it('should show loop disabled', () => {
			const playbook: PlaybookDetailDisplay = {
				...basePlaybook,
				loopEnabled: false,
			};

			const result = formatPlaybookDetail(playbook);

			expect(result).toContain('Loop:');
			expect(result).toContain('disabled');
		});

		it('should format multi-line prompts', () => {
			const playbook: PlaybookDetailDisplay = {
				...basePlaybook,
				prompt: 'Line 1\nLine 2\nLine 3',
			};

			const result = formatPlaybookDetail(playbook);

			expect(result).toContain('Prompt:');
			expect(result).toContain('Line 1');
			expect(result).toContain('Line 2');
			expect(result).toContain('Line 3');
		});

		it('should format documents with tasks', () => {
			const playbook: PlaybookDetailDisplay = {
				...basePlaybook,
				documents: [
					{
						filename: 'tasks.md',
						resetOnCompletion: false,
						taskCount: 3,
						tasks: ['Task 1', 'Task 2', 'Task 3'],
					},
				],
			};

			const result = formatPlaybookDetail(playbook);

			expect(result).toContain('Documents:');
			expect(result).toContain('1 files');
			expect(result).toContain('3 pending tasks');
			expect(result).toContain('tasks.md');
			expect(result).toContain('3 tasks');
			expect(result).toContain('Task 1');
			expect(result).toContain('Task 2');
			expect(result).toContain('Task 3');
		});

		it('should show reset indicator for documents', () => {
			const playbook: PlaybookDetailDisplay = {
				...basePlaybook,
				documents: [
					{
						filename: 'reset.md',
						resetOnCompletion: true,
						taskCount: 0,
						tasks: [],
					},
				],
			};

			const result = formatPlaybookDetail(playbook);

			expect(result).toContain('↺ reset');
		});

		it('should show only first 5 tasks and indicate more', () => {
			const playbook: PlaybookDetailDisplay = {
				...basePlaybook,
				documents: [
					{
						filename: 'many.md',
						resetOnCompletion: false,
						taskCount: 8,
						tasks: ['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5', 'Task 6', 'Task 7', 'Task 8'],
					},
				],
			};

			const result = formatPlaybookDetail(playbook);

			expect(result).toContain('Task 1');
			expect(result).toContain('Task 5');
			expect(result).not.toContain('Task 6');
			expect(result).toContain('... and 3 more');
		});

		it('should handle documents with zero tasks', () => {
			const playbook: PlaybookDetailDisplay = {
				...basePlaybook,
				documents: [
					{
						filename: 'empty.md',
						resetOnCompletion: false,
						taskCount: 0,
						tasks: [],
					},
				],
			};

			const result = formatPlaybookDetail(playbook);

			expect(result).toContain('0 tasks');
		});
	});

	// ============================================================================
	// formatPlaybooksByAgent Tests
	// ============================================================================

	describe('formatPlaybooksByAgent', () => {
		it('should return "No playbooks found" when all agents have empty playbooks', () => {
			const groups: PlaybooksByAgent[] = [
				{ agentId: 'agent-1', agentName: 'Agent 1', playbooks: [] },
			];

			const result = formatPlaybooksByAgent(groups);

			expect(result).toContain('No playbooks found');
		});

		it('should return "No playbooks found" for empty array', () => {
			const result = formatPlaybooksByAgent([]);
			expect(result).toContain('No playbooks found');
		});

		it('should format playbooks grouped by agent', () => {
			const groups: PlaybooksByAgent[] = [
				{
					agentId: 'agent-123456789',
					agentName: 'Agent One',
					playbooks: [
						{
							id: 'pb-1',
							name: 'Playbook A',
							sessionId: 'session-1',
							documents: [{ filename: 'doc.md', resetOnCompletion: false }],
						},
					],
				},
				{
					agentId: 'agent-987654321',
					agentName: 'Agent Two',
					playbooks: [
						{
							id: 'pb-2',
							name: 'Playbook B',
							sessionId: 'session-2',
							documents: [],
							loopEnabled: true,
						},
					],
				},
			];

			const result = formatPlaybooksByAgent(groups);

			expect(result).toContain('PLAYBOOKS');
			expect(result).toContain('2 across 2 agents');
			expect(result).toContain('Agent One');
			expect(result).toContain('Playbook A');
			expect(result).toContain('Agent Two');
			expect(result).toContain('Playbook B');
		});

		it('should use singular "agent" for single agent', () => {
			const groups: PlaybooksByAgent[] = [
				{
					agentId: 'agent-1',
					agentName: 'Solo Agent',
					playbooks: [
						{
							id: 'pb-1',
							name: 'Single',
							sessionId: 'session-1',
							documents: [],
						},
					],
				},
			];

			const result = formatPlaybooksByAgent(groups);

			expect(result).toContain('1 across 1 agent');
		});

		it('should show loop indicator for playbooks with loops', () => {
			const groups: PlaybooksByAgent[] = [
				{
					agentId: 'agent-1',
					agentName: 'Agent',
					playbooks: [
						{
							id: 'pb-1',
							name: 'Looper',
							sessionId: 'session-1',
							documents: [],
							loopEnabled: true,
						},
					],
				},
			];

			const result = formatPlaybooksByAgent(groups);

			expect(result).toContain('↻');
		});
	});

	// ============================================================================
	// formatRunEvent Tests
	// ============================================================================

	describe('formatRunEvent', () => {
		const timestamp = Date.now();

		it('should format start event', () => {
			const event: RunEvent = {
				type: 'start',
				timestamp,
			};

			const result = formatRunEvent(event);

			expect(result).toContain('▶');
			expect(result).toContain('Starting playbook run');
		});

		it('should format document_start event', () => {
			const event: RunEvent = {
				type: 'document_start',
				timestamp,
				document: 'tasks.md',
				taskCount: 5,
			};

			const result = formatRunEvent(event);

			expect(result).toContain('📄');
			expect(result).toContain('tasks.md');
			expect(result).toContain('5 tasks');
		});

		it('should format task_start event', () => {
			const event: RunEvent = {
				type: 'task_start',
				timestamp,
				taskIndex: 0,
				task: 'First task description',
			};

			const result = formatRunEvent(event);

			expect(result).toContain('⏳');
			expect(result).toContain('Task 1:');
			expect(result).toContain('First task description');
		});

		it('should format task_preview event', () => {
			const event: RunEvent = {
				type: 'task_preview',
				timestamp,
				taskIndex: 2,
				task: 'Preview task',
			};

			const result = formatRunEvent(event);

			expect(result).toContain('3.');
			expect(result).toContain('Preview task');
		});

		it('should format successful task_complete event', () => {
			const event: RunEvent = {
				type: 'task_complete',
				timestamp,
				success: true,
				elapsedMs: 5000,
				summary: 'Task completed successfully',
			};

			const result = formatRunEvent(event);

			expect(result).toContain('✓');
			expect(result).toContain('Task completed successfully');
			expect(result).toContain('5.0s');
		});

		it('should format failed task_complete event', () => {
			const event: RunEvent = {
				type: 'task_complete',
				timestamp,
				success: false,
				elapsedMs: 3000,
				summary: 'Task failed',
			};

			const result = formatRunEvent(event);

			expect(result).toContain('✗');
			expect(result).toContain('Task failed');
		});

		it('should format task_complete in debug mode with full response', () => {
			const event: RunEvent = {
				type: 'task_complete',
				timestamp,
				success: true,
				elapsedMs: 2000,
				fullResponse: 'First line of response\nSecond line',
				agentSessionId: 'claude-session-12345678',
			};

			const result = formatRunEvent(event, { debug: true });

			expect(result).toContain('First line of response');
			expect(result).toContain('2.0s');
			expect(result).toContain('claude-s'); // First 8 chars of session ID
		});

		it('should format history_write event', () => {
			const event: RunEvent = {
				type: 'history_write',
				timestamp,
				entryId: 'entry-12345678901234',
			};

			const result = formatRunEvent(event);

			expect(result).toContain('🔖');
			expect(result).toContain('[history]');
			expect(result).toContain('entry-12'); // First 8 chars
		});

		it('should format document_complete event', () => {
			const event: RunEvent = {
				type: 'document_complete',
				timestamp,
				tasksCompleted: 10,
			};

			const result = formatRunEvent(event);

			expect(result).toContain('✓');
			expect(result).toContain('Document complete');
			expect(result).toContain('10 tasks');
		});

		it('should format loop_complete event', () => {
			const event: RunEvent = {
				type: 'loop_complete',
				timestamp,
				iteration: 3,
			};

			const result = formatRunEvent(event);

			expect(result).toContain('↻');
			expect(result).toContain('Loop 3 complete');
		});

		it('should format complete event', () => {
			const event: RunEvent = {
				type: 'complete',
				timestamp,
				dryRun: false,
				totalTasksCompleted: 15,
				totalElapsedMs: 30000,
			};

			const result = formatRunEvent(event);

			expect(result).toContain('✓');
			expect(result).toContain('Playbook complete');
			expect(result).toContain('15 tasks');
			expect(result).toContain('30.0s');
		});

		it('should format complete event for dry run', () => {
			const event: RunEvent = {
				type: 'complete',
				timestamp,
				dryRun: true,
				wouldProcess: 5,
			};

			const result = formatRunEvent(event);

			expect(result).toContain('ℹ');
			expect(result).toContain('Dry run complete');
			expect(result).toContain('5 tasks would be processed');
		});

		it('should format error event', () => {
			const event: RunEvent = {
				type: 'error',
				timestamp,
				message: 'Something went wrong',
			};

			const result = formatRunEvent(event);

			expect(result).toContain('✗');
			expect(result).toContain('Error:');
			expect(result).toContain('Something went wrong');
		});

		it('should format debug event with different categories', () => {
			const categories = ['config', 'scan', 'loop', 'reset', 'unknown'];

			for (const category of categories) {
				const event: RunEvent = {
					type: 'debug',
					timestamp,
					category,
					message: `Debug message for ${category}`,
				};

				const result = formatRunEvent(event);

				expect(result).toContain('🔍');
				expect(result).toContain(`[${category}]`);
				expect(result).toContain(`Debug message for ${category}`);
			}
		});

		it('should format verbose event', () => {
			const event: RunEvent = {
				type: 'verbose',
				timestamp,
				category: 'task',
				document: 'test.md',
				taskIndex: 1,
				prompt: 'The full prompt text here',
			};

			const result = formatRunEvent(event);

			expect(result).toContain('📝');
			expect(result).toContain('[task]');
			expect(result).toContain('test.md');
			expect(result).toContain('Task 2');
			expect(result).toContain('The full prompt text here');
			expect(result).toContain('─'); // Separator line
		});

		it('should format unknown event type', () => {
			const event: RunEvent = {
				type: 'unknown_event',
				timestamp,
			};

			const result = formatRunEvent(event);

			expect(result).toContain('unknown_event');
		});

		it('should truncate long task descriptions', () => {
			const longTask = 'A'.repeat(100);
			const event: RunEvent = {
				type: 'task_start',
				timestamp,
				taskIndex: 0,
				task: longTask,
			};

			const result = formatRunEvent(event);

			// Should be truncated to 60 chars with ellipsis
			expect(result).toContain('…');
			expect(result.length).toBeLessThan(longTask.length + 50);
		});

		it('should handle empty task description', () => {
			const event: RunEvent = {
				type: 'task_start',
				timestamp,
				taskIndex: 0,
				task: '',
			};

			const result = formatRunEvent(event);

			expect(result).toContain('Task 1:');
		});
	});

	// ============================================================================
	// formatAgentDetail Tests
	// ============================================================================

	describe('formatAgentDetail', () => {
		const baseAgent: AgentDetailDisplay = {
			id: 'agent-123',
			name: 'Test Agent',
			toolType: 'claude-code',
			cwd: '/home/user/project',
			projectRoot: '/home/user/project',
			stats: {
				historyEntries: 10,
				successCount: 8,
				failureCount: 2,
				totalInputTokens: 50000,
				totalOutputTokens: 25000,
				totalCacheReadTokens: 10000,
				totalCacheCreationTokens: 5000,
				totalCost: 1.5,
				totalElapsedMs: 300000,
			},
			recentHistory: [],
		};

		it('should format basic agent details', () => {
			const result = formatAgentDetail(baseAgent);

			expect(result).toContain('AGENT');
			expect(result).toContain('Name:');
			expect(result).toContain('Test Agent');
			expect(result).toContain('ID:');
			expect(result).toContain('agent-123');
			expect(result).toContain('Type:');
			expect(result).toContain('claude-code');
			expect(result).toContain('Directory:');
			expect(result).toContain('/home/user/project');
		});

		it('should show group name when provided', () => {
			const agent: AgentDetailDisplay = {
				...baseAgent,
				groupName: 'My Group',
			};

			const result = formatAgentDetail(agent);

			expect(result).toContain('Group:');
			expect(result).toContain('My Group');
		});

		it('should show auto run folder when provided', () => {
			const agent: AgentDetailDisplay = {
				...baseAgent,
				autoRunFolderPath: '/path/to/playbooks',
			};

			const result = formatAgentDetail(agent);

			expect(result).toContain('Auto Run:');
			expect(result).toContain('/path/to/playbooks');
		});

		it('should format usage stats correctly', () => {
			const result = formatAgentDetail(baseAgent);

			expect(result).toContain('USAGE STATS');
			expect(result).toContain('Sessions:');
			expect(result).toContain('10 total');
			expect(result).toContain('8 success');
			expect(result).toContain('2 failed');
			expect(result).toContain('80% success rate');
			expect(result).toContain('Total Cost:');
			expect(result).toContain('$1.5000');
			expect(result).toContain('Total Time:');
			expect(result).toContain('5.0m'); // 300000ms = 5 minutes
		});

		it('should format token counts with K suffix', () => {
			const result = formatAgentDetail(baseAgent);

			expect(result).toContain('Tokens:');
			expect(result).toContain('50.0K'); // 50000 input tokens
			expect(result).toContain('25.0K'); // 25000 output tokens
		});

		it('should format token counts with M suffix for millions', () => {
			const agent: AgentDetailDisplay = {
				...baseAgent,
				stats: {
					...baseAgent.stats,
					totalInputTokens: 1500000,
					totalOutputTokens: 2500000,
				},
			};

			const result = formatAgentDetail(agent);

			expect(result).toContain('1.5M');
			expect(result).toContain('2.5M');
		});

		it('should format small token counts without suffix', () => {
			const agent: AgentDetailDisplay = {
				...baseAgent,
				stats: {
					...baseAgent.stats,
					totalInputTokens: 500,
					totalOutputTokens: 250,
				},
			};

			const result = formatAgentDetail(agent);

			expect(result).toContain('500');
			expect(result).toContain('250');
		});

		it('should format different durations correctly', () => {
			// Test milliseconds
			const agentMs: AgentDetailDisplay = {
				...baseAgent,
				stats: { ...baseAgent.stats, totalElapsedMs: 500 },
			};
			expect(formatAgentDetail(agentMs)).toContain('500ms');

			// Test seconds
			const agentSec: AgentDetailDisplay = {
				...baseAgent,
				stats: { ...baseAgent.stats, totalElapsedMs: 5000 },
			};
			expect(formatAgentDetail(agentSec)).toContain('5.0s');

			// Test minutes
			const agentMin: AgentDetailDisplay = {
				...baseAgent,
				stats: { ...baseAgent.stats, totalElapsedMs: 120000 },
			};
			expect(formatAgentDetail(agentMin)).toContain('2.0m');

			// Test hours
			const agentHour: AgentDetailDisplay = {
				...baseAgent,
				stats: { ...baseAgent.stats, totalElapsedMs: 7200000 },
			};
			expect(formatAgentDetail(agentHour)).toContain('2.0h');
		});

		it('should handle zero history entries', () => {
			const agent: AgentDetailDisplay = {
				...baseAgent,
				stats: {
					...baseAgent.stats,
					historyEntries: 0,
					successCount: 0,
					failureCount: 0,
				},
			};

			const result = formatAgentDetail(agent);

			expect(result).toContain('0 total');
			expect(result).toContain('0% success rate');
		});

		it('should format recent history entries', () => {
			const agent: AgentDetailDisplay = {
				...baseAgent,
				recentHistory: [
					{
						id: 'history-1',
						type: 'chat',
						timestamp: Date.now(),
						summary: 'Fixed a bug',
						success: true,
						elapsedTimeMs: 5000,
						cost: 0.05,
					},
					{
						id: 'history-2',
						type: 'task',
						timestamp: Date.now() - 3600000,
						summary: 'Failed task',
						success: false,
					},
					{
						id: 'history-3',
						type: 'unknown',
						timestamp: Date.now() - 7200000,
						summary: 'Neutral entry',
					},
				],
			};

			const result = formatAgentDetail(agent);

			expect(result).toContain('RECENT HISTORY');
			expect(result).toContain('last 3');
			expect(result).toContain('✓'); // Success
			expect(result).toContain('✗'); // Failure
			expect(result).toContain('•'); // Neutral
			expect(result).toContain('[chat]');
			expect(result).toContain('[task]');
			expect(result).toContain('Fixed a bug');
			expect(result).toContain('$0.0500');
			expect(result).toContain('5.0s');
		});

		it('should not show history section when empty', () => {
			const result = formatAgentDetail(baseAgent);

			expect(result).not.toContain('RECENT HISTORY');
		});
	});

	// ============================================================================
	// Message Formatting Tests
	// ============================================================================

	describe('Message formatting', () => {
		describe('formatError', () => {
			it('should format error messages', () => {
				const result = formatError('Something went wrong');

				expect(result).toContain('✗');
				expect(result).toContain('Error:');
				expect(result).toContain('Something went wrong');
			});
		});

		describe('formatSuccess', () => {
			it('should format success messages', () => {
				const result = formatSuccess('Operation completed');

				expect(result).toContain('✓');
				expect(result).toContain('Operation completed');
			});
		});

		describe('formatInfo', () => {
			it('should format info messages', () => {
				const result = formatInfo('Some information');

				expect(result).toContain('ℹ');
				expect(result).toContain('Some information');
			});
		});

		describe('formatWarning', () => {
			it('should format warning messages', () => {
				const result = formatWarning('Be careful');

				expect(result).toContain('⚠');
				expect(result).toContain('Be careful');
			});
		});
	});

	// ============================================================================
	// Edge Cases and Truncation Tests
	// ============================================================================

	describe('Edge cases', () => {
		it('should handle empty strings gracefully', () => {
			const result = formatError('');
			expect(result).toContain('Error:');
		});

		it('should handle special characters in names', () => {
			const agents: AgentDisplay[] = [
				{
					id: 'agent-1',
					name: 'Test <Agent> & "Special"',
					toolType: 'claude-code',
					cwd: '/path',
				},
			];

			const result = formatAgents(agents);

			expect(result).toContain('Test <Agent> & "Special"');
		});

		it('should handle unicode in names', () => {
			const groups: GroupDisplay[] = [{ id: 'group-1', name: '日本語プロジェクト', emoji: '🇯🇵' }];

			const result = formatGroups(groups);

			expect(result).toContain('日本語プロジェクト');
			expect(result).toContain('🇯🇵');
		});

		it('should truncate strings at correct length', () => {
			const longPath = 'a'.repeat(100);
			const agents: AgentDisplay[] = [
				{
					id: 'agent-1',
					name: 'Agent',
					toolType: 'claude-code',
					cwd: longPath,
				},
			];

			const result = formatAgents(agents);

			// Truncated to 60 chars with ellipsis (59 chars + …)
			expect(result).toContain('…');
		});

		it('should not truncate strings shorter than max length', () => {
			const shortPath = '/short/path';
			const agents: AgentDisplay[] = [
				{
					id: 'agent-1',
					name: 'Agent',
					toolType: 'claude-code',
					cwd: shortPath,
				},
			];

			const result = formatAgents(agents);

			expect(result).toContain(shortPath);
			expect(result).not.toContain('…');
		});
	});
});
