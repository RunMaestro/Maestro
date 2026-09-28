/**
 * Tests for the debug package renderer service.
 *
 * The point of this service is that Auto Run state lives only in the renderer's
 * in-memory batchStore, so main cannot collect it on its own. These tests pin
 * two things: the snapshot is actually attached, and it carries no document
 * content or paths.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BatchRunState } from '../../../renderer/types';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import {
	captureAutoRunSnapshots,
	createDebugPackage,
} from '../../../renderer/services/debugPackage';

const createBatchRunState = (overrides: Partial<BatchRunState> = {}): BatchRunState => ({
	isRunning: false,
	isStopping: false,
	documents: ['Phase 1'],
	lockedDocuments: ['Phase 1'],
	currentDocumentIndex: 0,
	currentDocTasksTotal: 3,
	currentDocTasksCompleted: 0,
	totalTasksAcrossAllDocs: 3,
	completedTasksAcrossAllDocs: 0,
	loopEnabled: false,
	loopIteration: 0,
	folderPath: '/test/folder',
	worktreeActive: false,
	totalTasks: 3,
	completedTasks: 0,
	currentTaskIndex: 0,
	originalContent: '',
	sessionIds: [],
	...overrides,
});

describe('debugPackage service', () => {
	beforeEach(() => {
		useBatchStore.setState({ batchRunStates: {} });
	});

	describe('captureAutoRunSnapshots', () => {
		it('captures live Auto Run state per agent', () => {
			const startTime = Date.now() - 60_000;
			useBatchStore.setState({
				batchRunStates: {
					'agent-1': createBatchRunState({
						isRunning: true,
						currentDocumentIndex: 2,
						documents: ['Phase 1', 'Phase 2', 'Phase 3'],
						completedTasksAcrossAllDocs: 66,
						totalTasksAcrossAllDocs: 124,
						loopEnabled: true,
						loopIteration: 3,
						startTime,
					}),
				},
			});

			const [snapshot] = captureAutoRunSnapshots();

			expect(snapshot.sessionId).toBe('agent-1');
			expect(snapshot.isRunning).toBe(true);
			expect(snapshot.documentCount).toBe(3);
			expect(snapshot.currentDocumentIndex).toBe(2);
			expect(snapshot.completedTasksAcrossAllDocs).toBe(66);
			expect(snapshot.totalTasksAcrossAllDocs).toBe(124);
			expect(snapshot.loopIteration).toBe(3);
			expect(snapshot.startTime).toBe(startTime);
		});

		it('omits document content, filenames, and paths', () => {
			useBatchStore.setState({
				batchRunStates: {
					'agent-1': createBatchRunState({
						isRunning: true,
						documents: ['Secret Phase Name'],
						folderPath: '/Users/someone/private/docs',
						worktreePath: '/Users/someone/worktrees/wt',
						customPrompt: 'a prompt that may quote the document',
						errorTaskDescription: 'task text from the document',
						originalContent: '# document body',
					}),
				},
			});

			const serialized = JSON.stringify(captureAutoRunSnapshots());

			expect(serialized).not.toContain('Secret Phase Name');
			expect(serialized).not.toContain('/Users/someone');
			expect(serialized).not.toContain('a prompt that may quote');
			expect(serialized).not.toContain('task text from the document');
			expect(serialized).not.toContain('# document body');
		});

		it('reports an error without leaking the error message', () => {
			useBatchStore.setState({
				batchRunStates: {
					'agent-1': createBatchRunState({
						errorPaused: true,
						error: {
							type: 'rate_limited',
							message: 'quota exceeded for /Users/someone/repo',
							recoverable: true,
							agentId: 'claude-code',
							timestamp: Date.now(),
						},
					}),
				},
			});

			const [snapshot] = captureAutoRunSnapshots();

			expect(snapshot.hasError).toBe(true);
			expect(snapshot.errorType).toBe('rate_limited');
			expect(snapshot.errorPaused).toBe(true);
			expect(JSON.stringify(snapshot)).not.toContain('quota exceeded');
		});
	});

	describe('createDebugPackage', () => {
		it('attaches the snapshot so main never has to guess', async () => {
			const createPackage = vi.fn().mockResolvedValue({ success: true });
			(globalThis as unknown as { window: unknown }).window = {
				maestro: { debug: { createPackage } },
			};

			useBatchStore.setState({
				batchRunStates: { 'agent-1': createBatchRunState({ isRunning: true }) },
			});

			await createDebugPackage({ includeLogs: false });

			expect(createPackage).toHaveBeenCalledWith(
				expect.objectContaining({
					includeLogs: false,
					autoRunSnapshots: [expect.objectContaining({ sessionId: 'agent-1', isRunning: true })],
				})
			);
		});
	});
});
