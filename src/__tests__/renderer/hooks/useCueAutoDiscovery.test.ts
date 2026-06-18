/**
 * Tests for useCueAutoDiscovery hook
 *
 * This hook auto-discovers .maestro/cue.yaml files when sessions are loaded,
 * created, or removed. Session discovery always runs so the Cue indicator
 * shows in the Left Bar. The encore feature flag only gates engine start/stop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCueAutoDiscovery } from '../../../renderer/hooks/useCueAutoDiscovery';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session, EncoreFeatureFlags } from '../../../renderer/types';

// Mock Cue API
const mockRefreshSession = vi.fn();
const mockRemoveSession = vi.fn();
const mockEnable = vi.fn();
const mockDisable = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();

	mockRefreshSession.mockResolvedValue(undefined);
	mockRemoveSession.mockResolvedValue(undefined);
	mockEnable.mockResolvedValue(undefined);
	mockDisable.mockResolvedValue(undefined);

	(window as any).maestro = {
		...(window as any).maestro,
		cue: {
			...(window as any).maestro?.cue,
			refreshSession: mockRefreshSession,
			removeSession: mockRemoveSession,
			enable: mockEnable,
			disable: mockDisable,
		},
	};

	// Reset session store
	useSessionStore.setState({ sessionsLoaded: false });
});

function makeSession(id: string, projectRoot: string): Session {
	return {
		id,
		name: `session-${id}`,
		projectRoot,
		cwd: projectRoot,
	} as unknown as Session;
}

function makeEncoreFeatures(maestroCue: boolean): EncoreFeatureFlags {
	return { maestroCue } as EncoreFeatureFlags;
}

describe('useCueAutoDiscovery', () => {
	describe('initial scan on app startup', () => {
		it('should not call refreshSession before sessions are loaded', () => {
			const sessions = [makeSession('s1', '/project/a')];
			const encoreFeatures = makeEncoreFeatures(true);

			renderHook(() => useCueAutoDiscovery(sessions, encoreFeatures));

			expect(mockRefreshSession).not.toHaveBeenCalled();
		});

		it('should scan all sessions once sessionsLoaded becomes true', async () => {
			const sessions = [makeSession('s1', '/project/a'), makeSession('s2', '/project/b')];
			const encoreFeatures = makeEncoreFeatures(true);

			renderHook(() => useCueAutoDiscovery(sessions, encoreFeatures));

			// Simulate sessions loaded
			act(() => {
				useSessionStore.setState({ sessionsLoaded: true });
			});

			expect(mockRefreshSession).toHaveBeenCalledTimes(2);
			expect(mockRefreshSession).toHaveBeenCalledWith('s1', '/project/a');
			expect(mockRefreshSession).toHaveBeenCalledWith('s2', '/project/b');
		});

		it('should scan sessions even if maestroCue is disabled (indicator always shows)', () => {
			const sessions = [makeSession('s1', '/project/a')];
			const encoreFeatures = makeEncoreFeatures(false);

			renderHook(() => useCueAutoDiscovery(sessions, encoreFeatures));

			act(() => {
				useSessionStore.setState({ sessionsLoaded: true });
			});

			expect(mockRefreshSession).toHaveBeenCalledTimes(1);
			expect(mockRefreshSession).toHaveBeenCalledWith('s1', '/project/a');
		});

		it('should skip sessions without projectRoot', () => {
			const sessions = [makeSession('s1', '/project/a'), makeSession('s2', '')];
			const encoreFeatures = makeEncoreFeatures(true);

			renderHook(() => useCueAutoDiscovery(sessions, encoreFeatures));

			act(() => {
				useSessionStore.setState({ sessionsLoaded: true });
			});

			expect(mockRefreshSession).toHaveBeenCalledTimes(1);
			expect(mockRefreshSession).toHaveBeenCalledWith('s1', '/project/a');
		});
	});

	describe('session additions', () => {
		it('should refresh new sessions when added', () => {
			const initialSessions = [makeSession('s1', '/project/a')];
			const encoreFeatures = makeEncoreFeatures(true);

			useSessionStore.setState({ sessionsLoaded: true });

			const { rerender } = renderHook(
				({ sessions, encore }) => useCueAutoDiscovery(sessions, encore),
				{ initialProps: { sessions: initialSessions, encore: encoreFeatures } }
			);

			mockRefreshSession.mockClear();

			// Add a new session
			const updatedSessions = [...initialSessions, makeSession('s2', '/project/b')];
			rerender({ sessions: updatedSessions, encore: encoreFeatures });

			expect(mockRefreshSession).toHaveBeenCalledWith('s2', '/project/b');
		});
	});

	describe('session removals', () => {
		it('should notify engine when session is removed', () => {
			const initialSessions = [makeSession('s1', '/project/a'), makeSession('s2', '/project/b')];
			const encoreFeatures = makeEncoreFeatures(true);

			useSessionStore.setState({ sessionsLoaded: true });

			const { rerender } = renderHook(
				({ sessions, encore }) => useCueAutoDiscovery(sessions, encore),
				{ initialProps: { sessions: initialSessions, encore: encoreFeatures } }
			);

			mockRefreshSession.mockClear();
			mockRemoveSession.mockClear();

			// Remove session s2
			const updatedSessions = [makeSession('s1', '/project/a')];
			rerender({ sessions: updatedSessions, encore: encoreFeatures });

			expect(mockRemoveSession).toHaveBeenCalledWith('s2');
		});
	});

	describe('encore feature toggle', () => {
		it('should enable Cue and scan all sessions when maestroCue is toggled ON', async () => {
			const sessions = [makeSession('s1', '/project/a'), makeSession('s2', '/project/b')];

			useSessionStore.setState({ sessionsLoaded: true });

			const { rerender } = renderHook(({ sessions: s, encore }) => useCueAutoDiscovery(s, encore), {
				initialProps: { sessions, encore: makeEncoreFeatures(false) },
			});

			mockRefreshSession.mockClear();
			mockEnable.mockClear();

			// Toggle maestroCue ON
			rerender({ sessions, encore: makeEncoreFeatures(true) });
			await act(async () => {});

			expect(mockEnable).toHaveBeenCalledTimes(1);
			expect(mockRefreshSession).toHaveBeenCalledTimes(2);
			expect(mockRefreshSession).toHaveBeenCalledWith('s1', '/project/a');
			expect(mockRefreshSession).toHaveBeenCalledWith('s2', '/project/b');
		});

		it('should call disable when maestroCue is toggled OFF', async () => {
			const sessions = [makeSession('s1', '/project/a')];

			useSessionStore.setState({ sessionsLoaded: true });

			const { rerender } = renderHook(({ sessions: s, encore }) => useCueAutoDiscovery(s, encore), {
				initialProps: { sessions, encore: makeEncoreFeatures(true) },
			});

			// Toggle maestroCue OFF
			rerender({ sessions, encore: makeEncoreFeatures(false) });
			// Toggle calls are now serialized on a Promise chain, so the
			// disable fires on the next microtask rather than synchronously.
			await act(async () => {});

			expect(mockDisable).toHaveBeenCalledTimes(1);
		});

		it('should not trigger actions when feature toggle value unchanged', () => {
			const sessions = [makeSession('s1', '/project/a')];

			useSessionStore.setState({ sessionsLoaded: true });

			const { rerender } = renderHook(({ sessions: s, encore }) => useCueAutoDiscovery(s, encore), {
				initialProps: { sessions, encore: makeEncoreFeatures(true) },
			});

			mockRefreshSession.mockClear();
			mockDisable.mockClear();

			// Rerender with same feature state
			rerender({ sessions, encore: makeEncoreFeatures(true) });

			// Only the initial scan calls should exist, no toggle-related calls
			expect(mockDisable).not.toHaveBeenCalled();
		});
	});

	describe('discovery always runs', () => {
		it('should refresh new sessions even when maestroCue is disabled', () => {
			const initialSessions = [makeSession('s1', '/project/a')];
			const encoreFeatures = makeEncoreFeatures(false);

			useSessionStore.setState({ sessionsLoaded: true });

			const { rerender } = renderHook(
				({ sessions, encore }) => useCueAutoDiscovery(sessions, encore),
				{ initialProps: { sessions: initialSessions, encore: encoreFeatures } }
			);

			mockRefreshSession.mockClear();

			// Add a new session while feature is disabled — should still refresh
			const updatedSessions = [...initialSessions, makeSession('s2', '/project/b')];
			rerender({ sessions: updatedSessions, encore: encoreFeatures });

			expect(mockRefreshSession).toHaveBeenCalledWith('s2', '/project/b');
		});
	});

	describe('rapid-toggle serialization', () => {
		// These tests guard the queueing behavior that prevents ON → OFF → ON
		// toggles from racing when enable/disable IPC calls have different
		// latencies. Without serialization, a slow enable() resolving after a
		// fast disable() could leave the engine enabled when the flag says off.

		it('serializes enable/disable calls in flag-change order even when IPC latency varies', async () => {
			const sessions = [makeSession('s1', '/project/a')];
			useSessionStore.setState({ sessionsLoaded: true });

			const callOrder: string[] = [];
			let resolveEnable: (() => void) | undefined;
			mockEnable.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						callOrder.push('enable:start');
						resolveEnable = () => {
							callOrder.push('enable:resolve');
							resolve();
						};
					})
			);
			mockDisable.mockImplementationOnce(async () => {
				callOrder.push('disable:start');
				callOrder.push('disable:resolve');
			});

			const { rerender } = renderHook(({ sessions: s, encore }) => useCueAutoDiscovery(s, encore), {
				initialProps: { sessions, encore: makeEncoreFeatures(false) },
			});

			// ON → queues enable (which will hang until we resolve it)
			rerender({ sessions, encore: makeEncoreFeatures(true) });
			await act(async () => {});
			// OFF → queues disable. Must NOT execute until enable resolves.
			rerender({ sessions, encore: makeEncoreFeatures(false) });
			await act(async () => {});

			// Disable has not started yet; it's waiting in the chain.
			expect(callOrder).toEqual(['enable:start']);
			expect(mockDisable).not.toHaveBeenCalled();

			// Resolve enable; disable should then fire in order.
			await act(async () => {
				resolveEnable!();
			});
			await act(async () => {});

			expect(callOrder).toEqual([
				'enable:start',
				'enable:resolve',
				'disable:start',
				'disable:resolve',
			]);
		});

		it('applies the final flag value when rapid toggles occur', async () => {
			const sessions = [makeSession('s1', '/project/a')];
			useSessionStore.setState({ sessionsLoaded: true });

			const { rerender } = renderHook(({ sessions: s, encore }) => useCueAutoDiscovery(s, encore), {
				initialProps: { sessions, encore: makeEncoreFeatures(false) },
			});

			// OFF → ON → OFF → ON, firing 3 transitions back-to-back
			rerender({ sessions, encore: makeEncoreFeatures(true) });
			rerender({ sessions, encore: makeEncoreFeatures(false) });
			rerender({ sessions, encore: makeEncoreFeatures(true) });
			await act(async () => {});
			// Let the microtask chain drain across all three toggles.
			await act(async () => {});

			// Every transition must have been observed once — never skipped or
			// reordered. Final call is enable to match the final flag value.
			expect(mockEnable).toHaveBeenCalledTimes(2);
			expect(mockDisable).toHaveBeenCalledTimes(1);
		});
	});
});
