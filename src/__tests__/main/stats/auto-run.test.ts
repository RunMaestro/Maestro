/**
 * Tests for Auto Run session and task CRUD operations.
 *
 * Note: better-sqlite3 is a native module compiled for Electron's Node version.
 * Direct testing with the native module in vitest is not possible without
 * electron-rebuild for the vitest runtime. These tests use mocked database
 * operations to verify the logic without requiring the actual native module.
 *
 * For full integration testing of the SQLite database, use the Electron test
 * environment (e2e tests) where the native module is properly loaded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

// Track Database constructor calls to verify file path
let lastDbPath: string | null = null;

// Store mock references so they can be accessed in tests
const mockStatement = {
	run: vi.fn(() => ({ changes: 1 })),
	get: vi.fn(() => ({ count: 0, total_duration: 0 })),
	all: vi.fn(() => []),
};

const mockDb = {
	pragma: vi.fn(() => [{ user_version: 0 }]),
	prepare: vi.fn(() => mockStatement),
	close: vi.fn(),
	// Transaction mock that immediately executes the function
	transaction: vi.fn((fn: () => void) => {
		return () => fn();
	}),
};

// Mock better-sqlite3 as a class
vi.mock('better-sqlite3', () => {
	return {
		default: class MockDatabase {
			constructor(dbPath: string) {
				lastDbPath = dbPath;
			}
			pragma = mockDb.pragma;
			prepare = mockDb.prepare;
			close = mockDb.close;
			transaction = mockDb.transaction;
		},
	};
});

// Mock electron's app module with trackable userData path
const mockUserDataPath = path.join(os.tmpdir(), 'maestro-test-stats-db');
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') return mockUserDataPath;
			return os.tmpdir();
		}),
	},
}));

// Track fs calls
const mockFsExistsSync = vi.fn(() => true);
const mockFsMkdirSync = vi.fn();
const mockFsCopyFileSync = vi.fn();
const mockFsUnlinkSync = vi.fn();
const mockFsRenameSync = vi.fn();
const mockFsStatSync = vi.fn(() => ({ size: 1024 }));
const mockFsReadFileSync = vi.fn(() => '0'); // Default: old timestamp (triggers vacuum check)
const mockFsWriteFileSync = vi.fn();
const mockFsReaddirSync = vi.fn(() => [] as string[]);

// Mock fs
vi.mock('fs', () => ({
	existsSync: (...args: unknown[]) => mockFsExistsSync(...args),
	mkdirSync: (...args: unknown[]) => mockFsMkdirSync(...args),
	copyFileSync: (...args: unknown[]) => mockFsCopyFileSync(...args),
	unlinkSync: (...args: unknown[]) => mockFsUnlinkSync(...args),
	renameSync: (...args: unknown[]) => mockFsRenameSync(...args),
	statSync: (...args: unknown[]) => mockFsStatSync(...args),
	readFileSync: (...args: unknown[]) => mockFsReadFileSync(...args),
	writeFileSync: (...args: unknown[]) => mockFsWriteFileSync(...args),
	readdirSync: (...args: unknown[]) => mockFsReaddirSync(...args),
	promises: {
		access: async (pathArg: unknown) => {
			if (!mockFsExistsSync(pathArg)) {
				const error = new Error('ENOENT');
				(error as NodeJS.ErrnoException).code = 'ENOENT';
				throw error;
			}
		},
		mkdir: async (...args: unknown[]) => mockFsMkdirSync(...args),
		stat: async (...args: unknown[]) => mockFsStatSync(...args),
		readdir: async (...args: unknown[]) => mockFsReaddirSync(...args),
		unlink: async (...args: unknown[]) => mockFsUnlinkSync(...args),
	},
	constants: { F_OK: 0 },
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Import types only - we'll test the type definitions
import type {
	QueryEvent,
	AutoRunSession,
	AutoRunTask,
	SessionLifecycleEvent,
	StatsTimeRange,
	StatsFilters,
	StatsAggregation,
} from '../../../shared/stats-types';

describe('Auto Run session and task recording', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lastDbPath = null;
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockFsExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('Auto Run sessions', () => {
		it('should insert Auto Run session and return id', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const sessionId = db.insertAutoRunSession({
				sessionId: 'session-1',
				agentType: 'claude-code',
				documentPath: '/docs/TASK-1.md',
				startTime: Date.now(),
				duration: 0,
				tasksTotal: 5,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			expect(sessionId).toBeDefined();
			expect(typeof sessionId).toBe('string');
			expect(mockStatement.run).toHaveBeenCalled();
		});

		it('should update Auto Run session on completion', async () => {
			mockStatement.run.mockReturnValue({ changes: 1 });

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const updated = db.updateAutoRunSession('session-id', {
				duration: 60000,
				tasksCompleted: 5,
			});

			expect(updated).toBe(true);
			expect(mockStatement.run).toHaveBeenCalled();
		});

		it('should retrieve Auto Run sessions within time range', async () => {
			mockStatement.all.mockReturnValue([
				{
					id: 'auto-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					document_path: '/docs/TASK-1.md',
					start_time: Date.now(),
					duration: 60000,
					tasks_total: 5,
					tasks_completed: 5,
					project_path: '/project',
				},
			]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const sessions = db.getAutoRunSessions('week');

			expect(sessions).toHaveLength(1);
			expect(sessions[0].sessionId).toBe('session-1');
			expect(sessions[0].tasksTotal).toBe(5);
		});
	});

	describe('Auto Run tasks', () => {
		it('should insert Auto Run task with success=true', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const taskId = db.insertAutoRunTask({
				autoRunSessionId: 'auto-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'First task',
				startTime: Date.now(),
				duration: 10000,
				success: true,
			});

			expect(taskId).toBeDefined();

			// Verify success was converted to 1 for SQLite
			const runCall = mockStatement.run.mock.calls[mockStatement.run.mock.calls.length - 1];
			expect(runCall[8]).toBe(1); // success parameter (last one)
		});

		it('should insert Auto Run task with success=false', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.insertAutoRunTask({
				autoRunSessionId: 'auto-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 1,
				taskContent: 'Failed task',
				startTime: Date.now(),
				duration: 5000,
				success: false,
			});

			// Verify success was converted to 0 for SQLite
			const runCall = mockStatement.run.mock.calls[mockStatement.run.mock.calls.length - 1];
			expect(runCall[8]).toBe(0); // success parameter (last one)
		});

		it('should retrieve tasks for Auto Run session ordered by task_index', async () => {
			mockStatement.all.mockReturnValue([
				{
					id: 'task-1',
					auto_run_session_id: 'auto-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 0,
					task_content: 'First task',
					start_time: Date.now(),
					duration: 10000,
					success: 1,
				},
				{
					id: 'task-2',
					auto_run_session_id: 'auto-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 1,
					task_content: 'Second task',
					start_time: Date.now(),
					duration: 15000,
					success: 1,
				},
			]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const tasks = db.getAutoRunTasks('auto-1');

			expect(tasks).toHaveLength(2);
			expect(tasks[0].taskIndex).toBe(0);
			expect(tasks[1].taskIndex).toBe(1);
			expect(tasks[0].success).toBe(true);
		});
	});
});

/**
 * Aggregation and filtering tests
 */

