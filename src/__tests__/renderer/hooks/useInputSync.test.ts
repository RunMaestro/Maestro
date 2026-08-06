/**
 * Tests for useInputSync - persisting the composer draft onto the active AI tab.
 *
 * The invariant under test is that **command mode travels with the text**. The
 * same string is a shell command or a message to the agent depending on the
 * mode flag, so a draft flushed with one and not the other comes back routed
 * the wrong way: a `rm -rf build` meant for the shell would be narrated at the
 * agent, or a sentence meant for the agent would be handed to sh.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useInputSync } from '../../../renderer/hooks/input/useInputSync';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { Session } from '../../../renderer/types';

const TAB_ID = 'tab-1';
const SESSION_ID = 'session-1';

function makeSession(): Session {
	return createMockSession({
		id: SESSION_ID,
		activeTabId: TAB_ID,
		aiTabs: [createMockAITab({ id: TAB_ID, inputValue: '', logs: [] })],
	});
}

/** Run the setSessions updater the hook produced and return the new state. */
function applySetSessions(setSessions: ReturnType<typeof vi.fn>, session: Session): Session[] {
	let sessions = [session];
	for (const [updater] of setSessions.mock.calls) {
		sessions = typeof updater === 'function' ? updater(sessions) : updater;
	}
	return sessions;
}

beforeEach(() => {
	useComposerInputStore.setState({ aiValue: '', terminalValue: '', aiCommandMode: false });
});

describe('useInputSync - syncAiInputToSession', () => {
	it('persists the draft text onto the active tab', () => {
		const setSessions = vi.fn();
		const session = makeSession();
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		result.current.syncAiInputToSession('half a thought');

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].inputValue).toBe('half a thought');
	});

	it('persists command mode alongside the draft', () => {
		useComposerInputStore.setState({ aiCommandMode: true });
		const setSessions = vi.fn();
		const session = makeSession();
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		result.current.syncAiInputToSession('rm -rf build');

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].inputValue).toBe('rm -rf build');
		expect(updated.aiTabs[0].commandMode).toBe(true);
	});

	it('clears command mode on the tab when the composer is not in it', () => {
		// Explicitly false, not absent: a stale `true` left on the tab would route
		// the next restored draft into a shell.
		useComposerInputStore.setState({ aiCommandMode: false });
		const setSessions = vi.fn();
		const session = makeSession();
		session.aiTabs[0].commandMode = true;
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		result.current.syncAiInputToSession('talk to the agent');

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].commandMode).toBe(false);
	});

	it('reads the mode at flush time, not from a stale closure', () => {
		const setSessions = vi.fn();
		const session = makeSession();
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		// Mode flips after the hook rendered - the flush must still see it.
		useComposerInputStore.setState({ aiCommandMode: true });
		result.current.syncAiInputToSession('ls');

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].commandMode).toBe(true);
	});

	it('does nothing without an active session', () => {
		const setSessions = vi.fn();
		const { result } = renderHook(() => useInputSync(null, { setSessions }));

		result.current.syncAiInputToSession('anything');

		expect(setSessions).not.toHaveBeenCalled();
	});
});
