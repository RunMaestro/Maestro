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
import { resetStore } from '../../helpers/resetStores';
import type { Session, EncoreFeatureFlags } from '../../../renderer/types';

// Mock Cue API
const mockRefreshSession = vi.fn();
const mockRemoveSession = vi.fn();
const mockEnable = vi.fn();
const mockDisable = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	resetStore(useSessionStore);

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

function seedSessions(sessions: Session[], sessionsLoaded = false) {
	useSessionStore.setState({ sessions, sessionsLoaded });
}

describe('useCueAutoDiscovery', () => {
	describe('initial scan on app startup', () => {
		it('should not call refreshSession before sessions are loaded', () => {
			const sessions = [makeSession('s1', '/project/a')];
			const encoreFeatures = makeEncoreFeatures(true);

			seedSessions(sessions, false);
			renderHook(() => useCueAutoDiscovery(encoreFeatures));

			expect(mockRefreshSession).not.toHaveBeenCalled();
		});

		it('should scan all sessions once sessionsLoaded becomes true', async () => {
			const sessions = [makeSession('s1', '/project/a'), makeSession('s2', '/project/b')];
			const encoreFeatures = makeEncoreFeatures(true);

			seedSessions(sessions, false);
			renderHook(() => useCueAutoDiscovery(encoreFeatures));

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

			seedSessions(sessions, false);
			renderHook(() => useCueAutoDiscovery(encoreFeatures));

			act(() => {
				useSessionStore.setState({ sessionsLoaded: true });
			});

			expect(mockRefreshSession).toHaveBeenCalledTimes(1);
			expect(mockRefreshSession).toHaveBeenCalledWith('s1', '/project/a');
		});

		it('should skip sessions without projectRoot', () => {
			const sessions = [makeSession('s1', '/project/a'), makeSession('s2', '')];
			const encoreFeatures = makeEncoreFeatures(true);

			seedSessions(sessions, false);
			renderHook(() => useCueAutoDiscovery(encoreFeatures));

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

			seedSessions(initialSessions, true);
			renderHook(() => useCueAutoDiscovery(encoreFeatures));

			mockRefreshSession.mockClear();

			// Add a new session
			act(() => {
				seedSessions([...initialSessions, makeSession('s2', '/project/b')], true);
			});

			expect(mockRefreshSession).toHaveBeenCalledWith('s2', '/project/b');
		});
	});

	describe('session removals', () => {
		it('should notify engine when session is removed', () => {
			const initialSessions = [makeSession('s1', '/project/a'), makeSession('s2', '/project/b')];
			const encoreFeatures = makeEncoreFeatures(true);

			seedSessions(initialSessions, true);
			renderHook(() => useCueAutoDiscovery(encoreFeatures));

			mockRefreshSession.mockClear();
			mockRemoveSession.mockClear();

			// Remove session s2
			act(() => {
				seedSessions([makeSession('s1', '/project/a')], true);
			});

			expect(mockRemoveSession).toHaveBeenCalledWith('s2');
		});
	});

	describe('projectRoot moves', () => {
		it('removes and refreshes when an existing session changes projectRoot', async () => {
			const initialSessions = [makeSession('s1', '/project/a')];
			const encoreFeatures = makeEncoreFeatures(true);

			seedSessions(initialSessions, true);
			renderHook(() => useCueAutoDiscovery(encoreFeatures));

			mockRefreshSession.mockClear();
			mockRemoveSession.mockClear();

			act(() => {
				seedSessions([makeSession('s1', '/project/moved')], true);
			});

			expect(mockRemoveSession).toHaveBeenCalledWith('s1');
			await act(async () => {});
			expect(mockRefreshSession).toHaveBeenCalledWith('s1', '/project/moved');
		});

		it('removes without refresh when projectRoot is cleared', async () => {
			const initialSessions = [makeSession('s1', '/project/a')];
			const encoreFeatures = makeEncoreFeatures(true);

			seedSessions(initialSessions, true);
			renderHook(() => useCueAutoDiscovery(encoreFeatures));

			mockRefreshSession.mockClear();
			mockRemoveSession.mockClear();

			act(() => {
				seedSessions([makeSession('s1', '')], true);
			});

			expect(mockRemoveSession).toHaveBeenCalledWith('s1');
			await act(async () => {});
			expect(mockRefreshSession).not.toHaveBeenCalled();
		});
	});

	describe('encore feature toggle', () => {
		it('should enable Cue and scan all sessions when maestroCue is toggled ON', async () => {
			const sessions = [makeSession('s1', '/project/a'), makeSession('s2', '/project/b')];

			seedSessions(sessions, true);

			const { rerender } = renderHook(({ encore }) => useCueAutoDiscovery(encore), {
				initialProps: { encore: makeEncoreFeatures(false) },
			});

			mockRefreshSession.mockClear();
			mockEnable.mockClear();

			// Toggle maestroCue ON
			rerender({ encore: makeEncoreFeatures(true) });
			await act(async () => {});

			expect(mockEnable).toHaveBeenCalledTimes(1);
			expect(mockRefreshSession).toHaveBeenCalledTimes(2);
			expect(mockRefreshSession).toHaveBeenCalledWith('s1', '/project/a');
			expect(mockRefreshSession).toHaveBeenCalledWith('s2', '/project/b');
		});

		it('should call disable when maestroCue is toggled OFF', async () => {
			const sessions = [makeSession('s1', '/project/a')];

			seedSessions(sessions, true);

			const { rerender } = renderHook(({ encore }) => useCueAutoDiscovery(encore), {
				initialProps: { encore: makeEncoreFeatures(true) },
			});

			// Toggle maestroCue OFF
			rerender({ encore: makeEncoreFeatures(false) });
			// Toggle calls are now serialized on a Promise chain, so the
			// disable fires on the next microtask rather than synchronously.
			await act(async () => {});

			expect(mockDisable).toHaveBeenCalledTimes(1);
		});

		it('should not trigger actions when feature toggle value unchanged', () => {
			const sessions = [makeSession('s1', '/project/a')];

			seedSessions(sessions, true);

			const { rerender } = renderHook(({ encore }) => useCueAutoDiscovery(encore), {
				initialProps: { encore: makeEncoreFeatures(true) },
			});

			mockRefreshSession.mockClear();
			mockDisable.mockClear();

			// Rerender with same feature state
			rerender({ encore: makeEncoreFeatures(true) });

			// Only the initial scan calls should exist, no toggle-related calls
			expect(mockDisable).not.toHaveBeenCalled();
		});
	});

	describe('discovery always runs', () => {
		it('should refresh new sessions even when maestroCue is disabled', () => {
			const initialSessions = [makeSession('s1', '/project/a')];
			const encoreFeatures = makeEncoreFeatures(false);

			seedSessions(initialSessions, true);
			renderHook(() => useCueAutoDiscovery(encoreFeatures));

			mockRefreshSession.mockClear();

			// Add a new session while feature is disabled - should still refresh
			act(() => {
				seedSessions([...initialSessions, makeSession('s2', '/project/b')], true);
			});

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
			seedSessions(sessions, true);

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

			const { rerender } = renderHook(({ encore }) => useCueAutoDiscovery(encore), {
				initialProps: { encore: makeEncoreFeatures(false) },
			});

			// ON → queues enable (which will hang until we resolve it)
			rerender({ encore: makeEncoreFeatures(true) });
			await act(async () => {});
			// OFF → queues disable. Must NOT execute until enable resolves.
			rerender({ encore: makeEncoreFeatures(false) });
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
			seedSessions(sessions, true);

			const { rerender } = renderHook(({ encore }) => useCueAutoDiscovery(encore), {
				initialProps: { encore: makeEncoreFeatures(false) },
			});

			// OFF → ON → OFF → ON, firing 3 transitions back-to-back
			rerender({ encore: makeEncoreFeatures(true) });
			rerender({ encore: makeEncoreFeatures(false) });
			rerender({ encore: makeEncoreFeatures(true) });
			await act(async () => {});
			// Let the microtask chain drain across all three toggles.
			await act(async () => {});

			// Every transition must have been observed once - never skipped or
			// reordered. Final call is enable to match the final flag value.
			expect(mockEnable).toHaveBeenCalledTimes(2);
			expect(mockDisable).toHaveBeenCalledTimes(1);
		});
	});
});
