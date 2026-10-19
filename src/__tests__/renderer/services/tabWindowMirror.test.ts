/**
 * Tests for services/tabWindowMirror and components/TabWindow/useTabWindowMirror:
 * the tab window's half of the Tab Windows patch stream (D2).
 *
 * A delta applied to the wrong base shows the user a transcript that never
 * existed; a stream that stops applying freezes the window. So the mirror must
 * start only from a snapshot, ask for one more exactly once on a gap, and never
 * lose what the tab window wrote itself (the draft, the scroll position).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	startTabWindowMirror,
	type TabWindowMirrorStream,
} from '../../../renderer/services/tabWindowMirror';
import { useTabWindowMirror } from '../../../renderer/components/TabWindow/useTabWindowMirror';
import { updateAiTab, useSessionStore } from '../../../renderer/stores/sessionStore';
import { captureMessage } from '../../../renderer/utils/sentry';
import type { AITab, LogEntry, Session } from '../../../renderer/types';
import type { TabWindowInfo, TabWindowTabRef } from '../../../shared/tabWindowTypes';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession } from '../../helpers/mockSession';
import {
	createOwnerPatchStream,
	installTabWindowsApi,
	type OwnerPatchStream,
} from '../../helpers/tabWindows';

vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

const AGENT = 'agent-1';
const POPPED: TabWindowTabRef = { type: 'ai', id: 'popped' };
const HOME: TabWindowTabRef = { type: 'ai', id: 'home' };

/** This window's record: it holds the popped tab and shows it. */
const INFO: TabWindowInfo = {
	windowId: 'tw-1',
	agentId: AGENT,
	tabRefs: [POPPED],
	activeTabRef: POPPED,
};

let nextLogId = 0;
function entry(text: string, overrides: Partial<LogEntry> = {}): LogEntry {
	nextLogId += 1;
	return { id: `log-${nextLogId}`, timestamp: nextLogId, source: 'stdout', text, ...overrides };
}

/** The agent as its owner holds it: one tab popped out, one at home. */
function ownerAgent(): Session {
	return createMockSession({
		id: AGENT,
		name: 'Maestro Marketing',
		aiTabs: [
			createMockAITab({
				id: 'popped',
				name: 'Popped Chat',
				logs: [entry('hello', { source: 'user' }), entry('world')],
			}),
			createMockAITab({ id: 'home', name: 'Home Chat', logs: [entry('stays home')] }),
		],
		activeTabId: 'home',
		unifiedTabOrder: [POPPED, HOME],
	});
}

/** The owner's next state: `fn` applied to one tab, immutably. */
function withTab(session: Session, tabId: string, fn: (tab: AITab) => AITab): Session {
	return { ...session, aiTabs: session.aiTabs.map((tab) => (tab.id === tabId ? fn(tab) : tab)) };
}

function appended(session: Session, tabId: string, text: string): Session {
	return withTab(session, tabId, (tab) => ({ ...tab, logs: [...tab.logs, entry(text)] }));
}

/** The last entry rewritten with a streamed chunk, as the owner's flush does. */
function streamed(session: Session, tabId: string, chunk: string): Session {
	return withTab(session, tabId, (tab) => {
		const last = tab.logs[tab.logs.length - 1];
		return { ...tab, logs: [...tab.logs.slice(0, -1), { ...last, text: last.text + chunk }] };
	});
}

const heldSessions = () => useSessionStore.getState().sessions;
const heldTab = (id: string) =>
	heldSessions()
		.find((s) => s.id === AGENT)
		?.aiTabs.find((tab) => tab.id === id);
const heldTexts = (id = 'popped') => heldTab(id)?.logs.map((log) => log.text);

/** The global mock of the write that persists the app's active agent. */
const persistActiveAgent = () =>
	(window as unknown as { maestro: { sessions: { setActiveSessionId: ReturnType<typeof vi.fn> } } })
		.maestro.sessions.setActiveSessionId;

let api: ReturnType<typeof installTabWindowsApi>;
let owner: OwnerPatchStream;
let stream: TabWindowMirrorStream | null;

/** Start the mirror with this window's record (null before it loads). */
function start(info: TabWindowInfo | null = INFO): TabWindowMirrorStream {
	stream = startTabWindowMirror(() => info);
	return stream;
}

beforeEach(() => {
	nextLogId = 0;
	vi.mocked(captureMessage).mockClear();
	persistActiveAgent().mockClear();
	useSessionStore.setState({ sessions: [], activeSessionId: '' });
	api = installTabWindowsApi();
	owner = createOwnerPatchStream(api.emitPatch, AGENT, [POPPED]);
	stream = null;
});

