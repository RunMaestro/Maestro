/**
 * Tests for usePluginFocusRequestListener.
 *
 * The hook applies main-side `sessions:focus-request` events (emitted by the
 * plugin `sessions.focus` verb) to the canonical renderer session store, since
 * the main-side store write is invisible to the live Zustand store.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { usePluginFocusRequestListener } from '../../../renderer/hooks/session/usePluginFocusRequestListener';
import { createMockSession, resetStore } from '../../helpers';

type FocusPayload = { sessionId: string; tabId?: string };

describe('usePluginFocusRequestListener', () => {
	let handler: ((payload: FocusPayload) => void) | null;
	let unsubscribe: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		resetStore(useSessionStore);
		handler = null;
		unsubscribe = vi.fn();
		// Add to the existing jsdom window rather than replacing it.
		(window as unknown as { maestro: unknown }).maestro = {
			sessions: {
				onFocusRequest: (cb: (payload: FocusPayload) => void) => {
					handler = cb;
					return unsubscribe;
				},
				// setActiveSessionId is fire-and-forget in the store action.
				setActiveSessionId: vi.fn(),
			},
		};
	});

	it('activates the target session and lands it on an AI tab', () => {
		const target = createMockSession({ id: 's-target', activeTabId: 'tab-a' });
		useSessionStore.setState({
			sessions: [createMockSession({ id: 's-other' }), target],
			activeSessionId: 's-other',
		});

		renderHook(() => usePluginFocusRequestListener());
		expect(handler).toBeTypeOf('function');

		handler!({ sessionId: 's-target', tabId: 'tab-a' });

		const state = useSessionStore.getState();
		expect(state.activeSessionId).toBe('s-target');
		const updated = state.sessions.find((s) => s.id === 's-target')!;
		// aiTabFocusFields clears the non-AI views and sets the AI tab + input mode.
		expect(updated.activeTabId).toBe('tab-a');
		expect(updated.activeFileTabId).toBeNull();
		expect(updated.activeBrowserTabId).toBeNull();
		expect(updated.activeTerminalTabId).toBeNull();
		expect(updated.inputMode).toBe('ai');
	});

	it('ignores a request for a session the live store does not have', () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 's-here' })],
			activeSessionId: 's-here',
		});

		renderHook(() => usePluginFocusRequestListener());
		handler!({ sessionId: 'ghost' });

		// Active session unchanged - a stale/unknown id must not hijack focus.
		expect(useSessionStore.getState().activeSessionId).toBe('s-here');
	});

	it('ignores an empty session id', () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 's-here' })],
			activeSessionId: 's-here',
		});

		renderHook(() => usePluginFocusRequestListener());
		handler!({ sessionId: '' });

		expect(useSessionStore.getState().activeSessionId).toBe('s-here');
	});

	it('unsubscribes on unmount', () => {
		const { unmount } = renderHook(() => usePluginFocusRequestListener());
		unmount();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});
