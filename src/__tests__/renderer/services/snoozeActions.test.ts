/**
 * Tests for src/renderer/services/snoozeActions.ts
 *
 * This service is the one place that knows what has to happen AROUND a snooze,
 * and it now serves three callers (the Snooze dialog, the Snoozed Tabs list,
 * and `maestro-cli snooze`). The failures it exists to prevent are all silent
 * months later:
 *
 *  - Mirroring the transcript AFTER the store write, when the tab has already
 *    left the session and there is nothing left to resolve it from.
 *  - Waking or dismissing without releasing the mirror, which strands a copy
 *    forever, or without recording the resolution, which loses the user's note.
 *  - A CLI snooze landing on the ACTIVE agent instead of the one it named.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mirrorSnoozedTranscript = vi.fn();
const releaseSnoozedTranscript = vi.fn();
vi.mock('../../../renderer/utils/snoozeTranscriptMirror', () => ({
	mirrorSnoozedTranscript: (...args: unknown[]) => mirrorSnoozedTranscript(...args),
	releaseSnoozedTranscript: (...args: unknown[]) => releaseSnoozedTranscript(...args),
}));

const recordSnoozeResolution = vi.fn();
const historyEntries: unknown[] = [];
vi.mock('../../../renderer/stores/snoozeHistoryStore', () => ({
	recordSnoozeResolution: (...args: unknown[]) => recordSnoozeResolution(...args),
	useSnoozeHistoryStore: { getState: () => ({ entries: historyEntries }) },
}));

const notifyToast = vi.fn();
vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => notifyToast(...args),
}));

const notifyCenterFlash = vi.fn();
vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: (...args: unknown[]) => notifyCenterFlash(...args),
}));

// The wake prompt spawns work; nothing here is testing that half.
vi.mock('../../../renderer/services/snoozeWakePrompt', () => ({
	runSnoozeWakePrompt: vi.fn(),
	runSnoozeWakePromptAfterGroupWake: vi.fn(),
}));

import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	dismissSnoozeNow,
	rescheduleSnoozeNow,
	runRemoteSnoozeCommand,
	snoozeTabWithMirror,
	wakeSnoozeNow,
} from '../../../renderer/services/snoozeActions';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { Session } from '../../../renderer/types';

const HOUR = 60 * 60 * 1000;

/** Two agents, each with two AI tabs, with `agent-a` active. */
function setup(): void {
	const build = (id: string, name: string): Session =>
		createMockSession({
			id,
			name,
			aiTabs: [
				createMockAITab({ id: `${id}-t1`, name: `${name} One` }),
				createMockAITab({ id: `${id}-t2`, name: `${name} Two` }),
			],
			unifiedTabOrder: [
				{ type: 'ai', id: `${id}-t1` },
				{ type: 'ai', id: `${id}-t2` },
			],
			activeTabId: `${id}-t1`,
		});
	useSessionStore.setState({
		sessions: [build('agent-a', 'Alpha'), build('agent-b', 'Bravo')],
		activeSessionId: 'agent-a',
	});
}

function snoozesOf(sessionId: string) {
	return useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.snoozedTabs ?? [];
}

beforeEach(() => {
	vi.clearAllMocks();
	historyEntries.length = 0;
	setup();
});

describe('snoozeTabWithMirror', () => {
	it('mirrors the transcript from the session as it was BEFORE the tab left it', () => {
		// Read after the write and there is no tab left to resolve a transcript
		// from, so the copy is never taken and the conversation dies with the
		// provider's retention.
		snoozeTabWithMirror('agent-a-t2', Date.now() + HOUR);

		expect(mirrorSnoozedTranscript).toHaveBeenCalledTimes(1);
		const [session, entry] = mirrorSnoozedTranscript.mock.calls[0];
		expect((session as Session).aiTabs.map((t) => t.id)).toContain('agent-a-t2');
		expect(entry).toMatchObject({ type: 'ai' });
	});

	it('parks on the named agent rather than the active one', () => {
		// The whole reason the store action grew a sessionId: "active" is whatever
		// the human is looking at, which is rarely the agent a script named.
		snoozeTabWithMirror('agent-b-t1', Date.now() + HOUR, undefined, { sessionId: 'agent-b' });

		expect(snoozesOf('agent-b')).toHaveLength(1);
		expect(snoozesOf('agent-a')).toHaveLength(0);
	});

	it('falls back to the active agent, which is what every click path means', () => {
		snoozeTabWithMirror('agent-a-t2', Date.now() + HOUR);
		expect(snoozesOf('agent-a')).toHaveLength(1);
	});

	it('announces by default and stays quiet when asked to', () => {
		snoozeTabWithMirror('agent-a-t2', Date.now() + HOUR);
		expect(notifyCenterFlash).toHaveBeenCalledTimes(1);

		notifyCenterFlash.mockClear();
		snoozeTabWithMirror('agent-a-t1', Date.now() + HOUR, undefined, { announce: false });
		expect(notifyCenterFlash).not.toHaveBeenCalled();
	});

	it('mirrors nothing when the id names no tab', () => {
		expect(snoozeTabWithMirror('nope', Date.now() + HOUR)).toBeNull();
		expect(mirrorSnoozedTranscript).not.toHaveBeenCalled();
		expect(notifyCenterFlash).not.toHaveBeenCalled();
	});
});

