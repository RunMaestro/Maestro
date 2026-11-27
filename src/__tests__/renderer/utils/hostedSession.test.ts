/**
 * Tests for `projectHostedSession()` and `mergeHostedLogs()`: a hosted agent's Left Bar record
 * takes the host's tabs, transcripts, live turns, busy state, and queue, without losing a local
 * tab or entry and without ever making a host queue item runnable here.
 */

import { describe, expect, it } from 'vitest';
import { liveTurnKey } from '../../../shared/maestro-lib/client/live-turn';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type {
	LogEntryRecord,
	LogEntryToolState,
} from '../../../shared/maestro-lib/store/transcript';
import {
	mergeHostedLogs,
	projectHostedSession,
	releaseHostedSession,
	type HostedProjectionInput,
} from '../../../renderer/utils/hostedSession';
import { isRunnableQueueItem, nextRunnableQueueItem } from '../../../renderer/utils/executionQueue';
import type { LogEntry } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

const record = (id: string, text = id): LogEntryRecord => ({
	id,
	timestamp: 1,
	source: 'user',
	text,
});
const local = (id: string, extra: Partial<LogEntry> = {}): LogEntry => ({
	id,
	timestamp: 1,
	source: 'user',
	text: id,
	...extra,
});

const host = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
	id: 'h1',
	name: 'Docs',
	toolType: 'claude-code',
	activeTabId: 't1',
	aiTabs: [{ id: 't1', name: 'Main', agentSessionId: 's1', state: 'idle' }],
	...overrides,
});

const hostedRow = (aiTabs = [createMockAITab({ id: 't1', logs: [local('old')] })]) =>
	createMockSession({
		id: 'row',
		liftedTo: { peer: 'box', agentId: 'h1', at: 1 },
		activeTabId: aiTabs[0]?.id ?? 't1',
		aiTabs,
		unifiedTabOrder: aiTabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
		executionQueue: [],
		state: 'idle',
	});

