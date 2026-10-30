import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryDatabase } from '../../../main/pianola/memory-database';
import {
	memoryIsEligible,
	validateMemoryRecallIntent,
} from '../../../main/pianola/memory-lifecycle';
import type { ContextualMemory, MemoryRecallIntent } from '../../../shared/pianola/memory';

const now = '2026-09-15T00:00:00.000Z';
const queryVector = new Float32Array(384);
queryVector[0] = 1;
const orthogonal = new Float32Array(384);
orthogonal[1] = 1;
let db: MemoryDatabase;
let dir: string;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date(now));
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-lifecycle-'));
	db = new MemoryDatabase(path.join(dir, 'memory.sqlite'));
});
afterEach(() => {
	db?.db.close();
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
	vi.useRealTimers();
});
function memory(id: string, changes: Partial<ContextualMemory> = {}): ContextualMemory {
	return {
		id,
		userId: 'owner',
		projectId: 'project',
		kind: 'decision',
		text: 'Synthetic palette ' + id,
		rationale: '',
		alternatives: [],
		support: 'explicit',
		status: 'current',
		validFrom: '2026-09-01T00:00:00.000Z',
		validTo: null,
		learnedAt: 1,
		pinned: false,
		related: [],
		supersedes: null,
		evidence: [
			{
				id: 'e-' + id,
				sourceId: 'explicit:' + id,
				messageId: id,
				role: 'user',
				text: 'Synthetic supported palette assertion',
				timestamp: null,
				attribution: 'human',
				durability: 'durable',
			},
		],
		...changes,
	};
}
function ids(intent: MemoryRecallIntent, limit = 80, query = 'palette') {
	return db
		.retrieveCandidates('owner', 'project', query, queryVector, intent, limit)
		.map((candidate) => candidate.memory.id)
		.sort();
}

test('canonical alternatives remain discoverable before bounded vector limits and after legacy-index repair', () => {
	for (let i = 0; i < 12; i++) db.store(memory('distractor-' + i), queryVector);
	const target = memory('choice', {
		text: 'Choose Arbor for the project store.',
		alternatives: ['src/persistence/oak-driver.ts'],
	});
	db.store(target, orthogonal);
	const query = 'Was src/persistence/oak-driver.ts considered?';
	expect(ids({ mode: 'current' }, 4, query)).toContain('choice');
	const original = db.db.prepare('SELECT uuid,data FROM memories ORDER BY id').all();
	const identities = db.db.prepare('SELECT rowid,scope FROM memory_fts ORDER BY rowid').all();
	db.db
		.prepare(
			"UPDATE memory_fts SET text='Choose Arbor for the project store.' WHERE rowid=(SELECT id FROM memories WHERE uuid='choice')"
		)
		.run();
	db.db.prepare("DELETE FROM metadata WHERE key='lexicalFactsVersion'").run();
	db.close();
	db = new MemoryDatabase(path.join(dir, 'memory.sqlite'));
	expect(ids({ mode: 'current' }, 4, query)).toContain('choice');
	expect(db.db.prepare('SELECT uuid,data FROM memories ORDER BY id').all()).toEqual(original);
	expect(db.db.prepare('SELECT rowid,scope FROM memory_fts ORDER BY rowid').all()).toEqual(
		identities
	);
});

test('derived evidence verdicts are rebuilt when the classification rules change', () => {
	const session = memory('session', {
		evidence: [
			{
				id: 'e-session',
				sourceId: 'explicit:session',
				messageId: 'session',
				role: 'user',
				text: 'For this session only, use orange headings.',
				timestamp: null,
				attribution: 'human',
				durability: 'session',
			},
		],
	});
	db.store(session, queryVector);
	const durable = memory('durable');
	db.store(durable, queryVector);
	expect(ids({ mode: 'current' })).toEqual(['durable']);
	// Simulate evidence stored under an older rule set: the derived verdict is stale.
	db.db.prepare('UPDATE evidence SET derived_session=0, derived_timebound=0').run();
	db.db.prepare("DELETE FROM metadata WHERE key='derivedEvidenceVersion'").run();
	expect(ids({ mode: 'current' })).toEqual(['durable', 'session']);
	db.close();
	db = new MemoryDatabase(path.join(dir, 'memory.sqlite'));
	expect(ids({ mode: 'current' })).toEqual(['durable']);
});

test('each lifecycle selector has an isolated native SQL status/time contract', () => {
	const rows = [
		memory('current'),
		memory('old', { status: 'superseded', validTo: '2026-09-10T00:00:00.000Z' }),
		memory('expired', { validTo: '2026-09-10T00:00:00.000Z' }),
		memory('proposal', { status: 'proposed' }),
		memory('conflict', { status: 'contested' }),
		memory('future', { validFrom: '2027-01-01T00:00:00.000Z', pinned: true }),
		memory('ended-proposal', { status: 'proposed', validTo: '2026-09-10T00:00:00.000Z' }),
	];
	for (const row of rows) db.store(row, queryVector);
	const cases: [MemoryRecallIntent, string[]][] = [
		[{ mode: 'current' }, ['current']],
		[{ mode: 'previous' }, ['expired', 'old']],
		[{ mode: 'proposed' }, ['proposal']],
		[{ mode: 'contested' }, ['conflict']],
		[{ mode: 'as-of', at: '2026-09-05T00:00:00.000Z' }, ['current', 'expired', 'old']],
		[{ mode: 'history' }, ['conflict', 'current', 'ended-proposal', 'expired', 'old', 'proposal']],
	];
	for (const [intent, expected] of cases) {
		expect(ids(intent)).toEqual(expected);
		expect(
			rows
				.filter((row) => memoryIsEligible(row, intent))
				.map((row) => row.id)
				.sort()
		).toEqual(expected);
	}
	// Broad history browsing is a deliberately different list operation.
	expect(db.list('owner', 'project', true).map((row) => row.id)).toContain('future');
});

