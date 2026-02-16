/**
 * Tests for batch state persistence IPC handlers
 *
 * Tests the batch-state:save, batch-state:load, batch-state:clear,
 * and batch-state:flush handlers that persist Auto Run batch state
 * across renderer reloads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';

// Create hoisted mocks
const mocks = vi.hoisted(() => ({
	mockLogger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
	mockFs: {
		writeFile: vi.fn(),
		readFile: vi.fn(),
		unlink: vi.fn(),
	},
	mockGetPath: vi.fn().mockReturnValue('/mock/userData'),
}));

// Mock electron
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
	app: {
		getPath: mocks.mockGetPath,
	},
}));

// Mock logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: mocks.mockLogger,
}));

// Mock fs/promises
vi.mock('fs/promises', () => mocks.mockFs);

// Aliases
const mockLogger = mocks.mockLogger;
const mockFs = mocks.mockFs;

import { registerBatchStateHandlers, type PersistedBatchRunState } from '../../../../main/ipc/handlers/batch-state';

function makeBatchState(overrides?: Partial<PersistedBatchRunState>): PersistedBatchRunState {
	return {
		sessionId: 'session-1',
		isRunning: true,
		processingState: 'RUNNING',
		documents: ['doc1.md', 'doc2.md'],
		lockedDocuments: [],
		currentDocumentIndex: 0,
		currentDocTasksTotal: 5,
		currentDocTasksCompleted: 2,
		totalTasksAcrossAllDocs: 10,
		completedTasksAcrossAllDocs: 2,
		loopEnabled: false,
		loopIteration: 1,
		folderPath: '/path/to/autorun',
		worktreeActive: false,
		...overrides,
	};
}

describe('Batch State Persistence IPC Handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		handlers = new Map();

		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
		});

		registerBatchStateHandlers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	describe('handler registration', () => {
		it('should register all 4 handlers', () => {
			expect(handlers.has('batch-state:save')).toBe(true);
			expect(handlers.has('batch-state:load')).toBe(true);
			expect(handlers.has('batch-state:clear')).toBe(true);
			expect(handlers.has('batch-state:flush')).toBe(true);
			expect(handlers.size).toBe(4);
		});
	});

	describe('batch-state:save', () => {
		it('should debounce writes to 3 seconds', async () => {
			const handler = handlers.get('batch-state:save')!;
			const batches = [makeBatchState()];

			mockFs.writeFile.mockResolvedValue(undefined);

			await handler({}, batches);

			// Should not write immediately
			expect(mockFs.writeFile).not.toHaveBeenCalled();

			// Advance timer past debounce
			await vi.advanceTimersByTimeAsync(3000);

			expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
			const writtenContent = JSON.parse(mockFs.writeFile.mock.calls[0][1]);
			expect(writtenContent.activeBatches).toEqual(batches);
			expect(writtenContent.timestamp).toBeTypeOf('number');
		});

		it('should coalesce multiple saves within the debounce window', async () => {
			const handler = handlers.get('batch-state:save')!;
			mockFs.writeFile.mockResolvedValue(undefined);

			// Multiple rapid saves
			await handler({}, [makeBatchState({ completedTasksAcrossAllDocs: 1 })]);
			await handler({}, [makeBatchState({ completedTasksAcrossAllDocs: 2 })]);
			await handler({}, [makeBatchState({ completedTasksAcrossAllDocs: 3 })]);

			await vi.advanceTimersByTimeAsync(3000);

			// Only one write, with the latest data
			expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
			const writtenContent = JSON.parse(mockFs.writeFile.mock.calls[0][1]);
			expect(writtenContent.activeBatches[0].completedTasksAcrossAllDocs).toBe(3);
		});

		it('should log warning on write failure', async () => {
			const handler = handlers.get('batch-state:save')!;
			mockFs.writeFile.mockRejectedValue(new Error('disk full'));

			await handler({}, [makeBatchState()]);
			await vi.advanceTimersByTimeAsync(3000);

			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Failed to save batch state snapshot',
				'BatchStatePersistence',
				expect.objectContaining({ error: expect.stringContaining('disk full') })
			);
		});

		it('should write to userData/batch-run-state.json', async () => {
			const handler = handlers.get('batch-state:save')!;
			mockFs.writeFile.mockResolvedValue(undefined);

			await handler({}, [makeBatchState()]);
			await vi.advanceTimersByTimeAsync(3000);

			expect(mockFs.writeFile.mock.calls[0][0]).toBe('/mock/userData/batch-run-state.json');
		});
	});

	describe('batch-state:load', () => {
		it('should return snapshot if fresh', async () => {
			const handler = handlers.get('batch-state:load')!;
			const snapshot = {
				timestamp: Date.now() - 5000, // 5 seconds ago
				activeBatches: [makeBatchState()],
			};
			mockFs.readFile.mockResolvedValue(JSON.stringify(snapshot));

			const result = await handler({});

			expect(result).toBeTruthy();
			expect(result!.activeBatches).toHaveLength(1);
			expect(result!.activeBatches[0].sessionId).toBe('session-1');
		});

		it('should return null for stale snapshots (>10 minutes)', async () => {
			const handler = handlers.get('batch-state:load')!;
			const snapshot = {
				timestamp: Date.now() - 11 * 60 * 1000, // 11 minutes ago
				activeBatches: [makeBatchState()],
			};
			mockFs.readFile.mockResolvedValue(JSON.stringify(snapshot));

			const result = await handler({});

			expect(result).toBeNull();
			expect(mockLogger.info).toHaveBeenCalledWith(
				'Batch state snapshot too old, ignoring',
				'BatchStatePersistence',
				expect.objectContaining({ ageMs: expect.any(Number) })
			);
		});

		it('should return null when file does not exist', async () => {
			const handler = handlers.get('batch-state:load')!;
			mockFs.readFile.mockRejectedValue(new Error('ENOENT'));

			const result = await handler({});

			expect(result).toBeNull();
		});

		it('should return null for invalid JSON', async () => {
			const handler = handlers.get('batch-state:load')!;
			mockFs.readFile.mockResolvedValue('not valid json');

			const result = await handler({});

			expect(result).toBeNull();
		});

		it('should log info on successful load', async () => {
			const handler = handlers.get('batch-state:load')!;
			const snapshot = {
				timestamp: Date.now() - 1000,
				activeBatches: [makeBatchState(), makeBatchState({ sessionId: 'session-2' })],
			};
			mockFs.readFile.mockResolvedValue(JSON.stringify(snapshot));

			await handler({});

			expect(mockLogger.info).toHaveBeenCalledWith(
				'Loaded batch state snapshot',
				'BatchStatePersistence',
				expect.objectContaining({ batchCount: 2 })
			);
		});
	});

	describe('batch-state:clear', () => {
		it('should delete the snapshot file', async () => {
			const handler = handlers.get('batch-state:clear')!;
			mockFs.unlink.mockResolvedValue(undefined);

			await handler({});

			expect(mockFs.unlink).toHaveBeenCalledWith('/mock/userData/batch-run-state.json');
		});

		it('should not throw when file does not exist', async () => {
			const handler = handlers.get('batch-state:clear')!;
			mockFs.unlink.mockRejectedValue(new Error('ENOENT'));

			await expect(handler({})).resolves.not.toThrow();
		});
	});

	describe('batch-state:flush', () => {
		it('should force-write pending snapshot immediately', async () => {
			const saveHandler = handlers.get('batch-state:save')!;
			const flushHandler = handlers.get('batch-state:flush')!;
			mockFs.writeFile.mockResolvedValue(undefined);

			// Save (starts debounce timer)
			await saveHandler({}, [makeBatchState()]);
			expect(mockFs.writeFile).not.toHaveBeenCalled();

			// Flush immediately
			await flushHandler({});

			expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
		});

		it('should be a no-op when no pending snapshot', async () => {
			const handler = handlers.get('batch-state:flush')!;

			await handler({});

			expect(mockFs.writeFile).not.toHaveBeenCalled();
		});

		it('should log warning on flush write failure', async () => {
			const saveHandler = handlers.get('batch-state:save')!;
			const flushHandler = handlers.get('batch-state:flush')!;
			mockFs.writeFile.mockRejectedValue(new Error('permission denied'));

			await saveHandler({}, [makeBatchState()]);
			await flushHandler({});

			expect(mockLogger.warn).toHaveBeenCalledWith(
				'Failed to flush batch state snapshot',
				'BatchStatePersistence',
				expect.objectContaining({ error: expect.stringContaining('permission denied') })
			);
		});

		it('should cancel the pending debounce timer', async () => {
			const saveHandler = handlers.get('batch-state:save')!;
			const flushHandler = handlers.get('batch-state:flush')!;
			mockFs.writeFile.mockResolvedValue(undefined);

			// Save triggers debounce timer
			await saveHandler({}, [makeBatchState()]);

			// Flush writes immediately and clears timer
			await flushHandler({});
			expect(mockFs.writeFile).toHaveBeenCalledTimes(1);

			// Advancing timer should not trigger another write
			mockFs.writeFile.mockClear();
			await vi.advanceTimersByTimeAsync(5000);
			expect(mockFs.writeFile).not.toHaveBeenCalled();
		});
	});

	describe('batch state with all optional fields', () => {
		it('should persist agentSessionId and agentType', async () => {
			const saveHandler = handlers.get('batch-state:save')!;
			mockFs.writeFile.mockResolvedValue(undefined);

			const batch = makeBatchState({
				agentSessionId: 'claude-session-abc-123',
				agentType: 'claude-code',
				worktreeActive: true,
				worktreePath: '/tmp/worktree',
				worktreeBranch: 'feature/test',
				customPrompt: 'Custom batch prompt',
				startTime: 1700000000000,
				cumulativeTaskTimeMs: 30000,
				accumulatedElapsedMs: 60000,
				lastActiveTimestamp: 1700000060000,
				maxLoops: 3,
			});

			await saveHandler({}, [batch]);
			await vi.advanceTimersByTimeAsync(3000);

			const writtenContent = JSON.parse(mockFs.writeFile.mock.calls[0][1]);
			expect(writtenContent.activeBatches[0]).toMatchObject({
				agentSessionId: 'claude-session-abc-123',
				agentType: 'claude-code',
				worktreeActive: true,
				worktreePath: '/tmp/worktree',
				worktreeBranch: 'feature/test',
				customPrompt: 'Custom batch prompt',
				maxLoops: 3,
			});
		});
	});
});
