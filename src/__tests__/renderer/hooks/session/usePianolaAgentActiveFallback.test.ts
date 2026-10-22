import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../../../../renderer/utils/activeSessionPersistence', () => ({
	persistActiveSessionId: vi.fn(),
	readPersistedActiveSessionId: vi.fn(async () => ''),
}));

import { usePianolaAgent } from '../../../../renderer/hooks/session/usePianolaAgent';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSidebarNavStore } from '../../../../renderer/stores/sidebarNavStore';
import { ENCORE_FEATURE_DEFAULTS } from '../../../../shared/encoreFeatureDefaults';
import type { Session } from '../../../../renderer/types';

const agent = (id: string, isPianola = false) =>
	({ id, name: id, isPianola }) as unknown as Session;

/**
 * The Pianola agent outlives its Encore flag in the session store. If it is the
 * active agent while the flag is off, the main panel shows an agent with no
 * Left Bar row, so the hook moves the selection to a visible one.
 */
describe('usePianolaAgent: active agent while the flag is off', () => {
	beforeEach(() => {
		useSidebarNavStore.setState({ visibleSessions: [] });
		useSessionStore.setState({
			sessions: [agent('pianola', true), agent('alpha'), agent('beta')],
			activeSessionId: 'pianola',
			sessionsLoaded: true,
		});
	});

	it('moves off the hidden Pianola agent to the first visible agent', () => {
		useSidebarNavStore.setState({ visibleSessions: [agent('beta'), agent('alpha')] });

		renderHook(() => usePianolaAgent({ ...ENCORE_FEATURE_DEFAULTS, pianola: false }));

		expect(useSessionStore.getState().activeSessionId).toBe('beta');
	});

	it('falls back to any other agent when the Left Bar list is not built yet', () => {
		renderHook(() => usePianolaAgent({ ...ENCORE_FEATURE_DEFAULTS, pianola: false }));

		expect(useSessionStore.getState().activeSessionId).toBe('alpha');
	});

	it('leaves the selection alone while Pianola is on', () => {
		renderHook(() => usePianolaAgent({ ...ENCORE_FEATURE_DEFAULTS, pianola: true }));

		expect(useSessionStore.getState().activeSessionId).toBe('pianola');
	});

	it('stays put when Pianola is the only agent', () => {
		useSessionStore.setState({ sessions: [agent('pianola', true)] });

		renderHook(() => usePianolaAgent({ ...ENCORE_FEATURE_DEFAULTS, pianola: false }));

		expect(useSessionStore.getState().activeSessionId).toBe('pianola');
	});
});
