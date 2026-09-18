/**
 * Tests for agentNavigation - the shared "take me to that agent" path.
 *
 * The value of this module is the housekeeping around `setActiveSessionId`:
 * a jump that leaves the Document Graph overlay up, leaves a group chat
 * rendering, lands on a stale terminal tab, or leaves the agent inside a
 * collapsed group looks to the user like the click did nothing. Each of those
 * steps gets a test, because each was a separate bug in a separate caller
 * before this module existed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	jumpToAgent,
	revealAgentInSidebar,
	openAgentSettings,
} from '../../../renderer/services/agentNavigation';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useFileExplorerStore } from '../../../renderer/stores/fileExplorerStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { createMockSession, createMockAITab } from '../../helpers';
import type { Session } from '../../../renderer/types';

const SESSION_ID = 'session-1';

function seed(overrides: Partial<Session> = {}, groups: { id: string; collapsed: boolean }[] = []) {
	const session = createMockSession({
		id: SESSION_ID,
		name: 'Test Agent',
		activeBrowserTabId: 'browser-1',
		activeTerminalTabId: 'terminal-1',
		...overrides,
	});
	useSessionStore.setState({
		sessions: [session],
		activeSessionId: 'other-agent',
		groups,
	} as never);
	return session;
}

beforeEach(() => {
	useSessionStore.setState({ sessions: [], groups: [], activeSessionId: null } as never);
	useUIStore.setState({ bookmarksCollapsed: false });
	useFileExplorerStore.setState({ isGraphViewOpen: false } as never);
	useGroupChatStore.setState({ activeGroupChatId: 'chat-1' } as never);
});

describe('jumpToAgent', () => {
	it('selects the agent and forces the AI view', () => {
		seed();

		expect(jumpToAgent(SESSION_ID)).toBe(true);

		const state = useSessionStore.getState();
		expect(state.activeSessionId).toBe(SESSION_ID);
		const session = state.sessions.find((s) => s.id === SESSION_ID);
		// The agent was last viewed on a browser/terminal tab; without clearing
		// those the main window keeps rendering them instead of the transcript.
		expect(session?.activeBrowserTabId).toBeNull();
		expect(session?.activeTerminalTabId).toBeNull();
	});

	it('dismisses a group chat that would render instead of the agent', () => {
		seed();

		jumpToAgent(SESSION_ID);

		expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
	});

	it('closes the Document Graph overlay that would cover the agent', () => {
		seed();
		useFileExplorerStore.setState({ isGraphViewOpen: true } as never);

		jumpToAgent(SESSION_ID);

		expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(false);
	});

	it('lands on a named AI tab when the agent still has it', () => {
		seed({ aiTabs: [createMockAITab({ id: 'tab-a' }), createMockAITab({ id: 'tab-b' })] });

		jumpToAgent(SESSION_ID, { tabId: 'tab-b' });

		expect(useSessionStore.getState().sessions[0].activeTabId).toBe('tab-b');
	});

	it('ignores a tab id the agent no longer has', () => {
		const session = seed({ aiTabs: [createMockAITab({ id: 'tab-a' })], activeTabId: 'tab-a' });
		const original = session.activeTabId;

		jumpToAgent(SESSION_ID, { tabId: 'tab-that-was-closed' });

		// Still switches to the AI view, just without moving the active tab.
		expect(useSessionStore.getState().sessions[0].activeTabId).toBe(original);
	});

	it('reveals the agent it just selected', () => {
		// The reveal is part of the jump, not a second thing the caller has to
		// remember: selecting an agent inside a collapsed group otherwise moves
		// nothing the user can see.
		seed({ groupId: 'group-1', bookmarked: false }, [{ id: 'group-1', collapsed: true }]);

		jumpToAgent(SESSION_ID);

		expect(useSessionStore.getState().groups[0].collapsed).toBe(false);
	});

	it('reports a miss instead of switching when the agent is gone', () => {
		expect(jumpToAgent('deleted-agent')).toBe(false);
		expect(useSessionStore.getState().activeSessionId).toBeNull();
	});
});

describe('revealAgentInSidebar', () => {
	it('expands the collapsed group holding an unbookmarked agent', () => {
		const session = seed({ groupId: 'group-1', bookmarked: false }, [
			{ id: 'group-1', collapsed: true },
		]);

		revealAgentInSidebar(session);

		expect(useSessionStore.getState().groups[0].collapsed).toBe(false);
	});

	it('expands bookmarks when a bookmarked agent is visible nowhere else', () => {
		const session = seed({ groupId: 'group-1', bookmarked: true }, [
			{ id: 'group-1', collapsed: true },
		]);
		useUIStore.setState({ bookmarksCollapsed: true });

		revealAgentInSidebar(session);

		expect(useUIStore.getState().bookmarksCollapsed).toBe(false);
		// The group stays as the user left it - the bookmark row is the lighter
		// of the two reveals, so expanding both would be over-eager.
		expect(useSessionStore.getState().groups[0].collapsed).toBe(true);
	});

	it('leaves both sections alone when a bookmarked agent is already visible', () => {
		const session = seed({ groupId: 'group-1', bookmarked: true }, [
			{ id: 'group-1', collapsed: false },
		]);
		useUIStore.setState({ bookmarksCollapsed: true });

		revealAgentInSidebar(session);

		expect(useUIStore.getState().bookmarksCollapsed).toBe(true);
	});
});

describe('openAgentSettings', () => {
	it('opens the Edit Agent modal carrying the agent', () => {
		const session = seed();
		const openModal = vi.spyOn(useModalStore.getState(), 'openModal');

		openAgentSettings(session);

		expect(openModal).toHaveBeenCalledWith('editAgent', { session });
	});
});
