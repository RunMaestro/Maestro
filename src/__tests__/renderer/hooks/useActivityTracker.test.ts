import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useActivityTracker, UseActivityTrackerReturn } from '../../../renderer/hooks';
import type { Session } from '../../../renderer/types';

// Constants matching the source file
const ACTIVITY_TIMEOUT_MS = 60000; // 1 minute of inactivity = idle
const TICK_INTERVAL_MS = 1000; // Update every second
const BATCH_UPDATE_INTERVAL_MS = 30000; // Batch updates every 30 seconds

describe('useActivityTracker', () => {
	let mockSetSessions: ReturnType<typeof vi.fn>;
	let mockSessions: Session[];

	beforeEach(() => {
		vi.useFakeTimers();
		mockSetSessions = vi.fn();
		mockSessions = [
			{
				id: 'session-1',
				name: 'Test Session 1',
				activeTimeMs: 0,
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/test',
				projectRoot: '/test',
				isGitRepo: false,
				fileTree: [],
				fileExplorerExpanded: [],
				aiLogs: [],
				shellLogs: [],
				messageQueue: [],
			} as Session,
			{
				id: 'session-2',
				name: 'Test Session 2',
				activeTimeMs: 5000,
				toolType: 'claude-code',
				state: 'idle',
				inputMode: 'ai',
				cwd: '/test2',
				projectRoot: '/test2',
				isGitRepo: false,
				fileTree: [],
				fileExplorerExpanded: [],
				aiLogs: [],
				shellLogs: [],
				messageQueue: [],
			} as Session,
		];
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	describe('initial state', () => {
		it('returns onActivity callback', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			expect(result.current).toBeDefined();
			expect(result.current.onActivity).toBeDefined();
			expect(typeof result.current.onActivity).toBe('function');
		});

		it('does not call setSessions on mount', () => {
			renderHook(() => useActivityTracker('session-1', mockSetSessions));

			expect(mockSetSessions).not.toHaveBeenCalled();
		});
	});

	describe('onActivity callback', () => {
		it('onActivity is stable (same reference across renders)', () => {
			const { result, rerender } = renderHook(
				({ sessionId }) => useActivityTracker(sessionId, mockSetSessions),
				{ initialProps: { sessionId: 'session-1' } }
			);

			const firstOnActivity = result.current.onActivity;
			rerender({ sessionId: 'session-1' });

			expect(result.current.onActivity).toBe(firstOnActivity);
		});

		it('onActivity marks user as active', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Call onActivity
			act(() => {
				result.current.onActivity();
			});

			// Advance time to trigger batch update (30 seconds)
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			// Should have called setSessions with accumulated time
			expect(mockSetSessions).toHaveBeenCalled();
		});
	});

	describe('time accumulation', () => {
		it('accumulates time every second when active', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Mark as active
			act(() => {
				result.current.onActivity();
			});

			// Advance 30 seconds to trigger batch update
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			// Should have accumulated ~30 seconds
			expect(mockSetSessions).toHaveBeenCalled();
			const updateFn = mockSetSessions.mock.calls[0][0];
			const result2 = updateFn(mockSessions);

			// Session 1 should have accumulated time
			const session1 = result2.find((s: Session) => s.id === 'session-1');
			expect(session1.activeTimeMs).toBe(BATCH_UPDATE_INTERVAL_MS);
		});

		it('does not update state before batch interval', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Mark as active
			act(() => {
				result.current.onActivity();
			});

			// Advance less than batch interval
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS - 1000);
			});

			// Should not have called setSessions yet
			expect(mockSetSessions).not.toHaveBeenCalled();
		});

		it('does batch update at correct interval', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Mark as active
			act(() => {
				result.current.onActivity();
			});

			// Advance exactly to batch update interval
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			expect(mockSetSessions).toHaveBeenCalledTimes(1);
		});

		it('accumulates time correctly over multiple batch intervals', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Mark as active
			act(() => {
				result.current.onActivity();
			});

			// First batch update
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			expect(mockSetSessions).toHaveBeenCalledTimes(1);

			// Keep activity alive
			act(() => {
				result.current.onActivity();
			});

			// Second batch update
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			expect(mockSetSessions).toHaveBeenCalledTimes(2);
		});

		it('only updates the active session', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Mark as active
			act(() => {
				result.current.onActivity();
			});

			// Trigger batch update
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			const updateFn = mockSetSessions.mock.calls[0][0];
			const updatedSessions = updateFn(mockSessions);

			// Session 1 should be updated
			expect(updatedSessions[0].activeTimeMs).toBe(BATCH_UPDATE_INTERVAL_MS);
			// Session 2 should remain unchanged
			expect(updatedSessions[1].activeTimeMs).toBe(5000);
		});

		it('preserves existing activeTimeMs when updating', () => {
			// Session with existing time
			const sessionsWithTime = [{ ...mockSessions[0], activeTimeMs: 10000 }, mockSessions[1]];

			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Mark as active
			act(() => {
				result.current.onActivity();
			});

			// Trigger batch update
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			const updateFn = mockSetSessions.mock.calls[0][0];
			const updatedSessions = updateFn(sessionsWithTime);

			// Should add to existing time
			expect(updatedSessions[0].activeTimeMs).toBe(10000 + BATCH_UPDATE_INTERVAL_MS);
		});

		it('handles undefined activeTimeMs gracefully', () => {
			const sessionsWithUndefined = [
				{ ...mockSessions[0], activeTimeMs: undefined },
				mockSessions[1],
			];

			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			act(() => {
				result.current.onActivity();
			});

			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			const updateFn = mockSetSessions.mock.calls[0][0];
			const updatedSessions = updateFn(sessionsWithUndefined);

			// Should treat undefined as 0
			expect(updatedSessions[0].activeTimeMs).toBe(BATCH_UPDATE_INTERVAL_MS);
		});
	});

	describe('activity timeout', () => {
		it('stops accumulating time after inactivity timeout', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Mark as active
			act(() => {
				result.current.onActivity();
			});

			// Advance past inactivity timeout (60 seconds)
			act(() => {
				vi.advanceTimersByTime(ACTIVITY_TIMEOUT_MS + 1000);
			});

			mockSetSessions.mockClear();

			// Advance another batch interval without new activity
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			// Should not have called setSessions (user is idle)
			expect(mockSetSessions).not.toHaveBeenCalled();
		});

		it('resumes tracking after new activity', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Mark as active
			act(() => {
				result.current.onActivity();
			});

			// Go idle
			act(() => {
				vi.advanceTimersByTime(ACTIVITY_TIMEOUT_MS + 1000);
			});

			mockSetSessions.mockClear();

			// New activity
			act(() => {
				result.current.onActivity();
			});

			// Advance to next batch update
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			// Should have resumed tracking
			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('does not accumulate time when user is initially idle', () => {
			renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Advance time without any activity
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS * 2);
			});

			// Should not have called setSessions
			expect(mockSetSessions).not.toHaveBeenCalled();
		});
	});

	describe('session changes', () => {
		it('flushes accumulated time on session change', () => {
			const { result, rerender } = renderHook(
				({ sessionId }) => useActivityTracker(sessionId, mockSetSessions),
				{ initialProps: { sessionId: 'session-1' as string | null } }
			);

			// Mark as active and accumulate some time
			act(() => {
				result.current.onActivity();
			});

			// Advance less than batch interval to have accumulated but unflushed time
			act(() => {
				vi.advanceTimersByTime(TICK_INTERVAL_MS * 15); // 15 seconds
			});

			// Change session (triggers cleanup)
			rerender({ sessionId: 'session-2' });

			// Should flush accumulated time for session-1
			expect(mockSetSessions).toHaveBeenCalled();
			const updateFn = mockSetSessions.mock.calls[0][0];
			const updatedSessions = updateFn(mockSessions);

			// Session 1 should have the flushed accumulated time
			expect(updatedSessions[0].activeTimeMs).toBeGreaterThan(0);
			expect(updatedSessions[0].activeTimeMs).toBeLessThanOrEqual(15000);
		});

		it('does not flush when no time accumulated', () => {
			const { rerender } = renderHook(
				({ sessionId }) => useActivityTracker(sessionId, mockSetSessions),
				{ initialProps: { sessionId: 'session-1' as string | null } }
			);

			// No activity, change session
			rerender({ sessionId: 'session-2' });

			// Should not have called setSessions
			expect(mockSetSessions).not.toHaveBeenCalled();
		});

		it('handles null session ID', () => {
			const { result, rerender } = renderHook(
				({ sessionId }) => useActivityTracker(sessionId, mockSetSessions),
				{ initialProps: { sessionId: null as string | null } }
			);

			// Mark as active
			act(() => {
				result.current.onActivity();
			});

			// Advance to batch update
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			// Should not call setSessions when sessionId is null
			expect(mockSetSessions).not.toHaveBeenCalled();
		});

		it('does not flush on unmount when sessionId is null', () => {
			const { result, unmount } = renderHook(
				({ sessionId }) => useActivityTracker(sessionId, mockSetSessions),
				{ initialProps: { sessionId: null as string | null } }
			);

			// Mark as active and accumulate time
			act(() => {
				result.current.onActivity();
			});

			act(() => {
				vi.advanceTimersByTime(TICK_INTERVAL_MS * 10);
			});

			// Unmount
			unmount();

			// Should not call setSessions
			expect(mockSetSessions).not.toHaveBeenCalled();
		});
	});

	describe('cleanup on unmount', () => {
		it('flushes accumulated time on unmount', () => {
			const { result, unmount } = renderHook(() =>
				useActivityTracker('session-1', mockSetSessions)
			);

			// Mark as active and accumulate time
			act(() => {
				result.current.onActivity();
			});

			act(() => {
				vi.advanceTimersByTime(TICK_INTERVAL_MS * 10); // 10 seconds
			});

			// Unmount
			unmount();

			// Should flush accumulated time
			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('clears interval on unmount', () => {
			const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

			const { result, unmount } = renderHook(() =>
				useActivityTracker('session-1', mockSetSessions)
			);

			// Trigger activity to start the interval
			act(() => {
				result.current.onActivity();
			});

			unmount();

			expect(clearIntervalSpy).toHaveBeenCalled();
		});
	});

	describe('global event listeners', () => {
		it('adds event listeners on mount', () => {
			const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

			renderHook(() => useActivityTracker('session-1', mockSetSessions));

			expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
			expect(addEventListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
			// Note: mousemove is intentionally NOT listened to (CPU performance optimization)
			expect(addEventListenerSpy).toHaveBeenCalledWith('wheel', expect.any(Function));
			expect(addEventListenerSpy).toHaveBeenCalledWith('touchstart', expect.any(Function));
		});

		it('removes event listeners on unmount', () => {
			const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

			const { unmount } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			unmount();

			expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
			expect(removeEventListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
			// Note: mousemove is intentionally NOT listened to (CPU performance optimization)
			expect(removeEventListenerSpy).toHaveBeenCalledWith('wheel', expect.any(Function));
			expect(removeEventListenerSpy).toHaveBeenCalledWith('touchstart', expect.any(Function));
		});

		it('responds to keydown events', () => {
			renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Simulate keydown
			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
			});

			// Advance to batch update
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('responds to mousedown events', () => {
			renderHook(() => useActivityTracker('session-1', mockSetSessions));

			act(() => {
				window.dispatchEvent(new MouseEvent('mousedown'));
			});

			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			expect(mockSetSessions).toHaveBeenCalled();
		});

		// Note: mousemove is intentionally NOT listened to for CPU performance
		// (it fires hundreds of times per second during cursor movement)

		it('responds to wheel events', () => {
			renderHook(() => useActivityTracker('session-1', mockSetSessions));

			act(() => {
				window.dispatchEvent(new WheelEvent('wheel'));
			});

			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('responds to touchstart events', () => {
			renderHook(() => useActivityTracker('session-1', mockSetSessions));

			act(() => {
				window.dispatchEvent(new TouchEvent('touchstart'));
			});

			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('multiple event types all mark activity', () => {
			renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Fire different events
			act(() => {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
			});

			// Advance but stay within activity timeout
			act(() => {
				vi.advanceTimersByTime(10000);
			});

			act(() => {
				window.dispatchEvent(new MouseEvent('mousedown'));
			});

			act(() => {
				vi.advanceTimersByTime(10000);
			});

			act(() => {
				window.dispatchEvent(new WheelEvent('wheel'));
			});

			act(() => {
				vi.advanceTimersByTime(10000);
			});

			// Should trigger batch update
			expect(mockSetSessions).toHaveBeenCalled();
		});
	});

	describe('edge cases', () => {
		it('handles rapid session switches', () => {
			const { result, rerender } = renderHook(
				({ sessionId }) => useActivityTracker(sessionId, mockSetSessions),
				{ initialProps: { sessionId: 'session-1' as string | null } }
			);

			act(() => {
				result.current.onActivity();
			});

			// Rapid switches
			rerender({ sessionId: 'session-2' });
			rerender({ sessionId: 'session-1' });
			rerender({ sessionId: 'session-2' });

			// Should handle without errors
			expect(mockSetSessions).toBeDefined();
		});

		it('handles session ID changing from null to valid', () => {
			const { result, rerender } = renderHook(
				({ sessionId }) => useActivityTracker(sessionId, mockSetSessions),
				{ initialProps: { sessionId: null as string | null } }
			);

			// Change to valid session
			rerender({ sessionId: 'session-1' });

			// New activity after session is valid
			act(() => {
				result.current.onActivity();
			});

			// Advance to batch update (need time to accumulate first, then hit batch interval)
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS + TICK_INTERVAL_MS);
			});

			// Should track for the new session
			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('handles session ID changing from valid to null', () => {
			const { result, rerender } = renderHook(
				({ sessionId }) => useActivityTracker(sessionId, mockSetSessions),
				{ initialProps: { sessionId: 'session-1' as string | null } }
			);

			act(() => {
				result.current.onActivity();
			});

			act(() => {
				vi.advanceTimersByTime(TICK_INTERVAL_MS * 10);
			});

			// Flush happens on change
			rerender({ sessionId: null });

			// Should have flushed accumulated time
			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('handles setSessions being called with current state', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			act(() => {
				result.current.onActivity();
			});

			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			// Verify the update function works correctly
			expect(mockSetSessions).toHaveBeenCalled();
			const updateFn = mockSetSessions.mock.calls[0][0];
			expect(typeof updateFn).toBe('function');

			// Test with empty sessions array
			const emptyResult = updateFn([]);
			expect(emptyResult).toEqual([]);
		});

		it('handles session not found in array', () => {
			const { result } = renderHook(() =>
				useActivityTracker('non-existent-session', mockSetSessions)
			);

			act(() => {
				result.current.onActivity();
			});

			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			expect(mockSetSessions).toHaveBeenCalled();
			const updateFn = mockSetSessions.mock.calls[0][0];
			const updatedSessions = updateFn(mockSessions);

			// Sessions should be unchanged (no matching session)
			expect(updatedSessions[0].activeTimeMs).toBe(0);
			expect(updatedSessions[1].activeTimeMs).toBe(5000);
		});

		it('handles very long activity periods', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Keep activity going for a long time with periodic refreshes
			for (let i = 0; i < 10; i++) {
				act(() => {
					result.current.onActivity();
				});

				act(() => {
					vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
				});
			}

			// Should have called setSessions 10 times
			expect(mockSetSessions).toHaveBeenCalledTimes(10);
		});

		it('handles continuous activity without gaps', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Activity every second for 60 seconds
			for (let i = 0; i < 60; i++) {
				act(() => {
					result.current.onActivity();
					vi.advanceTimersByTime(TICK_INTERVAL_MS);
				});
			}

			// Should have 2 batch updates (at 30s and 60s)
			expect(mockSetSessions).toHaveBeenCalledTimes(2);
		});
	});

	describe('return type', () => {
		it('matches UseActivityTrackerReturn interface', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			const returnValue: UseActivityTrackerReturn = result.current;

			expect(returnValue).toHaveProperty('onActivity');
			expect(typeof returnValue.onActivity).toBe('function');
		});
	});

	describe('timing precision', () => {
		it('tick interval is 1 second', () => {
			const setIntervalSpy = vi.spyOn(global, 'setInterval');

			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			// Interval only starts on activity (CPU optimization)
			act(() => {
				result.current.onActivity();
			});

			expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), TICK_INTERVAL_MS);
		});

		it('accumulates exactly TICK_INTERVAL_MS per tick', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			act(() => {
				result.current.onActivity();
			});

			// Advance exactly 30 ticks
			act(() => {
				vi.advanceTimersByTime(TICK_INTERVAL_MS * 30);
			});

			expect(mockSetSessions).toHaveBeenCalled();
			const updateFn = mockSetSessions.mock.calls[0][0];
			const updatedSessions = updateFn(mockSessions);

			// Should have accumulated exactly 30 seconds
			expect(updatedSessions[0].activeTimeMs).toBe(TICK_INTERVAL_MS * 30);
		});

		it('resets accumulated time after batch update', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			act(() => {
				result.current.onActivity();
			});

			// First batch update
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			const firstUpdateFn = mockSetSessions.mock.calls[0][0];
			const firstResult = firstUpdateFn(mockSessions);
			expect(firstResult[0].activeTimeMs).toBe(BATCH_UPDATE_INTERVAL_MS);

			// Keep active
			act(() => {
				result.current.onActivity();
			});

			// Second batch update
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			const secondUpdateFn = mockSetSessions.mock.calls[1][0];
			// Use updated sessions from first call
			const secondResult = secondUpdateFn(firstResult);

			// Should have added another 30 seconds
			expect(secondResult[0].activeTimeMs).toBe(BATCH_UPDATE_INTERVAL_MS * 2);
		});
	});

	describe('activity detection edge cases', () => {
		it('marks activity on exact timeout boundary', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			act(() => {
				result.current.onActivity();
			});

			// Advance to batch update (within timeout)
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			// Should have accumulated time
			expect(mockSetSessions).toHaveBeenCalled();

			// Clear and test at boundary
			mockSetSessions.mockClear();

			// New activity just before timeout expires
			act(() => {
				vi.advanceTimersByTime(ACTIVITY_TIMEOUT_MS - BATCH_UPDATE_INTERVAL_MS - 1);
			});

			act(() => {
				result.current.onActivity();
			});

			// Advance another batch interval
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			// Should still be tracking
			expect(mockSetSessions).toHaveBeenCalled();
		});

		it('becomes idle exactly at timeout', () => {
			const { result } = renderHook(() => useActivityTracker('session-1', mockSetSessions));

			act(() => {
				result.current.onActivity();
			});

			// Advance to batch update
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			mockSetSessions.mockClear();

			// Advance to exactly at timeout (no new activity)
			act(() => {
				vi.advanceTimersByTime(ACTIVITY_TIMEOUT_MS - BATCH_UPDATE_INTERVAL_MS);
			});

			// Advance more - should be idle now
			act(() => {
				vi.advanceTimersByTime(BATCH_UPDATE_INTERVAL_MS);
			});

			// Should not call setSessions when idle
			expect(mockSetSessions).not.toHaveBeenCalled();
		});
	});
});
