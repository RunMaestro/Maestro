/**
 * Batch state reducer for useBatchProcessor
 *
 * This module provides a reducer-based state management pattern for batch processing.
 * It defines all possible actions and ensures type-safe state transitions.
 */

import type { BatchRunState, AgentError } from '../../types';

/**
 * Default empty batch state for initializing new sessions
 */
export const DEFAULT_BATCH_STATE: BatchRunState = {
  isRunning: false,
  isStopping: false,
  // Multi-document progress
  documents: [],
  lockedDocuments: [],
  currentDocumentIndex: 0,
  currentDocTasksTotal: 0,
  currentDocTasksCompleted: 0,
  totalTasksAcrossAllDocs: 0,
  completedTasksAcrossAllDocs: 0,
  // Loop mode
  loopEnabled: false,
  loopIteration: 0,
  // Folder path for file operations
  folderPath: '',
  // Worktree tracking
  worktreeActive: false,
  worktreePath: undefined,
  worktreeBranch: undefined,
  // Legacy fields (kept for backwards compatibility)
  totalTasks: 0,
  completedTasks: 0,
  currentTaskIndex: 0,
  originalContent: '',
  sessionIds: [],
  // Time tracking (excludes sleep/suspend time)
  accumulatedElapsedMs: 0,
  lastActiveTimestamp: undefined,
  // Error handling state
  error: undefined,
  errorPaused: false,
  errorDocumentIndex: undefined,
  errorTaskDescription: undefined,
};

/**
 * Batch state stored per-session
 */
export type BatchState = Record<string, BatchRunState>;

/**
 * Payload for starting a batch run
 */
export interface StartBatchPayload {
  documents: string[];
  lockedDocuments: string[];
  totalTasksAcrossAllDocs: number;
  loopEnabled: boolean;
  maxLoops?: number | null;
  folderPath: string;
  worktreeActive: boolean;
  worktreePath?: string;
  worktreeBranch?: string;
  customPrompt?: string;
  startTime: number;
}

/**
 * Payload for updating progress
 */
export interface UpdateProgressPayload {
  currentDocumentIndex?: number;
  currentDocTasksTotal?: number;
  currentDocTasksCompleted?: number;
  totalTasksAcrossAllDocs?: number;
  completedTasksAcrossAllDocs?: number;
  // Legacy fields
  totalTasks?: number;
  completedTasks?: number;
  currentTaskIndex?: number;
  sessionIds?: string[];
  // Time tracking
  accumulatedElapsedMs?: number;
  lastActiveTimestamp?: number;
  // Loop mode
  loopIteration?: number;
}

/**
 * Payload for setting an error state
 */
export interface SetErrorPayload {
  error: AgentError;
  documentIndex: number;
  taskDescription?: string;
}

/**
 * Union type of all batch actions
 */
export type BatchAction =
  | { type: 'START_BATCH'; sessionId: string; payload: StartBatchPayload }
  | { type: 'UPDATE_PROGRESS'; sessionId: string; payload: UpdateProgressPayload }
  | { type: 'SET_STOPPING'; sessionId: string }
  | { type: 'SET_ERROR'; sessionId: string; payload: SetErrorPayload }
  | { type: 'CLEAR_ERROR'; sessionId: string }
  | { type: 'COMPLETE_BATCH'; sessionId: string; finalSessionIds?: string[] }
  | { type: 'INCREMENT_LOOP'; sessionId: string; newTotalTasks: number };

/**
 * Batch state reducer
 *
 * Handles all state transitions for batch processing. Each action type
 * represents a distinct operation that can be performed on the batch state.
 *
 * @param state - Current batch state for all sessions
 * @param action - The action to perform
 * @returns New batch state
 */