describe('wakeSnoozeNow', () => {
	it('restores the tab, releases the mirror, and logs it as pulled back early', () => {
		const entry = snoozeTabWithMirror('agent-a-t2', Date.now() + HOUR)!;
		const result = wakeSnoozeNow('agent-a', entry.id);

		expect(result?.tabId).toBe('agent-a-t2');
		expect(snoozesOf('agent-a')).toHaveLength(0);
		expect(releaseSnoozedTranscript).toHaveBeenCalledTimes(1);
		// `unsnoozed`, not `woke`: the user reached for it rather than it coming
		// due, and the history is only readable because those read differently.
		expect(recordSnoozeResolution).toHaveBeenCalledWith(
			expect.objectContaining({ resolution: 'unsnoozed' })
		);
	});

	it('answers null for a snooze that is not there', () => {
		expect(wakeSnoozeNow('agent-a', 'missing')).toBeNull();
		expect(releaseSnoozedTranscript).not.toHaveBeenCalled();
	});
});

describe('dismissSnoozeNow', () => {
	it('drops the snooze, releases the mirror, and records the discard', () => {
		const entry = snoozeTabWithMirror('agent-a-t2', Date.now() + HOUR)!;
		dismissSnoozeNow('agent-a', entry.id);

		expect(snoozesOf('agent-a')).toHaveLength(0);
		// Dismiss discards Maestro's tab, not the conversation: the provider file
		// is rehydrated on release so it stays reachable afterwards.
		expect(releaseSnoozedTranscript).toHaveBeenCalledTimes(1);
		expect(recordSnoozeResolution).toHaveBeenCalledWith(
			expect.objectContaining({ resolution: 'dismissed' })
		);
		expect(notifyToast).toHaveBeenCalledTimes(1);
	});

	it('suppresses the toast when asked, without skipping any of the work', () => {
		const entry = snoozeTabWithMirror('agent-a-t2', Date.now() + HOUR)!;
		dismissSnoozeNow('agent-a', entry.id, { announce: false });

		expect(notifyToast).not.toHaveBeenCalled();
		expect(recordSnoozeResolution).toHaveBeenCalledTimes(1);
	});

	it('does not restore the tab', () => {
		const entry = snoozeTabWithMirror('agent-a-t2', Date.now() + HOUR)!;
		dismissSnoozeNow('agent-a', entry.id);
		const session = useSessionStore.getState().sessions.find((s) => s.id === 'agent-a')!;
		expect(session.aiTabs.map((t) => t.id)).not.toContain('agent-a-t2');
	});
});

describe('rescheduleSnoozeNow', () => {
	it('moves the wake time and keeps the tab parked', () => {
		const entry = snoozeTabWithMirror('agent-a-t2', Date.now() + HOUR, { note: 'keep me' })!;
		const later = Date.now() + 5 * HOUR;
		const updated = rescheduleSnoozeNow('agent-a', entry.id, later);

		expect(updated?.wakeAt).toBe(later);
		expect(snoozesOf('agent-a')).toHaveLength(1);
		// The tab never came back, so its transcript copy must still be held.
		expect(releaseSnoozedTranscript).not.toHaveBeenCalled();
	});

	it('leaves an omitted note alone and clears an empty one', () => {
		const entry = snoozeTabWithMirror('agent-a-t2', Date.now() + HOUR, { note: 'keep me' })!;
		expect(rescheduleSnoozeNow('agent-a', entry.id, Date.now() + 2 * HOUR)?.note).toBe('keep me');
		expect(
			rescheduleSnoozeNow('agent-a', entry.id, Date.now() + 3 * HOUR, { note: '' })?.note
		).toBeUndefined();
	});
});

