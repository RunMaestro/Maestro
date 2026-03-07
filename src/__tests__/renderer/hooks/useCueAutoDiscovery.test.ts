/**
 * Tests for useCueAutoDiscovery hook
 *
 * This hook auto-discovers maestro-cue.yaml files when sessions are loaded,
 * created, or removed. It gates all operations on the maestroCue encore feature.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCueAutoDiscovery } from '../../../renderer/hooks/useCueAutoDiscovery';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session, EncoreFeatureFlags } from '../../../renderer/types';

// Mock Cue API
const mockRefreshSession = vi.fn();
const mockDisable = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();

	mockRefreshSession.mockResolvedValue(undefined);
	mockDisable.mockResolvedValue(undefined);

	(window as any).maestro = {
		...(window as any).maestro,
		cue: {
			...(window as any).maestro?.cue,
			refreshSession: mockRefreshSession,
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

		it('should not scan sessions if maestroCue is disabled', () => {
			const sessions = [makeSession('s1', '/project/a')];
			const encoreFeatures = makeEncoreFeatures(false);

			renderHook(() => useCueAutoDiscovery(sessions, encoreFeatures));

			act(() => {
				useSessionStore.setState({ sessionsLoaded: true });
			});

			expect(mockRefreshSession).not.toHaveBeenCalled();
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

			// Remove session s2
			const updatedSessions = [makeSession('s1', '/project/a')];
			rerender({ sessions: updatedSessions, encore: encoreFeatures });

			expect(mockRefreshSession).toHaveBeenCalledWith('s2', '');
		});
	});

	describe('encore feature toggle', () => {
		it('should scan all sessions when maestroCue is toggled ON', () => {
			const sessions = [makeSession('s1', '/project/a'), makeSession('s2', '/project/b')];

			useSessionStore.setState({ sessionsLoaded: true });

			const { rerender } = renderHook(({ sessions: s, encore }) => useCueAutoDiscovery(s, encore), {
				initialProps: { sessions, encore: makeEncoreFeatures(false) },
			});

			mockRefreshSession.mockClear();

			// Toggle maestroCue ON
			rerender({ sessions, encore: makeEncoreFeatures(true) });

			expect(mockRefreshSession).toHaveBeenCalledTimes(2);
			expect(mockRefreshSession).toHaveBeenCalledWith('s1', '/project/a');
			expect(mockRefreshSession).toHaveBeenCalledWith('s2', '/project/b');
		});

		it('should call disable when maestroCue is toggled OFF', () => {
			const sessions = [makeSession('s1', '/project/a')];

			useSessionStore.setState({ sessionsLoaded: true });

			const { rerender } = renderHook(({ sessions: s, encore }) => useCueAutoDiscovery(s, encore), {
				initialProps: { sessions, encore: makeEncoreFeatures(true) },
			});

			// Toggle maestroCue OFF
			rerender({ sessions, encore: makeEncoreFeatures(false) });

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

	describe('gating behavior', () => {
		it('should not refresh sessions when maestroCue is disabled even if sessions change', () => {
			const initialSessions = [makeSession('s1', '/project/a')];
			const encoreFeatures = makeEncoreFeatures(false);

			useSessionStore.setState({ sessionsLoaded: true });

			const { rerender } = renderHook(
				({ sessions, encore }) => useCueAutoDiscovery(sessions, encore),
				{ initialProps: { sessions: initialSessions, encore: encoreFeatures } }
			);

			mockRefreshSession.mockClear();

			// Add a new session while feature is disabled
			const updatedSessions = [...initialSessions, makeSession('s2', '/project/b')];
			rerender({ sessions: updatedSessions, encore: encoreFeatures });

			expect(mockRefreshSession).not.toHaveBeenCalled();
		});
	});
});