export function batchReducer(state: BatchState, action: BatchAction): BatchState {
  switch (action.type) {
    case 'START_BATCH': {
      const { sessionId, payload } = action;
      return {
        ...state,
        [sessionId]: {
          isRunning: true,
          isStopping: false,
          // Multi-document progress
          documents: payload.documents,
          lockedDocuments: payload.lockedDocuments,
          currentDocumentIndex: 0,
          currentDocTasksTotal: 0,
          currentDocTasksCompleted: 0,
          totalTasksAcrossAllDocs: payload.totalTasksAcrossAllDocs,
          completedTasksAcrossAllDocs: 0,
          // Loop mode
          loopEnabled: payload.loopEnabled,
          loopIteration: 0,
          maxLoops: payload.maxLoops,
          // Folder path
          folderPath: payload.folderPath,
          // Worktree tracking
          worktreeActive: payload.worktreeActive,
          worktreePath: payload.worktreePath,
          worktreeBranch: payload.worktreeBranch,
          // Legacy fields
          totalTasks: payload.totalTasksAcrossAllDocs,
          completedTasks: 0,
          currentTaskIndex: 0,
          originalContent: '',
          customPrompt: payload.customPrompt,
          sessionIds: [],
          startTime: payload.startTime,
          // Time tracking
          accumulatedElapsedMs: 0,
          lastActiveTimestamp: payload.startTime,
          // Error handling - cleared on start
          error: undefined,
          errorPaused: false,
          errorDocumentIndex: undefined,
          errorTaskDescription: undefined,
        },
      };
    }

    case 'UPDATE_PROGRESS': {
      const { sessionId, payload } = action;
      const currentState = state[sessionId];
      if (!currentState) return state;

      return {
        ...state,
        [sessionId]: {
          ...currentState,
          // Only update fields that are provided in the payload
          ...(payload.currentDocumentIndex !== undefined && {
            currentDocumentIndex: payload.currentDocumentIndex,
          }),
          ...(payload.currentDocTasksTotal !== undefined && {
            currentDocTasksTotal: payload.currentDocTasksTotal,
          }),
          ...(payload.currentDocTasksCompleted !== undefined && {
            currentDocTasksCompleted: payload.currentDocTasksCompleted,
          }),
          ...(payload.totalTasksAcrossAllDocs !== undefined && {
            totalTasksAcrossAllDocs: payload.totalTasksAcrossAllDocs,
          }),
          ...(payload.completedTasksAcrossAllDocs !== undefined && {
            completedTasksAcrossAllDocs: payload.completedTasksAcrossAllDocs,
          }),
          // Legacy fields
          ...(payload.totalTasks !== undefined && { totalTasks: payload.totalTasks }),
          ...(payload.completedTasks !== undefined && { completedTasks: payload.completedTasks }),
          ...(payload.currentTaskIndex !== undefined && { currentTaskIndex: payload.currentTaskIndex }),
          ...(payload.sessionIds !== undefined && { sessionIds: payload.sessionIds }),
          // Time tracking
          ...(payload.accumulatedElapsedMs !== undefined && {
            accumulatedElapsedMs: payload.accumulatedElapsedMs,
          }),
          ...(payload.lastActiveTimestamp !== undefined && {
            lastActiveTimestamp: payload.lastActiveTimestamp,
          }),
          // Loop iteration
          ...(payload.loopIteration !== undefined && { loopIteration: payload.loopIteration }),
        },
      };
    }

    case 'SET_STOPPING': {
      const { sessionId } = action;
      const currentState = state[sessionId] || DEFAULT_BATCH_STATE;

      return {
        ...state,
        [sessionId]: {
          ...currentState,
          isStopping: true,
        },
      };
    }

    case 'SET_ERROR': {
      const { sessionId, payload } = action;
      const currentState = state[sessionId];
      if (!currentState || !currentState.isRunning) return state;

      return {
        ...state,
        [sessionId]: {
          ...currentState,
          error: payload.error,
          errorPaused: true,
          errorDocumentIndex: payload.documentIndex,
          errorTaskDescription: payload.taskDescription,
        },
      };
    }

    case 'CLEAR_ERROR': {
      const { sessionId } = action;
      const currentState = state[sessionId];
      if (!currentState) return state;

      return {
        ...state,
        [sessionId]: {
          ...currentState,
          error: undefined,
          errorPaused: false,
          errorDocumentIndex: undefined,
          errorTaskDescription: undefined,
        },
      };
    }

    case 'COMPLETE_BATCH': {
      const { sessionId, finalSessionIds } = action;
      const currentState = state[sessionId];
      // Keep sessionIds if we have them, for session linking after completion
      const sessionIds = finalSessionIds ?? currentState?.sessionIds ?? [];

      return {
        ...state,
        [sessionId]: {
          isRunning: false,
          isStopping: false,
          documents: [],
          lockedDocuments: [],
          currentDocumentIndex: 0,
          currentDocTasksTotal: 0,
          currentDocTasksCompleted: 0,
          totalTasksAcrossAllDocs: 0,
          completedTasksAcrossAllDocs: 0,
          loopEnabled: false,
          loopIteration: 0,
          folderPath: '',
          // Clear worktree tracking
          worktreeActive: false,
          worktreePath: undefined,
          worktreeBranch: undefined,
          // Legacy fields
          totalTasks: 0,
          completedTasks: 0,
          currentTaskIndex: 0,
          originalContent: '',
          sessionIds,
          // Clear error state
          error: undefined,
          errorPaused: false,
          errorDocumentIndex: undefined,
          errorTaskDescription: undefined,
        },
      };
    }

    case 'INCREMENT_LOOP': {
      const { sessionId, newTotalTasks } = action;
      const currentState = state[sessionId];
      if (!currentState) return state;

      const nextLoopIteration = currentState.loopIteration + 1;

      return {
        ...state,
        [sessionId]: {
          ...currentState,
          loopIteration: nextLoopIteration,
          totalTasksAcrossAllDocs: newTotalTasks + currentState.completedTasksAcrossAllDocs,
          totalTasks: newTotalTasks + currentState.completedTasks,
        },
      };
    }

    default:
      return state;
  }
}