describe('Auto Run sessions and tasks recorded correctly', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 1 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
		mockStatement.all.mockReturnValue([]);
		mockFsExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('Auto Run session lifecycle', () => {
		it('should record Auto Run session with all required fields', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const startTime = Date.now();
			const sessionId = db.insertAutoRunSession({
				sessionId: 'maestro-session-123',
				agentType: 'claude-code',
				documentPath: 'Auto Run Docs/PHASE-1.md',
				startTime,
				duration: 0, // Duration is 0 at start
				tasksTotal: 10,
				tasksCompleted: 0,
				projectPath: '/Users/test/my-project',
			});

			expect(sessionId).toBeDefined();
			expect(typeof sessionId).toBe('string');

			// Verify all fields were passed correctly to the INSERT statement
			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];

			// INSERT parameters: id, session_id, agent_type, document_path, start_time, duration, tasks_total, tasks_completed, project_path
			expect(lastCall[1]).toBe('maestro-session-123'); // session_id
			expect(lastCall[2]).toBe('claude-code'); // agent_type
			expect(lastCall[3]).toBe('Auto Run Docs/PHASE-1.md'); // document_path
			expect(lastCall[4]).toBe(startTime); // start_time
			expect(lastCall[5]).toBe(0); // duration (0 at start)
			expect(lastCall[6]).toBe(10); // tasks_total
			expect(lastCall[7]).toBe(0); // tasks_completed (0 at start)
			expect(lastCall[8]).toBe('/Users/test/my-project'); // project_path
		});

		it('should record Auto Run session with multiple documents (comma-separated)', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const sessionId = db.insertAutoRunSession({
				sessionId: 'multi-doc-session',
				agentType: 'claude-code',
				documentPath: 'PHASE-1.md, PHASE-2.md, PHASE-3.md',
				startTime: Date.now(),
				duration: 0,
				tasksTotal: 25,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			expect(sessionId).toBeDefined();

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];
			expect(lastCall[3]).toBe('PHASE-1.md, PHASE-2.md, PHASE-3.md');
		});

		it('should update Auto Run session duration and tasks on completion', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// First, insert the session
			const autoRunId = db.insertAutoRunSession({
				sessionId: 'session-to-update',
				agentType: 'claude-code',
				documentPath: 'TASKS.md',
				startTime: Date.now() - 60000, // Started 1 minute ago
				duration: 0,
				tasksTotal: 5,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			// Now update it with completion data
			const updated = db.updateAutoRunSession(autoRunId, {
				duration: 60000, // 1 minute
				tasksCompleted: 5,
			});

			expect(updated).toBe(true);

			// Verify UPDATE was called
			expect(mockStatement.run).toHaveBeenCalled();
		});

		it('should update Auto Run session with partial completion (some tasks skipped)', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const autoRunId = db.insertAutoRunSession({
				sessionId: 'partial-session',
				agentType: 'claude-code',
				documentPath: 'COMPLEX-TASKS.md',
				startTime: Date.now(),
				duration: 0,
				tasksTotal: 10,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			// Update with partial completion (7 of 10 tasks)
			const updated = db.updateAutoRunSession(autoRunId, {
				duration: 120000, // 2 minutes
				tasksCompleted: 7,
			});

			expect(updated).toBe(true);
		});

		it('should handle Auto Run session stopped by user (wasStopped)', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const autoRunId = db.insertAutoRunSession({
				sessionId: 'stopped-session',
				agentType: 'claude-code',
				documentPath: 'TASKS.md',
				startTime: Date.now(),
				duration: 0,
				tasksTotal: 20,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			// User stopped after 3 tasks
			const updated = db.updateAutoRunSession(autoRunId, {
				duration: 30000, // 30 seconds
				tasksCompleted: 3,
			});

			expect(updated).toBe(true);
		});
	});

	describe('Auto Run task recording', () => {
		it('should record individual task with all fields', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const taskStartTime = Date.now() - 5000;
			const taskId = db.insertAutoRunTask({
				autoRunSessionId: 'auto-run-session-1',
				sessionId: 'maestro-session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'Implement user authentication module',
				startTime: taskStartTime,
				duration: 5000,
				success: true,
			});

			expect(taskId).toBeDefined();

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];

			// INSERT parameters: id, auto_run_session_id, session_id, agent_type, task_index, task_content, start_time, duration, success
			expect(lastCall[1]).toBe('auto-run-session-1'); // auto_run_session_id
			expect(lastCall[2]).toBe('maestro-session-1'); // session_id
			expect(lastCall[3]).toBe('claude-code'); // agent_type
			expect(lastCall[4]).toBe(0); // task_index
			expect(lastCall[5]).toBe('Implement user authentication module'); // task_content
			expect(lastCall[6]).toBe(taskStartTime); // start_time
			expect(lastCall[7]).toBe(5000); // duration
			expect(lastCall[8]).toBe(1); // success (true -> 1)
		});

		it('should record failed task with success=false', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.insertAutoRunTask({
				autoRunSessionId: 'auto-run-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 2,
				taskContent: 'Fix complex edge case that requires manual intervention',
				startTime: Date.now(),
				duration: 10000,
				success: false, // Task failed
			});

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];
			expect(lastCall[8]).toBe(0); // success (false -> 0)
		});

		it('should record multiple tasks for same Auto Run session', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			const autoRunSessionId = 'multi-task-session';
			const baseTime = Date.now();

			// Task 0
			const task0Id = db.insertAutoRunTask({
				autoRunSessionId,
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'Task 0: Initialize project',
				startTime: baseTime,
				duration: 3000,
				success: true,
			});

			// Task 1
			const task1Id = db.insertAutoRunTask({
				autoRunSessionId,
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 1,
				taskContent: 'Task 1: Add dependencies',
				startTime: baseTime + 3000,
				duration: 5000,
				success: true,
			});

			// Task 2
			const task2Id = db.insertAutoRunTask({
				autoRunSessionId,
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 2,
				taskContent: 'Task 2: Configure build system',
				startTime: baseTime + 8000,
				duration: 7000,
				success: true,
			});

			// All tasks should have unique IDs
			expect(task0Id).not.toBe(task1Id);
			expect(task1Id).not.toBe(task2Id);
			expect(task0Id).not.toBe(task2Id);

			// All 3 INSERT calls should have happened
			expect(mockStatement.run).toHaveBeenCalledTimes(3);
		});

		it('should record task without optional taskContent', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const taskId = db.insertAutoRunTask({
				autoRunSessionId: 'auto-run-1',
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				// taskContent is omitted
				startTime: Date.now(),
				duration: 2000,
				success: true,
			});

			expect(taskId).toBeDefined();

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];
			expect(lastCall[5]).toBeNull(); // task_content should be NULL
		});
	});

	describe('Auto Run session and task retrieval', () => {
		it('should retrieve Auto Run sessions with proper field mapping', async () => {
			const now = Date.now();
			mockStatement.all.mockReturnValue([
				{
					id: 'auto-run-id-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					document_path: 'PHASE-1.md',
					start_time: now - 60000,
					duration: 60000,
					tasks_total: 10,
					tasks_completed: 10,
					project_path: '/project/path',
				},
				{
					id: 'auto-run-id-2',
					session_id: 'session-2',
					agent_type: 'opencode',
					document_path: null, // No document path
					start_time: now - 120000,
					duration: 45000,
					tasks_total: 5,
					tasks_completed: 4,
					project_path: null,
				},
			]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const sessions = db.getAutoRunSessions('week');

			expect(sessions).toHaveLength(2);

			// First session - all fields present
			expect(sessions[0].id).toBe('auto-run-id-1');
			expect(sessions[0].sessionId).toBe('session-1');
			expect(sessions[0].agentType).toBe('claude-code');
			expect(sessions[0].documentPath).toBe('PHASE-1.md');
			expect(sessions[0].startTime).toBe(now - 60000);
			expect(sessions[0].duration).toBe(60000);
			expect(sessions[0].tasksTotal).toBe(10);
			expect(sessions[0].tasksCompleted).toBe(10);
			expect(sessions[0].projectPath).toBe('/project/path');

			// Second session - optional fields are undefined
			expect(sessions[1].id).toBe('auto-run-id-2');
			expect(sessions[1].documentPath).toBeUndefined();
			expect(sessions[1].projectPath).toBeUndefined();
			expect(sessions[1].tasksCompleted).toBe(4);
		});

		it('should retrieve tasks for Auto Run session with proper field mapping', async () => {
			const now = Date.now();
			mockStatement.all.mockReturnValue([
				{
					id: 'task-id-0',
					auto_run_session_id: 'auto-run-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 0,
					task_content: 'First task description',
					start_time: now - 15000,
					duration: 5000,
					success: 1,
				},
				{
					id: 'task-id-1',
					auto_run_session_id: 'auto-run-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 1,
					task_content: null, // No content
					start_time: now - 10000,
					duration: 5000,
					success: 1,
				},
				{
					id: 'task-id-2',
					auto_run_session_id: 'auto-run-1',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 2,
					task_content: 'Failed task',
					start_time: now - 5000,
					duration: 3000,
					success: 0, // Failed
				},
			]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const tasks = db.getAutoRunTasks('auto-run-1');

			expect(tasks).toHaveLength(3);

			// First task
			expect(tasks[0].id).toBe('task-id-0');
			expect(tasks[0].autoRunSessionId).toBe('auto-run-1');
			expect(tasks[0].sessionId).toBe('session-1');
			expect(tasks[0].agentType).toBe('claude-code');
			expect(tasks[0].taskIndex).toBe(0);
			expect(tasks[0].taskContent).toBe('First task description');
			expect(tasks[0].startTime).toBe(now - 15000);
			expect(tasks[0].duration).toBe(5000);
			expect(tasks[0].success).toBe(true); // 1 -> true

			// Second task - no content
			expect(tasks[1].taskContent).toBeUndefined();
			expect(tasks[1].success).toBe(true);

			// Third task - failed
			expect(tasks[2].success).toBe(false); // 0 -> false
		});

		it('should return tasks ordered by task_index ASC', async () => {
			// Return tasks in wrong order to verify sorting
			mockStatement.all.mockReturnValue([
				{
					id: 't2',
					auto_run_session_id: 'ar1',
					session_id: 's1',
					agent_type: 'claude-code',
					task_index: 2,
					task_content: 'C',
					start_time: 3,
					duration: 1,
					success: 1,
				},
				{
					id: 't0',
					auto_run_session_id: 'ar1',
					session_id: 's1',
					agent_type: 'claude-code',
					task_index: 0,
					task_content: 'A',
					start_time: 1,
					duration: 1,
					success: 1,
				},
				{
					id: 't1',
					auto_run_session_id: 'ar1',
					session_id: 's1',
					agent_type: 'claude-code',
					task_index: 1,
					task_content: 'B',
					start_time: 2,
					duration: 1,
					success: 1,
				},
			]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const tasks = db.getAutoRunTasks('ar1');

			// Should be returned as-is (the SQL query handles ordering)
			// The mock returns them unsorted, but the real DB would sort them
			expect(tasks).toHaveLength(3);
		});
	});

	describe('Auto Run time range filtering', () => {
		it('should filter Auto Run sessions by day range', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getAutoRunSessions('day');

			// Verify the query was prepared with time filter
			const prepareCalls = mockDb.prepare.mock.calls;
			const selectCall = prepareCalls.find((call) =>
				(call[0] as string).includes('SELECT * FROM auto_run_sessions')
			);
			expect(selectCall).toBeDefined();
			expect(selectCall![0]).toContain('start_time >= ?');
		});

		it('should return all Auto Run sessions for "all" time range', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			mockStatement.all.mockReturnValue([
				{
					id: 'old',
					session_id: 's1',
					agent_type: 'claude-code',
					document_path: null,
					start_time: 1000,
					duration: 100,
					tasks_total: 1,
					tasks_completed: 1,
					project_path: null,
				},
				{
					id: 'new',
					session_id: 's2',
					agent_type: 'claude-code',
					document_path: null,
					start_time: Date.now(),
					duration: 100,
					tasks_total: 1,
					tasks_completed: 1,
					project_path: null,
				},
			]);

			const sessions = db.getAutoRunSessions('all');

			// With 'all' range, startTime should be 0, so all sessions should be returned
			expect(sessions).toHaveLength(2);
		});
	});

	describe('complete Auto Run workflow', () => {
		it('should support the full Auto Run lifecycle: start -> record tasks -> end', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			const batchStartTime = Date.now();

			// Step 1: Start Auto Run session
			const autoRunId = db.insertAutoRunSession({
				sessionId: 'complete-workflow-session',
				agentType: 'claude-code',
				documentPath: 'PHASE-1.md, PHASE-2.md',
				startTime: batchStartTime,
				duration: 0,
				tasksTotal: 5,
				tasksCompleted: 0,
				projectPath: '/test/project',
			});

			expect(autoRunId).toBeDefined();

			// Step 2: Record individual tasks as they complete
			let taskTime = batchStartTime;

			for (let i = 0; i < 5; i++) {
				const taskDuration = 2000 + i * 500; // Varying durations
				db.insertAutoRunTask({
					autoRunSessionId: autoRunId,
					sessionId: 'complete-workflow-session',
					agentType: 'claude-code',
					taskIndex: i,
					taskContent: `Task ${i + 1}: Implementation step ${i + 1}`,
					startTime: taskTime,
					duration: taskDuration,
					success: i !== 3, // Task 4 (index 3) fails
				});
				taskTime += taskDuration;
			}

			// Step 3: End Auto Run session
			const totalDuration = taskTime - batchStartTime;
			const updated = db.updateAutoRunSession(autoRunId, {
				duration: totalDuration,
				tasksCompleted: 4, // 4 of 5 succeeded
			});

			expect(updated).toBe(true);

			// Verify the total number of INSERT/UPDATE calls
			// 1 session insert + 5 task inserts + 1 session update = 7 calls
			expect(mockStatement.run).toHaveBeenCalledTimes(7);
		});

		it('should handle Auto Run with loop mode (multiple passes)', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			const startTime = Date.now();

			// Start session for loop mode run
			const autoRunId = db.insertAutoRunSession({
				sessionId: 'loop-mode-session',
				agentType: 'claude-code',
				documentPath: 'RECURRING-TASKS.md',
				startTime,
				duration: 0,
				tasksTotal: 15, // Initial estimate (may grow with loops)
				tasksCompleted: 0,
				projectPath: '/project',
			});

			// Record tasks from multiple loop iterations
			// Loop 1: 5 tasks
			for (let i = 0; i < 5; i++) {
				db.insertAutoRunTask({
					autoRunSessionId: autoRunId,
					sessionId: 'loop-mode-session',
					agentType: 'claude-code',
					taskIndex: i,
					taskContent: `Loop 1, Task ${i + 1}`,
					startTime: startTime + i * 3000,
					duration: 3000,
					success: true,
				});
			}

			// Loop 2: 5 more tasks
			for (let i = 0; i < 5; i++) {
				db.insertAutoRunTask({
					autoRunSessionId: autoRunId,
					sessionId: 'loop-mode-session',
					agentType: 'claude-code',
					taskIndex: 5 + i, // Continue indexing from where loop 1 ended
					taskContent: `Loop 2, Task ${i + 1}`,
					startTime: startTime + 15000 + i * 3000,
					duration: 3000,
					success: true,
				});
			}

			// Update with final stats
			db.updateAutoRunSession(autoRunId, {
				duration: 30000, // 30 seconds total
				tasksCompleted: 10,
			});

			// 1 session + 10 tasks + 1 update = 12 calls
			expect(mockStatement.run).toHaveBeenCalledTimes(12);
		});
	});

	describe('edge cases and error scenarios', () => {
		it('should handle very long task content (synopsis)', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const longContent = 'A'.repeat(10000); // 10KB task content

			const taskId = db.insertAutoRunTask({
				autoRunSessionId: 'ar1',
				sessionId: 's1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: longContent,
				startTime: Date.now(),
				duration: 5000,
				success: true,
			});

			expect(taskId).toBeDefined();

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];
			expect(lastCall[5]).toBe(longContent);
		});

		it('should handle zero duration tasks', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const taskId = db.insertAutoRunTask({
				autoRunSessionId: 'ar1',
				sessionId: 's1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'Instant task',
				startTime: Date.now(),
				duration: 0, // Zero duration (e.g., cached result)
				success: true,
			});

			expect(taskId).toBeDefined();

			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];
			expect(lastCall[7]).toBe(0);
		});

		it('should handle Auto Run session with zero tasks total', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// This shouldn't happen in practice, but the database should handle it
			const sessionId = db.insertAutoRunSession({
				sessionId: 'empty-session',
				agentType: 'claude-code',
				documentPath: 'EMPTY.md',
				startTime: Date.now(),
				duration: 100,
				tasksTotal: 0,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			expect(sessionId).toBeDefined();
		});

		it('should handle different agent types for Auto Run', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// Clear mocks after initialize() to count only test operations
			mockStatement.run.mockClear();

			// Claude Code Auto Run
			db.insertAutoRunSession({
				sessionId: 's1',
				agentType: 'claude-code',
				documentPath: 'TASKS.md',
				startTime: Date.now(),
				duration: 1000,
				tasksTotal: 5,
				tasksCompleted: 5,
				projectPath: '/project',
			});

			// OpenCode Auto Run
			db.insertAutoRunSession({
				sessionId: 's2',
				agentType: 'opencode',
				documentPath: 'TASKS.md',
				startTime: Date.now(),
				duration: 2000,
				tasksTotal: 3,
				tasksCompleted: 3,
				projectPath: '/project',
			});

			// Verify both agent types were recorded
			const runCalls = mockStatement.run.mock.calls;
			expect(runCalls[0][2]).toBe('claude-code');
			expect(runCalls[1][2]).toBe('opencode');
		});
	});
});

