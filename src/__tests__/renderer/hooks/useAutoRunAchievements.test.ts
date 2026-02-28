/**
 * @fileoverview Tests for useAutoRunAchievements hook
 *
 * Tests cover:
 * - No interval created when activeBatchSessionIds is empty
 * - Interval setup when active batches are present
 * - Delta calculation multiplied by concurrent session count
 * - Badge unlock triggers standing ovation overlay
 * - Cleanup (clearInterval) on unmount
 * - Peak usage stats updated whenever sessions or activeBatchSessionIds change
 * - lastUpdateTime reset when batches become empty
 * - No standing ovation when updateAutoRunProgress returns null badge level
 * - No standing ovation when CONDUCTOR_BADGES has no matching level
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ============================================================================
// Mock modules BEFORE importing the hook
// ============================================================================

// Mock settingsStore
const mockUpdateAutoRunProgress = vi
	.fn()
	.mockReturnValue({ newBadgeLevel: null, isNewRecord: false });
const mockUpdateUsageStats = vi.fn();
const mockAutoRunStats = { longestRunMs: 0 };

vi.mock('../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(
		vi.fn((selector: (s: any) => any) => selector({ autoRunStats: mockAutoRunStats })),
		{
			getState: vi.fn(() => ({
				updateAutoRunProgress: mockUpdateAutoRunProgress,
				updateUsageStats: mockUpdateUsageStats,
				autoRunStats: mockAutoRunStats,
			})),
		}
	),
}));

// Mock sessionStore
const mockSessions: any[] = [];

vi.mock('../../../renderer/stores/sessionStore', () => ({
	useSessionStore: vi.fn((selector: (s: any) => any) => selector({ sessions: mockSessions })),
}));

// Mock modalStore
const mockSetStandingOvationData = vi.fn();

vi.mock('../../../renderer/stores/modalStore', () => ({
	getModalActions: () => ({
		setStandingOvationData: mockSetStandingOvationData,
	}),
}));

// Mock conductorBadges — provide just enough badges for tests (inlined to avoid TDZ in hoisted vi.mock)
vi.mock('../../../renderer/constants/conductorBadges', () => ({
	CONDUCTOR_BADGES: [
		{
			id: 'apprentice-conductor',
			level: 1,
			name: 'Apprentice Conductor',
			shortName: 'Apprentice',
			description: 'First badge',
			requiredTimeMs: 15 * 60 * 1000,
			exampleConductor: { name: 'Test', era: 'Test', achievement: 'Test', wikipediaUrl: '' },
			flavorText: 'First step',
		},
		{
			id: 'assistant-conductor',
			level: 2,
			name: 'Assistant Conductor',
			shortName: 'Assistant',
			description: 'Second badge',
			requiredTimeMs: 60 * 60 * 1000,
			exampleConductor: { name: 'Test2', era: 'Test2', achievement: 'Test2', wikipediaUrl: '' },
			flavorText: 'Second step',
		},
	],
}));

// ============================================================================
// Now import the hook
// ============================================================================

import { useAutoRunAchievements } from '../../../renderer/hooks/batch/useAutoRunAchievements';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { CONDUCTOR_BADGES as MOCK_CONDUCTOR_BADGES } from '../../../renderer/constants/conductorBadges';

// ============================================================================
// Helpers
// ============================================================================

function createMockSession(overrides: Record<string, any> = {}): any {
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test',
		projectRoot: '/test',
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		aiLogs: [],
		shellLogs: [],
		messageQueue: [],
		executionQueue: [],
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe('useAutoRunAchievements', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();

		// Reset mock sessions to empty
		mockSessions.length = 0;

		// Reset autoRunStats
		mockAutoRunStats.longestRunMs = 0;

		// Default: no badge unlocked
		mockUpdateAutoRunProgress.mockReturnValue({ newBadgeLevel: null, isNewRecord: false });

		// Re-wire store mocks to current mockSessions reference
		(useSessionStore as any).mockImplementation((selector: (s: any) => any) =>
			selector({ sessions: mockSessions })
		);
		(useSettingsStore as any).mockImplementation((selector: (s: any) => any) =>
			selector({ autoRunStats: mockAutoRunStats })
		);
		(useSettingsStore as any).getState.mockReturnValue({
			updateAutoRunProgress: mockUpdateAutoRunProgress,
			updateUsageStats: mockUpdateUsageStats,
			autoRunStats: mockAutoRunStats,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// ==========================================================================
	// Timer interval — empty activeBatchSessionIds
	// ==========================================================================

	describe('no interval when no active batches', () => {
		it('does not call setInterval when activeBatchSessionIds is empty', () => {
			const setIntervalSpy = vi.spyOn(global, 'setInterval');

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: [] }));

			// setInterval may be called by React internals, but the hook-specific
			// 60-second interval should not be among them
			const relevantCalls = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 60000);
			expect(relevantCalls).toHaveLength(0);
		});

		it('does not call updateAutoRunProgress when no active batches after 60 seconds', () => {
			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: [] }));

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			expect(mockUpdateAutoRunProgress).not.toHaveBeenCalled();
		});

		it('does not call setStandingOvationData when no active batches', () => {
			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: [] }));

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			expect(mockSetStandingOvationData).not.toHaveBeenCalled();
		});

		it('resets lastUpdateTime to 0 when activeBatchSessionIds becomes empty', () => {
			// Start with an active batch so a timer runs
			const { rerender } = renderHook(
				({ ids }) => useAutoRunAchievements({ activeBatchSessionIds: ids }),
				{ initialProps: { ids: ['session-1'] } }
			);

			// Advance one interval so lastUpdateTime has been stamped
			act(() => {
				vi.advanceTimersByTime(60000);
			});

			// Clear mocks so we can assert fresh state
			mockUpdateAutoRunProgress.mockClear();

			// Now remove all active sessions — should reset the ref
			rerender({ ids: [] });

			// Advance time — no progress update should fire because interval is torn down
			act(() => {
				vi.advanceTimersByTime(60000);
			});

			expect(mockUpdateAutoRunProgress).not.toHaveBeenCalled();
		});
	});

	// ==========================================================================
	// Timer interval — with active batches
	// ==========================================================================

	describe('interval setup with active batches', () => {
		it('creates a 60-second interval when activeBatchSessionIds is non-empty', () => {
			const setIntervalSpy = vi.spyOn(global, 'setInterval');

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			const relevantCalls = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 60000);
			expect(relevantCalls).toHaveLength(1);
		});

		it('calls updateAutoRunProgress after 60 seconds with one active session', () => {
			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			expect(mockUpdateAutoRunProgress).toHaveBeenCalledTimes(1);
		});

		it('calls updateAutoRunProgress multiple times for multiple intervals', () => {
			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			act(() => {
				vi.advanceTimersByTime(60000 * 3);
			});

			expect(mockUpdateAutoRunProgress).toHaveBeenCalledTimes(3);
		});

		it('does not fire before 60 seconds have elapsed', () => {
			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			act(() => {
				vi.advanceTimersByTime(59999);
			});

			expect(mockUpdateAutoRunProgress).not.toHaveBeenCalled();
		});
	});

	// ==========================================================================
	// Delta calculation with concurrent sessions
	// ==========================================================================

	describe('delta calculation with concurrent sessions', () => {
		it('passes elapsed time to updateAutoRunProgress for a single session', () => {
			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			// Advance exactly 60 seconds
			act(() => {
				vi.advanceTimersByTime(60000);
			});

			// deltaMs = elapsedMs * 1 session ≈ 60000
			const [deltaMs] = mockUpdateAutoRunProgress.mock.calls[0];
			expect(deltaMs).toBeGreaterThan(0);
		});

		it('multiplies elapsed time by number of concurrent sessions', () => {
			const activeBatchSessionIds = ['session-1', 'session-2', 'session-3'];

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds }));

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			// delta = elapsedMs * 3
			const [deltaMs] = mockUpdateAutoRunProgress.mock.calls[0];
			// elapsedMs should be approximately 60000, so deltaMs ≈ 180000
			// We use a generous range to accommodate timer precision
			expect(deltaMs).toBeGreaterThanOrEqual(60000 * 3 - 100);
			expect(deltaMs).toBeLessThanOrEqual(60000 * 3 + 100);
		});

		it('delta with two sessions is double the delta with one session', () => {
			let deltaOneSession = 0;
			let deltaTwoSessions = 0;

			// Run with one session
			const { unmount: unmount1 } = renderHook(() =>
				useAutoRunAchievements({ activeBatchSessionIds: ['s1'] })
			);

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			deltaOneSession = mockUpdateAutoRunProgress.mock.calls[0][0];
			unmount1();
			mockUpdateAutoRunProgress.mockClear();

			// Run with two sessions — reinitialize fake timers to get a fresh epoch
			vi.useRealTimers();
			vi.useFakeTimers();

			const { unmount: unmount2 } = renderHook(() =>
				useAutoRunAchievements({ activeBatchSessionIds: ['s1', 's2'] })
			);

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			deltaTwoSessions = mockUpdateAutoRunProgress.mock.calls[0][0];
			unmount2();

			// Two-session delta should be approximately double the one-session delta
			expect(deltaTwoSessions).toBeGreaterThanOrEqual(deltaOneSession * 2 - 200);
			expect(deltaTwoSessions).toBeLessThanOrEqual(deltaOneSession * 2 + 200);
		});
	});

	// ==========================================================================
	// Badge unlock triggers standing ovation
	// ==========================================================================

	describe('badge unlock triggers standing ovation', () => {
		it('calls setStandingOvationData when a new badge is unlocked', () => {
			// Simulate badge level 1 unlock
			mockUpdateAutoRunProgress.mockReturnValue({ newBadgeLevel: 1, isNewRecord: false });

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			expect(mockSetStandingOvationData).toHaveBeenCalledTimes(1);
		});

		it('passes the correct badge object to setStandingOvationData', () => {
			mockUpdateAutoRunProgress.mockReturnValue({ newBadgeLevel: 1, isNewRecord: false });

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			const callArg = mockSetStandingOvationData.mock.calls[0][0];
			expect(callArg.badge).toEqual(MOCK_CONDUCTOR_BADGES[0]);
		});

		it('always passes isNewRecord: false to setStandingOvationData', () => {
			mockUpdateAutoRunProgress.mockReturnValue({ newBadgeLevel: 1, isNewRecord: false });

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			const callArg = mockSetStandingOvationData.mock.calls[0][0];
			expect(callArg.isNewRecord).toBe(false);
		});

		it('passes recordTimeMs from autoRunStats.longestRunMs', () => {
			mockAutoRunStats.longestRunMs = 12345;
			(useSettingsStore as any).getState.mockReturnValue({
				updateAutoRunProgress: mockUpdateAutoRunProgress,
				updateUsageStats: mockUpdateUsageStats,
				autoRunStats: { longestRunMs: 12345 },
			});
			mockUpdateAutoRunProgress.mockReturnValue({ newBadgeLevel: 1, isNewRecord: false });

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			const callArg = mockSetStandingOvationData.mock.calls[0][0];
			expect(callArg.recordTimeMs).toBe(12345);
		});

		it('shows standing ovation for badge level 2', () => {
			mockUpdateAutoRunProgress.mockReturnValue({ newBadgeLevel: 2, isNewRecord: false });

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			const callArg = mockSetStandingOvationData.mock.calls[0][0];
			expect(callArg.badge).toEqual(MOCK_CONDUCTOR_BADGES[1]);
		});
	});

	// ==========================================================================
	// No standing ovation when badge not unlocked
	// ==========================================================================

	describe('no standing ovation when no badge unlocked', () => {
		it('does not call setStandingOvationData when newBadgeLevel is null', () => {
			mockUpdateAutoRunProgress.mockReturnValue({ newBadgeLevel: null, isNewRecord: false });

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			expect(mockSetStandingOvationData).not.toHaveBeenCalled();
		});

		it('does not call setStandingOvationData when badge level does not match any CONDUCTOR_BADGE', () => {
			// Level 99 does not exist in MOCK_CONDUCTOR_BADGES
			mockUpdateAutoRunProgress.mockReturnValue({ newBadgeLevel: 99, isNewRecord: false });

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			expect(mockSetStandingOvationData).not.toHaveBeenCalled();
		});

		it('only calls setStandingOvationData on ticks that unlock a badge', () => {
			// First interval: no badge; second interval: badge level 1
			mockUpdateAutoRunProgress
				.mockReturnValueOnce({ newBadgeLevel: null, isNewRecord: false })
				.mockReturnValueOnce({ newBadgeLevel: 1, isNewRecord: false });

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			// First tick
			act(() => {
				vi.advanceTimersByTime(60000);
			});
			expect(mockSetStandingOvationData).not.toHaveBeenCalled();

			// Second tick
			act(() => {
				vi.advanceTimersByTime(60000);
			});
			expect(mockSetStandingOvationData).toHaveBeenCalledTimes(1);
		});
	});

	// ==========================================================================
	// Cleanup on unmount
	// ==========================================================================

	describe('cleanup on unmount', () => {
		it('calls clearInterval when unmounted with active batches', () => {
			const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

			const { unmount } = renderHook(() =>
				useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] })
			);

			unmount();

			expect(clearIntervalSpy).toHaveBeenCalled();
		});

		it('does not call updateAutoRunProgress after unmount', () => {
			const { unmount } = renderHook(() =>
				useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] })
			);

			unmount();
			mockUpdateAutoRunProgress.mockClear();

			act(() => {
				vi.advanceTimersByTime(60000);
			});

			expect(mockUpdateAutoRunProgress).not.toHaveBeenCalled();
		});

		it('clears the interval when activeBatchSessionIds changes from non-empty to empty', () => {
			const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

			const { rerender } = renderHook(
				({ ids }) => useAutoRunAchievements({ activeBatchSessionIds: ids }),
				{ initialProps: { ids: ['session-1'] } }
			);

			clearIntervalSpy.mockClear();

			// Removing all sessions triggers effect cleanup
			rerender({ ids: [] });

			expect(clearIntervalSpy).toHaveBeenCalled();
		});
	});

	// ==========================================================================
	// Peak usage stats update
	// ==========================================================================

	describe('peak usage stats update with sessions', () => {
		it('calls updateUsageStats on mount with empty sessions', () => {
			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: [] }));

			expect(mockUpdateUsageStats).toHaveBeenCalledWith({
				maxAgents: 0,
				maxDefinedAgents: 0,
				maxSimultaneousAutoRuns: 0,
				maxSimultaneousQueries: 0,
				maxQueueDepth: 0,
			});
		});

		it('counts non-terminal sessions as active agents', () => {
			mockSessions.push(
				createMockSession({ id: 's1', toolType: 'claude-code', state: 'idle' }),
				createMockSession({ id: 's2', toolType: 'codex', state: 'idle' }),
				createMockSession({ id: 's3', toolType: 'terminal', state: 'idle' })
			);

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: [] }));

			const lastCall = mockUpdateUsageStats.mock.calls.at(-1)![0];
			// Only 2 non-terminal sessions
			expect(lastCall.maxAgents).toBe(2);
			expect(lastCall.maxDefinedAgents).toBe(2);
		});

		it('counts busy sessions as simultaneous queries', () => {
			mockSessions.push(
				createMockSession({ id: 's1', toolType: 'claude-code', state: 'busy' }),
				createMockSession({ id: 's2', toolType: 'claude-code', state: 'idle' }),
				createMockSession({ id: 's3', toolType: 'claude-code', state: 'busy' })
			);

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: [] }));

			const lastCall = mockUpdateUsageStats.mock.calls.at(-1)![0];
			expect(lastCall.maxSimultaneousQueries).toBe(2);
		});

		it('counts activeBatchSessionIds as simultaneous auto-runs', () => {
			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['s1', 's2', 's3'] }));

			const lastCall = mockUpdateUsageStats.mock.calls.at(-1)![0];
			expect(lastCall.maxSimultaneousAutoRuns).toBe(3);
		});

		it('sums executionQueue lengths across all sessions for queue depth', () => {
			mockSessions.push(
				createMockSession({ id: 's1', executionQueue: ['t1', 't2'] }),
				createMockSession({ id: 's2', executionQueue: ['t3'] }),
				createMockSession({ id: 's3', executionQueue: [] })
			);

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: [] }));

			const lastCall = mockUpdateUsageStats.mock.calls.at(-1)![0];
			expect(lastCall.maxQueueDepth).toBe(3);
		});

		it('handles sessions with undefined executionQueue gracefully', () => {
			mockSessions.push(
				createMockSession({ id: 's1', executionQueue: undefined }),
				createMockSession({ id: 's2', executionQueue: ['t1'] })
			);

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: [] }));

			const lastCall = mockUpdateUsageStats.mock.calls.at(-1)![0];
			expect(lastCall.maxQueueDepth).toBe(1);
		});

		it('re-calls updateUsageStats when sessions change', () => {
			const { rerender } = renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: [] }));

			const callsBefore = mockUpdateUsageStats.mock.calls.length;

			// Mutate sessions and force rerender
			mockSessions.push(createMockSession({ id: 's1' }));
			(useSessionStore as any).mockImplementation((selector: (s: any) => any) =>
				selector({ sessions: [...mockSessions] })
			);

			rerender();

			expect(mockUpdateUsageStats.mock.calls.length).toBeGreaterThan(callsBefore);
		});

		it('re-calls updateUsageStats when activeBatchSessionIds changes', () => {
			const { rerender } = renderHook(
				({ ids }) => useAutoRunAchievements({ activeBatchSessionIds: ids }),
				{ initialProps: { ids: [] as string[] } }
			);

			const callsBefore = mockUpdateUsageStats.mock.calls.length;

			rerender({ ids: ['session-1', 'session-2'] });

			const callsAfter = mockUpdateUsageStats.mock.calls.length;
			expect(callsAfter).toBeGreaterThan(callsBefore);

			const lastCall = mockUpdateUsageStats.mock.calls.at(-1)![0];
			expect(lastCall.maxSimultaneousAutoRuns).toBe(2);
		});

		it('calculates all stats correctly in a combined scenario', () => {
			mockSessions.push(
				createMockSession({
					id: 's1',
					toolType: 'claude-code',
					state: 'busy',
					executionQueue: ['t1', 't2'],
				}),
				createMockSession({ id: 's2', toolType: 'codex', state: 'idle', executionQueue: ['t3'] }),
				createMockSession({ id: 's3', toolType: 'terminal', state: 'busy', executionQueue: [] })
			);

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['s1', 's2'] }));

			const lastCall = mockUpdateUsageStats.mock.calls.at(-1)![0];
			expect(lastCall.maxAgents).toBe(2); // s1 + s2 (not terminal)
			expect(lastCall.maxDefinedAgents).toBe(2);
			expect(lastCall.maxSimultaneousQueries).toBe(2); // s1 + s3 are busy
			expect(lastCall.maxSimultaneousAutoRuns).toBe(2);
			expect(lastCall.maxQueueDepth).toBe(3); // 2 + 1 + 0
		});
	});

	// ==========================================================================
	// Edge cases
	// ==========================================================================

	describe('edge cases', () => {
		it('hook returns void (undefined)', () => {
			const { result } = renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: [] }));

			expect(result.current).toBeUndefined();
		});

		it('handles an empty sessions array with active batch IDs', () => {
			// Sessions is empty but we have active batch IDs
			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['s1', 's2'] }));

			expect(mockUpdateUsageStats).toHaveBeenCalledWith({
				maxAgents: 0,
				maxDefinedAgents: 0,
				maxSimultaneousAutoRuns: 2,
				maxSimultaneousQueries: 0,
				maxQueueDepth: 0,
			});
		});

		it('does not throw when activeBatchSessionIds transitions from empty to non-empty', () => {
			const { rerender } = renderHook(
				({ ids }) => useAutoRunAchievements({ activeBatchSessionIds: ids }),
				{ initialProps: { ids: [] as string[] } }
			);

			expect(() => rerender({ ids: ['session-1'] })).not.toThrow();
		});

		it('does not throw when activeBatchSessionIds transitions from non-empty to empty', () => {
			const { rerender } = renderHook(
				({ ids }) => useAutoRunAchievements({ activeBatchSessionIds: ids }),
				{ initialProps: { ids: ['session-1'] } }
			);

			expect(() => rerender({ ids: [] })).not.toThrow();
		});

		it('initializes lastUpdateTime on first active run and uses it for subsequent ticks', () => {
			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			// First tick — should fire and produce a positive delta
			act(() => {
				vi.advanceTimersByTime(60000);
			});

			expect(mockUpdateAutoRunProgress).toHaveBeenCalledTimes(1);
			const [deltaMs] = mockUpdateAutoRunProgress.mock.calls[0];
			expect(deltaMs).toBeGreaterThan(0);

			// Second tick should also produce a positive delta
			act(() => {
				vi.advanceTimersByTime(60000);
			});

			expect(mockUpdateAutoRunProgress).toHaveBeenCalledTimes(2);
			const [deltaMs2] = mockUpdateAutoRunProgress.mock.calls[1];
			expect(deltaMs2).toBeGreaterThan(0);
		});

		it('reads fresh autoRunStats from getState() inside interval, not stale closure', () => {
			// Each call to getState returns updated longestRunMs
			(useSettingsStore as any).getState
				.mockReturnValueOnce({
					updateAutoRunProgress: mockUpdateAutoRunProgress,
					updateUsageStats: mockUpdateUsageStats,
					autoRunStats: { longestRunMs: 1000 },
				})
				.mockReturnValue({
					updateAutoRunProgress: mockUpdateAutoRunProgress,
					updateUsageStats: mockUpdateUsageStats,
					autoRunStats: { longestRunMs: 5000 },
				});

			// Badge unlocked on second tick
			mockUpdateAutoRunProgress
				.mockReturnValueOnce({ newBadgeLevel: null, isNewRecord: false })
				.mockReturnValueOnce({ newBadgeLevel: 1, isNewRecord: false });

			renderHook(() => useAutoRunAchievements({ activeBatchSessionIds: ['session-1'] }));

			// First tick — no badge
			act(() => {
				vi.advanceTimersByTime(60000);
			});
			expect(mockSetStandingOvationData).not.toHaveBeenCalled();

			// Second tick — badge level 1 unlocked, uses fresh autoRunStats (longestRunMs: 5000)
			act(() => {
				vi.advanceTimersByTime(60000);
			});

			expect(mockSetStandingOvationData).toHaveBeenCalledTimes(1);
			const callArg = mockSetStandingOvationData.mock.calls[0][0];
			expect(callArg.recordTimeMs).toBe(5000);
		});
	});
});
