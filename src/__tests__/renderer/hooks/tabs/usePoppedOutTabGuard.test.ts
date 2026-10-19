import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
	reconcilePoppedOutActiveTabs,
	usePoppedOutTabGuard,
} from '../../../../renderer/hooks/tabs/usePoppedOutTabGuard';
import { useSessionStore, updateSessionWith } from '../../../../renderer/stores/sessionStore';
import { useTabWindowStore } from '../../../../renderer/stores/tabWindowStore';
import type { Session } from '../../../../renderer/types';
import type { TabWindowTabRef } from '../../../../shared/tabWindowTypes';
import { createMockAITab } from '../../../helpers/mockTab';
import { createMockSession } from '../../../helpers/mockSession';

function agent(id: string, activeTabId = 'a2'): Session {
	return createMockSession({
		id,
		aiTabs: [
			createMockAITab({ id: 'a1' }),
			createMockAITab({ id: 'a2' }),
			createMockAITab({ id: 'a3' }),
		],
		unifiedTabOrder: [
			{ type: 'ai', id: 'a1' },
			{ type: 'ai', id: 'a2' },
			{ type: 'ai', id: 'a3' },
		],
		activeTabId,
	});
}

function popOut(agentId: string, tabRefs: TabWindowTabRef[]) {
	useTabWindowStore
		.getState()
		.setWindows([{ windowId: 'tw-1', agentId, tabRefs, activeTabRef: tabRefs[0] ?? null }]);
}

const session = (id: string) => useSessionStore.getState().sessions.find((s) => s.id === id)!;

describe('reconcilePoppedOutActiveTabs', () => {
	beforeEach(() => {
		useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
		useSessionStore.setState({ sessions: [agent('s1'), agent('s2')], activeSessionId: 's1' });
	});

	it('does not write the store when nothing is popped', () => {
		const before = useSessionStore.getState().sessions;
		reconcilePoppedOutActiveTabs();
		expect(useSessionStore.getState().sessions).toBe(before);
	});

	it('does not write the store when no active tab is popped', () => {
		popOut('s1', [{ type: 'ai', id: 'a3' }]);
		const before = useSessionStore.getState().sessions;
		reconcilePoppedOutActiveTabs();
		expect(useSessionStore.getState().sessions).toBe(before);
	});

	it('moves an owned agent off its popped active tab and leaves the others alone', () => {
		popOut('s1', [{ type: 'ai', id: 'a2' }]);
		const other = session('s2');
		reconcilePoppedOutActiveTabs();
		expect(session('s1').activeTabId).toBe('a1');
		expect(session('s1').unifiedTabOrder).toContainEqual({ type: 'ai', id: 'a2' });
		expect(session('s2')).toBe(other);
	});

	it('never writes an agent this window does not own', () => {
		popOut('s1', [{ type: 'ai', id: 'a2' }]);
		reconcilePoppedOutActiveTabs((id) => id !== 's1');
		expect(session('s1').activeTabId).toBe('a2');
	});
});

describe('usePoppedOutTabGuard', () => {
	beforeEach(() => {
		useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
		useSessionStore.setState({ sessions: [agent('s1')], activeSessionId: 's1' });
	});

	it('re-picks when the active tab is popped out', () => {
		renderHook(() => usePoppedOutTabGuard());
		act(() => popOut('s1', [{ type: 'ai', id: 'a2' }]));
		expect(session('s1').activeTabId).toBe('a1');
	});

	it('re-picks when a session write lands on a popped tab', () => {
		popOut('s1', [{ type: 'ai', id: 'a3' }]);
		renderHook(() => usePoppedOutTabGuard());
		act(() => updateSessionWith('s1', (s) => ({ ...s, activeTabId: 'a3' })));
		expect(session('s1').activeTabId).toBe('a2');
	});

	it('stops after unmount', () => {
		const { unmount } = renderHook(() => usePoppedOutTabGuard());
		unmount();
		act(() => popOut('s1', [{ type: 'ai', id: 'a2' }]));
		expect(session('s1').activeTabId).toBe('a2');
	});

	it('honors the ownership predicate', () => {
		const ownsSession = vi.fn(() => false);
		renderHook(() => usePoppedOutTabGuard(ownsSession));
		act(() => popOut('s1', [{ type: 'ai', id: 'a2' }]));
		expect(session('s1').activeTabId).toBe('a2');
		expect(ownsSession).toHaveBeenCalledWith('s1');
	});
});
