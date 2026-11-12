/**
 * Tests for useWindowScopedActiveSession - keeping a window's active agent to one
 * it owns so a restored window never shows the false "No agents" empty state.
 *
 * Covers:
 *  - No WindowProvider (single-window / web): the global active agent is left
 *    untouched.
 *  - Active agent already owned by this window: no reconciliation.
 *  - Active agent owned by ANOTHER window: repoint to an owned agent (the scope's
 *    remembered active agent if owned, otherwise the first owned agent).
 *  - Window owns nothing: leave the (correct) empty state in place.
 *  - Waits for sessionsLoaded before acting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Controlled WindowContext: `null` => no window scoping; an object with
// `ownsSession` / `activeSessionId` => scope to that predicate. Mutated per-test.
let mockCtx: { ownsSession: (id: string) => boolean; activeSessionId: string | null } | null = null;
vi.mock('../../../../renderer/contexts/WindowContext', () => ({
	useWindowContextOptional: () => mockCtx,
}));

import { useWindowScopedActiveSession } from '../../../../renderer/hooks/session/useWindowScopedActiveSession';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { createMockSession } from '../../../helpers/mockSession';

function seedStore(opts: {
	sessionIds: string[];
	activeSessionId: string;
	sessionsLoaded?: boolean;
}) {
	useSessionStore.setState({
		sessions: opts.sessionIds.map((id) => createMockSession({ id, name: id })),
		groups: [],
		activeSessionId: opts.activeSessionId,
		sessionsLoaded: opts.sessionsLoaded ?? true,
	} as never);
}

describe('useWindowScopedActiveSession', () => {
	beforeEach(() => {
		mockCtx = null;
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			sessionsLoaded: false,
		} as never);
	});

	it('is a no-op without a WindowProvider (single-window / web)', () => {
		mockCtx = null;
		seedStore({ sessionIds: ['a', 'b'], activeSessionId: 'a' });

		renderHook(() => useWindowScopedActiveSession());

		expect(useSessionStore.getState().activeSessionId).toBe('a');
	});

	it('leaves the active agent alone when this window owns it', () => {
		mockCtx = { ownsSession: (id) => id === 'a', activeSessionId: null };
		seedStore({ sessionIds: ['a', 'b'], activeSessionId: 'a' });

		renderHook(() => useWindowScopedActiveSession());

		expect(useSessionStore.getState().activeSessionId).toBe('a');
	});

	it('repoints to the first owned agent when the active agent lives elsewhere', () => {
		// Active agent 'a' is owned by another window; this window owns 'b'/'c'.
		mockCtx = { ownsSession: (id) => id === 'b' || id === 'c', activeSessionId: null };
		seedStore({ sessionIds: ['a', 'b', 'c'], activeSessionId: 'a' });

		renderHook(() => useWindowScopedActiveSession());

		expect(useSessionStore.getState().activeSessionId).toBe('b');
	});

	it("prefers the window's remembered active agent when it owns it", () => {
		mockCtx = { ownsSession: (id) => id === 'b' || id === 'c', activeSessionId: 'c' };
		seedStore({ sessionIds: ['a', 'b', 'c'], activeSessionId: 'a' });

		renderHook(() => useWindowScopedActiveSession());

		expect(useSessionStore.getState().activeSessionId).toBe('c');
	});

	it('leaves the empty state in place when this window owns nothing', () => {
		mockCtx = { ownsSession: () => false, activeSessionId: null };
		seedStore({ sessionIds: ['a', 'b'], activeSessionId: 'a' });

		renderHook(() => useWindowScopedActiveSession());

		expect(useSessionStore.getState().activeSessionId).toBe('a');
	});

	it('waits for sessionsLoaded before reconciling', () => {
		mockCtx = { ownsSession: (id) => id === 'b', activeSessionId: null };
		seedStore({ sessionIds: ['a', 'b'], activeSessionId: 'a', sessionsLoaded: false });

		const { rerender } = renderHook(() => useWindowScopedActiveSession());
		// Not loaded yet: no reconciliation.
		expect(useSessionStore.getState().activeSessionId).toBe('a');

		useSessionStore.setState({ sessionsLoaded: true } as never);
		rerender();

		expect(useSessionStore.getState().activeSessionId).toBe('b');
	});
});
