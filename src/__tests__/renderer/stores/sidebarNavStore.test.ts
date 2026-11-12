/**
 * Tests for sidebarNavStore's activation path.
 *
 * `activateStarredItem` is the one navigation the transition-keyed drawer
 * effect in App.tsx can never see: a starred row routinely names the agent
 * that is ALREADY active, so nothing moves for the effect to react to and the
 * full-screen drawer stayed over the conversation the tap was meant to open.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSidebarNavStore } from '../../../renderer/stores/sidebarNavStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { createMockSession } from '../../helpers';
import type { StarredItem } from '../../../renderer/hooks/session/useStarredItems';

const SESSION_ID = 'session-1';
const TAB_ID = 'tab-1';

const openItem: StarredItem = {
	kind: 'open',
	key: `${SESSION_ID}:${TAB_ID}`,
	displayName: 'Refactor pass',
	agentName: 'Maestro',
	parentSessionId: SESSION_ID,
	tabId: TAB_ID,
};

const originalWidth = window.innerWidth;
const setViewportWidth = (width: number) => {
	Object.defineProperty(window, 'innerWidth', {
		configurable: true,
		writable: true,
		value: width,
	});
};

describe('sidebarNavStore', () => {
	beforeEach(() => {
		useSidebarNavStore.setState(useSidebarNavStore.getInitialState(), true);
		useSessionStore.setState({
			sessions: [createMockSession({ id: SESSION_ID, name: 'Maestro' })],
			activeSessionId: '',
		});
		useGroupChatStore.setState({ activeGroupChatId: null });
		useUIStore.setState({ leftSidebarOpen: true });
	});

	afterEach(() => {
		setViewportWidth(originalWidth);
		vi.restoreAllMocks();
	});

	describe('activateStarredItem', () => {
		it('activates the owning agent and its tab', async () => {
			setViewportWidth(1440);

			await useSidebarNavStore.getState().activateStarredItem(openItem);

			expect(useSessionStore.getState().activeSessionId).toBe(SESSION_ID);
			const session = useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID);
			expect(session?.activeTabId).toBe(TAB_ID);
			expect(session?.activeFileTabId).toBeNull();
			expect(session?.inputMode).toBe('ai');
		});

		it('closes the left drawer on a narrow viewport', async () => {
			setViewportWidth(390);

			await useSidebarNavStore.getState().activateStarredItem(openItem);

			expect(useUIStore.getState().leftSidebarOpen).toBe(false);
		});

		it('closes the drawer even when the starred row names the active agent', async () => {
			// The case the activeSessionId-transition effect cannot see: the id
			// the tap sets is the id that was already there.
			setViewportWidth(390);
			useSessionStore.setState({ activeSessionId: SESSION_ID });

			await useSidebarNavStore.getState().activateStarredItem(openItem);

			expect(useUIStore.getState().leftSidebarOpen).toBe(false);
		});

		it('leaves the Left Bar open when it is a permanent column', async () => {
			setViewportWidth(1440);

			await useSidebarNavStore.getState().activateStarredItem(openItem);

			expect(useUIStore.getState().leftSidebarOpen).toBe(true);
		});

		it('closes the drawer for a closed starred session too', async () => {
			setViewportWidth(390);
			const onJumpToStarredSession = vi.fn().mockResolvedValue(true);
			useSidebarNavStore.getState().registerStarredHandlers({ onJumpToStarredSession });

			await useSidebarNavStore.getState().activateStarredItem({
				kind: 'closed',
				key: 'closed-1',
				displayName: 'Aged out thread',
				agentName: 'Maestro',
				parentSessionId: SESSION_ID,
				agentId: 'claude-code',
				agentSessionId: 'abc-123',
				projectPath: '/tmp/project',
				sessionName: 'Aged out thread',
			});

			expect(onJumpToStarredSession).toHaveBeenCalled();
			expect(useUIStore.getState().leftSidebarOpen).toBe(false);
		});
	});
});
