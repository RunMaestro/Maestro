/**
 * Tests for LiveSessionManager
 *
 * Verifies:
 * - Live session tracking (setLive, setOffline, isLive)
 * - AutoRun state management
 * - Broadcast callback integration
 * - Memory leak prevention (cleanup on offline)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	LiveSessionManager,
	LiveSessionBroadcastCallbacks,
} from '../../../../main/web-server/managers/LiveSessionManager';

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

describe('LiveSessionManager', () => {
	let manager: LiveSessionManager;
	let mockBroadcastCallbacks: LiveSessionBroadcastCallbacks;

	beforeEach(() => {
		vi.clearAllMocks();
		manager = new LiveSessionManager();
		mockBroadcastCallbacks = {
			broadcastSessionLive: vi.fn(),
			broadcastSessionOffline: vi.fn(),
			broadcastAutoRunState: vi.fn(),
		};
	});

	describe('Live Session Tracking', () => {
		describe('setSessionLive', () => {
			it('should mark a session as live', () => {
				manager.setSessionLive('session-123');

				expect(manager.isSessionLive('session-123')).toBe(true);
			});

			it('should store agent session ID when provided', () => {
				manager.setSessionLive('session-123', 'agent-session-abc');

				const info = manager.getLiveSessionInfo('session-123');
				expect(info?.agentSessionId).toBe('agent-session-abc');
			});

			it('should record enabledAt timestamp', () => {
				const before = Date.now();
				manager.setSessionLive('session-123');
				const after = Date.now();

				const info = manager.getLiveSessionInfo('session-123');
				expect(info?.enabledAt).toBeGreaterThanOrEqual(before);
				expect(info?.enabledAt).toBeLessThanOrEqual(after);
			});

			it('should broadcast session live when callbacks set', () => {
				manager.setBroadcastCallbacks(mockBroadcastCallbacks);
				manager.setSessionLive('session-123', 'agent-session-abc');

				expect(mockBroadcastCallbacks.broadcastSessionLive).toHaveBeenCalledWith(
					'session-123',
					'agent-session-abc'
				);
			});

			it('should not broadcast when callbacks not set', () => {
				// No error should occur when broadcasting without callbacks
				manager.setSessionLive('session-123');
				expect(manager.isSessionLive('session-123')).toBe(true);
			});

			it('should update existing session info when called again', () => {
				manager.setSessionLive('session-123', 'agent-1');
				const firstInfo = manager.getLiveSessionInfo('session-123');

				manager.setSessionLive('session-123', 'agent-2');
				const secondInfo = manager.getLiveSessionInfo('session-123');

				expect(secondInfo?.agentSessionId).toBe('agent-2');
				expect(secondInfo?.enabledAt).toBeGreaterThanOrEqual(firstInfo!.enabledAt);
			});
		});

		describe('setSessionOffline', () => {
			it('should mark a session as offline', () => {
				manager.setSessionLive('session-123');
				expect(manager.isSessionLive('session-123')).toBe(true);

				manager.setSessionOffline('session-123');
				expect(manager.isSessionLive('session-123')).toBe(false);
			});

			it('should broadcast session offline when callbacks set', () => {
				manager.setBroadcastCallbacks(mockBroadcastCallbacks);
				manager.setSessionLive('session-123');
				manager.setSessionOffline('session-123');

				expect(mockBroadcastCallbacks.broadcastSessionOffline).toHaveBeenCalledWith('session-123');
			});

			it('should not broadcast if session was not live', () => {
				manager.setBroadcastCallbacks(mockBroadcastCallbacks);
				manager.setSessionOffline('never-existed');

				expect(mockBroadcastCallbacks.broadcastSessionOffline).not.toHaveBeenCalled();
			});

			it('should clean up associated AutoRun state (memory leak prevention)', () => {
				manager.setSessionLive('session-123');
				manager.setAutoRunState('session-123', {
					isRunning: true,
					totalTasks: 10,
					completedTasks: 5,
					currentTask: 'Task 5',
				});

				expect(manager.getAutoRunState('session-123')).toBeDefined();

				manager.setSessionOffline('session-123');

				expect(manager.getAutoRunState('session-123')).toBeUndefined();
			});
		});

		describe('isSessionLive', () => {
			it('should return false for non-existent session', () => {
				expect(manager.isSessionLive('non-existent')).toBe(false);
			});

			it('should return true for live session', () => {
				manager.setSessionLive('session-123');
				expect(manager.isSessionLive('session-123')).toBe(true);
			});

			it('should return false after session goes offline', () => {
				manager.setSessionLive('session-123');
				manager.setSessionOffline('session-123');
				expect(manager.isSessionLive('session-123')).toBe(false);
			});
		});

		describe('getLiveSessionInfo', () => {
			it('should return undefined for non-existent session', () => {
				expect(manager.getLiveSessionInfo('non-existent')).toBeUndefined();
			});

			it('should return complete session info', () => {
				manager.setSessionLive('session-123', 'agent-session-abc');

				const info = manager.getLiveSessionInfo('session-123');

				expect(info).toEqual({
					sessionId: 'session-123',
					agentSessionId: 'agent-session-abc',
					enabledAt: expect.any(Number),
				});
			});
		});

		describe('getLiveSessions', () => {
			it('should return empty array when no sessions', () => {
				expect(manager.getLiveSessions()).toEqual([]);
			});

			it('should return all live sessions', () => {
				manager.setSessionLive('session-1');
				manager.setSessionLive('session-2');
				manager.setSessionLive('session-3');

				const sessions = manager.getLiveSessions();

				expect(sessions).toHaveLength(3);
				expect(sessions.map((s) => s.sessionId)).toContain('session-1');
				expect(sessions.map((s) => s.sessionId)).toContain('session-2');
				expect(sessions.map((s) => s.sessionId)).toContain('session-3');
			});

			it('should not include offline sessions', () => {
				manager.setSessionLive('session-1');
				manager.setSessionLive('session-2');
				manager.setSessionOffline('session-1');

				const sessions = manager.getLiveSessions();

				expect(sessions).toHaveLength(1);
				expect(sessions[0].sessionId).toBe('session-2');
			});
		});

		describe('getLiveSessionIds', () => {
			it('should return iterable of session IDs', () => {
				manager.setSessionLive('session-1');
				manager.setSessionLive('session-2');

				const ids = Array.from(manager.getLiveSessionIds());

				expect(ids).toHaveLength(2);
				expect(ids).toContain('session-1');
				expect(ids).toContain('session-2');
			});
		});

		describe('getLiveSessionCount', () => {
			it('should return 0 when no sessions', () => {
				expect(manager.getLiveSessionCount()).toBe(0);
			});

			it('should return correct count', () => {
				manager.setSessionLive('session-1');
				manager.setSessionLive('session-2');
				manager.setSessionLive('session-3');

				expect(manager.getLiveSessionCount()).toBe(3);

				manager.setSessionOffline('session-2');

				expect(manager.getLiveSessionCount()).toBe(2);
			});
		});
	});

	describe('AutoRun State Management', () => {
		describe('setAutoRunState', () => {
			it('should store running AutoRun state', () => {
				const state = {
					isRunning: true,
					totalTasks: 10,
					completedTasks: 3,
					currentTask: 'Task 3',
				};

				manager.setAutoRunState('session-123', state);

				expect(manager.getAutoRunState('session-123')).toEqual(state);
			});

			it('should remove state when isRunning is false', () => {
				manager.setAutoRunState('session-123', {
					isRunning: true,
					totalTasks: 10,
					completedTasks: 3,
					currentTask: 'Task 3',
				});

				manager.setAutoRunState('session-123', {
					isRunning: false,
					totalTasks: 10,
					completedTasks: 10,
					currentTask: 'Complete',
				});

				expect(manager.getAutoRunState('session-123')).toBeUndefined();
			});

			it('should remove state when null is passed', () => {
				manager.setAutoRunState('session-123', {
					isRunning: true,
					totalTasks: 10,
					completedTasks: 3,
					currentTask: 'Task 3',
				});

				manager.setAutoRunState('session-123', null);

				expect(manager.getAutoRunState('session-123')).toBeUndefined();
			});

			it('should broadcast AutoRun state when callbacks set', () => {
				manager.setBroadcastCallbacks(mockBroadcastCallbacks);
				const state = {
					isRunning: true,
					totalTasks: 10,
					completedTasks: 3,
					currentTask: 'Task 3',
				};

				manager.setAutoRunState('session-123', state);

				expect(mockBroadcastCallbacks.broadcastAutoRunState).toHaveBeenCalledWith(
					'session-123',
					state
				);
			});

			it('should broadcast null state when clearing', () => {
				manager.setBroadcastCallbacks(mockBroadcastCallbacks);
				manager.setAutoRunState('session-123', {
					isRunning: true,
					totalTasks: 10,
					completedTasks: 3,
					currentTask: 'Task 3',
				});

				manager.setAutoRunState('session-123', null);

				expect(mockBroadcastCallbacks.broadcastAutoRunState).toHaveBeenLastCalledWith(
					'session-123',
					null
				);
			});
		});

		describe('getAutoRunState', () => {
			it('should return undefined for non-existent state', () => {
				expect(manager.getAutoRunState('non-existent')).toBeUndefined();
			});

			it('should return stored state', () => {
				const state = {
					isRunning: true,
					totalTasks: 5,
					completedTasks: 2,
					currentTask: 'Task 2',
				};
				manager.setAutoRunState('session-123', state);

				expect(manager.getAutoRunState('session-123')).toEqual(state);
			});
		});

		describe('getAutoRunStates', () => {
			it('should return empty map when no states', () => {
				const states = manager.getAutoRunStates();
				expect(states.size).toBe(0);
			});

			it('should return all stored states', () => {
				manager.setAutoRunState('session-1', {
					isRunning: true,
					totalTasks: 5,
					completedTasks: 1,
					currentTask: 'Task 1',
				});
				manager.setAutoRunState('session-2', {
					isRunning: true,
					totalTasks: 10,
					completedTasks: 5,
					currentTask: 'Task 5',
				});

				const states = manager.getAutoRunStates();

				expect(states.size).toBe(2);
				expect(states.get('session-1')?.totalTasks).toBe(5);
				expect(states.get('session-2')?.totalTasks).toBe(10);
			});
		});
	});

	describe('clearAll', () => {
		it('should mark all live sessions as offline', () => {
			manager.setBroadcastCallbacks(mockBroadcastCallbacks);
			manager.setSessionLive('session-1');
			manager.setSessionLive('session-2');
			manager.setSessionLive('session-3');

			manager.clearAll();

			expect(manager.getLiveSessionCount()).toBe(0);
			expect(mockBroadcastCallbacks.broadcastSessionOffline).toHaveBeenCalledTimes(3);
		});

		it('should clear all AutoRun states', () => {
			manager.setSessionLive('session-1');
			manager.setAutoRunState('session-1', {
				isRunning: true,
				totalTasks: 5,
				completedTasks: 1,
				currentTask: 'Task 1',
			});
			manager.setSessionLive('session-2');
			manager.setAutoRunState('session-2', {
				isRunning: true,
				totalTasks: 10,
				completedTasks: 5,
				currentTask: 'Task 5',
			});

			manager.clearAll();

			expect(manager.getAutoRunStates().size).toBe(0);
		});

		it('should handle being called when already empty', () => {
			// Should not throw
			manager.clearAll();
			expect(manager.getLiveSessionCount()).toBe(0);
		});
	});

	describe('Integration Scenarios', () => {
		it('should handle full session lifecycle', () => {
			manager.setBroadcastCallbacks(mockBroadcastCallbacks);

			// Session comes online
			manager.setSessionLive('session-123', 'agent-abc');
			expect(manager.isSessionLive('session-123')).toBe(true);
			expect(mockBroadcastCallbacks.broadcastSessionLive).toHaveBeenCalled();

			// AutoRun starts
			manager.setAutoRunState('session-123', {
				isRunning: true,
				totalTasks: 5,
				completedTasks: 0,
				currentTask: 'Task 1',
			});
			expect(mockBroadcastCallbacks.broadcastAutoRunState).toHaveBeenCalled();

			// AutoRun progresses
			manager.setAutoRunState('session-123', {
				isRunning: true,
				totalTasks: 5,
				completedTasks: 3,
				currentTask: 'Task 4',
			});

			// AutoRun completes
			manager.setAutoRunState('session-123', {
				isRunning: false,
				totalTasks: 5,
				completedTasks: 5,
				currentTask: 'Complete',
			});
			expect(manager.getAutoRunState('session-123')).toBeUndefined();

			// Session goes offline
			manager.setSessionOffline('session-123');
			expect(manager.isSessionLive('session-123')).toBe(false);
			expect(mockBroadcastCallbacks.broadcastSessionOffline).toHaveBeenCalled();
		});

		it('should handle multiple concurrent sessions', () => {
			manager.setSessionLive('session-1', 'agent-1');
			manager.setSessionLive('session-2', 'agent-2');
			manager.setSessionLive('session-3', 'agent-3');

			manager.setAutoRunState('session-1', {
				isRunning: true,
				totalTasks: 3,
				completedTasks: 1,
				currentTask: 'Task 1',
			});
			manager.setAutoRunState('session-3', {
				isRunning: true,
				totalTasks: 5,
				completedTasks: 2,
				currentTask: 'Task 2',
			});

			expect(manager.getLiveSessionCount()).toBe(3);
			expect(manager.getAutoRunStates().size).toBe(2);

			// Session 2 goes offline (no AutoRun state to clean)
			manager.setSessionOffline('session-2');
			expect(manager.getLiveSessionCount()).toBe(2);
			expect(manager.getAutoRunStates().size).toBe(2);

			// Session 1 goes offline (has AutoRun state)
			manager.setSessionOffline('session-1');
			expect(manager.getLiveSessionCount()).toBe(1);
			expect(manager.getAutoRunStates().size).toBe(1);
			expect(manager.getAutoRunState('session-1')).toBeUndefined();
			expect(manager.getAutoRunState('session-3')).toBeDefined();
		});
	});
});