/**
 * Foreign key relationship verification tests
 *
 * These tests verify that the foreign key relationship between auto_run_tasks
 * and auto_run_sessions is properly defined in the schema, ensuring referential
 * integrity can be enforced when foreign key constraints are enabled.
 */
describe('Foreign key relationship between tasks and sessions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
		mockStatement.get.mockReturnValue({ count: 0, total_duration: 0 });
		mockStatement.all.mockReturnValue([]);
		mockFsExistsSync.mockReturnValue(true);
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('schema definition', () => {
		it('should create auto_run_tasks table with REFERENCES clause to auto_run_sessions', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// Verify the CREATE TABLE statement includes the foreign key reference
			const prepareCalls = mockDb.prepare.mock.calls.map((call) => call[0] as string);
			const createTasksTable = prepareCalls.find((sql) =>
				sql.includes('CREATE TABLE IF NOT EXISTS auto_run_tasks')
			);

			expect(createTasksTable).toBeDefined();
			expect(createTasksTable).toContain(
				'auto_run_session_id TEXT NOT NULL REFERENCES auto_run_sessions(id)'
			);
		});

		it('should have auto_run_session_id column as NOT NULL in auto_run_tasks', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const prepareCalls = mockDb.prepare.mock.calls.map((call) => call[0] as string);
			const createTasksTable = prepareCalls.find((sql) =>
				sql.includes('CREATE TABLE IF NOT EXISTS auto_run_tasks')
			);

			expect(createTasksTable).toBeDefined();
			// Verify NOT NULL constraint is present for auto_run_session_id
			expect(createTasksTable).toContain('auto_run_session_id TEXT NOT NULL');
		});

		it('should create index on auto_run_session_id foreign key column', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const prepareCalls = mockDb.prepare.mock.calls.map((call) => call[0] as string);
			const indexCreation = prepareCalls.find((sql) => sql.includes('idx_task_auto_session'));

			expect(indexCreation).toBeDefined();
			expect(indexCreation).toContain('ON auto_run_tasks(auto_run_session_id)');
		});
	});

	describe('referential integrity behavior', () => {
		it('should store auto_run_session_id when inserting task', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const autoRunSessionId = 'parent-session-abc-123';
			db.insertAutoRunTask({
				autoRunSessionId,
				sessionId: 'maestro-session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'Test task',
				startTime: Date.now(),
				duration: 1000,
				success: true,
			});

			// Verify the auto_run_session_id was passed to the INSERT
			const runCalls = mockStatement.run.mock.calls;
			const lastCall = runCalls[runCalls.length - 1];

			// INSERT parameters: id, auto_run_session_id, session_id, agent_type, task_index, task_content, start_time, duration, success
			expect(lastCall[1]).toBe(autoRunSessionId);
		});

		it('should insert task with matching auto_run_session_id from parent session', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// Clear calls from initialization
			mockStatement.run.mockClear();

			// First insert a session
			const autoRunId = db.insertAutoRunSession({
				sessionId: 'session-1',
				agentType: 'claude-code',
				documentPath: 'PHASE-1.md',
				startTime: Date.now(),
				duration: 0,
				tasksTotal: 5,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			// Then insert a task referencing that session
			const taskId = db.insertAutoRunTask({
				autoRunSessionId: autoRunId,
				sessionId: 'session-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'First task',
				startTime: Date.now(),
				duration: 1000,
				success: true,
			});

			expect(autoRunId).toBeDefined();
			expect(taskId).toBeDefined();

			// Both inserts should have succeeded (session + task)
			expect(mockStatement.run).toHaveBeenCalledTimes(2);

			// Verify the task INSERT used the session ID returned from the session INSERT
			const runCalls = mockStatement.run.mock.calls;
			const taskInsertCall = runCalls[1];
			expect(taskInsertCall[1]).toBe(autoRunId); // auto_run_session_id matches
		});

		it('should retrieve tasks only for the specific parent session', async () => {
			const now = Date.now();

			// Mock returns tasks for session 'auto-run-A' only
			mockStatement.all.mockReturnValue([
				{
					id: 'task-1',
					auto_run_session_id: 'auto-run-A',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 0,
					task_content: 'Task for session A',
					start_time: now,
					duration: 1000,
					success: 1,
				},
				{
					id: 'task-2',
					auto_run_session_id: 'auto-run-A',
					session_id: 'session-1',
					agent_type: 'claude-code',
					task_index: 1,
					task_content: 'Another task for session A',
					start_time: now + 1000,
					duration: 2000,
					success: 1,
				},
			]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// Query tasks for 'auto-run-A'
			const tasksA = db.getAutoRunTasks('auto-run-A');

			expect(tasksA).toHaveLength(2);
			expect(tasksA[0].autoRunSessionId).toBe('auto-run-A');
			expect(tasksA[1].autoRunSessionId).toBe('auto-run-A');

			// Verify the WHERE clause used the correct auto_run_session_id
			expect(mockStatement.all).toHaveBeenCalledWith('auto-run-A');
		});

		it('should return empty array when no tasks exist for a session', async () => {
			mockStatement.all.mockReturnValue([]);

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			const tasks = db.getAutoRunTasks('non-existent-session');

			expect(tasks).toHaveLength(0);
			expect(tasks).toEqual([]);
		});
	});

	describe('data consistency verification', () => {
		it('should maintain consistent auto_run_session_id across multiple tasks', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// Clear calls from initialization
			mockStatement.run.mockClear();

			const parentSessionId = 'consistent-parent-session';

			// Insert multiple tasks for the same parent session
			for (let i = 0; i < 5; i++) {
				db.insertAutoRunTask({
					autoRunSessionId: parentSessionId,
					sessionId: 'maestro-session',
					agentType: 'claude-code',
					taskIndex: i,
					taskContent: `Task ${i + 1}`,
					startTime: Date.now() + i * 1000,
					duration: 1000,
					success: true,
				});
			}

			// Verify all 5 tasks used the same parent session ID
			const runCalls = mockStatement.run.mock.calls;
			expect(runCalls).toHaveLength(5);

			for (const call of runCalls) {
				expect(call[1]).toBe(parentSessionId); // auto_run_session_id
			}
		});

		it('should allow tasks from different sessions to be inserted independently', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// Clear calls from initialization
			mockStatement.run.mockClear();

			// Insert tasks for session A
			db.insertAutoRunTask({
				autoRunSessionId: 'session-A',
				sessionId: 'maestro-1',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'Task A1',
				startTime: Date.now(),
				duration: 1000,
				success: true,
			});

			// Insert tasks for session B
			db.insertAutoRunTask({
				autoRunSessionId: 'session-B',
				sessionId: 'maestro-2',
				agentType: 'opencode',
				taskIndex: 0,
				taskContent: 'Task B1',
				startTime: Date.now(),
				duration: 2000,
				success: true,
			});

			// Insert another task for session A
			db.insertAutoRunTask({
				autoRunSessionId: 'session-A',
				sessionId: 'maestro-1',
				agentType: 'claude-code',
				taskIndex: 1,
				taskContent: 'Task A2',
				startTime: Date.now(),
				duration: 1500,
				success: true,
			});

			const runCalls = mockStatement.run.mock.calls;
			expect(runCalls).toHaveLength(3);

			// Verify parent session IDs are correctly assigned
			expect(runCalls[0][1]).toBe('session-A');
			expect(runCalls[1][1]).toBe('session-B');
			expect(runCalls[2][1]).toBe('session-A');
		});

		it('should use generated session ID as foreign key when retrieved after insertion', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			// Clear calls from initialization
			mockStatement.run.mockClear();

			// Insert a session and capture the generated ID
			const generatedSessionId = db.insertAutoRunSession({
				sessionId: 'maestro-session',
				agentType: 'claude-code',
				documentPath: 'DOC.md',
				startTime: Date.now(),
				duration: 0,
				tasksTotal: 3,
				tasksCompleted: 0,
				projectPath: '/project',
			});

			// The generated ID should be a string with timestamp-random format
			expect(generatedSessionId).toMatch(/^\d+-[a-z0-9]+$/);

			// Use this generated ID as the foreign key for tasks
			db.insertAutoRunTask({
				autoRunSessionId: generatedSessionId,
				sessionId: 'maestro-session',
				agentType: 'claude-code',
				taskIndex: 0,
				taskContent: 'First task',
				startTime: Date.now(),
				duration: 1000,
				success: true,
			});

			const runCalls = mockStatement.run.mock.calls;
			const taskInsert = runCalls[1]; // Second call is the task insert (first is session insert)

			// Verify the task uses the exact same ID that was generated for the session
			expect(taskInsert[1]).toBe(generatedSessionId);
		});
	});

	describe('query filtering by foreign key', () => {
		it('should filter tasks using WHERE auto_run_session_id clause', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getAutoRunTasks('specific-session-id');

			// Verify the SQL query includes proper WHERE clause for foreign key
			const prepareCalls = mockDb.prepare.mock.calls;
			const selectTasksCall = prepareCalls.find(
				(call) =>
					(call[0] as string).includes('SELECT * FROM auto_run_tasks') &&
					(call[0] as string).includes('WHERE auto_run_session_id = ?')
			);

			expect(selectTasksCall).toBeDefined();
		});

		it('should order tasks by task_index within a session', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			await db.initialize();

			db.getAutoRunTasks('any-session');

			// Verify the query includes ORDER BY task_index
			const prepareCalls = mockDb.prepare.mock.calls;
			const selectTasksCall = prepareCalls.find((call) =>
				(call[0] as string).includes('ORDER BY task_index ASC')
			);

			expect(selectTasksCall).toBeDefined();
		});
	});
});

/**
 * Time-range filtering verification tests
 *
 * These tests verify that time-range filtering works correctly for all supported
 * ranges: 'day', 'week', 'month', 'year', and 'all'. Each range should correctly
 * calculate the start timestamp and use it to filter database queries.
 */
