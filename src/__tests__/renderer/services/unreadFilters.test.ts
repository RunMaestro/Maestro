/**
 * Tests for the combined "Unread Only" toggle.
 *
 * The agent filter and the tab filter are independent, and the whole point of
 * the combined toggle is that one press leaves them agreeing. Two behaviors are
 * easy to "simplify" into bugs, so they are pinned:
 *  - a HALF-filtered view (one filter on, one off) completes to both-on rather
 *    than clearing, or the palette entry reads "On" and then turns things off;
 *  - the tab side routes through the tab toggle, so the pre-filter tab is still
 *    saved on the way in and restored on the way out.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	areUnreadFiltersActive,
	toggleAllUnreadFilters,
} from '../../../renderer/services/unreadFilters';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { createMockSession } from '../../helpers/mockSession';
import type { AITab, Session } from '../../../renderer/types';

const SESSION_ID = 'agent-1';

const tab = (id: string): AITab => ({ id, name: id, logs: [] }) as unknown as AITab;

function seed(overrides: Partial<Session> = {}): Session {
	const session = createMockSession({
		id: SESSION_ID,
		inputMode: 'ai',
		aiTabs: [tab('tab-1'), tab('tab-2')],
		activeTabId: 'tab-1',
		activeFileTabId: null,
		activeBrowserTabId: null,
		activeTerminalTabId: null,
		...overrides,
	} as Partial<Session>);
	useSessionStore.setState({ sessions: [session], activeSessionId: SESSION_ID } as never);
	return session;
}

const currentSession = (): Session =>
	useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID) as Session;

const filters = () => {
	const { showUnreadOnly, showUnreadAgentsOnly } = useUIStore.getState();
	return { showUnreadOnly, showUnreadAgentsOnly };
};

beforeEach(() => {
	useUIStore.setState({
		showUnreadOnly: false,
		showUnreadAgentsOnly: false,
		preFilterActiveTabId: null,
	});
	seed();
});

describe('areUnreadFiltersActive', () => {
	it('is only active when BOTH filters are on', () => {
		expect(areUnreadFiltersActive()).toBe(false);

		useUIStore.setState({ showUnreadAgentsOnly: true });
		expect(areUnreadFiltersActive()).toBe(false);

		useUIStore.setState({ showUnreadOnly: true });
		expect(areUnreadFiltersActive()).toBe(true);
	});
});

describe('toggleAllUnreadFilters', () => {
	it('turns both filters on from off', () => {
		toggleAllUnreadFilters();
		expect(filters()).toEqual({ showUnreadOnly: true, showUnreadAgentsOnly: true });
	});

	it('turns both filters off when both are on', () => {
		useUIStore.setState({ showUnreadOnly: true, showUnreadAgentsOnly: true });
		toggleAllUnreadFilters();
		expect(filters()).toEqual({ showUnreadOnly: false, showUnreadAgentsOnly: false });
	});

	it('completes a half-filtered view instead of clearing it (agents on)', () => {
		useUIStore.setState({ showUnreadAgentsOnly: true });
		toggleAllUnreadFilters();
		expect(filters()).toEqual({ showUnreadOnly: true, showUnreadAgentsOnly: true });
	});

	it('completes a half-filtered view instead of clearing it (tabs on)', () => {
		useUIStore.setState({ showUnreadOnly: true });
		toggleAllUnreadFilters();
		expect(filters()).toEqual({ showUnreadOnly: true, showUnreadAgentsOnly: true });
	});

	it('saves the pre-filter AI tab on the way in and restores it on the way out', () => {
		toggleAllUnreadFilters();
		expect(useUIStore.getState().preFilterActiveTabId).toBe('tab-1');

		// The filtered view moves the user to another unread tab.
		useSessionStore.setState({
			sessions: [{ ...currentSession(), activeTabId: 'tab-2' }],
		} as never);

		toggleAllUnreadFilters();
		expect(useUIStore.getState().preFilterActiveTabId).toBeNull();
		expect(currentSession().activeTabId).toBe('tab-1');
	});

	it('does not force an AI tab restore when the user was on a terminal tab', () => {
		seed({ activeTerminalTabId: 'term-1' } as Partial<Session>);
		toggleAllUnreadFilters();
		expect(useUIStore.getState().preFilterActiveTabId).toBeNull();
	});
});
