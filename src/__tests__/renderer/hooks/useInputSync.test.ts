/**
 * Tests for useInputSync - persisting the composer draft onto the active AI tab.
 *
 * The invariant under test is that **command mode travels with the text**. The
 * same string is a shell command or a message to the agent depending on the
 * mode flag, so a draft flushed with one and not the other comes back routed
 * the wrong way: a `rm -rf build` meant for the shell would be narrated at the
 * agent, or a sentence meant for the agent would be handed to sh.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useInputSync } from '../../../renderer/hooks/input/useInputSync';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { Session } from '../../../renderer/types';

const TAB_ID = 'tab-1';
const OTHER_TAB_ID = 'tab-2';
const SESSION_ID = 'session-1';

function makeSession(): Session {
	return createMockSession({
		id: SESSION_ID,
		activeTabId: TAB_ID,
		aiTabs: [
			createMockAITab({ id: TAB_ID, inputValue: '', logs: [] }),
			createMockAITab({ id: OTHER_TAB_ID, inputValue: '', logs: [] }),
		],
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
	useComposerInputStore.setState({ aiValue: '', terminalValue: '', aiCommandMode: 'off' });
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
		useComposerInputStore.setState({ aiCommandMode: 'shell' });
		const setSessions = vi.fn();
		const session = makeSession();
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		result.current.syncAiInputToSession('rm -rf build');

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].inputValue).toBe('rm -rf build');
		expect(updated.aiTabs[0].commandMode).toBe('shell');
	});

	it('clears command mode on the tab when the composer is not in it', () => {
		// Explicitly false, not absent: a stale `true` left on the tab would route
		// the next restored draft into a shell.
		useComposerInputStore.setState({ aiCommandMode: 'off' });
		const setSessions = vi.fn();
		const session = makeSession();
		session.aiTabs[0].commandMode = 'shell';
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		result.current.syncAiInputToSession('talk to the agent');

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].commandMode).toBe('off');
	});

	it('reads the mode at flush time, not from a stale closure', () => {
		const setSessions = vi.fn();
		const session = makeSession();
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		// Mode flips after the hook rendered - the flush must still see it.
		useComposerInputStore.setState({ aiCommandMode: 'shell' });
		result.current.syncAiInputToSession('ls');

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].commandMode).toBe('shell');
	});

	it('does nothing without an active session', () => {
		const setSessions = vi.fn();
		const { result } = renderHook(() => useInputSync(null, { setSessions }));

		result.current.syncAiInputToSession('anything');

		expect(setSessions).not.toHaveBeenCalled();
	});

	it('writes to the tab it is given, not the tab that happens to be active', () => {
		// Blur and other async flushes can land after the active tab moved. An
		// unattributed write would stamp this text onto the new tab and wipe the
		// draft that tab was holding.
		const setSessions = vi.fn();
		const session = makeSession();
		session.aiTabs[1].inputValue = 'the other tab draft';
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		result.current.syncAiInputToSession('typed on tab-1', TAB_ID);

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].inputValue).toBe('typed on tab-1');
		expect(updated.aiTabs[1].inputValue).toBe('the other tab draft');
	});

	it('leaves the session reference untouched when nothing actually changed', () => {
		// The write-back runs on a typing timer, so a no-op must not churn
		// session identity - that would re-render the app and re-persist.
		const setSessions = vi.fn();
		const session = makeSession();
		session.aiTabs[0].inputValue = 'already stored';
		session.aiTabs[0].commandMode = 'off';
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		result.current.syncAiInputToSession('already stored', TAB_ID);

		const [updated] = applySetSessions(setSessions, session);
		expect(updated).toBe(session);
	});
});

describe('useInputSync - queueAiDraftFlush', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('writes the live draft back to its tab without any blur or submit', () => {
		// The guarantee: text the user typed reaches session state on its own.
		// No flush point (blur, tab switch, send) is load bearing.
		const setSessions = vi.fn();
		const session = makeSession();
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		result.current.queueAiDraftFlush(TAB_ID, 'never blurred', 'off');
		expect(setSessions).not.toHaveBeenCalled();

		vi.advanceTimersByTime(500);

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].inputValue).toBe('never blurred');
	});

	it('coalesces a burst of keystrokes into one write', () => {
		const setSessions = vi.fn();
		const session = makeSession();
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		for (const text of ['n', 'ne', 'nev', 'neve', 'never']) {
			result.current.queueAiDraftFlush(TAB_ID, text, 'off');
		}
		vi.advanceTimersByTime(500);

		expect(setSessions).toHaveBeenCalledTimes(1);
		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].inputValue).toBe('never');
	});

	it('flushes the previous tab before queuing for a new one', () => {
		// Switching tabs inside the coalescing window must not drop what was
		// typed in the tab being left.
		const setSessions = vi.fn();
		const session = makeSession();
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		result.current.queueAiDraftFlush(TAB_ID, 'first tab text', 'off');
		result.current.queueAiDraftFlush(OTHER_TAB_ID, 'second tab text', 'off');
		vi.advanceTimersByTime(500);

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].inputValue).toBe('first tab text');
		expect(updated.aiTabs[1].inputValue).toBe('second tab text');
	});

	it('is superseded by an explicit sync, so sent text cannot come back', () => {
		const setSessions = vi.fn();
		const session = makeSession();
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		result.current.queueAiDraftFlush(TAB_ID, 'about to be sent', 'off');
		// Sending clears the composer and syncs the empty value.
		result.current.syncAiInputToSession('', TAB_ID);
		vi.advanceTimersByTime(500);

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].inputValue).toBe('');
	});

	it('flushes a pending draft on unmount', () => {
		const setSessions = vi.fn();
		const session = makeSession();
		const { result, unmount } = renderHook(() => useInputSync(session, { setSessions }));

		result.current.queueAiDraftFlush(TAB_ID, 'typed right before teardown', 'off');
		unmount();

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].inputValue).toBe('typed right before teardown');
	});

	it('flushes a pending draft when the window loses focus', () => {
		// Stepping away to grab a screenshot is exactly when a user gets
		// interrupted mid-sentence, and it's when the session file gets written.
		const setSessions = vi.fn();
		const session = makeSession();
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		result.current.queueAiDraftFlush(TAB_ID, 'stepping away mid-sentence', 'off');
		window.dispatchEvent(new Event('blur'));

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].inputValue).toBe('stepping away mid-sentence');
	});

	it('carries command mode with the queued text', () => {
		const setSessions = vi.fn();
		const session = makeSession();
		const { result } = renderHook(() => useInputSync(session, { setSessions }));

		result.current.queueAiDraftFlush(TAB_ID, 'rm -rf build', 'shell');
		vi.advanceTimersByTime(500);

		const [updated] = applySetSessions(setSessions, session);
		expect(updated.aiTabs[0].commandMode).toBe('shell');
	});
});
