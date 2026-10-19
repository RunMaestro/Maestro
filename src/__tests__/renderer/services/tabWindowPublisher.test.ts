/**
 * Tests for services/tabWindowPublisher and hooks/tabs/useTabWindowPublisher:
 * the owner window's half of the Tab Windows patch stream (D2).
 *
 * A delta sent too early floods the tab window; one never sent freezes it. A
 * missed snapshot leaves a newly popped tab without its transcript, and a
 * reloaded tab window with nothing at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
	TAB_WINDOW_FRAME_WAIT_MS,
	TAB_WINDOW_PATCH_INTERVAL_MS,
	startTabWindowPublisher,
	type TabWindowPublisher,
} from '../../../renderer/services/tabWindowPublisher';
import { useTabWindowPublisher } from '../../../renderer/hooks/tabs/useTabWindowPublisher';
import {
	updateAiTab,
	updateSessionWith,
	useSessionStore,
} from '../../../renderer/stores/sessionStore';
import { useTabWindowStore } from '../../../renderer/stores/tabWindowStore';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { captureException } from '../../../renderer/utils/sentry';
import type { AITab, LogEntry, Session } from '../../../renderer/types';
import {
	applyTabWindowPatch,
	type TabWindowMirror,
	type TabWindowPatchOf,
} from '../../../shared/tabWindowPatch';
import type {
	TabWindowInfo,
	TabWindowSessionDelta,
	TabWindowSessionSnapshot,
	TabWindowTabRef,
} from '../../../shared/tabWindowTypes';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession } from '../../helpers/mockSession';
import { installTabWindowsApi } from '../../helpers/tabWindows';

vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

const web = vi.hoisted(() => ({ value: false }));
vi.mock('../../../renderer/utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/utils/runtimeContext')>()),
	isWebDesktop: () => web.value,
}));

const AGENT = 'agent-1';
const POPPED: TabWindowTabRef = { type: 'ai', id: 'popped' };
const SECOND: TabWindowTabRef = { type: 'ai', id: 'second' };

let nextLogId = 0;
function entry(text: string, overrides: Partial<LogEntry> = {}): LogEntry {
	nextLogId += 1;
	return { id: `log-${nextLogId}`, timestamp: nextLogId, source: 'stdout', text, ...overrides };
}

/** An agent with two tabs that can pop out and one that stays in the owner. */
function agent(): Session {
	return createMockSession({
		id: AGENT,
		name: 'Maestro Marketing',
		aiTabs: [
			createMockAITab({
				id: 'popped',
				logs: [entry('hello', { source: 'user' }), entry('world')],
			}),
			createMockAITab({ id: 'second', logs: [entry('a second transcript')] }),
			createMockAITab({ id: 'home', logs: [entry('a transcript that stays home')] }),
		],
		activeTabId: 'home',
		unifiedTabOrder: [POPPED, SECOND, { type: 'ai', id: 'home' }],
	});
}

function tabWindow(
	tabRefs: TabWindowTabRef[] = [POPPED],
	overrides: Partial<TabWindowInfo> = {}
): TabWindowInfo {
	return {
		windowId: 'tw-1',
		agentId: AGENT,
		tabRefs,
		activeTabRef: tabRefs[0] ?? null,
		...overrides,
	};
}

const setWindows = (windows: TabWindowInfo[]) => useTabWindowStore.getState().setWindows(windows);
const ownerSession = () => useSessionStore.getState().sessions.find((s) => s.id === AGENT)!;
const tabOf = (session: Session, id: string) => session.aiTabs.find((t) => t.id === id)!;

/** Append to a tab's transcript the way the owner's batched flush does: immutably. */
function appendLog(tabId: string, text: string): void {
	updateAiTab(AGENT, tabId, (tab) => ({ ...tab, logs: [...tab.logs, entry(text)] }));
}

/** Rewrite the tab's last entry, as a streamed chunk does. */
function streamIntoLast(tabId: string, chunk: string): void {
	updateAiTab(AGENT, tabId, (tab) => {
		const last = tab.logs[tab.logs.length - 1];
		return { ...tab, logs: [...tab.logs.slice(0, -1), { ...last, text: last.text + chunk }] };
	});
}