afterEach(() => {
	stream?.stop();
	api.restore();
});

describe('startTabWindowMirror', () => {
	it('holds the agent of a snapshot, alone, as the active agent, and persists nothing', () => {
		useSessionStore.setState({ sessions: [createMockSession({ id: 'left-over' })] });
		start();

		owner.snapshot(ownerAgent());

		expect(heldSessions().map((s) => s.id)).toEqual([AGENT]);
		expect(useSessionStore.getState().activeSessionId).toBe(AGENT);
		// The app's own active agent is not the tab window's to change.
		expect(persistActiveAgent()).not.toHaveBeenCalled();
		expect(heldTexts()).toEqual(['hello', 'world']);
		// A tab that is not popped into this window arrives without its transcript.
		expect(heldTexts('home')).toEqual([]);
	});

	it('applies deltas in order: an append, then streamed chunks into the last entry', () => {
		start();
		let session = ownerAgent();
		owner.snapshot(session);

		session = appended(session, 'popped', 'The answer');
		owner.delta(session);
		session = streamed(session, 'popped', ' is 42');
		owner.delta(session);
		session = { ...session, state: 'busy', busySource: 'ai', thinkingStartTime: 1234 };
		owner.delta(session);

		expect(heldTexts()).toEqual(['hello', 'world', 'The answer is 42']);
		const held = heldSessions()[0];
		expect(held.state).toBe('busy');
		expect(held.busySource).toBe('ai');
		expect(held.thinkingStartTime).toBe(1234);
	});

	it('follows a flush that drops an earlier entry, and a truncation', () => {
		start();
		let session = ownerAgent();
		owner.snapshot(session);

		// The batched flush drops a thinking entry when assistant text arrives.
		session = withTab(session, 'popped', (tab) => ({
			...tab,
			logs: [tab.logs[0], entry('reply')],
		}));
		owner.delta(session);
		expect(heldTexts()).toEqual(['hello', 'reply']);

		session = withTab(session, 'popped', (tab) => ({ ...tab, logs: [] }));
		owner.delta(session);
		expect(heldTexts()).toEqual([]);
	});

	it('drops deltas that come before the first snapshot without asking twice', () => {
		const before = ownerAgent();
		// The owner attached before this page listened: its snapshot is gone.
		owner.snapshot(before);
		start();

		owner.delta(appended(before, 'popped', 'missed the snapshot'));

		expect(heldSessions()).toEqual([]);
		// The load-time request (useTabWindowMirror) is already on its way.
		expect(api.sendIntent).not.toHaveBeenCalled();
		expect(captureMessage).not.toHaveBeenCalled();
	});

	it('asks for one snapshot on a gap, drops deltas until it lands, then streams again', () => {
		start();
		let session = ownerAgent();
		owner.snapshot(session);

		owner.lose();
		session = appended(session, 'popped', 'after the gap');
		owner.delta(session);
		session = appended(session, 'popped', 'still waiting');
		owner.delta(session);

		// Nothing applied on top of a state this window never held.
		expect(heldTexts()).toEqual(['hello', 'world']);
		expect(api.sendIntent).toHaveBeenCalledTimes(1);
		expect(api.sendIntent).toHaveBeenCalledWith({
			kind: 'requestSnapshot',
			agentId: AGENT,
			tabRef: POPPED,
		});
		expect(captureMessage).toHaveBeenCalledTimes(1);

		owner.snapshot(session);
		expect(heldTexts()).toEqual(['hello', 'world', 'after the gap', 'still waiting']);
		session = appended(session, 'popped', 'live again');
		owner.delta(session);
		expect(heldTexts()).toEqual(['hello', 'world', 'after the gap', 'still waiting', 'live again']);
	});

	it('keeps waiting when a delta fails before the record has loaded', () => {
		start(null);
		let session = ownerAgent();
		owner.snapshot(session);
		owner.lose();
		session = appended(session, 'popped', 'after the gap');
		owner.delta(session);

		// No record, no tab to address a request with: the load-time request asks.
		expect(api.sendIntent).not.toHaveBeenCalled();
		session = appended(session, 'popped', 'dropped');
		owner.delta(session);
		expect(heldTexts()).toEqual(['hello', 'world']);
	});

	it('does not hold back a live stream for a request that could not go out', () => {
		const mirror = start();
		let session = ownerAgent();
		owner.snapshot(session);

		// A record with no tab has nothing to address the request with.
		expect(mirror.requestSnapshot({ ...INFO, tabRefs: [], activeTabRef: null })).toBe(false);
		session = appended(session, 'popped', 'still streaming');
		owner.delta(session);

		expect(heldTexts()).toEqual(['hello', 'world', 'still streaming']);
	});

	it('keeps what this window wrote itself through deltas and snapshots of the same tabs', () => {
		start();
		let session = ownerAgent();
		owner.snapshot(session);

		// The composer flushing a draft, and the transcript saving its scroll offset.
		updateAiTab(AGENT, 'popped', (tab) => ({ ...tab, inputValue: 'typed here', scrollTop: 300 }));
		session = appended(session, 'popped', 'streaming on');
		owner.delta(session);

		expect(heldTab('popped')?.inputValue).toBe('typed here');
		expect(heldTab('popped')?.scrollTop).toBe(300);
		expect(heldTexts()).toEqual(['hello', 'world', 'streaming on']);

		// The owner re-sends the agent (for example after a gap): the draft is still ours.
		owner.snapshot(
			withTab(session, 'popped', (tab) => ({ ...tab, inputValue: 'stale owner copy' }))
		);
		expect(heldTab('popped')?.inputValue).toBe('typed here');
	});

	it('takes the owner draft for a tab that newly joins the window', () => {
		start();
		let session = ownerAgent();
		owner.snapshot(session);

		session = withTab(session, 'home', (tab) => ({ ...tab, inputValue: 'typed in the owner' }));
		owner.snapshot(session, [POPPED, HOME]);

		expect(heldTab('home')?.inputValue).toBe('typed in the owner');
		expect(heldTexts('home')).toEqual(['stays home']);
	});

	it('stops applying patches once stopped, and asks for nothing', () => {
		const mirror = start();
		const session = ownerAgent();
		owner.snapshot(session);
		mirror.stop();

		owner.delta(appended(session, 'popped', 'after stop'));

		expect(heldTexts()).toEqual(['hello', 'world']);
		expect(mirror.requestSnapshot(INFO)).toBe(false);
		expect(api.sendIntent).not.toHaveBeenCalled();
	});

	it('is a no-op without the tab windows API (the web-desktop build, TW-13)', () => {
		api.restore();
		const mirror = start();
		expect(mirror.requestSnapshot(INFO)).toBe(false);
		mirror.stop();
	});
});

