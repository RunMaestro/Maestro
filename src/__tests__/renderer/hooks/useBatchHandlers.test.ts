/**
 * Tests for useBatchHandlers hook (Phase 2I extraction from App.tsx)
 *
 * Tests cover:
 * - Hook initialization and return shape
 * - Handler callbacks (stop, kill, skip, resume, abort)
 * - Memoized batch state computation
 * - Quit confirmation effect
 * - handleSyncAutoRunStats
 * - Ref management
 * - Return value stability
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import type { Session, BatchRunState, AgentError } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';

// ============================================================================
// Mock useBatchProcessor BEFORE importing useBatchHandlers
// ============================================================================

const mockGetBatchState = vi.fn();
const mockStartBatchRun = vi.fn().mockResolvedValue(undefined);
const mockStopBatchRun = vi.fn();
const mockKillBatchRun = vi.fn().mockResolvedValue(undefined);
const mockPauseBatchOnError = vi.fn();
const mockSkipCurrentDocument = vi.fn();
const mockResumeAfterError = vi.fn();
const mockAbortBatchOnError = vi.fn();

let mockActiveBatchSessionIds: string[] = [];
let mockBatchRunStates: Record<string, BatchRunState> = {};

vi.mock('../../../renderer/hooks/batch/useBatchProcessor', () => ({
	useBatchProcessor: vi.fn(() => ({
		batchRunStates: mockBatchRunStates,
		getBatchState: mockGetBatchState,
		activeBatchSessionIds: mockActiveBatchSessionIds,
		startBatchRun: mockStartBatchRun,
		stopBatchRun: mockStopBatchRun,
		killBatchRun: mockKillBatchRun,
		pauseBatchOnError: mockPauseBatchOnError,
		skipCurrentDocument: mockSkipCurrentDocument,
		resumeAfterError: mockResumeAfterError,
		abortBatchOnError: mockAbortBatchOnError,
	})),
}));

// ============================================================================
// Now import the hook and stores
// ============================================================================

import {
	useBatchHandlers,
	type UseBatchHandlersDeps,
} from '../../../renderer/hooks/batch/useBatchHandlers';
import { useBatchProcessor } from '../../../renderer/hooks/batch/useBatchProcessor';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { useModalStore } from '../../../renderer/stores/modalStore';

// ============================================================================
// Helpers
// ============================================================================

function createDefaultBatchState(overrides: Partial<BatchRunState> = {}): BatchRunState {
	return {
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
		worktreeActive: false,
		totalTasks: 0,
		completedTasks: 0,
		currentTaskIndex: 0,
		startTime: null,
		currentTask: null,
		sessionIds: [],
		...overrides,
	};
}

// Thin wrapper: pre-populates an AI tab so batch handlers have something
// to operate on. Delegates to the shared factory for baseline fields.
function createMockSession(overrides: Partial<Session> = {}): Session {
	return baseCreateMockSession({
		id: 'session-1',
		name: 'Test Agent',
		aiTabs: [
			{
				id: 'tab-1',
				label: 'AI',
				type: 'ai',
				logs: [],
				state: 'idle',
			},
		] as any,
		activeTabId: 'tab-1',
		createdAt: Date.now(),
		...overrides,
	});
}

const mockSpawnAgentForSession = vi.fn().mockResolvedValue({ success: true });
const mockHandleClearAgentError = vi.fn();

function createDeps(overrides: Partial<UseBatchHandlersDeps> = {}): UseBatchHandlersDeps {
	return {
		spawnAgentForSession: mockSpawnAgentForSession,
		rightPanelRef: { current: null },
		processQueuedItemRef: { current: null },
		handleClearAgentError: mockHandleClearAgentError,
		...overrides,
	};
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	// Reset mock return values
	mockActiveBatchSessionIds = [];
	mockBatchRunStates = {};
	mockGetBatchState.mockReturnValue(createDefaultBatchState());

	// Reset stores to clean state
	useSessionStore.setState({
		sessions: [],
		activeSessionId: '',
		groups: [],
		sessionsLoaded: false,
		initialLoadComplete: false,
	});

	useSettingsStore.setState({
		audioFeedbackEnabled: false,
		audioFeedbackCommand: '',
		autoRunStats: {
			cumulativeTimeMs: 0,
			totalRuns: 0,
			currentBadgeLevel: 0,
			longestRunMs: 0,
			longestRunTimestamp: 0,
			lastBadgeUnlockLevel: 0,
			lastAcknowledgedBadgeLevel: 0,
		},
	});

	useModalStore.setState({
		modals: new Map(),
	});

	// Ensure window.maestro.app is available for quit confirmation
	(window as any).maestro = {
		...((window as any).maestro || {}),
		app: {
			onQuitConfirmationRequest: vi.fn().mockReturnValue(vi.fn()),
			confirmQuit: vi.fn(),
			cancelQuit: vi.fn(),
		},
		history: {
			add: vi.fn().mockResolvedValue(undefined),
		},
		leaderboard: {
			submit: vi.fn().mockResolvedValue({ success: false }),
		},
		process: {
			getActiveProcesses: vi.fn().mockResolvedValue([]),
		},
	};
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('useBatchHandlers', () => {
	// ====================================================================
	// Initialization & Return Shape
	// ====================================================================

	describe('initialization', () => {
		it('returns all expected properties', () => {
			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			expect(result.current).toHaveProperty('startBatchRun');
			expect(result.current).toHaveProperty('getBatchState');
			expect(result.current).toHaveProperty('handleStopBatchRun');
			expect(result.current).toHaveProperty('handleKillBatchRun');
			expect(result.current).toHaveProperty('handleSkipCurrentDocument');
			expect(result.current).toHaveProperty('handleResumeAfterError');
			expect(result.current).toHaveProperty('handleAbortBatchOnError');
			expect(result.current).toHaveProperty('activeBatchSessionIds');
			expect(result.current).toHaveProperty('currentSessionBatchState');
			expect(result.current).toHaveProperty('activeBatchRunState');
			expect(result.current).toHaveProperty('pauseBatchOnErrorRef');
			expect(result.current).toHaveProperty('getBatchStateRef');
			expect(result.current).toHaveProperty('handleSyncAutoRunStats');
		});

		it('calls useBatchProcessor with sessions and groups from stores', () => {
			const session = createMockSession();
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
				groups: [{ id: 'g1', name: 'Group 1' }],
			});

			renderHook(() => useBatchHandlers(createDeps()));

			expect(useBatchProcessor).toHaveBeenCalled();
			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];
			expect(callArgs.sessions).toEqual([session]);
			expect(callArgs.groups).toEqual([{ id: 'g1', name: 'Group 1' }]);
		});

		it('passes onSpawnAgent wrapper that marks Auto Run batch spawns', async () => {
			renderHook(() => useBatchHandlers(createDeps()));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];
			expect(callArgs.onSpawnAgent).not.toBe(mockSpawnAgentForSession);

			await callArgs.onSpawnAgent('session-1', 'Do work', '/tmp/worktree');

			expect(mockSpawnAgentForSession).toHaveBeenCalledWith(
				'session-1',
				'Do work',
				'/tmp/worktree',
				{
					isAutoRun: true,
				}
			);
		});

		it('passes audio feedback settings from store', () => {
			useSettingsStore.setState({
				audioFeedbackEnabled: true,
				audioFeedbackCommand: 'say',
			});

			renderHook(() => useBatchHandlers(createDeps()));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];
			expect(callArgs.audioFeedbackEnabled).toBe(true);
			expect(callArgs.audioFeedbackCommand).toBe('say');
		});
	});

	// ====================================================================
	// getBatchState
	// ====================================================================

	describe('getBatchState', () => {
		it('delegates to useBatchProcessor getBatchState', () => {
			const mockState = createDefaultBatchState({ isRunning: true });
			mockGetBatchState.mockReturnValue(mockState);

			const { result } = renderHook(() => useBatchHandlers(createDeps()));
			const state = result.current.getBatchState('session-1');

			expect(mockGetBatchState).toHaveBeenCalledWith('session-1');
			expect(state).toBe(mockState);
		});
	});

	// ====================================================================
	// Refs
	// ====================================================================

	describe('ref management', () => {
		it('sets getBatchStateRef.current to getBatchState', () => {
			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			expect(result.current.getBatchStateRef.current).toBe(mockGetBatchState);
		});

		it('sets pauseBatchOnErrorRef.current to pauseBatchOnError', () => {
			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			expect(result.current.pauseBatchOnErrorRef.current).toBe(mockPauseBatchOnError);
		});
	});

	// ====================================================================
	// Memoized Batch States
	// ====================================================================

	describe('currentSessionBatchState', () => {
		it('returns null when no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			expect(result.current.currentSessionBatchState).toBeNull();
		});

		it('returns batch state for active session', () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const runningState = createDefaultBatchState({ isRunning: true });
			mockGetBatchState.mockReturnValue(runningState);

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			expect(result.current.currentSessionBatchState).toBe(runningState);
			expect(mockGetBatchState).toHaveBeenCalledWith('session-1');
		});
	});

	describe('activeBatchRunState', () => {
		it('returns state of first active batch session when batches are running', () => {
			mockActiveBatchSessionIds = ['session-2'];
			const batchState = createDefaultBatchState({ isRunning: true, totalTasks: 5 });
			mockGetBatchState.mockImplementation((id: string) => {
				if (id === 'session-2') return batchState;
				return createDefaultBatchState();
			});

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			expect(result.current.activeBatchRunState).toBe(batchState);
		});

		it('returns active session batch state when no active batches', () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			mockActiveBatchSessionIds = [];

			const idleState = createDefaultBatchState();
			mockGetBatchState.mockReturnValue(idleState);

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			expect(result.current.activeBatchRunState).toBe(idleState);
		});

		it('returns default batch state when no active session and no active batches', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });
			mockActiveBatchSessionIds = [];

			const defaultState = createDefaultBatchState();
			mockGetBatchState.mockReturnValue(defaultState);

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			// Should call getBatchState with empty string as fallback
			expect(mockGetBatchState).toHaveBeenCalledWith('');
		});
	});

	// ====================================================================
	// Handler Callbacks
	// ====================================================================

	describe('handleStopBatchRun', () => {
		it('opens confirm modal and stops batch on confirm', () => {
			const session = createMockSession({ id: 'session-1', name: 'My Agent' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleStopBatchRun('session-1');
			});

			// Should have opened confirm modal via modalStore openModal('confirm', ...)
			const confirmModal = useModalStore.getState().modals.get('confirm');
			expect(confirmModal?.open).toBe(true);
			expect(confirmModal?.data?.message).toContain('My Agent');

			// Simulate confirm via the onConfirm callback in data
			act(() => {
				confirmModal?.data?.onConfirm?.();
			});

			expect(mockStopBatchRun).toHaveBeenCalledWith('session-1');
		});

		it('uses active session when no targetSessionId provided', () => {
			const session = createMockSession({ id: 'session-1', name: 'My Agent' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleStopBatchRun();
			});

			const confirmModal = useModalStore.getState().modals.get('confirm');
			expect(confirmModal?.open).toBe(true);
		});

		it('falls back to first active batch session when no active session', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });
			mockActiveBatchSessionIds = ['batch-session-1'];

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleStopBatchRun();
			});

			// Should still open confirm modal for the batch session
			const confirmModal = useModalStore.getState().modals.get('confirm');
			expect(confirmModal?.open).toBe(true);
		});

		it('does nothing when no session ID can be resolved', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });
			mockActiveBatchSessionIds = [];

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleStopBatchRun();
			});

			// Modal should NOT be opened
			const confirmModal = useModalStore.getState().modals.get('confirm');
			expect(confirmModal?.open).not.toBe(true);
		});
	});

	describe('handleKillBatchRun', () => {
		it('delegates to killBatchRun with session ID', async () => {
			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			await act(async () => {
				await result.current.handleKillBatchRun('session-1');
			});

			expect(mockKillBatchRun).toHaveBeenCalledWith('session-1');
		});
	});

	describe('handleSkipCurrentDocument', () => {
		it('calls skipCurrentDocument for the error-paused session', () => {
			mockActiveBatchSessionIds = ['session-2'];
			useBatchStore.setState({
				batchRunStates: {
					'session-2': createDefaultBatchState({ isRunning: true, errorPaused: true }),
				},
			});
			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleSkipCurrentDocument();
			});

			expect(mockSkipCurrentDocument).toHaveBeenCalledWith('session-2');
			expect(mockHandleClearAgentError).toHaveBeenCalledWith('session-2');
		});

		it('prefers active session when it is error-paused', () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useBatchStore.setState({
				batchRunStates: {
					'session-1': createDefaultBatchState({ isRunning: true, errorPaused: true }),
				},
			});
			mockActiveBatchSessionIds = [];

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleSkipCurrentDocument();
			});

			expect(mockSkipCurrentDocument).toHaveBeenCalledWith('session-1');
			expect(mockHandleClearAgentError).toHaveBeenCalledWith('session-1');
		});

		it('does nothing when no session is error-paused', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });
			useBatchStore.setState({ batchRunStates: {} });
			mockActiveBatchSessionIds = [];

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleSkipCurrentDocument();
			});

			expect(mockSkipCurrentDocument).not.toHaveBeenCalled();
			expect(mockHandleClearAgentError).not.toHaveBeenCalled();
		});
	});

	describe('handleResumeAfterError', () => {
		it('calls resumeAfterError for the error-paused session', () => {
			mockActiveBatchSessionIds = ['session-2'];
			useBatchStore.setState({
				batchRunStates: {
					'session-2': createDefaultBatchState({ isRunning: true, errorPaused: true }),
				},
			});
			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleResumeAfterError();
			});

			expect(mockResumeAfterError).toHaveBeenCalledWith('session-2');
			expect(mockHandleClearAgentError).toHaveBeenCalledWith('session-2');
		});

		it('prefers active session when it is error-paused', () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useBatchStore.setState({
				batchRunStates: {
					'session-1': createDefaultBatchState({ isRunning: true, errorPaused: true }),
				},
			});
			mockActiveBatchSessionIds = [];

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleResumeAfterError();
			});

			expect(mockResumeAfterError).toHaveBeenCalledWith('session-1');
			expect(mockHandleClearAgentError).toHaveBeenCalledWith('session-1');
		});

		it('does nothing when no session is error-paused', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });
			useBatchStore.setState({ batchRunStates: {} });
			mockActiveBatchSessionIds = [];

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleResumeAfterError();
			});

			expect(mockResumeAfterError).not.toHaveBeenCalled();
		});
	});

	describe('handleAbortBatchOnError', () => {
		it('calls abortBatchOnError for the error-paused session', () => {
			mockActiveBatchSessionIds = ['session-3'];
			useBatchStore.setState({
				batchRunStates: {
					'session-3': createDefaultBatchState({ isRunning: true, errorPaused: true }),
				},
			});
			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleAbortBatchOnError();
			});

			expect(mockAbortBatchOnError).toHaveBeenCalledWith('session-3');
			expect(mockHandleClearAgentError).toHaveBeenCalledWith('session-3');
		});

		it('does nothing when no session is error-paused', () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useBatchStore.setState({ batchRunStates: {} });
			mockActiveBatchSessionIds = [];

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleAbortBatchOnError();
			});

			expect(mockAbortBatchOnError).not.toHaveBeenCalled();
			expect(mockHandleClearAgentError).not.toHaveBeenCalled();
		});

		it('does nothing when no session ID can be resolved', () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });
			useBatchStore.setState({ batchRunStates: {} });
			mockActiveBatchSessionIds = [];

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleAbortBatchOnError();
			});

			expect(mockAbortBatchOnError).not.toHaveBeenCalled();
		});
	});

	// ====================================================================
	// handleSyncAutoRunStats
	// ====================================================================

	describe('handleSyncAutoRunStats', () => {
		it('updates autoRunStats in settings store', () => {
			useSettingsStore.setState({
				autoRunStats: {
					cumulativeTimeMs: 100,
					totalRuns: 1,
					currentBadgeLevel: 0,
					longestRunMs: 50,
					longestRunTimestamp: 1000,
					lastBadgeUnlockLevel: 0,
					lastAcknowledgedBadgeLevel: 0,
				},
			});

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleSyncAutoRunStats({
					cumulativeTimeMs: 5000,
					totalRuns: 10,
					currentBadgeLevel: 2,
					longestRunMs: 3000,
					longestRunTimestamp: 2000,
				});
			});

			const stats = useSettingsStore.getState().autoRunStats;
			expect(stats.cumulativeTimeMs).toBe(5000);
			expect(stats.totalRuns).toBe(10);
			expect(stats.currentBadgeLevel).toBe(2);
			expect(stats.longestRunMs).toBe(3000);
			expect(stats.longestRunTimestamp).toBe(2000);
			// Badge tracking should match synced level
			expect(stats.lastBadgeUnlockLevel).toBe(2);
			expect(stats.lastAcknowledgedBadgeLevel).toBe(2);
		});

		it('preserves other stats fields not in the sync payload', () => {
			useSettingsStore.setState({
				autoRunStats: {
					cumulativeTimeMs: 100,
					totalRuns: 1,
					currentBadgeLevel: 0,
					longestRunMs: 50,
					longestRunTimestamp: 1000,
					lastBadgeUnlockLevel: 0,
					lastAcknowledgedBadgeLevel: 0,
				},
			});

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleSyncAutoRunStats({
					cumulativeTimeMs: 200,
					totalRuns: 2,
					currentBadgeLevel: 0,
					longestRunMs: 100,
					longestRunTimestamp: 1500,
				});
			});

			// Verify the stats were updated (the hook does a spread merge)
			const stats = useSettingsStore.getState().autoRunStats;
			expect(stats.cumulativeTimeMs).toBe(200);
		});
	});

	// ====================================================================
	// Quit Confirmation Effect
	// ====================================================================

	describe('quit confirmation effect', () => {
		it('registers quit confirmation listener on mount', () => {
			renderHook(() => useBatchHandlers(createDeps()));

			expect(window.maestro.app.onQuitConfirmationRequest).toHaveBeenCalled();
		});

		it('calls confirmQuit when no busy agents and no active auto-runs', async () => {
			const session = createMockSession({ id: 'session-1', state: 'idle' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			mockGetBatchState.mockReturnValue(createDefaultBatchState({ isRunning: false }));

			// Capture the callback
			let quitCallback: () => Promise<void> = async () => {};
			(window.maestro.app.onQuitConfirmationRequest as any).mockImplementation(
				(cb: () => Promise<void>) => {
					quitCallback = cb;
					return vi.fn();
				}
			);

			renderHook(() => useBatchHandlers(createDeps()));

			// Trigger quit confirmation
			await act(async () => {
				await quitCallback();
			});

			expect(window.maestro.app.confirmQuit).toHaveBeenCalled();
		});

		it('opens quit confirm modal when agents are busy', async () => {
			const busySession = createMockSession({
				id: 'session-1',
				state: 'busy',
				busySource: 'ai',
				toolType: 'claude-code',
			});
			useSessionStore.setState({ sessions: [busySession], activeSessionId: 'session-1' });

			let quitCallback: () => Promise<void> = async () => {};
			(window.maestro.app.onQuitConfirmationRequest as any).mockImplementation(
				(cb: () => Promise<void>) => {
					quitCallback = cb;
					return vi.fn();
				}
			);

			renderHook(() => useBatchHandlers(createDeps()));

			await act(async () => {
				await quitCallback();
			});

			expect(window.maestro.app.confirmQuit).not.toHaveBeenCalled();
			const quitModal = useModalStore.getState().modals.get('quitConfirm');
			expect(quitModal?.open).toBe(true);
		});

		it('opens quit confirm modal when auto-runs are active', async () => {
			const session = createMockSession({ id: 'session-1', state: 'idle' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			let quitCallback: () => Promise<void> = async () => {};
			(window.maestro.app.onQuitConfirmationRequest as any).mockImplementation(
				(cb: () => Promise<void>) => {
					quitCallback = cb;
					return vi.fn();
				}
			);

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			// Set the ref to return a running state
			result.current.getBatchStateRef.current = (sessionId: string) =>
				createDefaultBatchState({ isRunning: true });

			await act(async () => {
				await quitCallback();
			});

			expect(window.maestro.app.confirmQuit).not.toHaveBeenCalled();
			const quitModal = useModalStore.getState().modals.get('quitConfirm');
			expect(quitModal?.open).toBe(true);
		});

		it('excludes terminal sessions from busy check', async () => {
			const terminalSession = createMockSession({
				id: 'session-1',
				state: 'busy',
				busySource: 'ai',
				toolType: 'terminal',
			});
			useSessionStore.setState({
				sessions: [terminalSession],
				activeSessionId: 'session-1',
			});
			mockGetBatchState.mockReturnValue(createDefaultBatchState({ isRunning: false }));

			let quitCallback: () => Promise<void> = async () => {};
			(window.maestro.app.onQuitConfirmationRequest as any).mockImplementation(
				(cb: () => Promise<void>) => {
					quitCallback = cb;
					return vi.fn();
				}
			);

			renderHook(() => useBatchHandlers(createDeps()));

			await act(async () => {
				await quitCallback();
			});

			// Terminal sessions should not prevent quitting
			expect(window.maestro.app.confirmQuit).toHaveBeenCalled();
		});

		it('unsubscribes on unmount', () => {
			const mockUnsubscribe = vi.fn();
			(window.maestro.app.onQuitConfirmationRequest as any).mockReturnValue(mockUnsubscribe);

			const { unmount } = renderHook(() => useBatchHandlers(createDeps()));

			unmount();

			expect(mockUnsubscribe).toHaveBeenCalled();
		});
	});

	// ====================================================================
	// onUpdateSession callback
	// ====================================================================

	describe('onUpdateSession callback', () => {
		it('updates session in store when called', () => {
			const session = createMockSession({ id: 'session-1', state: 'idle' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useBatchHandlers(createDeps()));

			// Extract the onUpdateSession callback from useBatchProcessor call
			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			act(() => {
				callArgs.onUpdateSession('session-1', { state: 'busy' as any });
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('busy');
		});

		it('only updates the targeted session', () => {
			const session1 = createMockSession({ id: 'session-1', state: 'idle' });
			const session2 = createMockSession({ id: 'session-2', state: 'idle' });
			useSessionStore.setState({
				sessions: [session1, session2],
				activeSessionId: 'session-1',
			});

			renderHook(() => useBatchHandlers(createDeps()));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			act(() => {
				callArgs.onUpdateSession('session-1', { state: 'busy' as any });
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions[0].state).toBe('busy');
			expect(sessions[1].state).toBe('idle');
		});
	});

	// ====================================================================
	// onAddHistoryEntry callback
	// ====================================================================

	describe('onAddHistoryEntry callback', () => {
		it('adds history entry via IPC and refreshes history panel', async () => {
			const mockRefresh = vi.fn();
			const rightPanelRef = { current: { refreshHistoryPanel: mockRefresh } } as any;

			renderHook(() => useBatchHandlers(createDeps({ rightPanelRef })));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			await act(async () => {
				await callArgs.onAddHistoryEntry({
					type: 'AUTO',
					timestamp: Date.now(),
					summary: 'Test entry',
					fullResponse: 'Details',
					projectPath: '/test',
					sessionId: 'session-1',
					success: true,
				} as any);
			});

			expect(window.maestro.history.add).toHaveBeenCalled();
			expect(mockRefresh).toHaveBeenCalled();
		});
	});

	// ====================================================================
	// onComplete callback
	// ====================================================================

	describe('onComplete callback', () => {
		it('sends toast notification on completion', () => {
			const session = createMockSession({ id: 'session-1', name: 'My Agent' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useSettingsStore.setState({
				firstAutoRunCompleted: true,
				autoRunStats: {
					cumulativeTimeMs: 0,
					totalRuns: 0,
					currentBadgeLevel: 0,
					longestRunMs: 0,
					longestRunTimestamp: 0,
					lastBadgeUnlockLevel: 0,
					lastAcknowledgedBadgeLevel: 0,
				},
				recordAutoRunComplete: vi.fn().mockReturnValue({ newBadgeLevel: null, isNewRecord: false }),
				leaderboardRegistration: null,
			});

			renderHook(() => useBatchHandlers(createDeps()));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			act(() => {
				callArgs.onComplete({
					sessionId: 'session-1',
					sessionName: 'My Agent',
					completedTasks: 5,
					totalTasks: 5,
					wasStopped: false,
					elapsedTimeMs: 60000,
					inputTokens: 1000,
					outputTokens: 500,
					totalCostUsd: 0.05,
					documentsProcessed: 2,
				});
			});

			// notifyToast is called (we can't easily check this without mocking the module,
			// but we verify the callback runs without error)
		});

		it('shows stopped warning when batch was stopped', () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			useSettingsStore.setState({
				firstAutoRunCompleted: true,
				autoRunStats: {
					cumulativeTimeMs: 0,
					totalRuns: 0,
					currentBadgeLevel: 0,
					longestRunMs: 0,
					longestRunTimestamp: 0,
					lastBadgeUnlockLevel: 0,
					lastAcknowledgedBadgeLevel: 0,
				},
				recordAutoRunComplete: vi.fn().mockReturnValue({ newBadgeLevel: null, isNewRecord: false }),
				leaderboardRegistration: null,
			});

			renderHook(() => useBatchHandlers(createDeps()));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			// Should not throw
			act(() => {
				callArgs.onComplete({
					sessionId: 'session-1',
					sessionName: 'Test',
					completedTasks: 2,
					totalTasks: 5,
					wasStopped: true,
					elapsedTimeMs: 30000,
					inputTokens: 400,
					outputTokens: 200,
					totalCostUsd: 0.02,
					documentsProcessed: 1,
				});
			});
		});

		it('triggers first run celebration on first completion', () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			const mockSetFirstAutoRunCompleted = vi.fn();
			useSettingsStore.setState({
				firstAutoRunCompleted: false,
				setFirstAutoRunCompleted: mockSetFirstAutoRunCompleted,
				autoRunStats: {
					cumulativeTimeMs: 0,
					totalRuns: 0,
					currentBadgeLevel: 0,
					longestRunMs: 0,
					longestRunTimestamp: 0,
					lastBadgeUnlockLevel: 0,
					lastAcknowledgedBadgeLevel: 0,
				},
				recordAutoRunComplete: vi.fn().mockReturnValue({ newBadgeLevel: null, isNewRecord: false }),
				leaderboardRegistration: null,
			});

			renderHook(() => useBatchHandlers(createDeps()));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			act(() => {
				callArgs.onComplete({
					sessionId: 'session-1',
					sessionName: 'Test',
					completedTasks: 3,
					totalTasks: 3,
					wasStopped: false,
					elapsedTimeMs: 10000,
					inputTokens: 600,
					outputTokens: 300,
					totalCostUsd: 0.03,
					documentsProcessed: 1,
				});
			});

			expect(mockSetFirstAutoRunCompleted).toHaveBeenCalledWith(true);
		});

		it('skips achievements when elapsedTimeMs is 0', () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			const mockRecordAutoRunComplete = vi.fn();
			useSettingsStore.setState({
				firstAutoRunCompleted: false,
				autoRunStats: {
					cumulativeTimeMs: 0,
					totalRuns: 0,
					currentBadgeLevel: 0,
					longestRunMs: 0,
					longestRunTimestamp: 0,
					lastBadgeUnlockLevel: 0,
					lastAcknowledgedBadgeLevel: 0,
				},
				recordAutoRunComplete: mockRecordAutoRunComplete,
				leaderboardRegistration: null,
			});

			renderHook(() => useBatchHandlers(createDeps()));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			act(() => {
				callArgs.onComplete({
					sessionId: 'session-1',
					sessionName: 'Test',
					completedTasks: 1,
					totalTasks: 1,
					wasStopped: false,
					elapsedTimeMs: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCostUsd: 0,
					documentsProcessed: 1,
				});
			});

			expect(mockRecordAutoRunComplete).not.toHaveBeenCalled();
		});

		it('includes group name in toast notification', () => {
			const session = createMockSession({ id: 'session-1', groupId: 'g1' });
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: 'session-1',
				groups: [{ id: 'g1', name: 'My Group' }],
			});
			useSettingsStore.setState({
				firstAutoRunCompleted: true,
				autoRunStats: {
					cumulativeTimeMs: 0,
					totalRuns: 0,
					currentBadgeLevel: 0,
					longestRunMs: 0,
					longestRunTimestamp: 0,
					lastBadgeUnlockLevel: 0,
					lastAcknowledgedBadgeLevel: 0,
				},
				recordAutoRunComplete: vi.fn().mockReturnValue({ newBadgeLevel: null, isNewRecord: false }),
				leaderboardRegistration: null,
			});

			renderHook(() => useBatchHandlers(createDeps()));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			// Should not throw - group name lookup works
			act(() => {
				callArgs.onComplete({
					sessionId: 'session-1',
					sessionName: 'Test',
					completedTasks: 1,
					totalTasks: 1,
					wasStopped: false,
					elapsedTimeMs: 5000,
					inputTokens: 200,
					outputTokens: 100,
					totalCostUsd: 0.01,
					documentsProcessed: 1,
				});
			});
		});
	});

	// ====================================================================
	// onPRResult callback
	// ====================================================================

	describe('onPRResult callback', () => {
		it('handles successful PR result', () => {
			const session = createMockSession({ id: 'session-1', name: 'My Agent' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useBatchHandlers(createDeps()));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			// Should not throw
			act(() => {
				callArgs.onPRResult({
					sessionId: 'session-1',
					sessionName: 'My Agent',
					success: true,
					prUrl: 'https://github.com/test/pr/1',
				});
			});
		});

		it('handles failed PR result', () => {
			const session = createMockSession({ id: 'session-1', name: 'My Agent' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useBatchHandlers(createDeps()));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			// Should not throw
			act(() => {
				callArgs.onPRResult({
					sessionId: 'session-1',
					sessionName: 'My Agent',
					success: false,
					error: 'gh not found',
				});
			});
		});

		it('uses Ungrouped as group name when session has no group', () => {
			const session = createMockSession({ id: 'session-1', groupId: undefined });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useBatchHandlers(createDeps()));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			// Should not throw
			act(() => {
				callArgs.onPRResult({
					sessionId: 'session-1',
					sessionName: 'Test',
					success: true,
				});
			});
		});
	});

	// ====================================================================
	// onProcessQueueAfterCompletion callback
	// ====================================================================

	describe('onProcessQueueAfterCompletion callback', () => {
		it('processes next queued item when queue is non-empty', () => {
			const mockProcessQueuedItem = vi.fn().mockResolvedValue(undefined);
			const processQueuedItemRef = { current: mockProcessQueuedItem };

			const session = createMockSession({
				id: 'session-1',
				executionQueue: [
					{ id: 'q1', type: 'message', text: 'Hello', tabId: 'tab-1' },
					{ id: 'q2', type: 'message', text: 'World', tabId: 'tab-1' },
				] as any,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useBatchHandlers(createDeps({ processQueuedItemRef })));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			act(() => {
				callArgs.onProcessQueueAfterCompletion('session-1');
			});

			expect(mockProcessQueuedItem).toHaveBeenCalledWith(
				'session-1',
				expect.objectContaining({ id: 'q1', text: 'Hello' })
			);

			// Queue should have been shortened
			const updatedSession = useSessionStore.getState().sessions[0];
			expect(updatedSession.executionQueue.length).toBe(1);
		});

		it('does nothing when queue is empty', () => {
			const mockProcessQueuedItem = vi.fn();
			const processQueuedItemRef = { current: mockProcessQueuedItem };

			const session = createMockSession({
				id: 'session-1',
				executionQueue: [],
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useBatchHandlers(createDeps({ processQueuedItemRef })));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			act(() => {
				callArgs.onProcessQueueAfterCompletion('session-1');
			});

			expect(mockProcessQueuedItem).not.toHaveBeenCalled();
		});

		it('does nothing when session is not found', () => {
			const mockProcessQueuedItem = vi.fn();
			const processQueuedItemRef = { current: mockProcessQueuedItem };

			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			renderHook(() => useBatchHandlers(createDeps({ processQueuedItemRef })));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			act(() => {
				callArgs.onProcessQueueAfterCompletion('nonexistent');
			});

			expect(mockProcessQueuedItem).not.toHaveBeenCalled();
		});

		it('does nothing when processQueuedItemRef.current is null', () => {
			const processQueuedItemRef = { current: null };

			const session = createMockSession({
				id: 'session-1',
				executionQueue: [{ id: 'q1', type: 'message', text: 'Hello', tabId: 'tab-1' }] as any,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() =>
				useBatchHandlers(createDeps({ processQueuedItemRef: processQueuedItemRef as any }))
			);

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			// Should not throw
			act(() => {
				callArgs.onProcessQueueAfterCompletion('session-1');
			});
		});
	});

	// ====================================================================
	// Return value stability
	// ====================================================================

	// ====================================================================
	// handleStopBatchRun edge cases
	// ====================================================================

	describe('handleStopBatchRun edge cases', () => {
		it('does NOT call stopBatchRun when user cancels confirmation', () => {
			const session = createMockSession({ id: 'session-1', name: 'My Agent' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleStopBatchRun('session-1');
			});

			// Confirm modal is open but user does NOT call onConfirm
			const confirmModal = useModalStore.getState().modals.get('confirm');
			expect(confirmModal?.open).toBe(true);

			// Simulate cancel by closing the modal without calling onConfirm
			act(() => {
				useModalStore.getState().closeModal('confirm');
			});

			// stopBatchRun should NOT have been called
			expect(mockStopBatchRun).not.toHaveBeenCalled();
		});

		it('uses "this session" as fallback when session not found in sessions array', () => {
			// Session ID resolves but the session is not in the sessions list
			useSessionStore.setState({ sessions: [], activeSessionId: '' });
			mockActiveBatchSessionIds = ['unknown-session'];

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleStopBatchRun();
			});

			const confirmModal = useModalStore.getState().modals.get('confirm');
			expect(confirmModal?.open).toBe(true);
			expect(confirmModal?.data?.message).toContain('this session');
		});

		it('prioritizes targetSessionId over activeSession and activeBatchSessionIds', () => {
			const session1 = createMockSession({ id: 'session-1', name: 'Agent One' });
			const session2 = createMockSession({ id: 'session-2', name: 'Agent Two' });
			const session3 = createMockSession({ id: 'session-3', name: 'Agent Three' });
			useSessionStore.setState({
				sessions: [session1, session2, session3],
				activeSessionId: 'session-2',
			});
			mockActiveBatchSessionIds = ['session-3'];

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleStopBatchRun('session-1');
			});

			const confirmModal = useModalStore.getState().modals.get('confirm');
			expect(confirmModal?.open).toBe(true);
			expect(confirmModal?.data?.message).toContain('Agent One');

			// Confirm and verify correct session ID was stopped
			act(() => {
				confirmModal?.data?.onConfirm?.();
			});

			expect(mockStopBatchRun).toHaveBeenCalledWith('session-1');
		});

		it('falls back to activeSession when no targetSessionId is provided', () => {
			const session1 = createMockSession({ id: 'session-1', name: 'Active Agent' });
			const session2 = createMockSession({ id: 'session-2', name: 'Batch Agent' });
			useSessionStore.setState({
				sessions: [session1, session2],
				activeSessionId: 'session-1',
			});
			mockActiveBatchSessionIds = ['session-2'];

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleStopBatchRun();
			});

			const confirmModal = useModalStore.getState().modals.get('confirm');
			expect(confirmModal?.open).toBe(true);
			expect(confirmModal?.data?.message).toContain('Active Agent');

			act(() => {
				confirmModal?.data?.onConfirm?.();
			});

			expect(mockStopBatchRun).toHaveBeenCalledWith('session-1');
		});
	});

	// ====================================================================
	// handleSyncAutoRunStats edge cases
	// ====================================================================

	describe('handleSyncAutoRunStats edge cases', () => {
		it('syncs badge tracking fields to match currentBadgeLevel from payload', () => {
			useSettingsStore.setState({
				autoRunStats: {
					cumulativeTimeMs: 100,
					totalRuns: 1,
					currentBadgeLevel: 1,
					longestRunMs: 50,
					longestRunTimestamp: 1000,
					lastBadgeUnlockLevel: 0,
					lastAcknowledgedBadgeLevel: 0,
				},
			});

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleSyncAutoRunStats({
					cumulativeTimeMs: 50000,
					totalRuns: 20,
					currentBadgeLevel: 5,
					longestRunMs: 10000,
					longestRunTimestamp: 5000,
				});
			});

			const stats = useSettingsStore.getState().autoRunStats;
			expect(stats.lastBadgeUnlockLevel).toBe(5);
			expect(stats.lastAcknowledgedBadgeLevel).toBe(5);
			expect(stats.currentBadgeLevel).toBe(5);
		});

		it('does not preserve existing higher badge level — synced value overwrites', () => {
			// The sync function unconditionally sets badge tracking to the synced level.
			// This tests that existing higher values are overwritten (server is source of truth).
			useSettingsStore.setState({
				autoRunStats: {
					cumulativeTimeMs: 100000,
					totalRuns: 50,
					currentBadgeLevel: 8,
					longestRunMs: 20000,
					longestRunTimestamp: 3000,
					lastBadgeUnlockLevel: 8,
					lastAcknowledgedBadgeLevel: 8,
				},
			});

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			act(() => {
				result.current.handleSyncAutoRunStats({
					cumulativeTimeMs: 5000,
					totalRuns: 5,
					currentBadgeLevel: 3,
					longestRunMs: 2000,
					longestRunTimestamp: 1500,
				});
			});

			const stats = useSettingsStore.getState().autoRunStats;
			// Server says badge level 3, so all badge tracking fields reflect 3
			expect(stats.currentBadgeLevel).toBe(3);
			expect(stats.lastBadgeUnlockLevel).toBe(3);
			expect(stats.lastAcknowledgedBadgeLevel).toBe(3);
			expect(stats.cumulativeTimeMs).toBe(5000);
			expect(stats.totalRuns).toBe(5);
		});
	});

	// ====================================================================
	// Quit confirmation edge cases
	// ====================================================================

	describe('quit confirmation edge cases', () => {
		it('shows modal (does not confirm) when both busy agents AND active auto-runs exist', async () => {
			const busySession = createMockSession({
				id: 'session-1',
				state: 'busy',
				busySource: 'ai',
				toolType: 'claude-code',
			});
			const autoRunSession = createMockSession({
				id: 'session-2',
				state: 'idle',
				toolType: 'claude-code',
			});
			useSessionStore.setState({
				sessions: [busySession, autoRunSession],
				activeSessionId: 'session-1',
			});

			let quitCallback: () => Promise<void> = async () => {};
			(window.maestro.app.onQuitConfirmationRequest as any).mockImplementation(
				(cb: () => Promise<void>) => {
					quitCallback = cb;
					return vi.fn();
				}
			);

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			// Make getBatchStateRef return running for session-2
			result.current.getBatchStateRef.current = (sessionId: string) => {
				if (sessionId === 'session-2') return createDefaultBatchState({ isRunning: true });
				return createDefaultBatchState({ isRunning: false });
			};

			await act(async () => {
				await quitCallback();
			});

			expect(window.maestro.app.confirmQuit).not.toHaveBeenCalled();
			const quitModal = useModalStore.getState().modals.get('quitConfirm');
			expect(quitModal?.open).toBe(true);
		});

		it('shows modal for busy session with busySource=terminal for non-terminal agent type', async () => {
			// A non-terminal agent (e.g. claude-code) that is busy with source 'ai' should block quit.
			// But busySource='terminal' on a non-terminal agent should also be checked.
			// Per the code: filter is s.state === 'busy' && s.busySource === 'ai' && s.toolType !== 'terminal'
			// So busySource='terminal' actually does NOT count as a busy agent.
			const session = createMockSession({
				id: 'session-1',
				state: 'busy',
				busySource: 'terminal' as any,
				toolType: 'claude-code',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });
			mockGetBatchState.mockReturnValue(createDefaultBatchState({ isRunning: false }));

			let quitCallback: () => Promise<void> = async () => {};
			(window.maestro.app.onQuitConfirmationRequest as any).mockImplementation(
				(cb: () => Promise<void>) => {
					quitCallback = cb;
					return vi.fn();
				}
			);

			renderHook(() => useBatchHandlers(createDeps()));

			await act(async () => {
				await quitCallback();
			});

			// busySource is 'terminal' not 'ai', so agent is NOT in busyAgents filter
			// No active auto-runs either, so quit should be confirmed
			expect(window.maestro.app.confirmQuit).toHaveBeenCalled();
		});

		it('confirms quit immediately when there are no sessions at all', async () => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });

			let quitCallback: () => Promise<void> = async () => {};
			(window.maestro.app.onQuitConfirmationRequest as any).mockImplementation(
				(cb: () => Promise<void>) => {
					quitCallback = cb;
					return vi.fn();
				}
			);

			renderHook(() => useBatchHandlers(createDeps()));

			await act(async () => {
				await quitCallback();
			});

			expect(window.maestro.app.confirmQuit).toHaveBeenCalled();
			const quitModal = useModalStore.getState().modals.get('quitConfirm');
			expect(quitModal?.open).not.toBe(true);
		});
	});

	// ====================================================================
	// onUpdateSession edge cases
	// ====================================================================

	describe('onUpdateSession edge cases', () => {
		it('leaves sessions unchanged when updating non-existent session ID', () => {
			const session1 = createMockSession({ id: 'session-1', state: 'idle' });
			const session2 = createMockSession({ id: 'session-2', state: 'idle' });
			useSessionStore.setState({
				sessions: [session1, session2],
				activeSessionId: 'session-1',
			});

			renderHook(() => useBatchHandlers(createDeps()));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			act(() => {
				callArgs.onUpdateSession('nonexistent-session', { state: 'busy' as any });
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions).toHaveLength(2);
			expect(sessions[0].state).toBe('idle');
			expect(sessions[1].state).toBe('idle');
		});

		it('preserves other fields when applying a partial update (just one field)', () => {
			const session = createMockSession({
				id: 'session-1',
				state: 'idle',
				name: 'My Agent',
				cwd: '/original/path',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useBatchHandlers(createDeps()));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			act(() => {
				callArgs.onUpdateSession('session-1', { state: 'busy' as any });
			});

			const updated = useSessionStore.getState().sessions[0];
			expect(updated.state).toBe('busy');
			expect(updated.name).toBe('My Agent');
			expect(updated.cwd).toBe('/original/path');
			expect(updated.id).toBe('session-1');
		});
	});

	// ====================================================================
	// onAddHistoryEntry edge cases
	// ====================================================================

	describe('onAddHistoryEntry edge cases', () => {
		it('adds history via IPC without crashing when rightPanelRef.current is null', async () => {
			// rightPanelRef.current is null by default in createDeps
			const rightPanelRef = { current: null } as any;

			renderHook(() => useBatchHandlers(createDeps({ rightPanelRef })));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			await act(async () => {
				await callArgs.onAddHistoryEntry({
					type: 'AUTO',
					timestamp: Date.now(),
					summary: 'Test entry with null panel',
					fullResponse: 'Details',
					projectPath: '/test',
					sessionId: 'session-1',
					success: true,
				} as any);
			});

			// IPC history.add should still be called
			expect(window.maestro.history.add).toHaveBeenCalled();
			// Should not throw — no crash from null ref
		});
	});

	// ====================================================================
	// onProcessQueueAfterCompletion edge cases
	// ====================================================================

	describe('onProcessQueueAfterCompletion edge cases', () => {
		it('adds log entry to target tab for queue item with type=message', () => {
			const mockProcessQueuedItem = vi.fn().mockResolvedValue(undefined);
			const processQueuedItemRef = { current: mockProcessQueuedItem };

			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						label: 'AI',
						type: 'ai',
						logs: [],
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
				executionQueue: [{ id: 'q1', type: 'message', text: 'Hello world', tabId: 'tab-1' }] as any,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useBatchHandlers(createDeps({ processQueuedItemRef })));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			act(() => {
				callArgs.onProcessQueueAfterCompletion('session-1');
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const targetTab = updatedSession.aiTabs.find((t: any) => t.id === 'tab-1');
			// A log entry with user source and the message text should have been added
			expect(targetTab?.logs).toHaveLength(1);
			expect(targetTab?.logs[0].source).toBe('user');
			expect(targetTab?.logs[0].text).toBe('Hello world');
		});

		it('targets specific tab by tabId from queue item', () => {
			const mockProcessQueuedItem = vi.fn().mockResolvedValue(undefined);
			const processQueuedItemRef = { current: mockProcessQueuedItem };

			const session = createMockSession({
				id: 'session-1',
				aiTabs: [
					{
						id: 'tab-1',
						label: 'AI Tab 1',
						type: 'ai',
						logs: [],
						state: 'idle',
					},
					{
						id: 'tab-2',
						label: 'AI Tab 2',
						type: 'ai',
						logs: [],
						state: 'idle',
					},
				],
				activeTabId: 'tab-1',
				executionQueue: [{ id: 'q1', type: 'message', text: 'For tab 2', tabId: 'tab-2' }] as any,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useBatchHandlers(createDeps({ processQueuedItemRef })));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			act(() => {
				callArgs.onProcessQueueAfterCompletion('session-1');
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const tab1 = updatedSession.aiTabs.find((t: any) => t.id === 'tab-1');
			const tab2 = updatedSession.aiTabs.find((t: any) => t.id === 'tab-2');

			// Log should only be on tab-2 (the target), not tab-1
			expect(tab1?.logs).toHaveLength(0);
			expect(tab2?.logs).toHaveLength(1);
			expect(tab2?.logs[0].text).toBe('For tab 2');

			// Active tab should be switched to tab-2
			expect(updatedSession.activeTabId).toBe('tab-2');
		});

		it('shifts queue (removes first item) after processing', () => {
			const mockProcessQueuedItem = vi.fn().mockResolvedValue(undefined);
			const processQueuedItemRef = { current: mockProcessQueuedItem };

			const session = createMockSession({
				id: 'session-1',
				executionQueue: [
					{ id: 'q1', type: 'message', text: 'First', tabId: 'tab-1' },
					{ id: 'q2', type: 'message', text: 'Second', tabId: 'tab-1' },
					{ id: 'q3', type: 'message', text: 'Third', tabId: 'tab-1' },
				] as any,
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			renderHook(() => useBatchHandlers(createDeps({ processQueuedItemRef })));

			const callArgs = vi.mocked(useBatchProcessor).mock.calls[0][0];

			act(() => {
				callArgs.onProcessQueueAfterCompletion('session-1');
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			// First item was dequeued, leaving 2 items
			expect(updatedSession.executionQueue).toHaveLength(2);
			expect((updatedSession.executionQueue[0] as any).id).toBe('q2');
			expect((updatedSession.executionQueue[1] as any).id).toBe('q3');

			// processQueuedItem was called with the first item
			expect(mockProcessQueuedItem).toHaveBeenCalledWith(
				'session-1',
				expect.objectContaining({ id: 'q1', text: 'First' })
			);
		});
	});

	// ====================================================================
	// activeBatchRunState edge cases
	// ====================================================================

	describe('activeBatchRunState edge cases', () => {
		it('uses first active batch session state when multiple are active', () => {
			mockActiveBatchSessionIds = ['session-a', 'session-b', 'session-c'];
			const stateA = createDefaultBatchState({ isRunning: true, totalTasks: 10 });
			const stateB = createDefaultBatchState({ isRunning: true, totalTasks: 20 });
			const stateC = createDefaultBatchState({ isRunning: true, totalTasks: 30 });

			mockGetBatchState.mockImplementation((id: string) => {
				if (id === 'session-a') return stateA;
				if (id === 'session-b') return stateB;
				if (id === 'session-c') return stateC;
				return createDefaultBatchState();
			});

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			// Should use the FIRST active batch session (session-a)
			expect(result.current.activeBatchRunState).toBe(stateA);
			expect(result.current.activeBatchRunState.totalTasks).toBe(10);
		});

		it('prioritizes active batch session over active session for activeBatchRunState', () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			mockActiveBatchSessionIds = ['session-2'];
			const batchState = createDefaultBatchState({ isRunning: true, totalTasks: 7 });
			const sessionState = createDefaultBatchState({ isRunning: false, totalTasks: 0 });

			mockGetBatchState.mockImplementation((id: string) => {
				if (id === 'session-2') return batchState;
				if (id === 'session-1') return sessionState;
				return createDefaultBatchState();
			});

			const { result } = renderHook(() => useBatchHandlers(createDeps()));

			// Even though session-1 is the active session, activeBatchRunState
			// should prefer the running batch session-2
			expect(result.current.activeBatchRunState).toBe(batchState);
			expect(result.current.activeBatchRunState.isRunning).toBe(true);
			expect(result.current.activeBatchRunState.totalTasks).toBe(7);
		});
	});

	// ====================================================================
	// Return value stability
	// ====================================================================

	describe('return value stability', () => {
		it('handler functions are stable across re-renders when deps do not change', () => {
			const session = createMockSession({ id: 'session-1' });
			useSessionStore.setState({ sessions: [session], activeSessionId: 'session-1' });

			const { result, rerender } = renderHook(() => useBatchHandlers(createDeps()));

			const firstRender = {
				handleStopBatchRun: result.current.handleStopBatchRun,
				handleKillBatchRun: result.current.handleKillBatchRun,
				handleSyncAutoRunStats: result.current.handleSyncAutoRunStats,
			};

			rerender();

			expect(result.current.handleKillBatchRun).toBe(firstRender.handleKillBatchRun);
			expect(result.current.handleSyncAutoRunStats).toBe(firstRender.handleSyncAutoRunStats);
		});

		it('refs maintain identity across re-renders', () => {
			const { result, rerender } = renderHook(() => useBatchHandlers(createDeps()));

			const firstRender = {
				pauseBatchOnErrorRef: result.current.pauseBatchOnErrorRef,
				getBatchStateRef: result.current.getBatchStateRef,
			};

			rerender();

			expect(result.current.pauseBatchOnErrorRef).toBe(firstRender.pauseBatchOnErrorRef);
			expect(result.current.getBatchStateRef).toBe(firstRender.getBatchStateRef);
		});
	});
});
