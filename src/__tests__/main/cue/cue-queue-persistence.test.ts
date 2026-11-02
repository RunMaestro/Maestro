/**
 * Tests for cue-queue-persistence - Phase 12A.
 *
 * Uses the in-memory cue-db mirror to exercise round-trip + restore semantics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	createInMemoryCueDb,
	buildCueDbModuleMock,
	type InMemoryCueDb,
} from './cue-integration-test-helpers';

let sharedDb: InMemoryCueDb | null = null;
function getSharedDb(): InMemoryCueDb {
	if (!sharedDb) sharedDb = createInMemoryCueDb();
	return sharedDb;
}

vi.mock('../../../main/cue/cue-db', () => buildCueDbModuleMock(() => getSharedDb()));

import {
	createCueQueuePersistence,
	type PersistableQueueEntry,
} from '../../../main/cue/cue-queue-persistence';
import type { CueCommand, CueEvent } from '../../../main/cue/cue-types';

function makeEvent(type: CueEvent['type'] = 'time.heartbeat'): CueEvent {
	return {
		id: `evt-${Math.random().toString(36).slice(2, 8)}`,
		type,
		timestamp: new Date().toISOString(),
		triggerName: 'trigger',
		payload: { foo: 'bar' },
	};
}

// Use close-together NOW + queuedAt so the default staleness check doesn't
// treat every entry as expired. NOW is the "current time" the persistence
// sees; queuedAt defaults to NOW - 60s (within any reasonable timeout).
const NOW = 1_700_100_000_000;

function makeEntry(overrides: Partial<PersistableQueueEntry> = {}): PersistableQueueEntry {
	return {
		event: makeEvent(),
		subscriptionName: 'sub',
		prompt: 'run me',
		queuedAt: NOW - 60_000,
		chainDepth: 0,
		...overrides,
	};
}

describe('cue-queue-persistence', () => {
	let onLog: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		if (!sharedDb) sharedDb = createInMemoryCueDb();
		sharedDb.resetAll();
		sharedDb.initCueDb();
		onLog = vi.fn();
	});

	function makePersistence(opts?: {
		timeoutMs?: number;
		known?: string[];
		knownSubscriptions?: string[];
		now?: number;
	}) {
		return createCueQueuePersistence({
			onLog,
			getSessionTimeoutMs: () => opts?.timeoutMs ?? 30 * 60 * 1000,
			knownSessionIds: () => new Set(opts?.known ?? ['s-1']),
			...(opts?.knownSubscriptions
				? { knownSubscriptionNames: () => new Set(opts.knownSubscriptions) }
				: {}),
			now: () => opts?.now ?? NOW,
		});
	}

	it('acknowledges durable persistence without reading unrelated sessions', () => {
		const p = makePersistence();
		const db = getSharedDb(),
			originalRead = db.getQueuedEvents.bind(db);
		const read = vi.spyOn(db, 'getQueuedEvents').mockImplementation((id) => {
			if (id === undefined) throw Error('synthetic unrelated backlog unavailable');
			return originalRead(id);
		});
		try {
			expect(
				p.persist('s-1', 'bounded-readback', makeEntry({ event: makeEvent('plugin.event') }))
			).toBe(true);
		} finally {
			read.mockRestore();
		}
	});

	it('recovers a failed startup snapshot without including new writes and resets exclusions next start', () => {
		const p = makePersistence();
		p.persist('s-1', 'old', makeEntry({ event: makeEvent('plugin.event') }));
		p.beginRestoreEpoch();
		const read = vi.spyOn(getSharedDb(), 'getQueuedEvents');
		read.mockImplementationOnce(() => {
			throw Error('synthetic snapshot read failure');
		});
		expect(p.persistedIds(true)).toBeNull();
		p.persist('s-1', 'current', makeEntry({ event: makeEvent('plugin.event') }));
		expect(p.persistedIds(true)).toEqual(new Set(['old']));
		p.beginRestoreEpoch();
		expect(p.persistedIds(true)).toEqual(new Set(['old', 'current']));
		read.mockImplementationOnce(() => {
			throw Error('synthetic restore read failure');
		});
		expect(p.restoreAll(new Set(['old']))).toBeNull();
		expect(
			p
				.restoreAll(new Set(['old']))!
				.get('s-1')!
				.map((entry) => entry.persistId)
		).toEqual(['old']);
	});

	it('parks unsupported historical rows without stale/session cleanup or execution', () => {
		const p = makePersistence({ known: [], now: NOW + 999999999 });
		const event = { ...makeEvent('app.startup'), type: 'retired.source' } as unknown as CueEvent;
		p.persist('s-1', 'historical-parked', makeEntry({ event }));
		expect(p.restoreAll()!.size).toBe(0);
		p.clearSession('s-1');
		p.clearAll();
		expect(p.persistedIds()!.has('historical-parked')).toBe(true);
	});
	it('acknowledges plugin events only after a matching durable row can be read back', () => {
		const p = makePersistence();
		const event = makeEvent('plugin.event');
		expect(p.persist('s-1', 'mail-row', makeEntry({ event }))).toBe(true);
		expect(p.restoreAll()!.get('s-1')![0].event).toEqual(event);
		const write = vi.spyOn(getSharedDb(), 'persistQueuedEvent').mockImplementation(() => {});
		expect(p.persist('s-1', 'no-op-row', makeEntry({ event }))).toBe(false);
		write.mockImplementation(() => {
			throw new Error('Synthetic disk failure');
		});
		expect(p.persist('s-1', 'failed-row', makeEntry({ event }))).toBe(false);
		write.mockRestore();
	});
	describe('restoring only what a previous run left behind', () => {
		// The engine snapshots persistedIds() before sessions initialize. A row
		// persisted after that (this boot's own app.startup queued behind a
		// busy slot) is still live in memory, so restoring it would run it twice.
		it('restores only the ids in the snapshot and leaves later rows alone', () => {
			const p = makePersistence();
			p.persist('s-1', 'from-last-run', makeEntry({ subscriptionName: 'old' }));
			const before = p.persistedIds()!;
			p.persist('s-1', 'queued-this-boot', makeEntry({ subscriptionName: 'startup' }));

			const restored = p.restoreAll(before)!.get('s-1')!;
			expect(restored.map((e) => e.persistId)).toEqual(['from-last-run']);
			expect(p.persistedIds()!).toEqual(new Set(['from-last-run', 'queued-this-boot']));
		});

		it('restores every row when no snapshot is given', () => {
			const p = makePersistence();
			p.persist('s-1', 'a', makeEntry());
			p.persist('s-1', 'b', makeEntry());
			expect(p.restoreAll()!.get('s-1')).toHaveLength(2);
		});
	});

	describe('persist + restore round-trip', () => {
		it('round-trips all scalar + nested fields', () => {
			const p = makePersistence();
			const command: CueCommand = { mode: 'shell', shell: 'echo hi' };
			const entry = makeEntry({
				outputPrompt: 'then do this',
				cliOutput: { target: 'agent-x' },
				action: 'command',
				command,
				chainDepth: 2,
			});
			p.persist('s-1', 'pid-1', entry);

			const restored = p.restoreAll()!;
			expect(restored.size).toBe(1);
			const entries = restored.get('s-1')!;
			expect(entries).toHaveLength(1);
			expect(entries[0].persistId).toBe('pid-1');
			expect(entries[0].subscriptionName).toBe('sub');
			expect(entries[0].prompt).toBe('run me');
			expect(entries[0].outputPrompt).toBe('then do this');
			expect(entries[0].cliOutput).toEqual({ target: 'agent-x' });
			expect(entries[0].action).toBe('command');
			expect(entries[0].command).toEqual({ mode: 'shell', shell: 'echo hi' });
			expect(entries[0].chainDepth).toBe(2);
			expect(entries[0].event.type).toBe('time.heartbeat');
		});

		it('round-trips the model choice so a restored run keeps its tier / model / effort', () => {
			const p = makePersistence();
			p.persist('s-1', 'pid-tier', makeEntry({ turnSettings: { tier: 'high', effort: 'low' } }));
			p.persist('s-1', 'pid-model', makeEntry({ turnSettings: { model: 'gpt-5.5-codex' } }));
			p.persist('s-1', 'pid-none', makeEntry());

			const entries = p.restoreAll()!.get('s-1')!;
			const byId = new Map(entries.map((e) => [e.persistId, e]));
			expect(byId.get('pid-tier')!.turnSettings).toEqual({ tier: 'high', effort: 'low' });
			expect(byId.get('pid-model')!.turnSettings).toEqual({ model: 'gpt-5.5-codex' });
			expect(byId.get('pid-none')!.turnSettings).toBeUndefined();
		});

		it('restores a row persisted before turn_settings_json existed', () => {
			const p = makePersistence();
			// Pre-column row: the field is absent rather than null.
			getSharedDb().persistQueuedEvent({
				id: 'legacy',
				sessionId: 's-1',
				subscriptionName: 'sub',
				eventJson: JSON.stringify(makeEvent()),
				prompt: 'p',
				outputPrompt: null,
				cliOutputJson: null,
				action: null,
				commandJson: null,
				chainDepth: 0,
				queuedAt: NOW - 1000,
				chainRootId: null,
				parentEventId: null,
			});

			const entries = p.restoreAll()!.get('s-1')!;
			expect(entries).toHaveLength(1);
			expect(entries[0].turnSettings).toBeUndefined();
		});

		it('round-trips chain lineage (chainRootId + parentEventId) through the queue table', () => {
			const p = makePersistence();
			p.persist(
				's-1',
				'pid-root',
				makeEntry({
					subscriptionName: 'root',
					queuedAt: NOW - 100,
				})
			);
			p.persist(
				's-1',
				'pid-child',
				makeEntry({
					subscriptionName: 'child',
					queuedAt: NOW - 50,
					chainRootId: 'run-root',
					parentEventId: 'run-root',
				})
			);

			const restored = p.restoreAll()!.get('s-1')!;
			const root = restored.find((e) => e.subscriptionName === 'root')!;
			const child = restored.find((e) => e.subscriptionName === 'child')!;
			// Root rows persisted without lineage come back undefined (matches
			// the "queued before usageStats was enabled" / Phase 01-root case).
			expect(root.chainRootId).toBeUndefined();
			expect(root.parentEventId).toBeUndefined();
			// Children round-trip the lineage so resumed runs stay attached
			// to their chain root after a crash.
			expect(child.chainRootId).toBe('run-root');
			expect(child.parentEventId).toBe('run-root');
		});

		// A queued `action: autorun` run launches from the payload captured when
		// it was scheduled. Losing it across a restart leaves a run with no
		// documents, which fails to launch a schedule nobody is watching.
		it('round-trips the Auto Run payload through the queue table', () => {
			const p = makePersistence();
			const autoRun = {
				documents: ['/repo/.maestro/playbooks/ship-it.md'],
				reset_on_completion: [true],
				prompt: 'work the list',
				loop_enabled: true,
				max_loops: 3,
				model: 'opus',
			};
			p.persist('s-1', 'pid-autorun', makeEntry({ action: 'autorun', autoRun }));
			p.persist('s-1', 'pid-prompt', makeEntry({ subscriptionName: 'plain' }));

			const restored = p.restoreAll()!.get('s-1')!;
			expect(restored.find((e) => e.action === 'autorun')!.autoRun).toEqual(autoRun);
			expect(restored.find((e) => e.subscriptionName === 'plain')!.autoRun).toBeUndefined();
		});

		// The message of a queued notify also rides the `prompt` slot, but
		// `sticky` lives only here. Losing it turned a toast the user asked to
		// stay on screen into one that dismissed itself after a restart.
		it('round-trips the notify config through the queue table', () => {
			const p = makePersistence();
			const notify = { message: 'Deploy finished', sticky: true };
			p.persist('s-1', 'pid-notify', makeEntry({ action: 'notify', notify }));
			p.persist('s-1', 'pid-prompt', makeEntry({ subscriptionName: 'plain' }));

			const restored = p.restoreAll()!.get('s-1')!;
			expect(restored.find((e) => e.action === 'notify')!.notify).toEqual(notify);
			expect(restored.find((e) => e.subscriptionName === 'plain')!.notify).toBeUndefined();
		});

		it('drops a row whose Auto Run payload is not valid JSON', () => {
			const p = makePersistence();
			getSharedDb().persistQueuedEvent({
				id: 'bad-autorun',
				sessionId: 's-1',
				subscriptionName: 'scheduled',
				eventJson: JSON.stringify(makeEvent()),
				prompt: '',
				outputPrompt: null,
				cliOutputJson: null,
				action: 'autorun',
				commandJson: null,
				chainDepth: 0,
				queuedAt: NOW - 1000,
				chainRootId: null,
				parentEventId: null,
				autoRunJson: '{not json',
			});

			expect(p.restoreAll()!.size).toBe(0);
			expect(getSharedDb().getQueuedEvents()).toHaveLength(0);
		});

		it('groups by session and preserves queuedAt ordering', () => {
			const p = makePersistence({ known: ['s-1', 's-2'] });
			p.persist('s-1', 'a', makeEntry({ subscriptionName: 'A', queuedAt: NOW - 100 }));
			p.persist('s-2', 'b', makeEntry({ subscriptionName: 'B', queuedAt: NOW - 150 }));
			p.persist('s-1', 'c', makeEntry({ subscriptionName: 'C', queuedAt: NOW - 50 }));

			const restored = p.restoreAll()!;
			expect(restored.get('s-1')?.map((e) => e.subscriptionName)).toEqual(['A', 'C']);
			expect(restored.get('s-2')?.map((e) => e.subscriptionName)).toEqual(['B']);
		});
	});

	describe('remove', () => {
		it('removes a specific row', () => {
			const p = makePersistence();
			p.persist('s-1', 'pid-1', makeEntry());
			p.persist('s-1', 'pid-2', makeEntry());
			p.remove('pid-1');
			expect(p.restoreAll()!.get('s-1')).toHaveLength(1);
		});

		it('is a no-op for unknown ids', () => {
			const p = makePersistence();
			expect(() => p.remove('nonexistent')).not.toThrow();
		});
	});

	describe('clear', () => {
		it.each(['all', 'session'])(
			'preserves acknowledged plugin rows across %s lifecycle clearing, then restores once',
			(scope) => {
				const p = makePersistence({ known: ['s-1', 's-2'] });
				const event = makeEvent('plugin.event');
				expect(p.persist('s-1', 'durable', makeEntry({ event }))).toBe(true);
				p.persist('s-1', 'ordinary', makeEntry());
				p.persist('s-2', 'other', makeEntry());
				if (scope === 'all') p.clearAll();
				else p.clearSession('s-1');
				expect(p.persistedIds()!.has('durable')).toBe(true);
				expect(p.persistedIds()!.has('ordinary')).toBe(false);
				expect(p.persistedIds()!.has('other')).toBe(scope !== 'all');
				expect(p.restoreAll()!.get('s-1')).toEqual([
					expect.objectContaining({ persistId: 'durable', event }),
				]);
				p.remove('durable');
				expect(p.restoreAll()!.has('s-1')).toBe(false);
			}
		);

		it("clearSession drops only that session's rows", () => {
			const p = makePersistence({ known: ['s-1', 's-2'] });
			p.persist('s-1', 'a', makeEntry());
			p.persist('s-2', 'b', makeEntry());
			p.clearSession('s-1');
			const restored = p.restoreAll()!;
			expect(restored.has('s-1')).toBe(false);
			expect(restored.get('s-2')).toHaveLength(1);
		});

		it('clearAll wipes every row', () => {
			const p = makePersistence({ known: ['s-1', 's-2'] });
			p.persist('s-1', 'a', makeEntry());
			p.persist('s-2', 'b', makeEntry());
			p.clearAll();
			expect(p.restoreAll()!.size).toBe(0);
		});
	});

	describe('restore filtering', () => {
		it('drops rows whose session is no longer registered', () => {
			const p = makePersistence({ known: ['s-1'] });
			p.persist('s-1', 'alive', makeEntry());
			p.persist('s-ghost', 'ghost', makeEntry());
			const restored = p.restoreAll()!;
			expect(restored.size).toBe(1);
			expect(restored.has('s-ghost')).toBe(false);
			// Warn was logged with queueDropped payload (no sessionId for aggregate)
			const dropped = onLog.mock.calls.find(
				(c) => c[2] && (c[2] as { type?: string }).type === 'queueDropped'
			);
			expect(dropped?.[2]).toMatchObject({ reason: 'session-missing' });
			expect((dropped?.[2] as { sessionId?: unknown }).sessionId).toBeUndefined();
			// Missing-session drops ALSO get recorded in cue_events for audit.
			// Status is persisted as a valid CueRunStatus ('timeout'); the
			// precise reason lives in the payload so the status column keeps
			// matching its typed union downstream.
			const events = getSharedDb().getRecentCueEvents(0);
			const ghostEvent = events.find((e) => e.id === 'ghost');
			expect(ghostEvent?.status).toBe('timeout');
			expect(JSON.parse(ghostEvent?.payload ?? '{}')).toMatchObject({
				droppedFromQueue: true,
				reason: 'session-missing',
			});
		});

		it('drops rows whose subscription is in no agent config, and records why', () => {
			const p = makePersistence({ known: ['s-1'], knownSubscriptions: ['kept'] });
			p.persist('s-1', 'alive', makeEntry({ subscriptionName: 'kept' }));
			p.persist('s-1', 'orphan', makeEntry({ subscriptionName: 'removed-by-import' }));

			const restored = p.restoreAll()!;

			expect(restored.get('s-1')?.map((e) => e.persistId)).toEqual(['alive']);
			expect(
				getSharedDb()
					.getQueuedEvents()
					.map((row) => row.id)
			).toEqual(['alive']);
			expect(onLog).toHaveBeenCalledWith(
				'warn',
				expect.stringContaining('whose subscription is no longer in any agent'),
				{ type: 'queueDropped', count: 1, reason: 'subscription-missing' }
			);
			const orphan = getSharedDb()
				.getRecentCueEvents(0)
				.find((e) => e.id === 'orphan');
			expect(JSON.parse(orphan?.payload ?? '{}')).toMatchObject({
				droppedFromQueue: true,
				reason: 'subscription-missing',
			});
		});

		it("keeps a fan-out row whose subscription lives in another agent's config", () => {
			// The target agent's own config has no `owner-fanout`; the owner's does,
			// and the names are checked across every agent.
			const p = makePersistence({
				known: ['s-1', 's-target'],
				knownSubscriptions: ['owner-fanout'],
			});
			p.persist('s-target', 'fanout', makeEntry({ subscriptionName: 'owner-fanout' }));

			expect(
				p
					.restoreAll()!
					.get('s-target')
					?.map((e) => e.persistId)
			).toEqual(['fanout']);
		});

		it('skips the subscription check when the dep is omitted', () => {
			const p = makePersistence({ known: ['s-1'] });
			p.persist('s-1', 'any', makeEntry({ subscriptionName: 'whatever' }));

			expect(p.restoreAll()!.get('s-1')).toHaveLength(1);
		});

		it('restores an acknowledged old plugin row while ordinary rows still expire', () => {
			const p = makePersistence({ timeoutMs: 60_000, now: NOW });
			p.persist(
				's-1',
				'durable-old',
				makeEntry({ event: makeEvent('plugin.event'), queuedAt: NOW - 86_400_000 })
			);
			p.persist('s-1', 'ordinary-old', makeEntry({ queuedAt: NOW - 86_400_000 }));
			expect(
				p
					.restoreAll()!
					.get('s-1')
					?.map((entry) => entry.persistId)
			).toEqual(['durable-old']);
			expect(p.persistedIds()!.has('durable-old')).toBe(true);
			expect(p.persistedIds()!.has('ordinary-old')).toBe(false);
		});

		it('drops stale rows whose age exceeds session timeout, records timeout event', () => {
			const p = makePersistence({ timeoutMs: 10 * 60 * 1000, now: NOW });
			// Queued 20 minutes ago
			p.persist('s-1', 'stale', makeEntry({ queuedAt: NOW - 20 * 60 * 1000 }));
			const restored = p.restoreAll()!;
			expect(restored.size).toBe(0);
			// cue_events has a timeout row for the dropped entry. Status is
			// 'timeout' (a valid CueRunStatus); reason goes in the payload.
			const events = getSharedDb().getRecentCueEvents(0);
			const staleEvent = events.find((e) => e.id === 'stale');
			expect(staleEvent?.status).toBe('timeout');
			expect(JSON.parse(staleEvent?.payload ?? '{}')).toMatchObject({
				droppedFromQueue: true,
				reason: 'stale',
			});
			const dropped = onLog.mock.calls.find(
				(c) => c[2] && (c[2] as { type?: string }).type === 'queueDropped'
			);
			expect(dropped?.[2]).toMatchObject({ reason: 'stale' });
		});

		it('drops malformed rows, logs queueDropped malformed, removes them from DB', () => {
			const p = makePersistence();
			// Inject a row with bad JSON directly into the underlying DB.
			getSharedDb().persistQueuedEvent({
				id: 'bad',
				sessionId: 's-1',
				subscriptionName: 'corrupt',
				eventJson: '{not json',
				prompt: 'p',
				outputPrompt: null,
				cliOutputJson: null,
				action: null,
				commandJson: null,
				chainDepth: 0,
				queuedAt: NOW - 1000,
				chainRootId: null,
				parentEventId: null,
			});
			const restored = p.restoreAll()!;
			expect(restored.size).toBe(0);
			// Live queue row removed; cue_events audit row recorded.
			expect(
				getSharedDb()
					.getQueuedEvents()
					.filter((r) => r.id === 'bad')
			).toHaveLength(0);
			const dropped = onLog.mock.calls.find(
				(c) => c[2] && (c[2] as { type?: string }).type === 'queueDropped'
			);
			expect(dropped?.[2]).toMatchObject({ reason: 'malformed' });
			const events = getSharedDb().getRecentCueEvents(0);
			const badEvent = events.find((e) => e.id === 'bad');
			expect(badEvent?.status).toBe('timeout');
			expect(JSON.parse(badEvent?.payload ?? '{}')).toMatchObject({
				droppedFromQueue: true,
				reason: 'malformed',
			});
		});

		it('emits queueRestored per session with correct count', () => {
			const p = makePersistence({ known: ['s-1', 's-2'] });
			p.persist('s-1', 'a', makeEntry());
			p.persist('s-1', 'b', makeEntry());
			p.persist('s-2', 'c', makeEntry());
			p.restoreAll()!;
			const restoredLogs = onLog.mock.calls.filter(
				(c) => c[2] && (c[2] as { type?: string }).type === 'queueRestored'
			);
			expect(restoredLogs).toHaveLength(2);
			expect(restoredLogs.map((l) => (l[2] as { count: number }).count).sort()).toEqual([1, 2]);
		});

		it('returns empty map when no rows exist', () => {
			const p = makePersistence();
			expect(p.restoreAll()!.size).toBe(0);
		});
	});

	describe('rows a drain deferred', () => {
		const timeoutMs = 30 * 60 * 1000;

		it('measures age while an engine was up, not the downtime, and rebases queuedAt', () => {
			const p = makePersistence({ timeoutMs });
			// Queued 5 minutes before the drain, restored 5 hours later.
			const drainedAt = NOW - 5 * 60 * 60 * 1000;
			p.persist('s-1', 'deferred', makeEntry({ queuedAt: drainedAt - 5 * 60_000, drainedAt }));

			const [entry] = p.restoreAll()!.get('s-1')!;
			expect(entry.persistId).toBe('deferred');
			expect(entry.drainedAt).toBe(drainedAt);
			expect(entry.queuedAt).toBe(NOW - 5 * 60_000);
			// The stamp is the module's; the event itself never carries it.
			expect(entry.event).not.toHaveProperty('maestroDrainedAt');
		});

		it('still drops a deferred row that was already stale when the engine stopped', () => {
			const p = makePersistence({ timeoutMs });
			const drainedAt = NOW - 60_000;
			p.persist('s-1', 'old', makeEntry({ queuedAt: drainedAt - 31 * 60_000, drainedAt }));
			expect(p.restoreAll()!.size).toBe(0);
		});

		it('keeps the wall-clock rule for an unstamped row of the same age', () => {
			const p = makePersistence({ timeoutMs });
			p.persist('s-1', 'crash', makeEntry({ queuedAt: NOW - 5 * 60 * 60 * 1000 - 5 * 60_000 }));
			expect(p.restoreAll()!.size).toBe(0);
		});
	});
});