test('as-of uses half-open millisecond epoch boundaries and approved predecessors only', () => {
	const row = memory('epoch', {
		status: 'superseded',
		validFrom: '1970-01-01T00:00:00.000Z',
		validTo: '1970-01-01T00:00:00.001Z',
	});
	db.store(row, queryVector);
	db.store(memory('proposal', { status: 'proposed', validFrom: null }), queryVector);
	for (const [at, expected] of [
		['1969-12-31T23:59:59.999Z', []],
		['1970-01-01T00:00:00.000Z', ['epoch']],
		['1970-01-01T00:00:00.001Z', []],
	] as [string, string[]][]) {
		expect(ids({ mode: 'as-of', at })).toEqual(expected);
		expect(memoryIsEligible(row, { mode: 'as-of', at })).toBe(expected.length === 1);
	}
});

test('pins cannot bypass user/project exclusions, quarantine, provenance, time or status before limits', () => {
	const allowed = memory('allowed');
	db.store(allowed, orthogonal);
	for (let i = 0; i < 12; i++) {
		db.store(memory('other-' + i, { userId: 'someone-else', pinned: true }), queryVector);
		db.store(memory('project-' + i, { projectId: 'other-project', pinned: true }), queryVector);
		db.store(memory('proposal-' + i, { status: 'proposed', pinned: true }), queryVector);
		db.store(
			memory('future-' + i, { validFrom: '2027-01-01T00:00:00.000Z', pinned: true }),
			queryVector
		);
		db.store(memory('excluded-' + i, { pinned: true }), queryVector);
		db.db.prepare('UPDATE memories SET excluded=1 WHERE uuid=?').run('excluded-' + i);
		db.store(memory('quarantined-' + i, { pinned: true }), queryVector);
		db.quarantine('quarantined-' + i, 'owner', 'synthetic quarantine');
		const contaminated = memory('bad-' + i, { pinned: true });
		contaminated.evidence[0].sourceId = 'untrusted-native';
		db.store(contaminated, queryVector);
	}
	expect(ids({ mode: 'current' }, 1)).toEqual(['allowed']);
});

test('shortlist shares capacity across scopes/channels with unique IDs and true ordinal ranks', () => {
	for (const projectId of ['project', null]) {
		for (let i = 0; i < 12; i++) {
			db.store(
				memory('lex-' + projectId + '-' + i, { projectId, text: 'palette unique token ' + i }),
				orthogonal
			);
			db.store(
				memory('vec-' + projectId + '-' + i, { projectId, text: 'Chromatic plan synonym ' + i }),
				queryVector
			);
		}
	}
	const candidates = db.retrieveCandidates(
		'owner',
		'project',
		'What is the palette?',
		queryVector,
		{ mode: 'current' },
		8
	);
	expect(new Set(candidates.map((c) => c.memory.id)).size).toBe(8);
	for (const scope of ['project', null]) {
		const scoped = candidates.filter((c) => c.memory.projectId === scope);
		expect(scoped).toHaveLength(4);
		expect(scoped.filter((c) => c.lexicalRank !== undefined)).toHaveLength(2);
		expect(scoped.filter((c) => c.vectorRank !== undefined)).toHaveLength(2);
		for (const candidate of scoped) {
			if (candidate.lexicalRank !== undefined)
				expect(Number.isInteger(candidate.lexicalRank)).toBe(true);
			if (candidate.vectorRank !== undefined)
				expect(Number.isInteger(candidate.vectorRank)).toBe(true);
		}
	}
});

test('question scaffolding does not consume lexical slots and vector-only queries remain retrievable', () => {
	db.store(memory('meaning', { text: 'Chromatic planning convention' }), queryVector);
	db.store(memory('scaffold', { text: 'What is the how and why' }), orthogonal);
	const rows = db.retrieveCandidates(
		'owner',
		'project',
		'What is the?',
		queryVector,
		{ mode: 'current' },
		1
	);
	expect(rows.map((row) => row.memory.id)).toEqual(['meaning']);
	expect(rows[0].lexicalRank).toBeUndefined();
	expect(rows[0].vectorRank).toBe(0);
});

test('untrusted intent rejects conflicting selectors, unknown modes and invalid as-of dates', () => {
	for (const invalid of [
		null,
		[],
		{},
		{ mode: 'all' },
		{ mode: 'as-of' },
		{ mode: 'current', at: now },
		{ mode: 'history', includeHistory: true },
		{ mode: 'as-of', at: 'not-a-date' },
		{ mode: 'as-of', at: '2024-02-30' },
		{ mode: 'as-of', at: '2026-09-15T00:00:00' },
		{ mode: 'as-of', at: '2026-09-15T24:00:00Z' },
		{ mode: ['current', 'proposed'] },
	]) {
		expect(() => validateMemoryRecallIntent(invalid)).toThrow();
		expect(() =>
			db.retrieveCandidates(
				'owner',
				'project',
				'palette',
				queryVector,
				invalid as MemoryRecallIntent
			)
		).toThrow();
	}
	expect(validateMemoryRecallIntent({ mode: 'as-of', at: '1970-01-01T01:00:00+01:00' })).toEqual({
		mode: 'as-of',
		at: '1970-01-01T00:00:00.000Z',
	});
});