describe('useTabWindowMirror', () => {
	it('subscribes before it asks for the load snapshot, and asks once per agent', () => {
		const { rerender } = renderHook(({ info }) => useTabWindowMirror(info), {
			initialProps: { info: null as TabWindowInfo | null },
		});
		expect(api.onSessionPatch).toHaveBeenCalledTimes(1);
		expect(api.sendIntent).not.toHaveBeenCalled();

		rerender({ info: INFO });
		expect(api.sendIntent).toHaveBeenCalledTimes(1);
		expect(api.sendIntent).toHaveBeenCalledWith({
			kind: 'requestSnapshot',
			agentId: AGENT,
			tabRef: POPPED,
		});
		// Listening first, so the answer cannot slip past.
		expect(api.onSessionPatch.mock.invocationCallOrder[0]).toBeLessThan(
			api.sendIntent.mock.invocationCallOrder[0]
		);

		// A tab switch re-reads the record; it needs no snapshot.
		rerender({ info: { ...INFO, activeTabRef: POPPED } });
		expect(api.sendIntent).toHaveBeenCalledTimes(1);
	});

	it('asks again once the record holds a tab to address the request with', () => {
		const empty: TabWindowInfo = { ...INFO, tabRefs: [], activeTabRef: null };
		const { rerender } = renderHook(({ info }) => useTabWindowMirror(info), {
			initialProps: { info: empty as TabWindowInfo | null },
		});
		expect(api.sendIntent).not.toHaveBeenCalled();
		rerender({ info: INFO });
		expect(api.sendIntent).toHaveBeenCalledTimes(1);
	});

	it('fills the store from the answer, and stops listening on unmount', () => {
		const { unmount } = renderHook(() => useTabWindowMirror(INFO));
		const session = ownerAgent();
		owner.snapshot(session);
		expect(heldTexts()).toEqual(['hello', 'world']);

		unmount();
		owner.delta(appended(session, 'popped', 'after unmount'));
		expect(heldTexts()).toEqual(['hello', 'world']);
	});
});
