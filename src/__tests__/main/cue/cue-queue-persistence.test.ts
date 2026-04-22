/**
 * Tests for cue-queue-persistence — Phase 12A.
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

	function makePersistence(opts?: { timeoutMs?: number; known?: string[]; now?: number }) {
		return createCueQueuePersistence({
			onLog,
			getSessionTimeoutMs: () => opts?.timeoutMs ?? 30 * 60 * 1000,
			knownSessionIds: () => new Set(opts?.known ?? ['s-1']),
			now: () => opts?.now ?? NOW,
		});
	}

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

			const restored = p.restoreAll();
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

		it('groups by session and preserves queuedAt ordering', () => {
			const p = makePersistence({ known: ['s-1', 's-2'] });
			p.persist('s-1', 'a', makeEntry({ subscriptionName: 'A', queuedAt: NOW - 100 }));
			p.persist('s-2', 'b', makeEntry({ subscriptionName: 'B', queuedAt: NOW - 150 }));
			p.persist('s-1', 'c', makeEntry({ subscriptionName: 'C', queuedAt: NOW - 50 }));

			const restored = p.restoreAll();
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
			expect(p.restoreAll().get('s-1')).toHaveLength(1);
		});

		it('is a no-op for unknown ids', () => {
			const p = makePersistence();
			expect(() => p.remove('nonexistent')).not.toThrow();
		});
	});

	describe('clear', () => {
		it("clearSession drops only that session's rows", () => {
			const p = makePersistence({ known: ['s-1', 's-2'] });
			p.persist('s-1', 'a', makeEntry());
			p.persist('s-2', 'b', makeEntry());
			p.clearSession('s-1');
			const restored = p.restoreAll();
			expect(restored.has('s-1')).toBe(false);
			expect(restored.get('s-2')).toHaveLength(1);
		});

		it('clearAll wipes every row', () => {
			const p = makePersistence({ known: ['s-1', 's-2'] });
			p.persist('s-1', 'a', makeEntry());
			p.persist('s-2', 'b', makeEntry());
			p.clearAll();
			expect(p.restoreAll().size).toBe(0);
		});
	});

	describe('restore filtering', () => {
		it('drops rows whose session is no longer registered', () => {
			const p = makePersistence({ known: ['s-1'] });
			p.persist('s-1', 'alive', makeEntry());
			p.persist('s-ghost', 'ghost', makeEntry());
			const restored = p.restoreAll();
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

		it('drops stale rows whose age exceeds session timeout, records timeout event', () => {
			const p = makePersistence({ timeoutMs: 10 * 60 * 1000, now: NOW });
			// Queued 20 minutes ago
			p.persist('s-1', 'stale', makeEntry({ queuedAt: NOW - 20 * 60 * 1000 }));
			const restored = p.restoreAll();
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
			});
			const restored = p.restoreAll();
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
			p.restoreAll();
			const restoredLogs = onLog.mock.calls.filter(
				(c) => c[2] && (c[2] as { type?: string }).type === 'queueRestored'
			);
			expect(restoredLogs).toHaveLength(2);
			expect(restoredLogs.map((l) => (l[2] as { count: number }).count).sort()).toEqual([1, 2]);
		});

		it('returns empty map when no rows exist', () => {
			const p = makePersistence();
			expect(p.restoreAll().size).toBe(0);
		});
	});
});
