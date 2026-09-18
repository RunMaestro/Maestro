import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSnoozeScheduler } from '../../../../renderer/hooks/tabs/useSnoozeScheduler';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { snoozeTab } from '../../../../renderer/utils/snoozeHelpers';
import { useSnoozeHistoryStore } from '../../../../renderer/stores/snoozeHistoryStore';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';
import type { Session } from '../../../../renderer/types';

const notifyToast = vi.hoisted(() => vi.fn());
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast }));

const HOUR = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15_000;

/** Seed the session store with one agent holding two AI tabs. */
function seedSession(overrides: Partial<Session> = {}): Session {
	const session = createMockSession({
		id: 'session-1',
		name: 'Atlas',
		aiTabs: [
			createMockAITab({ id: 'a', name: 'Alpha' }),
			createMockAITab({ id: 'b', name: 'Bravo' }),
		],
		unifiedTabOrder: [
			{ type: 'ai', id: 'a' },
			{ type: 'ai', id: 'b' },
		],
		activeTabId: 'a',
		...overrides,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

/** Read the single session back out of the store. */
function currentSession(): Session {
	return useSessionStore.getState().sessions[0];
}

/**
 * Spy on the store's `setSessions`, with a clean call history.
 *
 * The explicit `mockClear()` matters: zustand copies action properties onto the
 * new state object on every `setState`, so a spy installed in an earlier test
 * survives `mockRestore()` on the live state. `vi.spyOn` then hands back that
 * same spy rather than a fresh one, carrying stale calls with it.
 */
function spyOnSetSessions() {
	const spy = vi.spyOn(useSessionStore.getState(), 'setSessions');
	spy.mockClear();
	return spy;
}

/**
 * Snooze tab `tabId` in the seeded session and write the result back to the
 * store, returning the snooze ID.
 */
function snoozeInStore(tabId: string, wakeAt: number, note?: string): string {
	const result = snoozeTab(currentSession(), tabId, wakeAt, { note })!;
	useSessionStore.setState({ sessions: [result.session] });
	return result.entry.id;
}

/** Snooze `tabId` with a prompt to run the moment it returns. */
function snoozeWithPrompt(tabId: string, wakeAt: number, wakePrompt: string): string {
	const result = snoozeTab(currentSession(), tabId, wakeAt, { wakePrompt })!;
	useSessionStore.setState({ sessions: [result.session] });
	return result.entry.id;
}

describe('useSnoozeScheduler', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		notifyToast.mockClear();
		useSessionStore.setState({
			sessions: [],
			groups: [],
			activeSessionId: '',
			sessionsLoaded: false,
			initialLoadComplete: false,
			removedWorktreePaths: new Set(),
			cyclePosition: -1,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('leaves a snooze alone until its wake time arrives', () => {
		seedSession();
		snoozeInStore('b', Date.now() + HOUR);
		renderHook(() => useSnoozeScheduler());

		act(() => {
			vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 4);
		});

		expect(currentSession().snoozedTabs).toHaveLength(1);
		expect(currentSession().aiTabs.map((t) => t.id)).toEqual(['a']);
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('restores the tab and fires a sticky notification once due', () => {
		seedSession();
		snoozeInStore('b', Date.now() + SWEEP_INTERVAL_MS * 2, 'check the build');
		renderHook(() => useSnoozeScheduler());

		act(() => {
			vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 3);
		});

		const session = currentSession();
		expect(session.snoozedTabs).toHaveLength(0);
		expect(session.aiTabs.map((t) => t.id)).toEqual(['a', 'b']);

		expect(notifyToast).toHaveBeenCalledTimes(1);
		const toast = notifyToast.mock.calls[0][0];
		expect(toast).toMatchObject({
			title: 'Bravo',
			// The note IS the reminder when present.
			message: 'check the build',
			project: 'Atlas',
			dismissible: true,
			sessionId: 'session-1',
			tabId: 'b',
			clickAction: { kind: 'jump-session', sessionId: 'session-1', tabId: 'b' },
		});
	});

	it('falls back to a generic message when no note was left', () => {
		seedSession();
		snoozeInStore('b', Date.now() + SWEEP_INTERVAL_MS);
		renderHook(() => useSnoozeScheduler());

		act(() => {
			vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 2);
		});

		expect(notifyToast.mock.calls[0][0].message).toBe('Snoozed tab is back.');
	});

	it('fires immediately on mount for a wake missed while the app was closed', () => {
		// The snooze came due hours before this launch. It must not be dropped.
		seedSession();
		snoozeInStore('b', Date.now() - 5 * HOUR, 'overdue reminder');

		renderHook(() => useSnoozeScheduler());

		// No timer advance: the mount sweep alone should have handled it.
		expect(currentSession().snoozedTabs).toHaveLength(0);
		expect(currentSession().aiTabs.map((t) => t.id)).toEqual(['a', 'b']);
		expect(notifyToast).toHaveBeenCalledTimes(1);
		expect(notifyToast.mock.calls[0][0].message).toBe('overdue reminder');
	});

	it('notifies exactly once per snooze across repeated sweeps', () => {
		seedSession();
		snoozeInStore('b', Date.now() - 1000);
		renderHook(() => useSnoozeScheduler());

		act(() => {
			vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 5);
		});

		expect(notifyToast).toHaveBeenCalledTimes(1);
	});

	it('wakes several tabs due at once in a single store update', () => {
		seedSession();
		snoozeInStore('a', Date.now() - 2000, 'first');
		snoozeInStore('b', Date.now() - 1000, 'second');
		const setSessionsSpy = spyOnSetSessions();

		renderHook(() => useSnoozeScheduler());

		// Batching matters: N simultaneous wakes must not cost N re-renders and
		// N persistence writes.
		expect(setSessionsSpy).toHaveBeenCalledTimes(1);
		expect(currentSession().snoozedTabs).toHaveLength(0);
		expect(notifyToast).toHaveBeenCalledTimes(2);
		setSessionsSpy.mockRestore();
	});

	it('wakes tabs across different agents', () => {
		const first = createMockSession({
			id: 's1',
			name: 'One',
			aiTabs: [createMockAITab({ id: 'x', name: 'Ex' })],
			unifiedTabOrder: [{ type: 'ai', id: 'x' }],
			activeTabId: 'x',
		});
		const second = createMockSession({
			id: 's2',
			name: 'Two',
			aiTabs: [createMockAITab({ id: 'y', name: 'Why' })],
			unifiedTabOrder: [{ type: 'ai', id: 'y' }],
			activeTabId: 'y',
		});
		const snoozedFirst = snoozeTab(first, 'x', Date.now() - 1000)!.session;
		const snoozedSecond = snoozeTab(second, 'y', Date.now() - 1000)!.session;
		useSessionStore.setState({ sessions: [snoozedFirst, snoozedSecond], activeSessionId: 's1' });

		renderHook(() => useSnoozeScheduler());

		const [s1, s2] = useSessionStore.getState().sessions;
		expect(s1.snoozedTabs).toHaveLength(0);
		expect(s2.snoozedTabs).toHaveLength(0);
		expect(notifyToast).toHaveBeenCalledTimes(2);
		expect(notifyToast.mock.calls.map((c) => c[0].project).sort()).toEqual(['One', 'Two']);
	});

	it('re-sweeps on window focus so a wake during sleep is not stranded', () => {
		seedSession();
		renderHook(() => useSnoozeScheduler());

		// Snooze becomes due after mount; simulate the machine waking with the
		// interval having stalled.
		snoozeInStore('b', Date.now() - 1000, 'after sleep');
		expect(notifyToast).not.toHaveBeenCalled();

		act(() => {
			window.dispatchEvent(new Event('focus'));
		});

		expect(currentSession().snoozedTabs).toHaveLength(0);
		expect(notifyToast).toHaveBeenCalledTimes(1);
	});

	it('does no work and touches no store when nothing is snoozed', () => {
		seedSession();
		const setSessionsSpy = spyOnSetSessions();

		renderHook(() => useSnoozeScheduler());
		act(() => {
			vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 4);
		});

		expect(setSessionsSpy).not.toHaveBeenCalled();
		expect(notifyToast).not.toHaveBeenCalled();
		setSessionsSpy.mockRestore();
	});

	it('releases the transcript mirror when a tab wakes', () => {
		// The snooze held Maestro's own copy of the transcript; waking hands it
		// back. The main process rehydrates before dropping it, so this call is
		// what restores a conversation the provider aged out mid-snooze.
		const release = window.maestro.agentSessions.releaseSnoozedTranscript as ReturnType<
			typeof vi.fn
		>;
		release.mockClear();

		seedSession({ projectRoot: '/proj', toolType: 'claude-code' });
		useSessionStore.setState({
			sessions: [
				{
					...currentSession(),
					aiTabs: [
						createMockAITab({ id: 'a' }),
						createMockAITab({ id: 'b', agentSessionId: 'provider-session-1' }),
					],
				},
			],
		});
		snoozeInStore('b', Date.now() - 1000);

		renderHook(() => useSnoozeScheduler());

		expect(release).toHaveBeenCalledWith('claude-code', '/proj', 'provider-session-1');
	});

	it('does not try to release a mirror for a tab that never ran', () => {
		// No agentSessionId means no provider transcript to preserve.
		const release = window.maestro.agentSessions.releaseSnoozedTranscript as ReturnType<
			typeof vi.fn
		>;
		release.mockClear();

		seedSession({ projectRoot: '/proj' });
		snoozeInStore('b', Date.now() - 1000);
		renderHook(() => useSnoozeScheduler());

		expect(release).not.toHaveBeenCalled();
	});

	it('logs the completed snooze to history, note included', () => {
		// The sticky toast is transient; the history entry is what lets the user
		// find the note again next week.
		useSnoozeHistoryStore.setState({ entries: [] });
		seedSession();
		snoozeInStore('b', Date.now() - 1000, 'check the build');

		renderHook(() => useSnoozeScheduler());

		const entries = useSnoozeHistoryStore.getState().entries;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			label: 'Bravo',
			note: 'check the build',
			sessionName: 'Atlas',
			resolution: 'woke',
		});
	});

	it('stops sweeping after unmount', () => {
		seedSession();
		const { unmount } = renderHook(() => useSnoozeScheduler());
		unmount();

		snoozeInStore('b', Date.now() - 1000);
		act(() => {
			vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 4);
		});

		expect(currentSession().snoozedTabs).toHaveLength(1);
		expect(notifyToast).not.toHaveBeenCalled();
	});
});