// Animation frames are painted by hand, so a test decides which comes first:
// the frame or the 50 ms interval.
let frames: Map<number, FrameRequestCallback>;
let lastFrameId: number;
function paintFrame(): void {
	const due = [...frames.values()];
	frames.clear();
	for (const callback of due) callback(0);
}

function setDocumentHidden(hidden: boolean): void {
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => (hidden ? 'hidden' : 'visible'),
	});
}

let api: ReturnType<typeof installTabWindowsApi>;
let publisher: TabWindowPublisher | null;

function sent(): TabWindowPatchOf<Session>[] {
	return api.sendSessionPatch.mock.calls.map(([patch]) => patch as TabWindowPatchOf<Session>);
}
const lastSent = () => sent()[sent().length - 1];
const snapshots = () =>
	sent().filter((p): p is TabWindowSessionSnapshot<Session> => p.form === 'snapshot');
const deltas = () =>
	sent().filter((p): p is TabWindowSessionDelta<Session, AITab, LogEntry> => p.form === 'delta');

/** Paint a frame and let the interval pass: whatever is due goes out. */
function flushDue(): void {
	paintFrame();
	vi.advanceTimersByTime(TAB_WINDOW_PATCH_INTERVAL_MS);
}

/** Feed every patch into a tab window mirror, the way the tab window applies them. */
function replay(patches: TabWindowPatchOf<Session>[]): TabWindowMirror<Session> {
	let mirror: TabWindowMirror<Session> | null = null;
	for (const patch of patches) {
		mirror = applyTabWindowPatch(mirror, patch);
		if (!mirror) throw new Error(`patch ${patch.seq} (${patch.form}) did not apply`);
	}
	if (!mirror) throw new Error('nothing was sent');
	return mirror;
}

beforeEach(() => {
	vi.useFakeTimers();
	frames = new Map();
	lastFrameId = 0;
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		lastFrameId += 1;
		frames.set(lastFrameId, callback);
		return lastFrameId;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => {
		frames.delete(id);
	});
	vi.mocked(captureException).mockClear();
	web.value = false;
	api = installTabWindowsApi();
	publisher = null;
	useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
	useSessionStore.setState({ sessions: [agent()], sessionsLoaded: true, sessionsReadOk: true });
	useComposerInputStore.setState(useComposerInputStore.getInitialState(), true);
});

