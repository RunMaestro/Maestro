/**
 * Tests for the Cue task scanner module.
 *
 * Tests cover:
 * - extractPendingTasks: parsing markdown for unchecked tasks
 * - createCueTaskScanner: polling lifecycle, hash tracking, event emission
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn();
vi.mock('fs', () => ({
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
	readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
}));

// Mock picomatch
vi.mock('picomatch', () => ({
	default: (pattern: string) => {
		// Simple mock: match files ending in .md for "**/*.md" pattern
		if (pattern === '**/*.md' || pattern === 'tasks/**/*.md') {
			return (file: string) => file.endsWith('.md');
		}
		return () => true;
	},
}));

// Mock crypto
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
	createHash: () => ({
		update: (content: string) => ({
			digest: () => `hash-${content.length}`,
		}),
	}),
}));

import { extractPendingTasks, createCueTaskScanner } from '../../../main/cue/cue-task-scanner';

describe('cue-task-scanner', () => {
	describe('extractPendingTasks', () => {
		it('extracts unchecked tasks from markdown', () => {
			const content = `# Tasks
- [ ] First task
- [x] Completed task
- [ ] Second task
`;
			const tasks = extractPendingTasks(content);
			expect(tasks).toHaveLength(2);
			expect(tasks[0]).toEqual({ line: 2, text: 'First task' });
			expect(tasks[1]).toEqual({ line: 4, text: 'Second task' });
		});

		it('handles indented tasks', () => {
			const content = `# Project
  - [ ] Nested task
    - [ ] Deeply nested
`;
			const tasks = extractPendingTasks(content);
			expect(tasks).toHaveLength(2);
			expect(tasks[0].text).toBe('Nested task');
			expect(tasks[1].text).toBe('Deeply nested');
		});

		it('handles different list markers', () => {
			const content = `- [ ] Dash task
* [ ] Star task
+ [ ] Plus task
`;
			const tasks = extractPendingTasks(content);
			expect(tasks).toHaveLength(3);
		});

		it('returns empty array for no pending tasks', () => {
			const content = `# Done
- [x] All done
- [x] Also done
`;
			const tasks = extractPendingTasks(content);
			expect(tasks).toHaveLength(0);
		});

		it('returns empty array for empty content', () => {
			const tasks = extractPendingTasks('');
			expect(tasks).toHaveLength(0);
		});

		it('skips tasks with empty text', () => {
			const content = `- [ ]
- [ ] Real task
`;
			const tasks = extractPendingTasks(content);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].text).toBe('Real task');
		});

		it('does not match checked tasks', () => {
			const content = `- [x] Done
- [X] Also done
- [ ] Not done
`;
			const tasks = extractPendingTasks(content);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].text).toBe('Not done');
		});
	});

	describe('createCueTaskScanner', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('returns a cleanup function', () => {
			const cleanup = createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent: vi.fn(),
				onLog: vi.fn(),
				triggerName: 'test-scanner',
			});
			expect(typeof cleanup).toBe('function');
			cleanup();
		});

		it('cleanup stops polling', () => {
			const onEvent = vi.fn();
			const cleanup = createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent,
				onLog: vi.fn(),
				triggerName: 'test-scanner',
			});

			cleanup();

			// Advance past initial delay
			vi.advanceTimersByTime(3000);
			expect(onEvent).not.toHaveBeenCalled();
		});

		it('seeds hashes on first scan without firing events', async () => {
			const onEvent = vi.fn();

			// Mock directory walk: one .md file with pending tasks
			mockReaddirSync.mockImplementation((_dir: string, opts: { withFileTypes: boolean }) => {
				if (opts?.withFileTypes) {
					return [{ name: 'task.md', isDirectory: () => false, isFile: () => true }];
				}
				return [];
			});
			mockReadFileSync.mockReturnValue('- [ ] Pending task\n');

			createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent,
				onLog: vi.fn(),
				triggerName: 'test-scanner',
			});

			// Advance past initial delay
			await vi.advanceTimersByTimeAsync(3000);

			// First scan seeds hashes — should NOT fire events
			expect(onEvent).not.toHaveBeenCalled();
		});

		it('fires event on second scan when content has changed and has pending tasks', async () => {
			const onEvent = vi.fn();

			mockReaddirSync.mockImplementation((_dir: string, opts: { withFileTypes: boolean }) => {
				if (opts?.withFileTypes) {
					return [{ name: 'task.md', isDirectory: () => false, isFile: () => true }];
				}
				return [];
			});

			// First scan: seed with initial content
			mockReadFileSync.mockReturnValueOnce('- [ ] Initial task\n');

			const cleanup = createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent,
				onLog: vi.fn(),
				triggerName: 'test-scanner',
			});

			// First scan (seed)
			await vi.advanceTimersByTimeAsync(3000);
			expect(onEvent).not.toHaveBeenCalled();

			// Second scan: content changed, has pending tasks
			mockReadFileSync.mockReturnValue('- [ ] Initial task\n- [ ] New task\n');
			await vi.advanceTimersByTimeAsync(60 * 1000);

			expect(onEvent).toHaveBeenCalledTimes(1);
			const event = onEvent.mock.calls[0][0];
			expect(event.type).toBe('task.pending');
			expect(event.triggerName).toBe('test-scanner');
			expect(event.payload.taskCount).toBe(2);
			expect(event.payload.filename).toBe('task.md');

			cleanup();
		});

		it('does not fire when content unchanged', async () => {
			const onEvent = vi.fn();

			mockReaddirSync.mockImplementation((_dir: string, opts: { withFileTypes: boolean }) => {
				if (opts?.withFileTypes) {
					return [{ name: 'task.md', isDirectory: () => false, isFile: () => true }];
				}
				return [];
			});

			// Same content every scan
			mockReadFileSync.mockReturnValue('- [ ] Same task\n');

			const cleanup = createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent,
				onLog: vi.fn(),
				triggerName: 'test-scanner',
			});

			// First scan + second scan
			await vi.advanceTimersByTimeAsync(3000);
			await vi.advanceTimersByTimeAsync(60 * 1000);

			expect(onEvent).not.toHaveBeenCalled();
			cleanup();
		});

		it('does not fire when content changed but no pending tasks', async () => {
			const onEvent = vi.fn();

			mockReaddirSync.mockImplementation((_dir: string, opts: { withFileTypes: boolean }) => {
				if (opts?.withFileTypes) {
					return [{ name: 'task.md', isDirectory: () => false, isFile: () => true }];
				}
				return [];
			});

			// First scan: has pending tasks
			mockReadFileSync.mockReturnValueOnce('- [ ] Task\n');

			const cleanup = createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent,
				onLog: vi.fn(),
				triggerName: 'test-scanner',
			});

			// Seed
			await vi.advanceTimersByTimeAsync(3000);

			// Second scan: all tasks completed
			mockReadFileSync.mockReturnValue('- [x] Task\n');
			await vi.advanceTimersByTimeAsync(60 * 1000);

			expect(onEvent).not.toHaveBeenCalled();
			cleanup();
		});

		it('logs error when scan fails', async () => {
			const onLog = vi.fn();

			mockReaddirSync.mockImplementation(() => {
				throw new Error('Permission denied');
			});

			const cleanup = createCueTaskScanner({
				watchGlob: '**/*.md',
				pollMinutes: 1,
				projectRoot: '/project',
				onEvent: vi.fn(),
				onLog,
				triggerName: 'test-scanner',
			});

			await vi.advanceTimersByTimeAsync(3000);

			expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('Task scan error'));

			cleanup();
		});
	});
});
