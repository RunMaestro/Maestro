/**
 * Tests for GitShortcutActionsBridge - the leaf that publishes the active
 * agent's git actions for the global keyboard handler.
 *
 * The bridge exists so App does not have to subscribe to GitStatusContext, so
 * what matters here is that the publish actually happens, that it follows the
 * active agent, and that it is cleared on unmount rather than left pointing at
 * a dead action set.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { GitShortcutActionsBridge } from '../../../renderer/components/GitShortcutActionsBridge';
import { getGitShortcutActions } from '../../../renderer/services/gitShortcutActions';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session } from '../../../renderer/types';

// Stubbed so the test exercises the publish wiring, not git polling. The
// returned shape only needs enough to prove WHICH agent was resolved.
vi.mock('../../../renderer/hooks/git/useGitAgentActions', () => ({
	useGitAgentActions: (session: Session | null | undefined) => ({
		isGitRepo: Boolean(session?.isGitRepo),
		sessionId: session?.id,
	}),
}));

function makeSession(id: string, isGitRepo: boolean): Session {
	return { id, name: id, cwd: `/tmp/${id}`, isGitRepo } as Session;
}

describe('GitShortcutActionsBridge', () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [makeSession('a', true), makeSession('b', false)],
			activeSessionId: 'a',
		});
	});

	afterEach(() => {
		useSessionStore.setState({ sessions: [], activeSessionId: undefined });
	});

	it('publishes the active agent actions and renders nothing', () => {
		const { container } = render(<GitShortcutActionsBridge />);

		expect(container.firstChild).toBeNull();
		expect(getGitShortcutActions()).toMatchObject({ isGitRepo: true, sessionId: 'a' });
	});

	it('follows the active agent', () => {
		render(<GitShortcutActionsBridge />);

		act(() => {
			useSessionStore.setState({ activeSessionId: 'b' });
		});

		expect(getGitShortcutActions()).toMatchObject({ isGitRepo: false, sessionId: 'b' });
	});

	it('clears the published actions on unmount', () => {
		const { unmount } = render(<GitShortcutActionsBridge />);
		expect(getGitShortcutActions()).not.toBeNull();

		unmount();

		expect(getGitShortcutActions()).toBeNull();
	});
});
