/**
 * Tests for batchReducer - Core Auto Run state management
 *
 * This file tests the reducer that manages Auto Run batch processing state.
 * These tests are critical because the reducer handles progress tracking,
 * which directly affects the UI progress bar and Auto Run completion detection.
 */

import { describe, it, expect } from 'vitest';
import {
	batchReducer,
	DEFAULT_BATCH_STATE,
	type BatchState,
} from '../../../../renderer/hooks/batch/batchReducer';
import type { AgentError } from '../../../../renderer/types';

describe('batchReducer', () => {
	// ============================================================================
	// START_BATCH action tests
	// ============================================================================

	describe('START_BATCH', () => {
		it('should initialize batch state for a new session', () => {
			const initialState: BatchState = {};

			const result = batchReducer(initialState, {
				type: 'START_BATCH',
				sessionId: 'session-1',
				payload: {
					documents: ['doc1.md', 'doc2.md'],
					lockedDocuments: ['doc1.md', 'doc2.md'],
					totalTasksAcrossAllDocs: 10,
					loopEnabled: false,
					maxLoops: null,
					folderPath: '/test/folder',
					worktreeActive: false,
					worktreePath: undefined,
					worktreeBranch: undefined,
					startTime: 1000,
					cumulativeTaskTimeMs: 0,
					accumulatedElapsedMs: 0,
					lastActiveTimestamp: 1000,
				},
			});

			expect(result['session-1']).toBeDefined();
			expect(result['session-1'].isRunning).toBe(true);
			expect(result['session-1'].isStopping).toBe(false);
			expect(result['session-1'].documents).toEqual(['doc1.md', 'doc2.md']);
			expect(result['session-1'].totalTasksAcrossAllDocs).toBe(10);
			expect(result['session-1'].completedTasksAcrossAllDocs).toBe(0);
			expect(result['session-1'].processingState).toBe('INITIALIZING');
		});

		it('should preserve other sessions when starting a new batch', () => {
			const initialState: BatchState = {
				'existing-session': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					completedTasksAcrossAllDocs: 5,
				},
			};

			const result = batchReducer(initialState, {
				type: 'START_BATCH',
				sessionId: 'session-1',
				payload: {
					documents: ['doc1.md'],
					lockedDocuments: ['doc1.md'],
					totalTasksAcrossAllDocs: 10,
					loopEnabled: false,
					maxLoops: null,
					folderPath: '/test/folder',
					worktreeActive: false,
					startTime: 1000,
					cumulativeTaskTimeMs: 0,
					accumulatedElapsedMs: 0,
					lastActiveTimestamp: 1000,
				},
			});

			expect(result['existing-session'].completedTasksAcrossAllDocs).toBe(5);
			expect(result['session-1'].completedTasksAcrossAllDocs).toBe(0);
		});
	});

	// ============================================================================
	// UPDATE_PROGRESS action tests - Critical for progress bar bug prevention
	// ============================================================================

	describe('UPDATE_PROGRESS', () => {
		it('should update completedTasksAcrossAllDocs when provided', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					totalTasksAcrossAllDocs: 10,
					completedTasksAcrossAllDocs: 0,
				},
			};

			const result = batchReducer(initialState, {
				type: 'UPDATE_PROGRESS',
				sessionId: 'session-1',
				payload: {
					completedTasksAcrossAllDocs: 5,
				},
			});

			expect(result['session-1'].completedTasksAcrossAllDocs).toBe(5);
		});

		it('should NOT update completedTasksAcrossAllDocs when undefined', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					completedTasksAcrossAllDocs: 5,
				},
			};

			const result = batchReducer(initialState, {
				type: 'UPDATE_PROGRESS',
				sessionId: 'session-1',
				payload: {
					totalTasksAcrossAllDocs: 20, // Only updating total, not completed
				},
			});

			// Should keep the existing completed count
			expect(result['session-1'].completedTasksAcrossAllDocs).toBe(5);
			expect(result['session-1'].totalTasksAcrossAllDocs).toBe(20);
		});

		it('should handle multiple sequential progress updates correctly', () => {
			let state: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					totalTasksAcrossAllDocs: 17,
					completedTasksAcrossAllDocs: 0,
				},
			};

			// Simulate 17 tasks completing one by one
			for (let i = 1; i <= 17; i++) {
				state = batchReducer(state, {
					type: 'UPDATE_PROGRESS',
					sessionId: 'session-1',
					payload: {
						completedTasksAcrossAllDocs: i,
					},
				});
				expect(state['session-1'].completedTasksAcrossAllDocs).toBe(i);
			}

			expect(state['session-1'].completedTasksAcrossAllDocs).toBe(17);
		});

		it('should handle rapid updates without losing progress', () => {
			let state: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					totalTasksAcrossAllDocs: 100,
					completedTasksAcrossAllDocs: 0,
				},
			};

			// Simulate rapid batch of updates
			const updates = [1, 5, 10, 25, 50, 75, 100];
			for (const completed of updates) {
				state = batchReducer(state, {
					type: 'UPDATE_PROGRESS',
					sessionId: 'session-1',
					payload: {
						completedTasksAcrossAllDocs: completed,
					},
				});
			}

			expect(state['session-1'].completedTasksAcrossAllDocs).toBe(100);
		});

		it('should return unchanged state for unknown session', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					completedTasksAcrossAllDocs: 5,
				},
			};

			const result = batchReducer(initialState, {
				type: 'UPDATE_PROGRESS',
				sessionId: 'unknown-session',
				payload: {
					completedTasksAcrossAllDocs: 10,
				},
			});

			// Should return the same state reference when session doesn't exist
			expect(result).toBe(initialState);
		});

		it('should update all provided fields in a single update', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					totalTasksAcrossAllDocs: 10,
					completedTasksAcrossAllDocs: 0,
					currentDocumentIndex: 0,
					currentDocTasksTotal: 5,
					currentDocTasksCompleted: 0,
				},
			};

			const result = batchReducer(initialState, {
				type: 'UPDATE_PROGRESS',
				sessionId: 'session-1',
				payload: {
					completedTasksAcrossAllDocs: 3,
					currentDocTasksCompleted: 3,
					currentTaskIndex: 3,
					completedTasks: 3,
				},
			});

			expect(result['session-1'].completedTasksAcrossAllDocs).toBe(3);
			expect(result['session-1'].currentDocTasksCompleted).toBe(3);
			expect(result['session-1'].currentTaskIndex).toBe(3);
			expect(result['session-1'].completedTasks).toBe(3);
		});
	});

	// ============================================================================
	// SET_RUNNING action tests
	// ============================================================================

	describe('SET_RUNNING', () => {
		it('should transition from INITIALIZING to RUNNING state', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					processingState: 'INITIALIZING',
				},
			};

			const result = batchReducer(initialState, {
				type: 'SET_RUNNING',
				sessionId: 'session-1',
			});

			expect(result['session-1'].processingState).toBe('RUNNING');
		});
	});

	// ============================================================================
	// SET_STOPPING action tests
	// ============================================================================

	describe('SET_STOPPING', () => {
		it('should set isStopping to true', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					isStopping: false,
				},
			};

			const result = batchReducer(initialState, {
				type: 'SET_STOPPING',
				sessionId: 'session-1',
			});

			expect(result['session-1'].isStopping).toBe(true);
		});
	});

	// ============================================================================
	// SET_ERROR and CLEAR_ERROR action tests
	// ============================================================================

	describe('SET_ERROR', () => {
		it('should set error state and pause processing', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					processingState: 'RUNNING',
				},
			};

			const error: AgentError = {
				type: 'rate_limited',
				message: 'Rate limit exceeded',
				recoverable: true,
				agentId: 'agent-1',
				timestamp: Date.now(),
			};

			const result = batchReducer(initialState, {
				type: 'SET_ERROR',
				sessionId: 'session-1',
				payload: {
					error,
					documentIndex: 2,
					taskDescription: 'Processing task 3',
				},
			});

			expect(result['session-1'].error).toEqual(error);
			expect(result['session-1'].errorPaused).toBe(true);
			expect(result['session-1'].errorDocumentIndex).toBe(2);
			expect(result['session-1'].errorTaskDescription).toBe('Processing task 3');
			expect(result['session-1'].processingState).toBe('PAUSED_ERROR');
		});
	});

	describe('CLEAR_ERROR', () => {
		it('should clear error state and resume processing', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					processingState: 'PAUSED_ERROR',
					error: {
						type: 'rate_limited',
						message: 'Rate limit exceeded',
						recoverable: true,
						agentId: 'agent-1',
						timestamp: Date.now(),
					},
					errorPaused: true,
					errorDocumentIndex: 2,
					errorTaskDescription: 'Test task',
				},
			};

			const result = batchReducer(initialState, {
				type: 'CLEAR_ERROR',
				sessionId: 'session-1',
			});

			expect(result['session-1'].error).toBeUndefined();
			expect(result['session-1'].errorPaused).toBe(false);
			expect(result['session-1'].errorDocumentIndex).toBeUndefined();
			expect(result['session-1'].errorTaskDescription).toBeUndefined();
			expect(result['session-1'].processingState).toBe('RUNNING');
		});
	});

	// ============================================================================
	// COMPLETE_BATCH action tests
	// ============================================================================

	describe('COMPLETE_BATCH', () => {
		it('should reset batch state to default values', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					totalTasksAcrossAllDocs: 17,
					completedTasksAcrossAllDocs: 17,
					documents: ['doc1.md'],
					processingState: 'RUNNING',
				},
			};

			const result = batchReducer(initialState, {
				type: 'COMPLETE_BATCH',
				sessionId: 'session-1',
				finalSessionIds: ['claude-session-1', 'claude-session-2'],
			});

			expect(result['session-1'].isRunning).toBe(false);
			expect(result['session-1'].isStopping).toBe(false);
			expect(result['session-1'].totalTasksAcrossAllDocs).toBe(0);
			expect(result['session-1'].completedTasksAcrossAllDocs).toBe(0);
			expect(result['session-1'].documents).toEqual([]);
			expect(result['session-1'].sessionIds).toEqual(['claude-session-1', 'claude-session-2']);
			expect(result['session-1'].processingState).toBe('IDLE');
		});

		it('should preserve sessionIds when batch completes', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					sessionIds: ['old-session-1'],
				},
			};

			const result = batchReducer(initialState, {
				type: 'COMPLETE_BATCH',
				sessionId: 'session-1',
				finalSessionIds: ['new-session-1', 'new-session-2'],
			});

			expect(result['session-1'].sessionIds).toEqual(['new-session-1', 'new-session-2']);
		});
	});

	// ============================================================================
	// INCREMENT_LOOP action tests
	// ============================================================================

	describe('INCREMENT_LOOP', () => {
		it('should increment loop iteration and update task counts', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					loopEnabled: true,
					loopIteration: 0,
					totalTasksAcrossAllDocs: 10,
					completedTasksAcrossAllDocs: 10,
					totalTasks: 10,
					completedTasks: 10,
				},
			};

			const result = batchReducer(initialState, {
				type: 'INCREMENT_LOOP',
				sessionId: 'session-1',
				newTotalTasks: 8, // New tasks found for next loop
			});

			expect(result['session-1'].loopIteration).toBe(1);
			// newTotalTasks + completedTasksAcrossAllDocs
			expect(result['session-1'].totalTasksAcrossAllDocs).toBe(18);
			expect(result['session-1'].totalTasks).toBe(18);
		});
	});

	// ============================================================================
	// State immutability tests
	// ============================================================================

	describe('immutability', () => {
		it('should not mutate the original state', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					completedTasksAcrossAllDocs: 5,
				},
			};

			const originalCompleted = initialState['session-1'].completedTasksAcrossAllDocs;

			batchReducer(initialState, {
				type: 'UPDATE_PROGRESS',
				sessionId: 'session-1',
				payload: {
					completedTasksAcrossAllDocs: 10,
				},
			});

			// Original state should be unchanged
			expect(initialState['session-1'].completedTasksAcrossAllDocs).toBe(originalCompleted);
		});

		it('should return new state object for each action', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
				},
			};

			const result = batchReducer(initialState, {
				type: 'UPDATE_PROGRESS',
				sessionId: 'session-1',
				payload: {
					completedTasksAcrossAllDocs: 1,
				},
			});

			expect(result).not.toBe(initialState);
			expect(result['session-1']).not.toBe(initialState['session-1']);
		});
	});

	// ============================================================================
	// Edge cases and regression tests
	// ============================================================================

	describe('edge cases', () => {
		it('should handle 0 to 0 progress update (no change)', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					completedTasksAcrossAllDocs: 0,
				},
			};

			const result = batchReducer(initialState, {
				type: 'UPDATE_PROGRESS',
				sessionId: 'session-1',
				payload: {
					completedTasksAcrossAllDocs: 0,
				},
			});

			expect(result['session-1'].completedTasksAcrossAllDocs).toBe(0);
		});

		it('should handle completing more tasks than total (edge case)', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					totalTasksAcrossAllDocs: 10,
					completedTasksAcrossAllDocs: 0,
				},
			};

			// This could happen if tasks are added during processing
			const result = batchReducer(initialState, {
				type: 'UPDATE_PROGRESS',
				sessionId: 'session-1',
				payload: {
					completedTasksAcrossAllDocs: 15,
				},
			});

			// Should still set the value (caller is responsible for validity)
			expect(result['session-1'].completedTasksAcrossAllDocs).toBe(15);
		});

		it('should handle default action (unknown action type)', () => {
			const initialState: BatchState = {
				'session-1': {
					...DEFAULT_BATCH_STATE,
					isRunning: true,
					completedTasksAcrossAllDocs: 5,
				},
			};

			// Test that unknown action types return unchanged state
			// We cast to any to bypass TypeScript's strict action type checking
			const unknownAction = {
				type: 'UNKNOWN_ACTION',
				sessionId: 'session-1',
			} as Parameters<typeof batchReducer>[1];

			const result = batchReducer(initialState, unknownAction);

			// Should return same state for unknown action
			expect(result).toBe(initialState);
		});
	});
});