afterEach(() => {
	publisher?.stop();
	api.restore();
	Reflect.deleteProperty(document, 'visibilityState');
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('startTabWindowPublisher', () => {
	describe('attach', () => {
		it('sends a snapshot when the tab window attaches, with transcripts on the popped tabs only', () => {
			publisher = startTabWindowPublisher();
			expect(api.sendSessionPatch).not.toHaveBeenCalled();

			setWindows([tabWindow()]);
			expect(sent()).toHaveLength(1);
			const snapshot = snapshots()[0];
			expect(snapshot).toMatchObject({
				form: 'snapshot',
				agentId: AGENT,
				seq: 0,
				tabRefs: [POPPED],
			});
			expect(tabOf(snapshot.session, 'popped').logs).toEqual(tabOf(ownerSession(), 'popped').logs);
			expect(tabOf(snapshot.session, 'second').logs).toEqual([]);
			expect(tabOf(snapshot.session, 'home').logs).toEqual([]);
		});

		it('sends the snapshot at once for a tab window that already exists at start', () => {
			setWindows([tabWindow()]);
			publisher = startTabWindowPublisher();
			expect(snapshots()).toHaveLength(1);
		});

		it('publishes nothing for an agent this window does not own (D1)', () => {
			setWindows([tabWindow()]);
			publisher = startTabWindowPublisher(() => false);
			appendLog('popped', 'more');
			flushDue();
			expect(api.sendSessionPatch).not.toHaveBeenCalled();
		});

		it('waits for the agent session before it attaches', () => {
			useSessionStore.setState({ sessions: [] });
			setWindows([tabWindow()]);
			publisher = startTabWindowPublisher();
			expect(api.sendSessionPatch).not.toHaveBeenCalled();

			act(() => useSessionStore.setState({ sessions: [agent()] }));
			expect(snapshots()).toHaveLength(1);
		});

		it('is a no-op without the tab windows API', () => {
			api.restore();
			setWindows([tabWindow()]);
			publisher = startTabWindowPublisher();
			expect(() => appendLog('popped', 'more')).not.toThrow();
		});

		it('is a no-op in the web-desktop build (TW-13)', () => {
			web.value = true;
			setWindows([tabWindow()]);
			publisher = startTabWindowPublisher();
			appendLog('popped', 'more');
			flushDue();
			expect(api.sendSessionPatch).not.toHaveBeenCalled();
			expect(api.onIntent).not.toHaveBeenCalled();
		});
	});

	describe('deltas', () => {
		beforeEach(() => {
			setWindows([tabWindow()]);
			publisher = startTabWindowPublisher();
			api.sendSessionPatch.mockClear();
		});

		it('coalesces a burst into one delta, sent once both the frame and 50 ms passed', () => {
			appendLog('popped', 'one');
			appendLog('popped', 'two');
			appendLog('popped', 'three');
			vi.advanceTimersByTime(TAB_WINDOW_PATCH_INTERVAL_MS);
			expect(api.sendSessionPatch).not.toHaveBeenCalled();

			paintFrame();
			expect(sent()).toHaveLength(1);
			const delta = deltas()[0];
			expect(delta).toMatchObject({ form: 'delta', agentId: AGENT, seq: 1 });
			expect(delta.tabs).toHaveLength(1);
			expect(delta.tabs![0].logSplice).toEqual({
				start: 2,
				entries: tabOf(ownerSession(), 'popped').logs.slice(2),
			});
			expect(delta.tabs![0].logSplice!.entries.map((e) => e.text)).toEqual(['one', 'two', 'three']);
		});

		it('waits out the 50 ms interval when the frame comes first', () => {
			appendLog('popped', 'one');
			paintFrame();
			vi.advanceTimersByTime(TAB_WINDOW_PATCH_INTERVAL_MS - 1);
			expect(api.sendSessionPatch).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(deltas()).toHaveLength(1);
		});

		it('sends a streamed rewrite of the last entry as one splice from that entry', () => {
			streamIntoLast('popped', ' and');
			streamIntoLast('popped', ' more');
			flushDue();
			expect(deltas()).toHaveLength(1);
			expect(deltas()[0].tabs![0].logSplice).toMatchObject({ start: 1 });
			expect(deltas()[0].tabs![0].logSplice!.entries.map((e) => e.text)).toEqual([
				'world and more',
			]);
		});

		it('sends session fields the tab UI reads in the same delta', () => {
			updateSessionWith(AGENT, (s) => ({ ...s, state: 'busy', name: 'Renamed' }));
			flushDue();
			expect(deltas()[0].session).toMatchObject({ state: 'busy', name: 'Renamed' });
		});

		it('sends no delta when only what the tab window does not receive changed', () => {
			appendLog('home', 'owner-only output');
			updateSessionWith(AGENT, (s) => ({ ...s, activeTabId: 'second' }));
			flushDue();
			vi.advanceTimersByTime(TAB_WINDOW_FRAME_WAIT_MS);
			expect(api.sendSessionPatch).not.toHaveBeenCalled();

			// The skipped state still becomes the base of the next diff.
			appendLog('popped', 'next');
			flushDue();
			expect(deltas()).toHaveLength(1);
			expect(deltas()[0]).toMatchObject({ seq: 1 });
			expect(deltas()[0].session).toBeUndefined();
		});

		it('numbers patches in order, and a mirror fed the stream matches the owner (round trip)', () => {
			api.sendSessionPatch.mockClear();
			// Restart from a snapshot this test records.
			api.emitIntent({ kind: 'requestSnapshot', agentId: AGENT, tabRef: POPPED });
			appendLog('popped', 'one');
			flushDue();
			streamIntoLast('popped', ' streamed');
			flushDue();
			updateAiTab(AGENT, 'popped', (tab) => ({ ...tab, logs: tab.logs.slice(1) }));
			flushDue();
			appendLog('popped', 'two');
			updateSessionWith(AGENT, (s) => ({ ...s, state: 'busy' }));
			flushDue();

			expect(sent().map((p) => p.seq)).toEqual([1, 2, 3, 4, 5]);
			const mirror = replay(sent());
			expect(tabOf(mirror.session, 'popped').logs).toEqual(tabOf(ownerSession(), 'popped').logs);
			expect(mirror.session.state).toBe('busy');
		});

		it('sends nothing when nothing changed', () => {
			flushDue();
			vi.advanceTimersByTime(TAB_WINDOW_FRAME_WAIT_MS * 4);
			expect(api.sendSessionPatch).not.toHaveBeenCalled();
		});
	});

	describe('a window that paints no frames', () => {
		beforeEach(() => {
			setWindows([tabWindow()]);
			publisher = startTabWindowPublisher();
			api.sendSessionPatch.mockClear();
		});

		it('keeps streaming while the owner window is hidden', () => {
			setDocumentHidden(true);
			appendLog('popped', 'one');
			vi.advanceTimersByTime(TAB_WINDOW_PATCH_INTERVAL_MS);
			expect(deltas()).toHaveLength(1);
			expect(frames.size).toBe(0);
		});

		it('stops waiting for a frame that never comes (the window hid mid-wait)', () => {
			appendLog('popped', 'one');
			setDocumentHidden(true);
			vi.advanceTimersByTime(TAB_WINDOW_PATCH_INTERVAL_MS);
			expect(api.sendSessionPatch).not.toHaveBeenCalled();
			vi.advanceTimersByTime(TAB_WINDOW_FRAME_WAIT_MS);
			expect(deltas()).toHaveLength(1);
		});
	});

	describe('snapshots after attach', () => {
		beforeEach(() => {
			setWindows([tabWindow()]);
			publisher = startTabWindowPublisher();
			api.sendSessionPatch.mockClear();
		});

		it('sends a new snapshot when the popped set changes', () => {
			setWindows([tabWindow([POPPED, SECOND])]);
			expect(sent()).toHaveLength(1);
			expect(lastSent()).toMatchObject({ form: 'snapshot', seq: 1, tabRefs: [POPPED, SECOND] });
			const snapshot = snapshots()[0];
			expect(tabOf(snapshot.session, 'second').logs).toEqual(tabOf(ownerSession(), 'second').logs);

			setWindows([tabWindow([SECOND])]);
			expect(lastSent()).toMatchObject({ form: 'snapshot', seq: 2, tabRefs: [SECOND] });
			expect(tabOf(snapshots()[1].session, 'popped').logs).toEqual([]);
		});

		it('sends nothing when only the shown tab or the strip order changes', () => {
			setWindows([tabWindow([POPPED, SECOND])]);
			api.sendSessionPatch.mockClear();
			setWindows([tabWindow([POPPED, SECOND], { activeTabRef: SECOND })]);
			setWindows([tabWindow([SECOND, POPPED], { activeTabRef: SECOND })]);
			flushDue();
			expect(api.sendSessionPatch).not.toHaveBeenCalled();
		});

		it('then streams the new popped tab too', () => {
			setWindows([tabWindow([POPPED, SECOND])]);
			appendLog('second', 'for the new tab');
			flushDue();
			expect(deltas()[0].tabs!.map((t) => t.ref)).toEqual([SECOND]);
		});

		it('drops the delta still waiting when a snapshot goes out', () => {
			appendLog('popped', 'one');
			setWindows([tabWindow([POPPED, SECOND])]);
			flushDue();
			vi.advanceTimersByTime(TAB_WINDOW_FRAME_WAIT_MS);
			expect(sent().map((p) => p.form)).toEqual(['snapshot']);
			const logs = tabOf(snapshots()[0].session, 'popped').logs;
			expect(logs[logs.length - 1].text).toBe('one');
		});

		it('sends a snapshot to a new tab window of the agent, even with the same tabs', () => {
			setWindows([tabWindow([POPPED], { windowId: 'tw-2' })]);
			expect(lastSent()).toMatchObject({ form: 'snapshot', seq: 1 });
		});

		it('answers requestSnapshot with a fresh snapshot, so a reloaded tab window recovers', () => {
			appendLog('popped', 'while the window reloaded');
			api.emitIntent({ kind: 'requestSnapshot', agentId: AGENT, tabRef: POPPED });
			expect(sent()).toHaveLength(1);
			const snapshot = snapshots()[0];
			expect(snapshot).toMatchObject({ seq: 1, tabRefs: [POPPED] });
			expect(tabOf(snapshot.session, 'popped').logs).toEqual(tabOf(ownerSession(), 'popped').logs);
			// The snapshot covered the change: no delta repeats it.
			flushDue();
			vi.advanceTimersByTime(TAB_WINDOW_FRAME_WAIT_MS);
			expect(sent()).toHaveLength(1);
		});

		it('leaves every other intent to the intent dispatcher', () => {
			api.emitIntent({ kind: 'closeTab', agentId: AGENT, tabRef: POPPED });
			api.emitIntent({ kind: 'requestSnapshot', agentId: 'someone-else', tabRef: POPPED });
			expect(api.sendSessionPatch).not.toHaveBeenCalled();
		});
	});

	describe('the draft seed (D2)', () => {
		beforeEach(() => {
			updateAiTab(AGENT, 'popped', (tab) => ({
				...tab,
				inputValue: 'Stored draft',
				commandMode: 'off',
			}));
			publisher = startTabWindowPublisher();
		});

		it('seeds a popped tab with the draft stored on it, staged images included', () => {
			updateAiTab(AGENT, 'popped', (tab) => ({
				...tab,
				stagedImages: ['data:image/png;base64,AA'],
			}));
			useComposerInputStore.getState().loadAiDraft('home', 'typed for home', 'off');
			setWindows([tabWindow()]);
			expect(tabOf(snapshots()[0].session, 'popped')).toMatchObject({
				inputValue: 'Stored draft',
				commandMode: 'off',
				stagedImages: ['data:image/png;base64,AA'],
			});
		});

		it('seeds it with the text still in the composer, which the typing pause has not written back yet', () => {
			// The owner shows the tab, and its composer holds what the user typed last.
			useComposerInputStore
				.getState()
				.loadAiDraft('popped', 'Stored draft, then more typing', 'shell');
			const stored = ownerSession();
			setWindows([tabWindow()]);

			expect(tabOf(snapshots()[0].session, 'popped')).toMatchObject({
				inputValue: 'Stored draft, then more typing',
				commandMode: 'shell',
			});
			// The store is the composer's to write: the snapshot read it, nothing more.
			expect(ownerSession()).toBe(stored);
			expect(tabOf(stored, 'popped').inputValue).toBe('Stored draft');
		});

		it("never puts the composer's text on a tab the composer does not hold, or on one that is not popped", () => {
			useComposerInputStore.getState().loadAiDraft('home', 'typed for home', 'off');
			setWindows([tabWindow([POPPED, SECOND])]);
			const snapshot = snapshots()[0].session;
			expect(tabOf(snapshot, 'popped').inputValue).toBe('Stored draft');
			expect(tabOf(snapshot, 'second').inputValue).toBe(tabOf(ownerSession(), 'second').inputValue);
			expect(tabOf(snapshot, 'home').inputValue).toBe(tabOf(ownerSession(), 'home').inputValue);
		});

		it('sends no delta for the draft written back after the snapshot', () => {
			useComposerInputStore
				.getState()
				.loadAiDraft('popped', 'Stored draft, then more typing', 'off');
			setWindows([tabWindow()]);
			api.sendSessionPatch.mockClear();
			// The composer lets go of the tab and writes its draft back, as useInputSync does.
			updateAiTab(AGENT, 'popped', (tab) => ({
				...tab,
				inputValue: 'Stored draft, then more typing',
			}));
			flushDue();
			vi.advanceTimersByTime(TAB_WINDOW_FRAME_WAIT_MS);
			expect(api.sendSessionPatch).not.toHaveBeenCalled();
		});
	});

	describe('detach', () => {
		beforeEach(() => {
			setWindows([tabWindow()]);
		});

		it('stops streaming when the tab window closes, dropping the delta still waiting', () => {
			publisher = startTabWindowPublisher();
			api.sendSessionPatch.mockClear();
			appendLog('popped', 'one');
			setWindows([]);
			flushDue();
			vi.advanceTimersByTime(TAB_WINDOW_FRAME_WAIT_MS);
			appendLog('popped', 'two');
			flushDue();
			expect(api.sendSessionPatch).not.toHaveBeenCalled();
		});

		it('stops when the agent leaves this window and attaches again when it comes back (D7)', () => {
			let owned = true;
			publisher = startTabWindowPublisher(() => owned);
			api.sendSessionPatch.mockClear();

			owned = false;
			publisher.sync();
			appendLog('popped', 'published by the new owner');
			flushDue();
			expect(api.sendSessionPatch).not.toHaveBeenCalled();

			owned = true;
			publisher.sync();
			expect(sent()).toHaveLength(1);
			expect(lastSent()).toMatchObject({ form: 'snapshot', seq: 0 });
		});

		it('stops when the agent is removed', () => {
			publisher = startTabWindowPublisher();
			api.sendSessionPatch.mockClear();
			appendLog('popped', 'one');
			useSessionStore.setState({ sessions: [] });
			flushDue();
			vi.advanceTimersByTime(TAB_WINDOW_FRAME_WAIT_MS);
			expect(api.sendSessionPatch).not.toHaveBeenCalled();
		});

		it('stop() drops the waiting delta and every subscription', () => {
			publisher = startTabWindowPublisher();
			api.sendSessionPatch.mockClear();
			appendLog('popped', 'one');
			publisher.stop();
			flushDue();
			vi.advanceTimersByTime(TAB_WINDOW_FRAME_WAIT_MS);
			setWindows([tabWindow([POPPED, SECOND])]);
			api.emitIntent({ kind: 'requestSnapshot', agentId: AGENT, tabRef: POPPED });
			expect(api.sendSessionPatch).not.toHaveBeenCalled();
		});
	});

	it('never throws into the store write when a send fails, and reports it', () => {
		api.sendSessionPatch.mockImplementation(() => {
			throw new Error('An object could not be cloned');
		});
		publisher = startTabWindowPublisher();
		expect(() => setWindows([tabWindow()])).not.toThrow();
		expect(captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ extra: expect.objectContaining({ form: 'snapshot' }) })
		);
	});
});

describe('useTabWindowPublisher', () => {
	beforeEach(() => {
		setWindows([tabWindow()]);
	});

	it('publishes from mount to unmount', () => {
		const { unmount } = renderHook(() => useTabWindowPublisher());
		expect(snapshots()).toHaveLength(1);

		act(() => appendLog('popped', 'one'));
		flushDue();
		expect(deltas()).toHaveLength(1);

		unmount();
		act(() => appendLog('popped', 'two'));
		flushDue();
		expect(deltas()).toHaveLength(1);
	});

	it('follows ownership changes', () => {
		const { rerender } = renderHook(({ owns }) => useTabWindowPublisher(owns), {
			initialProps: { owns: (_id: string) => false },
		});
		expect(api.sendSessionPatch).not.toHaveBeenCalled();

		rerender({ owns: (_id: string) => true });
		expect(snapshots()).toHaveLength(1);

		rerender({ owns: (_id: string) => false });
		act(() => appendLog('popped', 'one'));
		flushDue();
		expect(deltas()).toHaveLength(0);
	});
});
