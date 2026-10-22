import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSessionCategories } from '../../../renderer/hooks/session/useSessionCategories';
import { computeSortedSessions } from '../../../renderer/hooks/session/computeSortedSessions';
import { sessionNeedsAttention } from '../../../renderer/utils/sessionAttention';
import { passesUnreadFilter } from '../../../renderer/utils/sidebarMembership';
import { useHeadlessActivityStore } from '../../../renderer/stores/headlessActivityStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { cycleSession } from '../../../renderer/hooks/session/useCycleSession';
import { createMockSession } from '../../helpers/mockSession';

const session = createMockSession({ id: 'relay-target', state: 'idle', aiTabs: [] });
const counts = { [session.id]: 1 };
afterEach(() => useHeadlessActivityStore.setState({ revision: -1, counts: {} }));

describe('headless activity under the unread agents filter', () => {
	it('keeps only actual headless workers in shared attention and membership decisions', () => {
		const ctx = {
			batchSessionIds: new Set<string>(),
			stuckOutageIds: new Set<string>(),
			headlessCounts: counts,
		};
		expect(sessionNeedsAttention(session, ctx)).toBe(true);
		expect(passesUnreadFilter(session, { showUnreadAgentsOnly: true, ...ctx })).toBe(true);
		expect(sessionNeedsAttention(createMockSession({ id: 'queued', state: 'idle' }), ctx)).toBe(
			false
		);
	});
	it('keeps headless agents in the navigation projection without desktop tabs', () => {
		const input = {
			sessions: [session],
			groups: [],
			bookmarksCollapsed: false,
			showUnreadAgentsOnly: true,
			headlessCounts: counts,
		};
		expect(computeSortedSessions(input).visibleSessions.map((s) => s.id)).toContain(session.id);
	});
	it('cycles to a Relay worker under the unread filter without changing its desktop state', () => {
		const active = createMockSession({ id: 'active', name: 'Alpha' });
		useSessionStore.setState({
			sessions: [active, session],
			groups: [],
			activeSessionId: active.id,
			cyclePosition: -1,
		});
		useUIStore.setState({
			leftSidebarOpen: true,
			bookmarksCollapsed: true,
			showUnreadAgentsOnly: true,
		});
		useSettingsStore.setState({ groupChatsExpanded: false, ungroupedCollapsed: false });
		useHeadlessActivityStore.setState({ revision: 1, counts });
		cycleSession('next', {
			handleOpenGroupChat: vi.fn(),
			starredItems: [],
			navIndexMap: new Map(),
		});
		expect(useSessionStore.getState().activeSessionId).toBe(session.id);
		expect(useSessionStore.getState().sessions[1].state).toBe('idle');
	});

	it('updates categorization when only the live counts change', () => {
		useSessionStore.setState({ sessions: [session], groups: [] });
		useHeadlessActivityStore.setState({ revision: 0, counts: {} });
		const { result } = renderHook(() => useSessionCategories('', [session], true, 'other'));
		expect(result.current.sortedFilteredSessions).toHaveLength(0);
		act(() => useHeadlessActivityStore.setState({ revision: 1, counts }));
		expect(result.current.sortedFilteredSessions.map((s) => s.id)).toContain(session.id);
		act(() => useHeadlessActivityStore.setState({ revision: 2, counts: {} }));
		expect(result.current.sortedFilteredSessions).toHaveLength(0);
	});
});