describe('runRemoteSnoozeCommand', () => {
	it('lists every agent, and narrows to one when asked', () => {
		snoozeTabWithMirror('agent-a-t2', Date.now() + HOUR);
		snoozeTabWithMirror('agent-b-t2', Date.now() + 2 * HOUR, undefined, { sessionId: 'agent-b' });

		const all = runRemoteSnoozeCommand({ action: 'list' });
		expect(all.snoozes?.map((s) => s.agentId)).toEqual(['agent-a', 'agent-b']);
		// Flat, not the stored entry: a summary carrying the parked tab would put
		// the whole transcript on the wire.
		expect(all.snoozes?.[0]).not.toHaveProperty('tab');
		expect(all.snoozes?.[0].label).toBe('Alpha Two');

		const scoped = runRemoteSnoozeCommand({ action: 'list', sessionId: 'agent-b' });
		expect(scoped.snoozes).toHaveLength(1);
		expect(scoped.snoozes?.[0].agentName).toBe('Bravo');
	});

	it('parks a tab on the agent the request names', () => {
		const wakeAt = Date.now() + HOUR;
		const result = runRemoteSnoozeCommand({
			action: 'snooze',
			sessionId: 'agent-b',
			targetId: 'agent-b-t2',
			wakeAt,
			note: 'ship it',
		});

		expect(result.success).toBe(true);
		expect(result.snooze).toMatchObject({ agentId: 'agent-b', wakeAt, note: 'ship it' });
		expect(snoozesOf('agent-b')).toHaveLength(1);
		expect(snoozesOf('agent-a')).toHaveLength(0);
	});

	it('honours background as a NOTICE suppressor, not a work suppressor', () => {
		const result = runRemoteSnoozeCommand({
			action: 'snooze',
			sessionId: 'agent-a',
			targetId: 'agent-a-t2',
			wakeAt: Date.now() + HOUR,
			background: true,
		});

		expect(result.success).toBe(true);
		expect(snoozesOf('agent-a')).toHaveLength(1);
		expect(notifyCenterFlash).not.toHaveBeenCalled();
	});

	it('describes the snooze it woke, snapshotting it before it disappears', () => {
		const entry = snoozeTabWithMirror('agent-a-t2', Date.now() + HOUR)!;
		const result = runRemoteSnoozeCommand({
			action: 'wake',
			sessionId: 'agent-a',
			targetId: entry.id,
		});

		expect(result.success).toBe(true);
		expect(result.tabId).toBe('agent-a-t2');
		// Read after the wake and there is no entry left to describe.
		expect(result.snooze?.snoozeId).toBe(entry.id);
	});

	it('answers rather than throws for an id that is not there', () => {
		for (const action of ['wake', 'dismiss'] as const) {
			const result = runRemoteSnoozeCommand({ action, sessionId: 'agent-a', targetId: 'ghost' });
			expect(result.success, action).toBe(false);
			expect(result.error, action).toContain('ghost');
		}
	});

	it('refuses a write that names no agent, even though main already checks', () => {
		// Also reachable from a browser client on a different build, and a write
		// addressed to `undefined` would park or drop the wrong thing.
		const result = runRemoteSnoozeCommand({ action: 'dismiss', targetId: 'sn1' });
		expect(result.success).toBe(false);
	});

	it('caps history with --limit and reports the newest first', () => {
		historyEntries.push(
			{
				id: 'h1',
				label: 'Newest',
				sessionId: 'agent-a',
				sessionName: 'Alpha',
				tabId: 't1',
				snoozedAt: 1,
				wakeAt: 2,
				resolvedAt: 3,
				resolution: 'woke',
			},
			{
				id: 'h2',
				label: 'Older',
				sessionId: 'agent-b',
				sessionName: 'Bravo',
				tabId: 't2',
				snoozedAt: 1,
				wakeAt: 2,
				resolvedAt: 3,
				resolution: 'dismissed',
			}
		);

		expect(runRemoteSnoozeCommand({ action: 'history' }).history).toHaveLength(2);
		const capped = runRemoteSnoozeCommand({ action: 'history', limit: 1 });
		expect(capped.history?.map((h) => h.id)).toEqual(['h1']);
		expect(capped.history?.[0].agentId).toBe('agent-a');
	});
});