describe('useSnoozeScheduler wake prompts', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		notifyToast.mockClear();
		useSessionStore.setState({ sessions: [], activeSessionId: null });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('queues the wake prompt on the restored tab', () => {
		seedSession();
		snoozeWithPrompt('b', Date.now() + SWEEP_INTERVAL_MS, 'summarize what changed');
		renderHook(() => useSnoozeScheduler());

		act(() => {
			vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 2);
		});

		const session = currentSession();
		expect(session.aiTabs.map((t) => t.id)).toEqual(['a', 'b']);
		// Queued rather than spawned: the tab was restored in this same tick, so
		// nothing downstream may depend on React having re-rendered around it.
		expect(session.executionQueue).toHaveLength(1);
		expect(session.executionQueue[0]).toMatchObject({
			tabId: 'b',
			type: 'message',
			text: 'summarize what changed',
		});
	});

	it('leaves the queue alone for a snooze that carries no prompt', () => {
		seedSession();
		snoozeInStore('b', Date.now() + SWEEP_INTERVAL_MS, 'just a reminder');
		renderHook(() => useSnoozeScheduler());

		act(() => {
			vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 2);
		});

		expect(currentSession().executionQueue).toHaveLength(0);
	});

	it('still notifies as well as prompting - the two are independent', () => {
		seedSession();
		const result = snoozeTab(currentSession(), 'b', Date.now() + SWEEP_INTERVAL_MS, {
			note: 'check the build',
			wakePrompt: 'run the test suite',
		})!;
		useSessionStore.setState({ sessions: [result.session] });
		renderHook(() => useSnoozeScheduler());

		act(() => {
			vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 2);
		});

		expect(notifyToast.mock.calls[0][0].message).toBe('check the build');
		expect(currentSession().executionQueue[0].text).toBe('run the test suite');
	});
});
