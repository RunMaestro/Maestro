import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryDatabase } from '../../../main/pianola/memory-database';
import { MemoryModels } from '../../../main/pianola/memory-models';
import type { ContextualMemory, MemoryEvidence } from '../../../shared/pianola/memory';
import { memoryIsEligible } from '../../../main/pianola/memory-lifecycle';

const fixtures = path.resolve('synthetic-validity');
const databases: { bank: MemoryDatabase; dir: string }[] = [];
function bank() {
	fs.mkdirSync(fixtures, { recursive: true });
	const dir = fs.mkdtempSync(path.join(fixtures, 'case-'));
	const bank = new MemoryDatabase(path.join(dir, 'memory.sqlite'));
	databases.push({ bank, dir });
	return bank;
}
afterEach(() => {
	for (const { bank, dir } of databases.splice(0)) {
		bank.db.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
const vector = new Float32Array(384);
vector[0] = 1;
function evidence(id: string, timestamp = '2026-09-01T00:00:00.000Z'): MemoryEvidence {
	return {
		id,
		sourceId: 'explicit:' + id,
		messageId: id,
		role: 'user',
		text: 'Synthetic version choice',
		timestamp,
		attribution: 'human',
	};
}
function memory(id: string, changes: Partial<ContextualMemory> = {}): ContextualMemory {
	return {
		id,
		userId: 'synthetic-user',
		projectId: 'synthetic-project',
		kind: 'decision',
		text: 'Use major version',
		rationale: '',
		alternatives: [],
		support: 'inferred',
		status: 'current',
		validFrom: '2026-09-01T00:00:00.000Z',
		validTo: null,
		learnedAt: 1,
		pinned: false,
		evidence: [evidence(id)],
		related: [],
		supersedes: null,
		...changes,
	};
}

test('canonical duplicate deliberately upgrades supported metadata and stable identity', () => {
	const db = bank();
	db.store(memory('canonical'), vector);
	const incoming = memory('incoming', {
		support: 'explicit',
		rationale: 'User gave a reason',
		alternatives: ['Other version'],
		pinned: true,
		validFrom: '2026-09-02T00:00:00.000Z',
		validTo: '2026-10-01T00:00:00.000Z',
		evidence: [evidence('incoming', '2026-09-02T00:00:00.000Z')],
	});
	assert.equal(db.store(incoming, vector), 'canonical');
	const stored = db.find('canonical')!;
	assert.equal(stored.support, 'explicit');
	assert.equal(stored.rationale, incoming.rationale);
	assert.deepEqual(stored.alternatives, incoming.alternatives);
	assert.equal(stored.pinned, true);
	assert.equal(stored.validFrom, incoming.validFrom);
	assert.equal(stored.validTo, incoming.validTo);
	assert.deepEqual(stored.evidence.map((e) => e.id).sort(), ['canonical', 'incoming']);
});

test('major to minor correction links, retires and is atomic through actual store', () => {
	const db = bank();
	db.store(memory('major', { support: 'explicit' }), vector);
	db.store(
		memory('minor', {
			text: 'Use later minor version',
			support: 'explicit',
			validFrom: '2026-09-02T00:00:00.000Z',
			supersedes: 'major',
		}),
		vector
	);
	assert.equal(db.find('major')!.status, 'superseded');
	assert.equal(db.find('major')!.validTo, '2026-09-02T00:00:00.000Z');
	assert.equal(db.find('minor')!.status, 'current');
	assert.deepEqual(db.db.prepare('SELECT from_id,to_id,kind FROM relationships').all(), [
		{ from_id: 'minor', to_id: 'major', kind: 'supersedes' },
	]);
});

test('unapproved canonical proposal cannot become or replace approval', () => {
	const db = bank();
	db.store(memory('approved', { support: 'explicit' }), vector);
	db.store(
		memory('proposal', {
			status: 'proposed',
			support: 'explicit',
			validFrom: '2026-09-02T00:00:00.000Z',
			supersedes: 'approved',
		}),
		vector
	);
	assert.equal(db.find('approved')!.status, 'current');
	assert.equal(db.find('proposal')!.status, 'proposed');
	assert.equal(
		(
			db.db.prepare("SELECT count(*) n FROM relationships WHERE kind='supersedes'").get() as {
				n: number;
			}
		).n,
		0
	);
});

test('verification rejects unsupported contradiction metadata', () => {
	const models = Object.create(MemoryModels.prototype) as MemoryModels;
	const result = models.verified(
		[
			{
				kind: 'decision',
				support: 'explicit',
				status: 'current',
				supersedes: 'old',
				contradicts: ['old'],
			},
		],
		[
			{
				index: 0,
				supported: true,
				rationaleSupported: true,
				authoredByUser: true,
				correctionSupported: false,
				duplicateSupported: false,
				validitySupported: false,
				observedEvidenceSupported: false,
				scope: 'target-project',
				durability: 'durable',
			},
		]
	) as { contradicts: string[]; supersedes: null }[];
	assert.deepEqual(result[0].contradicts, []);
	assert.equal(result[0].supersedes, null);
});

test('default and explicit as-of enforce half-open validity and unresolved modality', () => {
	const now = Date.parse('2026-09-15T00:00:00.000Z');
	const current = memory('eligible', {
		validFrom: '2026-09-15T00:00:00.000Z',
		validTo: '2026-09-16T00:00:00.000Z',
	});
	assert.equal(memoryIsEligible(current, { mode: 'current' }, now), true);
	assert.equal(memoryIsEligible(current, { mode: 'current' }, now - 1), false);
	assert.equal(memoryIsEligible(current, { mode: 'current' }, Date.parse(current.validTo!)), false);
	for (const status of ['proposed', 'contested', 'superseded'] as const)
		assert.equal(memoryIsEligible({ ...current, status }, { mode: 'current' }, now), false);
	assert.equal(
		memoryIsEligible(
			{ ...current, status: 'superseded' },
			{ mode: 'as-of', at: current.validFrom! }
		),
		true
	);
	assert.equal(
		memoryIsEligible({ ...current, status: 'proposed' }, { mode: 'as-of', at: current.validFrom! }),
		false
	);
	assert.equal(
		memoryIsEligible({ ...current, status: 'proposed' }, { mode: 'history' }, now + 1e10),
		true
	);
	assert.equal(memoryIsEligible(current, { mode: 'as-of', at: current.validTo! }), false);
	assert.throws(() => memoryIsEligible(current, { mode: 'as-of', at: 'not-a-date' }), /as-of/);
});

test('semantic duplicate preserves incoming metadata without conflating kinds or proposals', () => {
	const models = Object.create(MemoryModels.prototype) as MemoryModels;
	const old = memory('old');
	const candidate = {
		text: 'Same assertion differently phrased',
		kind: 'decision',
		rationale: 'New literal reason',
		alternatives: ['Alternative'],
		support: 'explicit',
		status: 'current',
		global: false,
		evidence: [{ id: 'new', quote: 'Synthetic version choice' }],
		contradicts: [],
		supersedes: null,
		duplicateOf: 'old',
		validFrom: '2026-09-02T00:00:00.000Z',
		validTo: '2026-09-30T00:00:00.000Z',
	};
	const result = models.validate(
		[candidate],
		[evidence('new', '2026-09-02T00:00:00.000Z')],
		old.userId,
		old.projectId!,
		[old]
	)[0];
	assert.equal(result.duplicateOf, 'old');
	assert.equal(result.support, 'explicit');
	assert.equal(result.rationale, candidate.rationale);
	assert.equal(result.validTo, candidate.validTo);
	const db = bank();
	db.store(old, vector);
	assert.equal(db.store(result, vector), 'old');
	assert.equal(db.find('old')!.text, old.text);
	assert.equal(db.find('old')!.rationale, candidate.rationale);
	assert.equal(
		models.validate(
			[{ ...candidate, kind: 'project' }],
			[evidence('new')],
			old.userId,
			old.projectId!,
			[old]
		)[0].duplicateOf,
		undefined
	);
	assert.equal(
		models.validate(
			[{ ...candidate, status: 'proposed' }],
			[evidence('new')],
			old.userId,
			old.projectId!,
			[old]
		)[0].status,
		'proposed'
	);
});

test('stale or weaker duplicate retains later supported metadata while adding evidence', () => {
	const db = bank();
	db.store(
		memory('later', {
			support: 'explicit',
			rationale: 'Latest reason',
			pinned: true,
			validFrom: '2026-09-03T00:00:00.000Z',
		}),
		vector
	);
	db.store(
		memory('earlier', {
			support: 'explicit',
			rationale: 'Obsolete reason',
			alternatives: ['Stale option'],
			validFrom: '2026-09-01T00:00:00.000Z',
		}),
		vector
	);
	db.store(
		memory('weak', {
			support: 'unverified',
			rationale: 'Unverified reason',
			validFrom: '2026-09-04T00:00:00.000Z',
		}),
		vector
	);
	const stored = db.find('later')!;
	assert.equal(stored.rationale, 'Latest reason');
	assert.equal(stored.support, 'explicit');
	assert.equal(stored.pinned, true);
	assert.equal(stored.validFrom, '2026-09-03T00:00:00.000Z');
	assert.deepEqual(stored.alternatives, []);
	assert.deepEqual(stored.evidence.map((e) => e.id).sort(), ['earlier', 'later', 'weak']);
});

test('proposal correction links versions without inventing approval', () => {
	const models = Object.create(MemoryModels.prototype) as MemoryModels;
	const old = memory('major-proposal', { status: 'proposed', support: 'explicit' });
	const source = evidence('minor-source', '2026-09-02T00:00:00.000Z');
	const candidate = {
		text: 'Propose later minor version',
		kind: 'decision',
		rationale: '',
		alternatives: [],
		support: 'explicit',
		status: 'proposed',
		global: false,
		evidence: [{ id: source.id, quote: source.text }],
		contradicts: [old.id],
		supersedes: old.id,
		duplicateOf: null,
		validFrom: null,
		validTo: null,
	};
	const corrected = models.validate([candidate], [source], old.userId, old.projectId!, [old])[0];
	assert.equal(corrected.status, 'proposed');
	assert.equal(corrected.supersedes, old.id);
	assert.deepEqual(corrected.related, []);
	const db = bank();
	db.store(old, vector);
	db.store(corrected, vector);
	assert.equal(db.find(old.id)!.validTo, '2026-09-02T00:00:00.000Z');
	assert.equal(db.find(corrected.id)!.status, 'proposed');
	assert.equal(memoryIsEligible(db.find(old.id)!, { mode: 'as-of', at: old.validFrom! }), false);
	assert.equal(memoryIsEligible(db.find(old.id)!, { mode: 'history' }), true);
	assert.equal(memoryIsEligible(db.find(corrected.id)!), false);
});

test('bad evidence identity rolls back assertion and indexes without mutating canonical evidence', () => {
	const db = bank();
	db.store(memory('original'), vector);
	const changedEvidence = { ...evidence('original'), text: 'Different source content' };
	assert.throws(
		() =>
			db.store(
				memory('conflict', { text: 'Other assertion', evidence: [changedEvidence] }),
				vector
			),
		/identity collision/
	);
	assert.equal(db.find('conflict'), null);
	assert.equal(db.find('original')!.evidence[0].text, 'Synthetic version choice');
	assert.equal((db.db.prepare('SELECT count(*) n FROM memory_fts').get() as { n: number }).n, 1);
});

test('invalid intervals fail before writing and future correction does not erase current fact', () => {
	const db = bank();
	assert.throws(
		() => db.store(memory('invalid', { validTo: '2026-09-01T00:00:00.000Z' }), vector),
		/interval/
	);
	assert.equal(db.find('invalid'), null);
	db.store(memory('today', { support: 'explicit' }), vector);
	db.store(
		memory('future', {
			support: 'explicit',
			text: 'Future version',
			validFrom: '2099-01-01T00:00:00.000Z',
			supersedes: 'today',
		}),
		vector
	);
	assert.equal(
		memoryIsEligible(
			db.find('today')!,
			{ mode: 'current' },
			Date.parse('2026-09-15T00:00:00.000Z')
		),
		true
	);
	assert.equal(
		memoryIsEligible(
			db.find('future')!,
			{ mode: 'current' },
			Date.parse('2026-09-15T00:00:00.000Z')
		),
		false
	);
	assert.equal(
		memoryIsEligible(db.find('today')!, { mode: 'as-of', at: '2099-01-01T00:00:00.000Z' }),
		false
	);
	assert.equal(
		memoryIsEligible(db.find('future')!, { mode: 'as-of', at: '2099-01-01T00:00:00.000Z' }),
		true
	);
});

test('quarantine and pause survive reopen without touching real usage or queued payloads', () => {
	let db = bank();
	const queued = JSON.stringify({ input: 'keep literal synthetic source' });
	db.db
		.prepare(
			'INSERT INTO sources(id,user_id,project_id,revision,state,cursor,data) VALUES(?,?,?,?,?,?,?)'
		)
		.run('source', 'synthetic-user', 'synthetic-project', 'synthetic', 'pending', 0, '{}');
	db.db
		.prepare('INSERT INTO ingestion_queue(id,source_id,data) VALUES(?,?,?)')
		.run('synthetic-job', 'source', queued);
	db.db.prepare('INSERT INTO usage VALUES(?,?,?,?,?,?,?)').run('spent', 17, 9, 0.25, 0, 0, 'spent');
	const usage = db.db.prepare('SELECT * FROM usage').all();
	db.quarantineExtraction('synthetic-job', 'unsupported provenance');
	const fixture = databases.pop()!;
	db.db.close();
	db = new MemoryDatabase(path.join(fixture.dir, 'memory.sqlite'));
	databases.push({ bank: db, dir: fixture.dir });
	assert.equal(db.get('paused'), true);
	assert.equal(db.get('pauseReason'), 'provenance-quarantine');
	assert.deepEqual(db.db.prepare('SELECT * FROM usage').all(), usage);
	assert.equal(
		(
			db.db.prepare('SELECT data FROM ingestion_queue WHERE id=?').get('synthetic-job') as {
				data: string;
			}
		).data,
		queued
	);
	assert.equal(
		(
			db.db.prepare('SELECT reason FROM extraction_quarantine WHERE id=?').get('synthetic-job') as {
				reason: string;
			}
		).reason,
		'unsupported provenance'
	);
});

test('failed durable pause rolls back quarantine rather than partially applying containment', () => {
	const db = bank();
	db.db.exec(
		"CREATE TRIGGER fail_pause BEFORE INSERT ON metadata WHEN new.key='pauseReason' BEGIN SELECT RAISE(ABORT,'synthetic pause failure'); END"
	);
	assert.throws(
		() => db.quarantineExtraction('job', 'synthetic provenance failure'),
		/pause failure/
	);
	assert.equal(db.get('paused'), undefined);
	assert.deepEqual(db.db.prepare('SELECT id FROM extraction_quarantine').all(), []);
});

test('session requests and unbounded outages cannot enter durable current assertions', () => {
	const models = Object.create(MemoryModels.prototype) as MemoryModels;
	const source = evidence('temporary');
	const candidate = {
		text: 'Use a temporary setting',
		kind: 'preference',
		rationale: '',
		alternatives: [],
		support: 'explicit',
		status: 'current',
		global: false,
		evidence: [{ id: source.id, quote: 'For this test only, use a temporary setting.' }],
		contradicts: [],
		supersedes: null,
		duplicateOf: null,
		validFrom: null,
		validTo: null,
	};
	source.text = candidate.evidence[0].quote;
	assert.deepEqual(
		models.validate([candidate], [source], 'synthetic-user', 'synthetic-project', []),
		[]
	);
	source.text = 'For this response only, use orange headings.';
	assert.deepEqual(
		models.validate(
			[{ ...candidate, evidence: [{ id: source.id, quote: source.text }] }],
			[source],
			'synthetic-user',
			'synthetic-project',
			[]
		),
		[]
	);
	source.text = 'Provider is down right now.';
	const outage = {
		...candidate,
		kind: 'project',
		text: 'Provider is unavailable',
		evidence: [{ id: source.id, quote: source.text }],
	};
	assert.deepEqual(
		models.validate([outage], [source], 'synthetic-user', 'synthetic-project', []),
		[]
	);
	const bounded = models.validate(
		[{ ...outage, validTo: '2026-09-02T00:00:00.000Z' }],
		[source],
		'synthetic-user',
		'synthetic-project',
		[]
	)[0];
	assert.equal(bounded.status, 'current');
	assert.equal(bounded.validTo, '2026-09-02T00:00:00.000Z');
	assert.equal(
		memoryIsEligible(bounded, { mode: 'current' }, Date.parse('2026-09-02T00:00:00.000Z')),
		false
	);
});

test('observed assistant and tool outcomes support facts, never human approval or preference', () => {
	const models = Object.create(MemoryModels.prototype) as MemoryModels;
	for (const role of ['assistant', 'tool'] as const) {
		const source = {
			...evidence(role),
			role,
			authorship: role,
			attribution: 'automated' as const,
			text: 'Synthetic compiler output confirms version 4.2.',
		};
		const candidate = {
			text: 'Compiler reports version 4.2',
			kind: 'project',
			rationale: '',
			alternatives: [],
			support: 'observed',
			status: 'current',
			global: false,
			evidence: [{ id: source.id, quote: source.text }],
			contradicts: [],
			supersedes: null,
			duplicateOf: null,
			validFrom: null,
			validTo: null,
		};
		const fact = models.validate(
			[candidate],
			[source],
			'synthetic-user',
			'synthetic-project',
			[]
		)[0];
		assert.equal(fact.support, 'observed');
		assert.equal(fact.status, 'current');
		for (const kind of ['preference', 'decision']) {
			const unsupported = models.validate(
				[{ ...candidate, kind, support: 'explicit' }],
				[source],
				'synthetic-user',
				'synthetic-project',
				[]
			)[0];
			assert.equal(unsupported.support, 'unverified');
			assert.equal(unsupported.status, 'proposed');
		}
	}
});

test('canonical identity respects project/global/user/kind slots and proposal modality', () => {
	const db = bank();
	db.store(memory('local'), vector);
	for (const [id, changes] of [
		['global', { projectId: null }],
		['other-project', { projectId: 'other-synthetic-project' }],
		['other-user', { userId: 'other-synthetic-user' }],
		['other-kind', { kind: 'project' }],
		['proposal', { status: 'proposed' }],
	] as [string, Partial<ContextualMemory>][]) {
		assert.equal(db.store(memory(id, changes), vector), id);
		assert.equal(db.find(id)!.id, id);
	}
});

test('explicit user pinned correction supersedes a pin while historical extraction cannot', () => {
	const db = bank();
	db.store(memory('pinned', { support: 'explicit', pinned: true }), vector);
	db.store(
		memory('history', {
			support: 'explicit',
			text: 'Unapproved extracted change',
			validFrom: '2026-09-02T00:00:00.000Z',
			supersedes: 'pinned',
		}),
		vector
	);
	assert.equal(db.find('pinned')!.status, 'current');
	assert.equal(db.find('history')!.status, 'contested');
	db.store(
		memory('user-correction', {
			support: 'explicit',
			text: 'Explicit corrected setting',
			pinned: true,
			validFrom: '2026-09-03T00:00:00.000Z',
			supersedes: 'pinned',
		}),
		vector
	);
	assert.equal(db.find('pinned')!.status, 'superseded');
	assert.equal(db.find('user-correction')!.status, 'current');
});

test('canonical duplicate updates contested status and provenance without losing existing links', () => {
	const db = bank();
	db.store(memory('related', { text: 'Other relevant choice' }), vector);
	db.store(memory('canonical', { support: 'explicit', related: ['related'] }), vector);
	const citation = {
		...evidence('canonical'),
		provenance: 'conversation' as const,
		authorship: 'human' as const,
		carriageRole: 'user',
		durability: 'durable' as const,
	};
	db.store(
		memory('duplicate', {
			support: 'explicit',
			status: 'contested',
			rationale: 'Explicit unresolved conflict',
			evidence: [citation],
			validFrom: '2026-09-02T00:00:00.000Z',
		}),
		vector
	);
	const stored = db.find('canonical')!;
	assert.equal(stored.status, 'contested');
	assert.equal(stored.evidence[0].authorship, 'human');
	assert.equal(stored.evidence[0].provenance, 'conversation');
	assert.deepEqual(stored.related, ['related']);
});

test('duplicate metadata merge preserves an already-resolved correction link', () => {
	const db = bank();
	db.store(memory('major', { support: 'explicit' }), vector);
	db.store(
		memory('minor', {
			text: 'Use later minor version',
			support: 'explicit',
			validFrom: '2026-09-02T00:00:00.000Z',
			supersedes: 'major',
		}),
		vector
	);
	const correction = db.find('minor')!;
	db.store(
		{
			...correction,
			id: 'duplicate-correction',
			rationale: 'New explicit correction reason',
			pinned: true,
		},
		vector
	);
	const stored = db.find('minor')!;
	assert.equal(stored.status, 'current');
	assert.equal(stored.supersedes, 'major');
	assert.equal(stored.rationale, 'New explicit correction reason');
	assert.deepEqual(db.db.prepare('SELECT from_id,to_id,kind FROM relationships').all(), [
		{ from_id: 'minor', to_id: 'major', kind: 'supersedes' },
	]);
});

test('explicit agent proposal correction closes only an unapproved proposal and keeps unverified support', () => {
	const db = bank();
	const source = (id: string) => ({
		...evidence(id),
		role: 'assistant',
		attribution: 'automated' as const,
		authorship: 'assistant' as const,
	});
	db.store(
		memory('agent-major', {
			status: 'proposed',
			support: 'unverified',
			evidence: [source('major')],
		}),
		vector
	);
	db.store(
		memory('agent-minor', {
			text: 'Propose minor version',
			status: 'proposed',
			support: 'unverified',
			evidence: [source('minor')],
			validFrom: '2026-09-02T00:00:00.000Z',
			supersedes: 'agent-major',
		}),
		vector
	);
	const prior = db.find('agent-major')!,
		next = db.find('agent-minor')!;
	assert.equal(prior.validTo, '2026-09-02T00:00:00.000Z');
	assert.equal(next.supersedes, prior.id);
	assert.equal(next.status, 'proposed');
	assert.equal(next.support, 'unverified');
	assert.equal(memoryIsEligible(prior, { mode: 'as-of', at: prior.validFrom! }), false);
	assert.equal(memoryIsEligible(next), false);
	assert.deepEqual(db.db.prepare('SELECT from_id,to_id,kind FROM relationships').all(), [
		{ from_id: next.id, to_id: prior.id, kind: 'supersedes' },
	]);
});

test('verified native assistant proposal correction links only proposed predecessors and preserves approval modality', () => {
	const models = Object.create(MemoryModels.prototype) as MemoryModels;
	const source: MemoryEvidence = {
		...evidence('native-minor', '2026-09-02T00:00:00.000Z'),
		sourceId: 'synthetic-native-conversation',
		provenance: 'conversation',
		role: 'assistant',
		authorship: 'assistant',
		attribution: 'automated',
		text: 'I propose minor version 4.2 instead of major version 5.',
	};
	const prior = memory('native-major', {
		status: 'proposed',
		support: 'unverified',
		evidence: [
			{
				...source,
				id: 'native-major-evidence',
				timestamp: '2026-09-01T00:00:00.000Z',
				text: 'I propose major version 5.',
			},
		],
	});
	const candidate = {
		text: 'Propose minor version 4.2',
		kind: 'decision',
		rationale: '',
		alternatives: ['Major version 5'],
		support: 'explicit',
		status: 'current',
		global: false,
		evidence: [{ id: source.id, quote: source.text }],
		contradicts: [prior.id],
		supersedes: prior.id,
		duplicateOf: null,
		validFrom: null,
		validTo: null,
	};
	const judgment = {
		index: 0,
		supported: true,
		rationaleSupported: true,
		authoredByUser: false,
		correctionSupported: true,
		duplicateSupported: false,
		validitySupported: false,
		observedEvidenceSupported: false,
		scope: 'target-project',
		durability: 'durable',
	};
	const approvedCorrection = models.validate(
		models.verified([candidate], [judgment]),
		[source],
		prior.userId,
		prior.projectId!,
		[prior]
	)[0];
	assert.equal(approvedCorrection.supersedes, prior.id);
	assert.equal(approvedCorrection.status, 'proposed');
	assert.equal(approvedCorrection.support, 'unverified');
	assert.deepEqual(approvedCorrection.related, []);
	const db = bank();
	db.store(prior, vector);
	db.store(approvedCorrection, vector);
	assert.equal(db.find(prior.id)!.validTo, '2026-09-02T00:00:00.000Z');
	assert.equal(db.find(approvedCorrection.id)!.supersedes, prior.id);
	assert.equal(
		memoryIsEligible(db.find(prior.id)!, { mode: 'as-of', at: prior.validFrom! }),
		false
	);
	assert.equal(memoryIsEligible(db.find(approvedCorrection.id)!), false);
	assert.deepEqual(db.db.prepare('SELECT from_id,to_id,kind FROM relationships').all(), [
		{ from_id: approvedCorrection.id, to_id: prior.id, kind: 'supersedes' },
	]);
	const unsupported = models.validate(
		models.verified([candidate], [{ ...judgment, correctionSupported: false }]),
		[source],
		prior.userId,
		prior.projectId!,
		[prior]
	)[0];
	assert.equal(unsupported.supersedes, null);
	assert.deepEqual(unsupported.related, []);
	const humanCurrent = {
		...prior,
		status: 'current' as const,
		support: 'explicit' as const,
		evidence: [evidence('human-current')],
	};
	const unapprovedChange = models.validate(
		models.verified([candidate], [judgment]),
		[source],
		prior.userId,
		prior.projectId!,
		[humanCurrent]
	)[0];
	assert.equal(unapprovedChange.supersedes, null);
	assert.equal(unapprovedChange.status, 'proposed');
	assert.equal(unapprovedChange.support, 'unverified');
	const other = bank();
	other.store(humanCurrent, vector);
	other.store(unapprovedChange, vector);
	assert.equal(other.find(prior.id)!.status, 'current');
	assert.equal(other.find(prior.id)!.validTo, null);
});

test('canonical repeats retain unresolved conflicts until supported corrections resolve every predecessor', () => {
	const db = bank();
	const green = memory('green', { text: 'Use Green paint', support: 'explicit' });
	db.store(green, vector);
	const blue = memory('blue', {
		text: 'Use Blue paint',
		status: 'contested',
		support: 'explicit',
		validFrom: '2026-09-02T00:00:00.000Z',
		related: [green.id],
	});
	const purple = memory('purple', {
		text: 'Use Purple paint',
		status: 'contested',
		support: 'explicit',
		validFrom: '2026-09-03T00:00:00.000Z',
		related: [green.id],
	});
	db.store(blue, vector);
	db.store(purple, vector);
	assert.equal(db.find(green.id)!.status, 'contested');
	const repeat = {
		...green,
		id: 'repeat',
		duplicateOf: green.id,
		rationale: 'Restated without resolving either conflict',
		evidence: [evidence('repeat')],
	};
	assert.equal(db.store(repeat, vector), green.id);
	const unresolved = db.find(green.id)!;
	assert.equal(unresolved.status, 'contested');
	assert.equal(unresolved.rationale, repeat.rationale);
	assert.deepEqual(unresolved.related.sort(), [blue.id, purple.id].sort());
	assert.equal(memoryIsEligible(unresolved), false);
	const partial = {
		...green,
		id: 'partial',
		duplicateOf: green.id,
		supersedes: blue.id,
		validFrom: '2026-09-04T00:00:00.000Z',
		evidence: [evidence('partial', '2026-09-04T00:00:00.000Z')],
	};
	assert.equal(db.store(partial, vector), green.id);
	assert.equal(db.find(blue.id)!.status, 'contested');
	assert.equal(db.find(blue.id)!.validTo, partial.validFrom);
	assert.equal(
		memoryIsEligible(db.find(blue.id)!, { mode: 'as-of', at: '2026-09-03T00:00:00.000Z' }),
		false
	);
	assert.equal(db.find(green.id)!.status, 'contested');
	assert.deepEqual(db.find(green.id)!.related, [purple.id]);
	assert.equal(memoryIsEligible(db.find(green.id)!), false);
	const final = {
		...green,
		id: 'resolved',
		duplicateOf: green.id,
		supersedes: purple.id,
		validFrom: '2026-09-05T00:00:00.000Z',
		evidence: [evidence('resolved', '2026-09-05T00:00:00.000Z')],
	};
	assert.equal(db.store(final, vector), green.id);
	const resolved = db.find(green.id)!;
	assert.equal(db.find(purple.id)!.status, 'contested');
	assert.equal(resolved.status, 'current');
	assert.deepEqual(resolved.related, []);
	assert.equal(memoryIsEligible(resolved), true);
	assert.deepEqual(
		db
			.retrieve(green.userId, green.projectId, 'Green paint', vector, { mode: 'current' })
			.map((m) => m.id),
		[green.id]
	);
	assert.equal(
		(
			db.db
				.prepare("SELECT COUNT(*) count FROM relationships WHERE kind='contradiction'")
				.get() as { count: number }
		).count,
		2
	);
});
