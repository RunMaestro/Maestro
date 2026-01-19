/**
 * @file jsonl.test.ts
 * @description Tests for CLI JSONL output functions
 *
 * Tests all JSONL event emitters used for machine-parseable CLI output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	emitJsonl,
	emitError,
	emitStart,
	emitDocumentStart,
	emitTaskStart,
	emitTaskComplete,
	emitDocumentComplete,
	emitLoopComplete,
	emitComplete,
	emitGroup,
	emitAgent,
	emitPlaybook,
} from '../../../cli/output/jsonl';
import type { UsageStats } from '../../../shared/types';

describe('jsonl output', () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;
	let dateNowSpy: ReturnType<typeof vi.spyOn>;
	const mockTimestamp = 1702000000000;

	beforeEach(() => {
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(mockTimestamp);
	});

	afterEach(() => {
		consoleSpy.mockRestore();
		dateNowSpy.mockRestore();
	});

	describe('emitJsonl', () => {
		it('should emit a JSON line with timestamp', () => {
			emitJsonl({ type: 'test', data: 'value' });

			expect(consoleSpy).toHaveBeenCalledTimes(1);
			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('test');
			expect(parsed.data).toBe('value');
			expect(parsed.timestamp).toBe(mockTimestamp);
		});

		it('should emit valid JSON', () => {
			emitJsonl({ type: 'test', nested: { a: 1, b: [2, 3] } });

			const output = consoleSpy.mock.calls[0][0];
			expect(() => JSON.parse(output)).not.toThrow();
		});

		it('should handle special characters in values', () => {
			emitJsonl({ type: 'test', message: 'Hello "world"\nNew line\ttab' });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.message).toBe('Hello "world"\nNew line\ttab');
		});

		it('should preserve all event properties', () => {
			const event = {
				type: 'custom',
				stringProp: 'value',
				numberProp: 42,
				boolProp: true,
				nullProp: null,
				arrayProp: [1, 2, 3],
				objectProp: { nested: true },
			};

			emitJsonl(event);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('custom');
			expect(parsed.stringProp).toBe('value');
			expect(parsed.numberProp).toBe(42);
			expect(parsed.boolProp).toBe(true);
			expect(parsed.nullProp).toBe(null);
			expect(parsed.arrayProp).toEqual([1, 2, 3]);
			expect(parsed.objectProp).toEqual({ nested: true });
		});

		it('should add timestamp even if event already has one', () => {
			// The timestamp is always added with current Date.now()
			emitJsonl({ type: 'test', timestamp: 999 });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			// The new timestamp should override any existing one
			expect(parsed.timestamp).toBe(mockTimestamp);
		});
	});

	describe('emitError', () => {
		it('should emit error event with message', () => {
			emitError('Something went wrong');

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('error');
			expect(parsed.message).toBe('Something went wrong');
			expect(parsed.timestamp).toBe(mockTimestamp);
		});

		it('should emit error event with message and code', () => {
			emitError('Connection failed', 'ERR_CONNECTION');

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('error');
			expect(parsed.message).toBe('Connection failed');
			expect(parsed.code).toBe('ERR_CONNECTION');
		});

		it('should emit error event without code when not provided', () => {
			emitError('Simple error');

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('error');
			expect(parsed.message).toBe('Simple error');
			expect(parsed.code).toBeUndefined();
		});

		it('should handle empty error message', () => {
			emitError('');

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('error');
			expect(parsed.message).toBe('');
		});
	});

	describe('emitStart', () => {
		it('should emit start event with playbook and session info', () => {
			const playbook = { id: 'pb-123', name: 'Test Playbook' };
			const session = { id: 'sess-456', name: 'Test Session', cwd: '/path/to/project' };

			emitStart(playbook, session);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('start');
			expect(parsed.playbook).toEqual(playbook);
			expect(parsed.session).toEqual(session);
			expect(parsed.timestamp).toBe(mockTimestamp);
		});

		it('should handle complex paths in session cwd', () => {
			const playbook = { id: 'pb-1', name: 'PB' };
			const session = { id: 's-1', name: 'S', cwd: '/Users/dev/Projects/My App/src' };

			emitStart(playbook, session);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.session.cwd).toBe('/Users/dev/Projects/My App/src');
		});
	});

	describe('emitDocumentStart', () => {
		it('should emit document start event', () => {
			emitDocumentStart('README.md', 0, 5);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('document_start');
			expect(parsed.document).toBe('README.md');
			expect(parsed.index).toBe(0);
			expect(parsed.taskCount).toBe(5);
			expect(parsed.timestamp).toBe(mockTimestamp);
		});

		it('should handle zero task count', () => {
			emitDocumentStart('empty.md', 3, 0);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.taskCount).toBe(0);
		});

		it('should handle nested document paths', () => {
			emitDocumentStart('docs/setup/README.md', 2, 10);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.document).toBe('docs/setup/README.md');
		});
	});

	describe('emitTaskStart', () => {
		it('should emit task start event', () => {
			emitTaskStart('README.md', 0);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('task_start');
			expect(parsed.document).toBe('README.md');
			expect(parsed.taskIndex).toBe(0);
			expect(parsed.timestamp).toBe(mockTimestamp);
		});

		it('should handle large task indices', () => {
			emitTaskStart('large.md', 999);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.taskIndex).toBe(999);
		});
	});

	describe('emitTaskComplete', () => {
		it('should emit task complete event with success', () => {
			emitTaskComplete('README.md', 0, true, 'Task completed successfully', 1500);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('task_complete');
			expect(parsed.document).toBe('README.md');
			expect(parsed.taskIndex).toBe(0);
			expect(parsed.success).toBe(true);
			expect(parsed.summary).toBe('Task completed successfully');
			expect(parsed.elapsedMs).toBe(1500);
			expect(parsed.timestamp).toBe(mockTimestamp);
		});

		it('should emit task complete event with failure', () => {
			emitTaskComplete('README.md', 1, false, 'Task failed', 500);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.success).toBe(false);
			expect(parsed.summary).toBe('Task failed');
		});

		it('should include optional fullResponse', () => {
			emitTaskComplete('README.md', 0, true, 'Done', 1000, {
				fullResponse: 'This is the full response from the agent.',
			});

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.fullResponse).toBe('This is the full response from the agent.');
		});

		it('should include optional usageStats', () => {
			const usageStats: UsageStats = {
				inputTokens: 100,
				outputTokens: 200,
				totalCost: 0.05,
			};

			emitTaskComplete('README.md', 0, true, 'Done', 1000, { usageStats });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.usageStats).toEqual(usageStats);
		});

		it('should include optional agentSessionId', () => {
			emitTaskComplete('README.md', 0, true, 'Done', 1000, {
				agentSessionId: 'claude-sess-abc123',
			});

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.agentSessionId).toBe('claude-sess-abc123');
		});

		it('should include all optional fields together', () => {
			const usageStats: UsageStats = {
				inputTokens: 50,
				outputTokens: 100,
				totalCost: 0.02,
			};

			emitTaskComplete('README.md', 0, true, 'All done', 2000, {
				fullResponse: 'Full response here',
				usageStats,
				agentSessionId: 'sess-xyz',
			});

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.fullResponse).toBe('Full response here');
			expect(parsed.usageStats).toEqual(usageStats);
			expect(parsed.agentSessionId).toBe('sess-xyz');
		});

		it('should work without optional fields', () => {
			emitTaskComplete('doc.md', 2, true, 'OK', 500);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.fullResponse).toBeUndefined();
			expect(parsed.usageStats).toBeUndefined();
			expect(parsed.agentSessionId).toBeUndefined();
		});
	});

	describe('emitDocumentComplete', () => {
		it('should emit document complete event', () => {
			emitDocumentComplete('README.md', 5);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('document_complete');
			expect(parsed.document).toBe('README.md');
			expect(parsed.tasksCompleted).toBe(5);
			expect(parsed.timestamp).toBe(mockTimestamp);
		});

		it('should handle zero completed tasks', () => {
			emitDocumentComplete('empty.md', 0);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.tasksCompleted).toBe(0);
		});
	});

	describe('emitLoopComplete', () => {
		it('should emit loop complete event without usage stats', () => {
			emitLoopComplete(1, 10, 5000);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('loop_complete');
			expect(parsed.iteration).toBe(1);
			expect(parsed.tasksCompleted).toBe(10);
			expect(parsed.elapsedMs).toBe(5000);
			expect(parsed.timestamp).toBe(mockTimestamp);
			expect(parsed.usageStats).toBeUndefined();
		});

		it('should emit loop complete event with usage stats', () => {
			const usageStats: UsageStats = {
				inputTokens: 1000,
				outputTokens: 2000,
				totalCost: 0.5,
			};

			emitLoopComplete(3, 15, 10000, usageStats);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.iteration).toBe(3);
			expect(parsed.usageStats).toEqual(usageStats);
		});

		it('should handle first iteration (0)', () => {
			emitLoopComplete(0, 5, 2000);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.iteration).toBe(0);
		});
	});

	describe('emitComplete', () => {
		it('should emit complete event with success', () => {
			emitComplete(true, 20, 60000);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('complete');
			expect(parsed.success).toBe(true);
			expect(parsed.totalTasksCompleted).toBe(20);
			expect(parsed.totalElapsedMs).toBe(60000);
			expect(parsed.timestamp).toBe(mockTimestamp);
			expect(parsed.totalCost).toBeUndefined();
		});

		it('should emit complete event with failure', () => {
			emitComplete(false, 5, 10000);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.success).toBe(false);
			expect(parsed.totalTasksCompleted).toBe(5);
		});

		it('should emit complete event with total cost', () => {
			emitComplete(true, 100, 300000, 15.5);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.success).toBe(true);
			expect(parsed.totalCost).toBe(15.5);
		});

		it('should handle zero tasks completed', () => {
			emitComplete(false, 0, 1000);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.totalTasksCompleted).toBe(0);
		});

		it('should handle zero cost', () => {
			emitComplete(true, 1, 1000, 0);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.totalCost).toBe(0);
		});
	});

	describe('emitGroup', () => {
		it('should emit group event', () => {
			const group = {
				id: 'group-123',
				name: 'My Group',
				emoji: '🚀',
				collapsed: false,
			};

			emitGroup(group);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('group');
			expect(parsed.id).toBe('group-123');
			expect(parsed.name).toBe('My Group');
			expect(parsed.emoji).toBe('🚀');
			expect(parsed.collapsed).toBe(false);
			expect(parsed.timestamp).toBe(mockTimestamp);
		});

		it('should emit collapsed group', () => {
			const group = {
				id: 'group-456',
				name: 'Collapsed Group',
				emoji: '📁',
				collapsed: true,
			};

			emitGroup(group);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.collapsed).toBe(true);
		});

		it('should handle empty emoji', () => {
			const group = {
				id: 'group-789',
				name: 'No Emoji Group',
				emoji: '',
				collapsed: false,
			};

			emitGroup(group);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.emoji).toBe('');
		});
	});

	describe('emitAgent', () => {
		it('should emit agent event with required fields', () => {
			const agent = {
				id: 'agent-123',
				name: 'Test Agent',
				toolType: 'claude-code',
				cwd: '/path/to/project',
			};

			emitAgent(agent);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('agent');
			expect(parsed.id).toBe('agent-123');
			expect(parsed.name).toBe('Test Agent');
			expect(parsed.toolType).toBe('claude-code');
			expect(parsed.cwd).toBe('/path/to/project');
			expect(parsed.timestamp).toBe(mockTimestamp);
		});

		it('should emit agent event with groupId', () => {
			const agent = {
				id: 'agent-456',
				name: 'Grouped Agent',
				toolType: 'aider',
				cwd: '/path',
				groupId: 'group-123',
			};

			emitAgent(agent);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.groupId).toBe('group-123');
		});

		it('should emit agent event with autoRunFolderPath', () => {
			const agent = {
				id: 'agent-789',
				name: 'Auto Run Agent',
				toolType: 'claude-code',
				cwd: '/project',
				autoRunFolderPath: '/project/playbooks',
			};

			emitAgent(agent);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.autoRunFolderPath).toBe('/project/playbooks');
		});

		it('should emit agent event with all optional fields', () => {
			const agent = {
				id: 'agent-full',
				name: 'Full Agent',
				toolType: 'terminal',
				cwd: '/home/user/project',
				groupId: 'dev-group',
				autoRunFolderPath: '/home/user/project/auto',
			};

			emitAgent(agent);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.groupId).toBe('dev-group');
			expect(parsed.autoRunFolderPath).toBe('/home/user/project/auto');
		});

		it('should handle different tool types', () => {
			const toolTypes = ['claude-code', 'aider', 'terminal', 'gemini-cli', 'qwen3-coder'];

			toolTypes.forEach((toolType, index) => {
				consoleSpy.mockClear();
				emitAgent({
					id: `agent-${index}`,
					name: `Agent ${index}`,
					toolType,
					cwd: '/path',
				});

				const output = consoleSpy.mock.calls[0][0];
				const parsed = JSON.parse(output);
				expect(parsed.toolType).toBe(toolType);
			});
		});
	});

	describe('emitPlaybook', () => {
		it('should emit playbook event without loop', () => {
			const playbook = {
				id: 'pb-123',
				name: 'Test Playbook',
				sessionId: 'sess-456',
				documents: ['doc1.md', 'doc2.md'],
				loopEnabled: false,
			};

			emitPlaybook(playbook);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.type).toBe('playbook');
			expect(parsed.id).toBe('pb-123');
			expect(parsed.name).toBe('Test Playbook');
			expect(parsed.sessionId).toBe('sess-456');
			expect(parsed.documents).toEqual(['doc1.md', 'doc2.md']);
			expect(parsed.loopEnabled).toBe(false);
			expect(parsed.timestamp).toBe(mockTimestamp);
		});

		it('should emit playbook event with loop enabled and max loops', () => {
			const playbook = {
				id: 'pb-loop',
				name: 'Loop Playbook',
				sessionId: 'sess-789',
				documents: ['task.md'],
				loopEnabled: true,
				maxLoops: 5,
			};

			emitPlaybook(playbook);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.loopEnabled).toBe(true);
			expect(parsed.maxLoops).toBe(5);
		});

		it('should emit playbook event with infinite loop (maxLoops null)', () => {
			const playbook = {
				id: 'pb-infinite',
				name: 'Infinite Playbook',
				sessionId: 'sess-inf',
				documents: ['infinite.md'],
				loopEnabled: true,
				maxLoops: null,
			};

			emitPlaybook(playbook);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.loopEnabled).toBe(true);
			expect(parsed.maxLoops).toBe(null);
		});

		it('should handle empty documents array', () => {
			const playbook = {
				id: 'pb-empty',
				name: 'Empty Playbook',
				sessionId: 'sess-e',
				documents: [],
				loopEnabled: false,
			};

			emitPlaybook(playbook);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.documents).toEqual([]);
		});

		it('should handle many documents', () => {
			const documents = Array.from({ length: 100 }, (_, i) => `doc${i}.md`);
			const playbook = {
				id: 'pb-many',
				name: 'Many Docs Playbook',
				sessionId: 'sess-m',
				documents,
				loopEnabled: false,
			};

			emitPlaybook(playbook);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.documents).toHaveLength(100);
			expect(parsed.documents[0]).toBe('doc0.md');
			expect(parsed.documents[99]).toBe('doc99.md');
		});
	});

	describe('JSON output format', () => {
		it('should output single line JSON (no newlines in output)', () => {
			emitJsonl({ type: 'test', data: 'multiline\nvalue' });

			const output = consoleSpy.mock.calls[0][0];
			// The output itself should be a single line (newline is inside the JSON string)
			expect(output.split('\n')).toHaveLength(1);
		});

		it('should produce parseable JSON for all event types', () => {
			const events = [
				() => emitError('error'),
				() => emitStart({ id: 'p1', name: 'p' }, { id: 's1', name: 's', cwd: '/' }),
				() => emitDocumentStart('doc', 0, 1),
				() => emitTaskStart('doc', 0),
				() => emitTaskComplete('doc', 0, true, 'ok', 100),
				() => emitDocumentComplete('doc', 1),
				() => emitLoopComplete(1, 1, 100),
				() => emitComplete(true, 1, 100),
				() => emitGroup({ id: 'g1', name: 'g', emoji: '', collapsed: false }),
				() => emitAgent({ id: 'a1', name: 'a', toolType: 't', cwd: '/' }),
				() =>
					emitPlaybook({ id: 'p1', name: 'p', sessionId: 's1', documents: [], loopEnabled: false }),
			];

			events.forEach((emitFn, index) => {
				consoleSpy.mockClear();
				emitFn();
				const output = consoleSpy.mock.calls[0][0];
				expect(
					() => JSON.parse(output),
					`Event at index ${index} should produce valid JSON`
				).not.toThrow();
			});
		});
	});

	describe('edge cases', () => {
		it('should handle unicode characters', () => {
			emitError('错误: 发生了问题 🔥');

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.message).toBe('错误: 发生了问题 🔥');
		});

		it('should handle very long strings', () => {
			const longString = 'a'.repeat(10000);
			emitError(longString);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.message).toBe(longString);
		});

		it('should handle special JSON characters in strings', () => {
			emitError('Backslash: \\ Quote: " Tab: \t Newline: \n');

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.message).toContain('\\');
			expect(parsed.message).toContain('"');
			expect(parsed.message).toContain('\t');
			expect(parsed.message).toContain('\n');
		});

		it('should handle negative numbers', () => {
			// This tests that negative numbers are properly serialized
			emitTaskComplete('doc', -1, true, 'ok', -100);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.taskIndex).toBe(-1);
			expect(parsed.elapsedMs).toBe(-100);
		});

		it('should handle floating point numbers', () => {
			emitComplete(true, 10, 1000, 0.123456789);

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);

			expect(parsed.totalCost).toBe(0.123456789);
		});
	});
});
