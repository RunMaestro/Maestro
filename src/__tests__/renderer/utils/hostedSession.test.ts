/**
 * Tests for `projectHostedSession()` and `mergeHostedLogs()`: a hosted agent's Left Bar record
 * takes the host's tabs, transcripts, live turns, busy state, and queue, without losing a local
 * tab or entry and without ever making a host queue item runnable here.
 */

import { describe, expect, it } from 'vitest';
import { liveTurnKey } from '../../../shared/maestro-lib/client/live-turn';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type { LogEntryRecord } from '../../../shared/maestro-lib/store/transcript';
import {
	mergeHostedLogs,
	projectHostedSession,
	releaseHostedSession,
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