describe('mergeHostedLogs', () => {
	// Parity R8: a local turn appends to one entry and leaves the others' identity alone, so only
	// that row renders again. A hosted turn's pass builds new objects for the live tail (and the
	// delivered tick); every entry that draws the same keeps the object it had.
	it('keeps the object of every entry that draws the same while a live reply grows (R8)', () => {
		const saved = [
			record('u1', 'question'),
			{ ...record('a0'), source: 'stdout', text: 'earlier' },
		];
		const tool = {
			id: 'tool1',
			timestamp: 2,
			source: 'tool',
			text: 'Read',
			metadata: { toolState: { status: 'completed', input: { file: 'a.ts' } } },
		} as unknown as LogEntryRecord;
		const reply = (text: string): LogEntryRecord => ({
			id: 'live1',
			timestamp: 3,
			source: 'stdout',
			text,
		});
		const first = mergeHostedLogs([], saved, [tool, reply('line 1\n')]);
		const second = mergeHostedLogs(first, saved, [tool, reply('line 1\nline 2\n')]);
		expect(second).not.toBe(first);
		// The saved entries and the finished tool card are the same objects: their rows do not render.
		expect(second.slice(0, 3).every((entry, i) => entry === first[i])).toBe(true);
		// Only the growing reply is new.
		expect(second[3]).not.toBe(first[3]);
		expect(second[3].text).toBe('line 1\nline 2\n');
	});

	it('takes the new text of a saved entry the host rewrote in place (M22)', () => {
		const pending = { ...record('p1'), source: 'system', text: 'Generating history synopsis...' };
		const first = mergeHostedLogs([], [pending], undefined);
		const settled = mergeHostedLogs(
			first,
			[{ ...pending, text: 'Synopsis saved to history: x' }],
			undefined
		);
		expect(settled).not.toBe(first);
		expect(settled.map((entry) => entry.text)).toEqual(['Synopsis saved to history: x']);
	});

	it('settles a saved line the host rewrote while a turn runs on its tab, from the live entry (CodeRabbit on #2154)', () => {
		const pending = { ...record('p1'), source: 'system', text: 'Generating history synopsis...' };
		const first = mergeHostedLogs([], [pending], undefined);
		// The busy tab's live turn carries the rewrite under the saved line's id; the saved
		// transcript is read again only when the turn ends.
		const settled = mergeHostedLogs(
			first,
			[pending],
			[{ ...pending, text: 'Synopsis saved to history: x' }, record('a1')]
		);
		expect(settled.map((entry) => entry.text)).toEqual(['Synopsis saved to history: x', 'a1']);
		expect(settled.filter((entry) => entry.id === 'p1')).toHaveLength(1);
		expect(settled[0].hostLive).toBeUndefined();
	});

	it('draws a kept message once when the host writes it under the same id (R14)', () => {
		const bubble = local('k1', { text: 'hello', timestamp: 5, keptForHost: true });
		const before = [local('h1'), bubble];
		// While it waits: the host does not have it, the bubble stays.
		expect(mergeHostedLogs(before, [record('h1')], undefined).map((e) => e.id)).toEqual([
			'h1',
			'k1',
		]);
		// Sent, and the host took the id: its live entry and then its saved one are that bubble.
		const live = mergeHostedLogs(before, [record('h1')], [record('k1', 'hello'), record('a1')]);
		expect(live.filter((e) => e.source === 'user' && e.text === 'hello')).toHaveLength(1);
		const saved = mergeHostedLogs(live, [record('h1'), record('k1', 'hello')], undefined);
		expect(saved.filter((e) => e.text === 'hello').map((e) => e.id)).toEqual(['k1']);
	});

	it('makes a kept message the host one once the host runs it under that id (Greptile on #2161)', () => {
		const bubble = local('k1', { text: 'hello', timestamp: 5, keptForHost: true, keptSentAt: 6 });
		const live = mergeHostedLogs([local('h1'), bubble], [record('h1')], [record('k1', 'hello')]);
		const drawn = live.find((e) => e.id === 'k1');
		expect(drawn).toMatchObject({ id: 'k1', text: 'hello', source: 'user' });
		expect(drawn?.keptForHost).toBeUndefined();
		expect(drawn?.keptSentAt).toBeUndefined();
	});

	it('never takes a host message with the same words for a kept message this machine has not sent (Greptile on #2161)', () => {
		const bubble = local('k1', { text: 'continue', timestamp: 5, keptForHost: true });
		// Another client sent "continue" while this one still waits for its retry.
		const merged = mergeHostedLogs(
			[local('h1'), bubble],
			[record('h1'), record('y1', 'continue')],
			undefined
		);
		expect(merged.filter((e) => e.text === 'continue').map((e) => e.id)).toEqual(['y1', 'k1']);
	});

	it('never takes an older host message with the same words, read in now, for a sent kept message (CodeRabbit on #2161)', () => {
		const sentAt = 10 * 60_000;
		const bubble = local('k1', {
			text: 'continue',
			timestamp: sentAt,
			keptForHost: true,
			keptSentAt: sentAt,
		});
		// The reconnect reads a longer window: a "continue" from an hour before is new to the tab.
		const merged = mergeHostedLogs(
			[local('h1'), bubble],
			[record('h1'), { ...record('old', 'continue'), timestamp: sentAt - 3_600_000 }],
			undefined
		);
		expect(merged.filter((e) => e.text === 'continue').map((e) => e.id)).toEqual(['old', 'k1']);
	});

	it('draws a kept message once when the host writes it under its own id (R14)', () => {
		const bubble = local('k1', { text: 'hello', timestamp: 5, keptForHost: true, keptSentAt: 6 });
		const before = [local('h1'), bubble];
		// The host writes its copy when it takes the message: after the bubble was typed.
		const copy = { ...record('y1', 'hello'), timestamp: 7 };
		const live = mergeHostedLogs(before, [record('h1')], [copy, record('a1')]);
		expect(live.filter((e) => e.text === 'hello').map((e) => e.id)).toEqual(['y1']);
		const saved = mergeHostedLogs(live, [record('h1'), copy], undefined);
		expect(saved.filter((e) => e.text === 'hello').map((e) => e.id)).toEqual(['y1']);
	});

	// Parity R28: the old rule let a host entry from up to 60 s BEFORE the bubble match it.
	it('never takes a host message with the same words written before the bubble, even seconds before (R28)', () => {
		const typedAt = 10 * 60_000;
		const bubble = local('k1', {
			text: 'continue',
			timestamp: typedAt,
			keptForHost: true,
			keptSentAt: typedAt + 30_000,
		});
		// Another client's "continue" from 20 s before this one was typed, never drawn here.
		const earlier = { ...record('y0', 'continue'), timestamp: typedAt - 20_000 };
		const waiting = mergeHostedLogs([local('h1'), bubble], [record('h1'), earlier], undefined);
		expect(waiting.filter((e) => e.text === 'continue').map((e) => e.id)).toEqual(['y0', 'k1']);
		// The host's own copy, written at the send, takes the bubble's place.
		const copy = { ...record('y1', 'continue'), timestamp: typedAt + 30_000 };
		const taken = mergeHostedLogs(waiting, [record('h1'), earlier, copy], undefined);
		expect(taken.filter((e) => e.text === 'continue').map((e) => e.id)).toEqual(['y0', 'y1']);
	});

	it('keeps a kept bubble when the host holds only an earlier message with the same words (R14)', () => {
		// "hello" was sent and drawn before the link dropped; the kept "hello" is a second one.
		const before = [
			local('h1', { text: 'hello' }),
			local('k1', { text: 'hello', timestamp: 5, keptForHost: true }),
		];
		const merged = mergeHostedLogs(before, [record('h1', 'hello')], undefined);
		expect(merged.map((e) => e.id)).toEqual(['h1', 'k1']);
	});

	it('keeps local entries the host read window does not hold, ahead of the host entries', () => {
		const merged = mergeHostedLogs([local('a'), local('b')], [record('b'), record('c')], undefined);
		expect(merged.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
	});

	it('places an entry written here where it happened, as a local tab holds it', () => {
		// A wizard that ran here flattens its turns into the tab after the host's earlier ones.
		const merged = mergeHostedLogs(
			[
				local('h1', { timestamp: 10 }),
				local('h2', { timestamp: 20 }),
				local('wizard-q', { timestamp: 30 }),
				local('wizard-a', { timestamp: 40 }),
			],
			[
				{ ...record('h1'), timestamp: 10 },
				{ ...record('h2'), timestamp: 20 },
				{ ...record('h3'), timestamp: 50 },
			],
			undefined
		);
		expect(merged.map((entry) => entry.id)).toEqual(['h1', 'h2', 'wizard-q', 'wizard-a', 'h3']);
	});

	it('keeps local entries untouched while the host transcript was never read', () => {
		const logs = [local('a')];
		expect(mergeHostedLogs(logs, undefined, undefined)).toBe(logs);
	});

	it('appends the live tail as hostLive entries and drops them on the next pass', () => {
		const first = mergeHostedLogs([local('a')], [record('a')], [record('live-1', 'Thin')]);
		expect(first.map((entry) => [entry.id, entry.hostLive === true])).toEqual([
			['a', false],
			['live-1', true],
		]);
		// The turn ended and the re-read holds its answer under its own id: the live entry goes.
		const settled = mergeHostedLogs(first, [record('a'), record('answer')], undefined);
		expect(settled.map((entry) => entry.id)).toEqual(['a', 'answer']);
	});

	it('returns the same array when nothing changed, so the store write is skipped', () => {
		const first = mergeHostedLogs([], [record('a')], [record('live', 'x')]);
		expect(mergeHostedLogs(first, [record('a')], [record('live', 'x')])).toBe(first);
		expect(mergeHostedLogs(first, [record('a')], [record('live', 'xy')])).not.toBe(first);
	});

	// Live pass L8: a hosted tool call froze the window. The mirror builds a new tool card object on
	// every pass, so an identity check never settled and the sync rewrote the record forever.
	it('settles on a live tool card, and still redraws it when its state changes', () => {
		const tool = (status: LogEntryToolState['status'], output?: string): LogEntryRecord => ({
			id: 'tool-1',
			timestamp: 2,
			source: 'tool',
			text: 'Read',
			metadata: { toolState: { status, input: { file_path: '/p/README.md' }, output } },
		});
		const first = mergeHostedLogs([], [record('a')], [tool('running')]);
		expect(first[1].metadata?.toolState?.status).toBe('running');
		expect(mergeHostedLogs(first, [record('a')], [tool('running')])).toBe(first);
		const done = mergeHostedLogs(first, [record('a')], [tool('completed', '# Parity')]);
		expect(done).not.toBe(first);
		expect(done[1].metadata?.toolState).toMatchObject({ status: 'completed', output: '# Parity' });
		expect(mergeHostedLogs(done, [record('a')], [tool('completed', '# Parity')])).toBe(done);
	});

	// Parity round 3, N3: the tick follows the local rule (the answer arrived), not the host's flag.
	it("ticks a host message once the host recorded its answer, keeps a local entry's own flag, and stays stable", () => {
		const sent = { ...record('u1'), delivered: true };
		const answer: LogEntryRecord = { id: 'a1', timestamp: 2, source: 'stdout', text: 'Done' };
		const waiting = mergeHostedLogs([], [sent], undefined);
		expect(waiting[0].delivered).toBe(false);
		expect(mergeHostedLogs(waiting, [sent], undefined)).toBe(waiting);
		// Partial text streaming in a live entry is not the answer yet, as a local tab's is not.
		const streaming = mergeHostedLogs(waiting, [sent], [{ ...answer, id: 'p1', text: 'Do' }]);
		expect(streaming[0].delivered).toBe(false);
		const answered = mergeHostedLogs(streaming, [sent, answer], undefined);
		expect(answered[0].delivered).toBe(true);
		expect(mergeHostedLogs(answered, [sent, answer], undefined)).toBe(answered);
		// A message written here before the move keeps the flag it was given here.
		const kept = mergeHostedLogs([local('old', { delivered: true })], [sent], undefined);
		expect(kept.map((entry) => [entry.id, entry.delivered])).toEqual([
			['old', true],
			['u1', false],
		]);
	});
});

describe('projectHostedSession', () => {
	// Parity round 3, N6: unread follows the local rule (the answer of a watched run arrived).
	it('marks a tab unread when the answer of a run it watched arrives, never for a loaded conversation', () => {
		const key = liveTurnKey('h1', 't2');
		const answer = { id: 'a1', timestamp: 3, source: 'stdout', text: 'Done' } as LogEntryRecord;
		const transcripts = { [key]: { entries: [record('u1'), answer], loaded: true } };
		// First read of an idle conversation (startup): nothing new happened, so nothing is unread.
		const loaded = projectHostedSession(hostedRow(), {
			agent: host({ aiTabs: [{ id: 't1' }, { id: 't2', state: 'idle' }] }),
			transcripts,
		});
		expect(loaded.aiTabs.find((tab) => tab.id === 't2')?.hasUnread).toBeUndefined();
		// A host tab first seen running (another client opened it), whose answer then arrives.
		const running = projectHostedSession(hostedRow(), {
			agent: host({ aiTabs: [{ id: 't1' }, { id: 't2', state: 'busy' }] }),
		});
		const answered = projectHostedSession(running, {
			agent: host({ aiTabs: [{ id: 't1' }, { id: 't2', state: 'idle' }] }),
			transcripts,
		});
		expect(answered.aiTabs.find((tab) => tab.id === 't2')?.hasUnread).toBe(true);
	});

	it("takes the host's name, star, provider session, and busy state onto the matching tab", () => {
		const session = hostedRow();
		const next = projectHostedSession(session, {
			agent: host({
				aiTabs: [
					{
						id: 't1',
						name: 'Renamed',
						starred: true,
						agentSessionId: 's1',
						state: 'busy',
						thinkingStartTime: 42,
					},
				],
			}),
		});
		expect(next.aiTabs[0]).toMatchObject({
			name: 'Renamed',
			starred: true,
			agentSessionId: 's1',
			state: 'busy',
			thinkingStartTime: 42,
		});
		expect(next.state).toBe('busy');
		expect(next.busySource).toBe('ai');
	});

	it('merges the read transcript and the live turn into the tab logs', () => {
		const key = liveTurnKey('h1', 't1');
		const next = projectHostedSession(hostedRow(), {
			agent: host(),
			transcripts: { [key]: { entries: [record('old'), record('new')], loaded: true } },
			liveTurns: { [key]: { startedAt: 1, busy: true, entries: [record('streaming')] } },
		});
		expect(next.aiTabs[0].logs.map((entry) => entry.id)).toEqual(['old', 'new', 'streaming']);
		expect(next.aiTabs[0].logs[2].hostLive).toBe(true);
	});

	it('appends a host tab this record lacks and keeps a local tab the host does not have', () => {
		const kept = createMockAITab({ id: 'kept', agentSessionId: 'older', logs: [local('k')] });
		const session = hostedRow([createMockAITab({ id: 't1' }), kept]);
		const next = projectHostedSession(session, {
			agent: host({
				aiTabs: [
					{ id: 't1', agentSessionId: 's1' },
					{ id: 't2', name: 'New on host', agentSessionId: 's2' },
				],
			}),
		});
		expect(next.aiTabs.map((tab) => tab.id)).toEqual(['t1', 'kept', 't2']);
		expect(next.aiTabs[1]).toBe(kept);
		expect(next.unifiedTabOrder.map((ref) => ref.id)).toEqual(['t1', 'kept', 't2']);
	});

	// Parity round 5, P1: a tab closed on the host is gone here and stays gone.
	it('drops a tab the host reported and then closed, keeping one from before the move', () => {
		const kept = createMockAITab({ id: 'kept', agentSessionId: 'older', logs: [local('k')] });
		const session = hostedRow([
			createMockAITab({ id: 't1' }),
			kept,
			createMockAITab({ id: 't2', agentSessionId: 's2' }),
		]);
		const seen = projectHostedSession(session, {
			agent: host({ aiTabs: [{ id: 't1' }, { id: 't2', agentSessionId: 's2' }] }),
		});
		expect(seen.aiTabs.find((tab) => tab.id === 't2')?.hostSeenAt).toBe(1);
		expect(seen.aiTabs.find((tab) => tab.id === 'kept')?.hostSeenAt).toBeUndefined();
		// The host closed t2: the record drops it and its strip slot; the kept tab stays.
		const closed = projectHostedSession(seen, { agent: host({ aiTabs: [{ id: 't1' }] }) });
		expect(closed.aiTabs.map((tab) => tab.id)).toEqual(['t1', 'kept']);
		expect(closed.unifiedTabOrder.map((ref) => ref.id)).toEqual(['t1', 'kept']);
		expect(projectHostedSession(closed, { agent: host({ aiTabs: [{ id: 't1' }] }) })).toBe(closed);
	});

	it('never draws back a tab closed here while the host still lists it', () => {
		const session = hostedRow([createMockAITab({ id: 't1' })]);
		const next = projectHostedSession(session, {
			agent: host({ aiTabs: [{ id: 't1' }, { id: 't2' }] }),
			closing: new Set(['t2']),
		});
		expect(next.aiTabs.map((tab) => tab.id)).toEqual(['t1']);
		expect(next.unifiedTabOrder.map((ref) => ref.id)).toEqual(['t1']);
	});

	it('keeps a tab marked by an earlier hosting, and one the host only hid', () => {
		const earlier = createMockAITab({ id: 'earlier', agentSessionId: 'e', hostSeenAt: 0 });
		const hidden = createMockAITab({
			id: 'consult',
			agentSessionId: 'c',
			hidden: true,
			hostSeenAt: 1,
		});
		const session = hostedRow([createMockAITab({ id: 't1' }), earlier, hidden]);
		const next = projectHostedSession(session, {
			agent: host({ aiTabs: [{ id: 't1' }, { id: 'consult', hidden: true }] }),
		});
		expect(next.aiTabs.map((tab) => tab.id)).toEqual(['t1', 'earlier', 'consult']);
	});

	it('keeps the draft of a tab another client closed on the host, for Cmd+Shift+T', () => {
		const drafted = createMockAITab({
			id: 't2',
			agentSessionId: 's2',
			inputValue: 'half a thought',
			stagedImages: ['data:image/png;base64,AAAA'],
			hostSeenAt: 1,
		});
		const session = hostedRow([createMockAITab({ id: 't1', hostSeenAt: 1 }), drafted]);
		const closed = projectHostedSession(session, { agent: host({ aiTabs: [{ id: 't1' }] }) });
		expect(closed.aiTabs.map((tab) => tab.id)).toEqual(['t1']);
		expect(closed.closedTabHistory?.[0]).toMatchObject({
			index: 1,
			tab: { id: 't2', inputValue: 'half a thought', stagedImages: drafted.stagedImages },
		});
	});

	it('drops the last conversation another client closed while another tab kind remains', () => {
		const session = {
			...hostedRow([createMockAITab({ id: 't1', agentSessionId: 's1', hostSeenAt: 1 })]),
			terminalTabs: [{ id: 'term-1' } as never],
		};
		const closed = projectHostedSession(session, { agent: host({ aiTabs: [] }) });
		expect(closed.aiTabs).toEqual([]);
		// A record whose tab list is not known yet closes nothing.
		const unknown = projectHostedSession(session, { agent: host({ aiTabs: undefined }) });
		expect(unknown.aiTabs.map((tab) => tab.id)).toEqual(['t1']);
	});

	it('marks a tab the host lists as hidden, and closes it when the host drops it', () => {
		const consult = createMockAITab({
			id: 'consult',
			agentSessionId: 'c',
			hidden: true,
			logs: [local('c')],
		});
		const session = hostedRow([createMockAITab({ id: 't1' }), consult]);
		const seen = projectHostedSession(session, {
			agent: host({ aiTabs: [{ id: 't1' }, { id: 'consult', hidden: true }] }),
		});
		expect(seen.aiTabs.find((tab) => tab.id === 'consult')?.hostSeenAt).toBe(1);
		const gone = projectHostedSession(seen, { agent: host({ aiTabs: [{ id: 't1' }] }) });
		expect(gone.aiTabs.map((tab) => tab.id)).toEqual(['t1']);
	});

	it('keeps a blank tab the host lists only as hidden', () => {
		const blankHidden = createMockAITab({ id: 'consult', logs: [], agentSessionId: null });
		const session = hostedRow([blankHidden]);
		const next = projectHostedSession(session, {
			agent: host({ aiTabs: [{ id: 'consult', hidden: true }] }),
		});
		expect(next.aiTabs.map((tab) => tab.id)).toEqual(['consult']);
	});

	it('takes a host-closed tab out of its tile group', () => {
		const tabs = ['t1', 't2', 't3'].map((id) =>
			createMockAITab({ id, agentSessionId: `s-${id}`, hostSeenAt: 1 })
		);
		const leaf = (id: string) => ({
			kind: 'leaf' as const,
			id: `pane-${id}`,
			tab: { type: 'ai' as const, id },
		});
		const session = {
			...hostedRow(tabs),
			tabGroups: [
				{
					id: 'g1',
					name: 'Pair',
					createdAt: 1,
					layout: {
						kind: 'split' as const,
						id: 'split-1',
						direction: 'row' as const,
						children: [leaf('t1'), leaf('t2')],
						sizes: [0.5, 0.5],
					},
					focusedPaneId: 'pane-t2',
				},
			],
			activeGroupId: 'g1',
		} as never;
		const closed = projectHostedSession(session, {
			agent: host({ aiTabs: [{ id: 't1' }, { id: 't3' }] }),
		});
		expect(closed.aiTabs.map((tab) => tab.id)).toEqual(['t1', 't3']);
		// One pane left is no group: it dissolves, as after a local close.
		expect(closed.tabGroups).toEqual([]);
		expect(closed.activeGroupId ?? null).toBeNull();
	});

	it("drops an added agent's blank starting tab once the host has tabs", () => {
		const session = hostedRow([createMockAITab({ id: 'blank', logs: [], agentSessionId: null })]);
		const next = projectHostedSession(session, { agent: host() });
		expect(next.aiTabs.map((tab) => tab.id)).toEqual(['t1']);
		expect(next.activeTabId).toBe('t1');
		expect(next.unifiedTabOrder).toEqual([{ type: 'ai', id: 't1' }]);
	});

	it('draws the host queue as host-only cards that no local drain can run', () => {
		const next = projectHostedSession(hostedRow(), {
			agent: host(),
			queue: [
				{ itemId: 'q1', tabId: 't1', text: 'next', queuedAt: 5, kind: 'message', paused: false },
			],
		});
		expect(next.executionQueue).toEqual([
			expect.objectContaining({ id: 'q1', text: 'next', hostQueued: true }),
		]);
		expect(isRunnableQueueItem(next.executionQueue[0])).toBe(false);
		expect(nextRunnableQueueItem(next.executionQueue)).toBeUndefined();
	});

	it('redraws a host card when only its images, model, or command arguments changed', () => {
		const base = {
			itemId: 'q1',
			tabId: 't1',
			text: 'next',
			queuedAt: 5,
			kind: 'message' as const,
			paused: false,
		};
		const first = projectHostedSession(hostedRow(), { agent: host(), queue: [base] });
		const images = projectHostedSession(first, {
			agent: host(),
			queue: [{ ...base, images: ['data:image/png;base64,AA'] }],
		});
		expect(images.executionQueue[0].images).toEqual(['data:image/png;base64,AA']);
		const model = projectHostedSession(images, {
			agent: host(),
			queue: [{ ...base, images: ['data:image/png;base64,AA'], turnSettings: { model: 'opus' } }],
		});
		expect(model.executionQueue[0].turnSettings).toEqual({ model: 'opus' });
		const command = { ...base, kind: 'command' as const, text: '/plan auth' };
		const plan = projectHostedSession(model, { agent: host(), queue: [command] });
		const replan = projectHostedSession(plan, {
			agent: host(),
			queue: [{ ...command, text: '/plan billing' }],
		});
		expect(replan.executionQueue[0].commandArgs).toBe('billing');
		// Unchanged: the same record, so nothing redraws.
		expect(
			projectHostedSession(replan, {
				agent: host(),
				queue: [{ ...command, text: '/plan billing' }],
			})
		).toBe(replan);
	});

	it('leaves a running terminal command in charge of the busy state', () => {
		const session = { ...hostedRow(), state: 'busy' as const, busySource: 'terminal' as const };
		const next = projectHostedSession(session, { agent: host() });
		expect(next.state).toBe('busy');
		expect(next.busySource).toBe('terminal');
	});

	it('returns the same record when it already matches the host', () => {
		const first = projectHostedSession(hostedRow(), { agent: host() });
		expect(projectHostedSession(first, { agent: host() })).toBe(first);
	});

	it('returns the same record while a live tool call runs, so the sync settles', () => {
		const key = liveTurnKey('h1', 't1');
		const input: HostedProjectionInput = {
			agent: host(),
			transcripts: { [key]: { entries: [record('old')], loaded: true } },
			liveTurns: {
				[key]: {
					startedAt: 1,
					busy: true,
					entries: [
						{
							id: 'tool-1',
							timestamp: 2,
							source: 'tool',
							text: 'Read',
							metadata: { toolState: { status: 'running', input: { file_path: 'README.md' } } },
						},
					],
				},
			},
		};
		const first = projectHostedSession(hostedRow(), input);
		expect(first.aiTabs[0].logs.map((entry) => entry.id)).toEqual(['old', 'tool-1']);
		expect(projectHostedSession(first, input)).toBe(first);
	});

	describe('the error banner', () => {
		const key = liveTurnKey('h1', 't1');
		const error = {
			type: 'auth_expired' as const,
			message: 'Login expired',
			recoverable: true,
			agentId: 'claude-code',
			timestamp: 7,
		};
		const errorEntry: LogEntryRecord = {
			id: 'err',
			timestamp: 7,
			source: 'error',
			text: 'Login expired',
			agentError: error,
		};
		const failed = (session = hostedRow()) =>
			projectHostedSession(session, {
				agent: host(),
				liveTurns: { [key]: { startedAt: 1, busy: false, entries: [errorEntry] } },
			});

		it("raises the tab's and the agent's error when the host's turn reports one, as a local error does", () => {
			const next = failed();
			expect(next.aiTabs[0].agentError).toEqual(error);
			expect(next.agentError).toEqual(error);
			expect(next.agentErrorTabId).toBe('t1');
			expect(next.state).toBe('error');
			// The host runs the queue, so the queue pause a local error adds is not taken here.
			expect(next.agentErrorPaused).toBeFalsy();
			// The error card draws with its details, as a local one does.
			expect(next.aiTabs[0].logs.at(-1)?.agentError).toEqual(error);
		});

		it('stays dismissed once the user dismisses it', () => {
			const raised = failed();
			const dismissed = {
				...raised,
				agentError: undefined,
				agentErrorTabId: undefined,
				state: 'idle' as const,
				aiTabs: raised.aiTabs.map((tab) => ({ ...tab, agentError: undefined })),
			};
			const next = failed(dismissed);
			expect(next.aiTabs[0].agentError).toBeUndefined();
			expect(next.agentError).toBeUndefined();
			expect(next.state).toBe('idle');
		});

		it('clears when the next turn starts, as a local send clears it', () => {
			const raised = failed();
			const next = projectHostedSession(raised, {
				agent: host({ aiTabs: [{ id: 't1', agentSessionId: 's1', state: 'busy' }] }),
			});
			expect(next.aiTabs[0].agentError).toBeUndefined();
			expect(next.agentError).toBeUndefined();
			expect(next.state).toBe('busy');
		});

		it('raises nothing for an old error in a transcript that loads later', () => {
			const next = projectHostedSession(hostedRow(), {
				agent: host(),
				transcripts: { [key]: { entries: [errorEntry], loaded: true } },
			});
			expect(next.aiTabs[0].agentError).toBeUndefined();
			expect(next.agentError).toBeUndefined();
			expect(next.state).toBe('idle');
		});
	});
});

describe('releaseHostedSession', () => {
	it('takes out host queue cards, live entries, and host busy state, keeping the conversation', () => {
		const key = liveTurnKey('h1', 't1');
		const projected = projectHostedSession(hostedRow(), {
			agent: host({ aiTabs: [{ id: 't1', agentSessionId: 's1', state: 'busy' }] }),
			transcripts: { [key]: { entries: [record('old'), record('done')], loaded: true } },
			liveTurns: { [key]: { startedAt: 1, busy: true, entries: [record('streaming')] } },
			queue: [
				{ itemId: 'q1', tabId: 't1', text: 'next', queuedAt: 5, kind: 'message', paused: false },
			],
		});
		const released = releaseHostedSession(projected);
		expect(released.aiTabs[0].logs.map((entry) => entry.id)).toEqual(['old', 'done']);
		expect(released.aiTabs[0].state).toBe('idle');
		expect(released.executionQueue).toEqual([]);
		expect(released.state).toBe('idle');
	});

	it('returns the same record when there is nothing to take out', () => {
		const session = hostedRow();
		expect(releaseHostedSession(session)).toBe(session);
	});

	it('leaves a running terminal command alone', () => {
		const session = { ...hostedRow(), state: 'busy' as const, busySource: 'terminal' as const };
		expect(releaseHostedSession(session).state).toBe('busy');
	});
});
