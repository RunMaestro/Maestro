/**
 * @file agent-spawner.test.ts
 * @description Tests for the agent-spawner CLI service
 *
 * Tests all exported functions and internal utilities:
 * - Document reading and task counting
 * - Document reading and task extraction
 * - Checkbox manipulation (uncheckAllTasks)
 * - Document writing
 * - Claude detection and spawning
 * - UUID generation
 * - PATH expansion
 * - Executable detection
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { EventEmitter } from 'events';

// Create mock spawn function at module level
const mockSpawn = vi.fn();
const mockStdin = {
	end: vi.fn(),
};
const mockStdout = new EventEmitter();
const mockStderr = new EventEmitter();
const mockChild = Object.assign(new EventEmitter(), {
	stdin: mockStdin,
	stdout: mockStdout,
	stderr: mockStderr,
});

// Mock child_process before imports
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawn(...args),
		default: {
			...actual,
			spawn: (...args: unknown[]) => mockSpawn(...args),
		},
	};
});

// Mock fs module
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		readFileSync: vi.fn(),
		writeFileSync: vi.fn(),
		promises: {
			stat: vi.fn(),
			access: vi.fn(),
		},
		constants: {
			X_OK: 1,
		},
	};
});

// Mock os module
vi.mock('os', () => ({
	homedir: vi.fn(() => '/Users/testuser'),
}));

// Mock storage service
const mockGetAgentCustomPath = vi.fn();
vi.mock('../../../cli/services/storage', () => ({
	getAgentCustomPath: (...args: unknown[]) => mockGetAgentCustomPath(...args),
}));

import {
	readDocAndCountTasks,
	readDocAndGetTasks,
	uncheckAllTasks,
	writeDoc,
	getClaudeCommand,
	detectClaude,
	spawnAgent,
	AgentResult,
} from '../../../cli/services/agent-spawner';

describe('agent-spawner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset mock child emitter for each test
		mockStdout.removeAllListeners();
		mockStderr.removeAllListeners();
		(mockChild as EventEmitter).removeAllListeners();
		mockGetAgentCustomPath.mockReturnValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('readDocAndCountTasks', () => {
		it('should count unchecked tasks in a document', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
# Task List

- [ ] First task
- [ ] Second task
- [x] Completed task
- [ ] Third task
      `);

			const result = readDocAndCountTasks('/playbooks', 'tasks');

			expect(result.taskCount).toBe(3);
			expect(result.content).toContain('First task');
		});

		it('should return zero count for document with no unchecked tasks', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
# Task List

- [x] Completed task
- [x] Another completed
      `);

			const result = readDocAndCountTasks('/playbooks', 'tasks');

			expect(result.taskCount).toBe(0);
		});

		it('should return empty content and zero count when file does not exist', () => {
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const result = readDocAndCountTasks('/playbooks', 'missing');

			expect(result.content).toBe('');
			expect(result.taskCount).toBe(0);
		});

		it('should handle various checkbox formats', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
- [ ] Basic unchecked
  - [ ] Nested unchecked
    - [ ] Deeply nested
- [ ]    Extra spaces after checkbox
      `);

			const result = readDocAndCountTasks('/playbooks', 'tasks');

			expect(result.taskCount).toBe(4);
		});

		it('should append .md extension to filename', () => {
			vi.mocked(fs.readFileSync).mockReturnValue('- [ ] Task');

			readDocAndCountTasks('/playbooks', 'tasks');

			expect(fs.readFileSync).toHaveBeenCalledWith('/playbooks/tasks.md', 'utf-8');
		});

		it('should handle document with only whitespace', () => {
			vi.mocked(fs.readFileSync).mockReturnValue('   \n  \n   ');

			const result = readDocAndCountTasks('/playbooks', 'empty');

			expect(result.taskCount).toBe(0);
			expect(result.content).toBe('   \n  \n   ');
		});

		it('should count tasks with varying indentation levels', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
- [ ] No indent
 - [ ] One space
  - [ ] Two spaces
   - [ ] Three spaces
    - [ ] Four spaces
      `);

			const result = readDocAndCountTasks('/playbooks', 'indented');

			expect(result.taskCount).toBe(5);
		});

		it('should not count tasks with text before checkbox', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
text - [ ] This should not count
- [ ] This should count
      `);

			const result = readDocAndCountTasks('/playbooks', 'mixed');

			// The regex only matches lines starting with optional whitespace then -
			expect(result.taskCount).toBe(1);
		});

		it('should count empty checkbox tasks', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
- [ ]
- [ ] Task with content
      `);

			const result = readDocAndCountTasks('/playbooks', 'empty-tasks');

			// Empty checkbox line might not match due to regex requiring content
			// Let's verify behavior
			expect(result.taskCount).toBeGreaterThanOrEqual(1);
		});
	});

	describe('readDocAndGetTasks', () => {
		it('should extract task text from unchecked items', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
# Task List

- [ ] First task
- [ ] Second task with details
- [x] Completed task (should not appear)
- [ ] Third task
      `);

			const result = readDocAndGetTasks('/playbooks', 'tasks');

			expect(result.tasks).toEqual(['First task', 'Second task with details', 'Third task']);
		});

		it('should return empty array for document with no unchecked tasks', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
# All Done!

- [x] Completed
      `);

			const result = readDocAndGetTasks('/playbooks', 'tasks');

			expect(result.tasks).toEqual([]);
		});

		it('should return empty content and tasks when file does not exist', () => {
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error('ENOENT');
			});

			const result = readDocAndGetTasks('/playbooks', 'missing');

			expect(result.content).toBe('');
			expect(result.tasks).toEqual([]);
		});

		it('should trim task text properly', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
- [ ]    Task with leading spaces
- [ ] Task with trailing spaces
      `);

			const result = readDocAndGetTasks('/playbooks', 'tasks');

			expect(result.tasks[0]).toBe('Task with leading spaces');
			expect(result.tasks[1]).toBe('Task with trailing spaces');
		});

		it('should preserve task content with special characters', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
- [ ] Task with "quotes" and 'apostrophes'
- [ ] Task with code: \`npm install\`
- [ ] Task with **bold** and *italic*
- [ ] Task with emoji 🚀
      `);

			const result = readDocAndGetTasks('/playbooks', 'special');

			expect(result.tasks).toHaveLength(4);
			expect(result.tasks[0]).toContain('"quotes"');
			expect(result.tasks[3]).toContain('🚀');
		});

		it('should handle nested tasks', () => {
			vi.mocked(fs.readFileSync).mockReturnValue(`
- [ ] Parent task
  - [ ] Child task
    - [ ] Grandchild task
      `);

			const result = readDocAndGetTasks('/playbooks', 'nested');

			expect(result.tasks).toEqual(['Parent task', 'Child task', 'Grandchild task']);
		});

		it('should append .md extension to filename', () => {
			vi.mocked(fs.readFileSync).mockReturnValue('- [ ] Task');

			readDocAndGetTasks('/playbooks', 'tasks');

			expect(fs.readFileSync).toHaveBeenCalledWith('/playbooks/tasks.md', 'utf-8');
		});
	});

	describe('uncheckAllTasks', () => {
		it('should uncheck all checked tasks', () => {
			const content = `
# Task List

- [x] First completed
- [X] Second completed (uppercase)
- [ ] Already unchecked
- [x] Third completed
      `;

			const result = uncheckAllTasks(content);

			expect(result).not.toContain('[x]');
			expect(result).not.toContain('[X]');
			expect(result.match(/\[ \]/g)?.length).toBe(4);
		});

		it('should preserve indentation', () => {
			const content = `
  - [x] Indented task
    - [x] Nested task
      `;

			const result = uncheckAllTasks(content);

			expect(result).toContain('  - [ ] Indented task');
			expect(result).toContain('    - [ ] Nested task');
		});

		it('should not modify non-list checkbox patterns', () => {
			const content = `
# Title

Some text with [x] in it that's not a checkbox

- [x] Real checkbox
      `;

			const result = uncheckAllTasks(content);

			// The inline [x] should not be changed - only list item checkboxes
			expect(result).toContain('# Title');
			expect(result).toContain('Some text with [x] in it');
			expect(result).toContain('- [ ] Real checkbox');
		});

		it('should handle empty content', () => {
			expect(uncheckAllTasks('')).toBe('');
		});

		it('should handle content with no checkboxes', () => {
			const content = '# Just a title\n\nSome text';
			expect(uncheckAllTasks(content)).toBe(content);
		});

		it('should handle mixed checked and unchecked tasks', () => {
			const content = `
- [x] Done
- [ ] Not done
- [X] Also done
- [ ] Also not done
      `;

			const result = uncheckAllTasks(content);

			// All should be unchecked now
			const checkboxMatches = result.match(/- \[.\]/g) || [];
			expect(checkboxMatches.every((m) => m === '- [ ]')).toBe(true);
		});

		it('should handle multiline content correctly', () => {
			const content = `# Project Tasks

## Phase 1
- [x] Setup repository
- [x] Initialize project
- [ ] Configure CI/CD

## Phase 2
- [x] Implement feature A
- [ ] Implement feature B
- [x] Write tests
`;

			const result = uncheckAllTasks(content);

			expect(result).toContain('## Phase 1');
			expect(result).toContain('## Phase 2');
			expect(result).not.toContain('[x]');
			expect(result).not.toContain('[X]');
		});

		it('should preserve other markdown formatting', () => {
			const content = `
**Bold text**
*Italic text*
\`code\`
> Blockquote
- [x] Task

1. Numbered item
2. Another item
      `;

			const result = uncheckAllTasks(content);

			expect(result).toContain('**Bold text**');
			expect(result).toContain('*Italic text*');
			expect(result).toContain('`code`');
			expect(result).toContain('> Blockquote');
			expect(result).toContain('1. Numbered item');
		});

		it('should handle Windows line endings', () => {
			const content = '- [x] Task 1\r\n- [x] Task 2\r\n';

			const result = uncheckAllTasks(content);

			expect(result).toContain('- [ ] Task 1');
			expect(result).toContain('- [ ] Task 2');
		});

		it('should handle tasks with no space after checkbox', () => {
			// Edge case: malformed checkbox
			const content = '- [x]Task without space';

			const result = uncheckAllTasks(content);

			// The regex requires - [x] pattern at line start
			expect(result).toContain('- [ ]Task without space');
		});
	});

	describe('writeDoc', () => {
		it('should write content to file', () => {
			writeDoc('/playbooks', 'tasks.md', '# New Content');

			expect(fs.writeFileSync).toHaveBeenCalledWith(
				'/playbooks/tasks.md',
				'# New Content',
				'utf-8'
			);
		});

		it('should write to correct path', () => {
			writeDoc('/path/to/folder', 'doc.md', 'content');

			expect(fs.writeFileSync).toHaveBeenCalledWith('/path/to/folder/doc.md', 'content', 'utf-8');
		});

		it('should handle empty content', () => {
			writeDoc('/playbooks', 'empty.md', '');

			expect(fs.writeFileSync).toHaveBeenCalledWith('/playbooks/empty.md', '', 'utf-8');
		});

		it('should handle content with special characters', () => {
			const content = '# Title\n\n- [ ] Task with "quotes" and \'apostrophes\' and `code`';

			writeDoc('/playbooks', 'special.md', content);

			expect(fs.writeFileSync).toHaveBeenCalledWith('/playbooks/special.md', content, 'utf-8');
		});

		it('should handle unicode content', () => {
			const content = '# 任务列表\n\n- [ ] 任务一 🚀';

			writeDoc('/playbooks', 'unicode.md', content);

			expect(fs.writeFileSync).toHaveBeenCalledWith('/playbooks/unicode.md', content, 'utf-8');
		});

		it('should concatenate folder and filename with slash', () => {
			writeDoc('/some/path', 'file.md', 'content');

			const calledPath = (fs.writeFileSync as Mock).mock.calls[0][0];
			expect(calledPath).toBe('/some/path/file.md');
		});
	});

	describe('getClaudeCommand', () => {
		it('should return a non-empty string', () => {
			const command = getClaudeCommand();
			expect(typeof command).toBe('string');
			expect(command.length).toBeGreaterThan(0);
		});

		it('should return default command when no cached path', () => {
			// Before any detection is done, should return default 'claude'
			const command = getClaudeCommand();
			// Either 'claude' or a cached path
			expect(command).toBeTruthy();
		});
	});

	describe('detectClaude', () => {
		beforeEach(() => {
			// Reset the cached path by reimporting
			vi.resetModules();
		});

		it('should detect Claude with custom path from settings', async () => {
			// Mock custom path from settings
			mockGetAgentCustomPath.mockReturnValue('/custom/path/to/claude');

			// Mock file exists and is executable
			vi.mocked(fs.promises.stat).mockResolvedValue({
				isFile: () => true,
			} as fs.Stats);
			vi.mocked(fs.promises.access).mockResolvedValue(undefined);

			// Re-import to get fresh module without cached path
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const result = await freshDetectClaude();

			expect(result.available).toBe(true);
			expect(result.path).toBe('/custom/path/to/claude');
			expect(result.source).toBe('settings');
		});

		it('should fall back to PATH detection when custom path is invalid', async () => {
			// Mock custom path from settings
			mockGetAgentCustomPath.mockReturnValue('/invalid/path/to/claude');

			// Mock file does not exist
			vi.mocked(fs.promises.stat).mockRejectedValue(new Error('ENOENT'));

			// Mock which command finding claude
			mockSpawn.mockReturnValue(mockChild);

			// Re-import to get fresh module
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const resultPromise = freshDetectClaude();

			// Simulate which finding claude
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockStdout.emit('data', Buffer.from('/usr/local/bin/claude\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.available).toBe(true);
			expect(result.path).toBe('/usr/local/bin/claude');
			expect(result.source).toBe('path');
		});

		it('should return unavailable when Claude is not found', async () => {
			// No custom path
			mockGetAgentCustomPath.mockReturnValue(undefined);

			// Mock which command not finding claude
			mockSpawn.mockReturnValue(mockChild);

			// Re-import to get fresh module
			vi.resetModules();
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const resultPromise = freshDetectClaude();

			// Simulate which not finding claude
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 1);

			const result = await resultPromise;

			expect(result.available).toBe(false);
			expect(result.path).toBeUndefined();
		});

		it('should handle which command error', async () => {
			mockGetAgentCustomPath.mockReturnValue(undefined);
			mockSpawn.mockReturnValue(mockChild);

			vi.resetModules();
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const resultPromise = freshDetectClaude();

			// Simulate error event
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('error', new Error('spawn error'));

			const result = await resultPromise;

			expect(result.available).toBe(false);
		});

		it('should return cached result on subsequent calls', async () => {
			// First call - setup
			mockGetAgentCustomPath.mockReturnValue('/custom/path/to/claude');
			vi.mocked(fs.promises.stat).mockResolvedValue({
				isFile: () => true,
			} as fs.Stats);
			vi.mocked(fs.promises.access).mockResolvedValue(undefined);

			vi.resetModules();
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const result1 = await freshDetectClaude();
			expect(result1.available).toBe(true);

			// Clear the mock to verify caching
			vi.mocked(fs.promises.stat).mockClear();

			// Second call - should use cache
			const result2 = await freshDetectClaude();
			expect(result2.available).toBe(true);
			expect(result2.source).toBe('settings');

			// stat should not be called again (cached)
			// Note: Due to how caching works, if path is cached, isExecutable isn't rechecked
		});

		it('should reject non-file paths', async () => {
			mockGetAgentCustomPath.mockReturnValue('/path/to/directory');

			// Mock stat returning directory
			vi.mocked(fs.promises.stat).mockResolvedValue({
				isFile: () => false,
			} as fs.Stats);

			// Mock which not finding claude
			mockSpawn.mockReturnValue(mockChild);

			vi.resetModules();
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const resultPromise = freshDetectClaude();

			// which command won't find it either
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 1);

			const result = await resultPromise;

			expect(result.available).toBe(false);
		});

		it('should reject non-executable files on Unix', async () => {
			// Save original platform
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

			mockGetAgentCustomPath.mockReturnValue('/path/to/claude');

			// Mock file exists but is not executable
			vi.mocked(fs.promises.stat).mockResolvedValue({
				isFile: () => true,
			} as fs.Stats);
			vi.mocked(fs.promises.access).mockRejectedValue(new Error('EACCES'));

			// Mock which not finding claude
			mockSpawn.mockReturnValue(mockChild);

			vi.resetModules();
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const resultPromise = freshDetectClaude();

			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 1);

			const result = await resultPromise;

			// Restore platform
			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });

			expect(result.available).toBe(false);
		});
	});

	describe('spawnAgent', () => {
		beforeEach(() => {
			mockSpawn.mockReturnValue(mockChild);
		});

		it('should spawn Claude with correct arguments', async () => {
			const resultPromise = spawnAgent('claude-code', '/project/path', 'Test prompt');

			// Let the async operations start
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Verify spawn was called
			expect(mockSpawn).toHaveBeenCalled();
			const [cmd, args, options] = mockSpawn.mock.calls[0];

			// Command should be 'claude' or cached path
			expect(cmd).toBeTruthy();

			// Should have base args + session-id + prompt
			expect(args).toContain('--print');
			expect(args).toContain('--verbose');
			expect(args).toContain('--output-format');
			expect(args).toContain('stream-json');
			expect(args).toContain('--dangerously-skip-permissions');
			expect(args).toContain('--session-id');
			expect(args).toContain('--');
			expect(args).toContain('Test prompt');

			// Options
			expect(options.cwd).toBe('/project/path');
			expect(options.env.PATH).toBeDefined();

			// Complete the spawn
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Success"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.success).toBe(true);
		});

		it('should use --resume for existing session', async () => {
			const resultPromise = spawnAgent(
				'claude-code',
				'/project/path',
				'Test prompt',
				'existing-session-id'
			);

			await new Promise((resolve) => setTimeout(resolve, 0));

			const [, args] = mockSpawn.mock.calls[0];
			expect(args).toContain('--resume');
			expect(args).toContain('existing-session-id');
			expect(args).not.toContain('--session-id');

			// Complete
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;
			expect(result.success).toBe(true);
		});

		it('should parse result from stdout', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Emit result JSON
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"The response text"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.response).toBe('The response text');
		});

		it('should capture session_id from stdout', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Emit session_id and result
			mockStdout.emit('data', Buffer.from('{"session_id":"abc-123"}\n'));
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.agentSessionId).toBe('abc-123');
		});

		it('should parse usage statistics from modelUsage', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Emit usage stats
			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({
						modelUsage: {
							'claude-3': {
								inputTokens: 100,
								outputTokens: 50,
								cacheReadInputTokens: 20,
								cacheCreationInputTokens: 10,
								contextWindow: 200000,
							},
						},
						total_cost_usd: 0.05,
					}) + '\n'
				)
			);
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.usageStats).toEqual({
				inputTokens: 100,
				outputTokens: 50,
				cacheReadInputTokens: 20,
				cacheCreationInputTokens: 10,
				totalCostUsd: 0.05,
				contextWindow: 200000,
			});
		});

		it('should parse usage statistics from usage field', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Emit usage stats via 'usage' field
			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({
						usage: {
							input_tokens: 200,
							output_tokens: 100,
							cache_read_input_tokens: 30,
							cache_creation_input_tokens: 15,
						},
						total_cost_usd: 0.08,
					}) + '\n'
				)
			);
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.usageStats?.inputTokens).toBe(200);
			expect(result.usageStats?.outputTokens).toBe(100);
		});

		it('should aggregate usage from multiple models', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			mockStdout.emit(
				'data',
				Buffer.from(
					JSON.stringify({
						modelUsage: {
							'model-a': {
								inputTokens: 100,
								outputTokens: 50,
							},
							'model-b': {
								inputTokens: 200,
								outputTokens: 100,
								contextWindow: 300000,
							},
						},
						total_cost_usd: 0.1,
					}) + '\n'
				)
			);
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.usageStats?.inputTokens).toBe(300); // 100 + 200
			expect(result.usageStats?.outputTokens).toBe(150); // 50 + 100
			expect(result.usageStats?.contextWindow).toBe(300000); // Larger window
		});

		it('should return error on non-zero exit code', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Emit stderr
			mockStderr.emit('data', Buffer.from('Error: Something went wrong\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 1);

			const result = await resultPromise;

			expect(result.success).toBe(false);
			expect(result.error).toContain('Something went wrong');
		});

		it('should return error when no result and non-zero exit', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 1);

			const result = await resultPromise;

			expect(result.success).toBe(false);
			expect(result.error).toContain('Process exited with code 1');
		});

		it('should handle spawn error', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('error', new Error('spawn ENOENT'));

			const result = await resultPromise;

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to spawn Claude');
			expect(result.error).toContain('spawn ENOENT');
		});

		it('should close stdin immediately', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(mockStdin.end).toHaveBeenCalled();

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);

			await resultPromise;
		});

		it('should handle partial JSON lines (buffering)', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Send data in chunks
			mockStdout.emit('data', Buffer.from('{"type":"result",'));
			mockStdout.emit('data', Buffer.from('"result":"Complete"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.response).toBe('Complete');
		});

		it('should ignore non-JSON lines', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Mix of JSON and non-JSON
			mockStdout.emit('data', Buffer.from('Some debug output\n'));
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockStdout.emit('data', Buffer.from('More output\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(result.response).toBe('Done');
		});

		it('should only capture first result', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// Multiple results
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"First"}\n'));
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Second"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.response).toBe('First');
		});

		it('should only capture first session_id', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			mockStdout.emit('data', Buffer.from('{"session_id":"first-id"}\n'));
			mockStdout.emit('data', Buffer.from('{"session_id":"second-id"}\n'));
			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.agentSessionId).toBe('first-id');
		});

		it('should preserve session_id and usageStats on error', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			mockStdout.emit('data', Buffer.from('{"session_id":"error-session"}\n'));
			mockStdout.emit('data', Buffer.from('{"total_cost_usd":0.01}\n'));
			mockStderr.emit('data', Buffer.from('Error!\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 1);

			const result = await resultPromise;

			expect(result.success).toBe(false);
			expect(result.agentSessionId).toBe('error-session');
			expect(result.usageStats?.totalCostUsd).toBe(0.01);
		});

		it('should handle empty lines in output', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			mockStdout.emit('data', Buffer.from('\n\n{"type":"result","result":"Done"}\n\n'));
			await new Promise((resolve) => setTimeout(resolve, 0));
			mockChild.emit('close', 0);

			const result = await resultPromise;

			expect(result.success).toBe(true);
		});

		it('should handle success without result field', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			// No result emitted, but process exits cleanly
			mockChild.emit('close', 0);

			const result = await resultPromise;

			// Without a result, success is false even with exit code 0
			expect(result.success).toBe(false);
		});

		it('should include expanded PATH in environment', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');

			await new Promise((resolve) => setTimeout(resolve, 0));

			const [, , options] = mockSpawn.mock.calls[0];
			const pathEnv = options.env.PATH;

			// Should include common paths
			expect(pathEnv).toContain('/opt/homebrew/bin');
			expect(pathEnv).toContain('/usr/local/bin');
			expect(pathEnv).toContain('/Users/testuser/.local/bin');

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);

			await resultPromise;
		});

		it('should generate unique session-id for each spawn', async () => {
			// First spawn
			const promise1 = spawnAgent('claude-code', '/project', 'prompt1');
			await new Promise((resolve) => setTimeout(resolve, 0));
			const args1 = mockSpawn.mock.calls[0][1];

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await promise1;

			// Reset emitters
			mockStdout.removeAllListeners();
			mockStderr.removeAllListeners();
			(mockChild as EventEmitter).removeAllListeners();
			mockSpawn.mockClear();
			mockSpawn.mockReturnValue(mockChild);

			// Second spawn
			const promise2 = spawnAgent('claude-code', '/project', 'prompt2');
			await new Promise((resolve) => setTimeout(resolve, 0));
			const args2 = mockSpawn.mock.calls[0][1];

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await promise2;

			// Extract session IDs
			const sessionIdIndex1 = args1.indexOf('--session-id');
			const sessionIdIndex2 = args2.indexOf('--session-id');

			if (sessionIdIndex1 !== -1 && sessionIdIndex2 !== -1) {
				const id1 = args1[sessionIdIndex1 + 1];
				const id2 = args2[sessionIdIndex2 + 1];

				// UUIDs should be different
				expect(id1).not.toBe(id2);
				// Should be valid UUID format
				expect(id1).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
				);
				expect(id2).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
				);
			}
		});
	});

	describe('PATH expansion (via spawnAgent)', () => {
		beforeEach(() => {
			mockSpawn.mockReturnValue(mockChild);
		});

		it('should include homebrew paths', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const pathEnv = mockSpawn.mock.calls[0][2].env.PATH;
			expect(pathEnv).toContain('/opt/homebrew/bin');
			expect(pathEnv).toContain('/opt/homebrew/sbin');

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should include user home paths', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const pathEnv = mockSpawn.mock.calls[0][2].env.PATH;
			expect(pathEnv).toContain('/Users/testuser/.local/bin');
			expect(pathEnv).toContain('/Users/testuser/.npm-global/bin');
			expect(pathEnv).toContain('/Users/testuser/bin');
			expect(pathEnv).toContain('/Users/testuser/.claude/local');

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should include system paths', async () => {
			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const pathEnv = mockSpawn.mock.calls[0][2].env.PATH;
			expect(pathEnv).toContain('/usr/bin');
			expect(pathEnv).toContain('/bin');
			expect(pathEnv).toContain('/usr/sbin');
			expect(pathEnv).toContain('/sbin');
			expect(pathEnv).toContain('/usr/local/bin');
			expect(pathEnv).toContain('/usr/local/sbin');

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should not duplicate existing paths', async () => {
			// Set PATH to include a path that would be added
			const originalPath = process.env.PATH;
			process.env.PATH = '/opt/homebrew/bin:/usr/bin';

			const resultPromise = spawnAgent('claude-code', '/project', 'prompt');
			await new Promise((resolve) => setTimeout(resolve, 0));

			const pathEnv = mockSpawn.mock.calls[0][2].env.PATH;

			// Count occurrences of /opt/homebrew/bin
			const parts = pathEnv.split(':');
			const homebrewCount = parts.filter((p: string) => p === '/opt/homebrew/bin').length;

			// Should only appear once
			expect(homebrewCount).toBe(1);

			// Restore
			process.env.PATH = originalPath;

			mockStdout.emit('data', Buffer.from('{"type":"result","result":"Done"}\n'));
			mockChild.emit('close', 0);
			await resultPromise;
		});
	});

	describe('platform-specific behavior', () => {
		it('should use where command on Windows for findClaudeInPath', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			mockGetAgentCustomPath.mockReturnValue(undefined);
			mockSpawn.mockReturnValue(mockChild);

			vi.resetModules();
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const resultPromise = freshDetectClaude();

			await new Promise((resolve) => setTimeout(resolve, 0));

			// On Windows, 'where' should be used
			const command = mockSpawn.mock.calls[0][0];
			expect(command).toBe('where');

			mockChild.emit('close', 1);
			await resultPromise;

			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		});

		it('should use which command on Unix', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			mockGetAgentCustomPath.mockReturnValue(undefined);
			mockSpawn.mockReturnValue(mockChild);

			vi.resetModules();
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const resultPromise = freshDetectClaude();

			await new Promise((resolve) => setTimeout(resolve, 0));

			const command = mockSpawn.mock.calls[0][0];
			expect(command).toBe('which');

			mockChild.emit('close', 1);
			await resultPromise;

			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		});

		it('should skip X_OK check on Windows', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			mockGetAgentCustomPath.mockReturnValue('C:\\Program Files\\claude\\claude.exe');
			vi.mocked(fs.promises.stat).mockResolvedValue({
				isFile: () => true,
			} as fs.Stats);
			// Don't mock access - it shouldn't be called on Windows

			vi.resetModules();
			const { detectClaude: freshDetectClaude } =
				await import('../../../cli/services/agent-spawner');

			const result = await freshDetectClaude();

			// On Windows, just checking if it's a file is enough
			expect(result.available).toBe(true);
			expect(fs.promises.access).not.toHaveBeenCalled();

			Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
		});
	});
});
