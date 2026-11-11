// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MemoryDatabase } from '../../../main/pianola/memory-database';
import type { ContextualMemory } from '../../../shared/pianola/memory';

const databases: MemoryDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const database of databases.splice(0)) database.close();
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
	);
});

async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pianola-batch-'));
	directories.push(directory);
	const database = new MemoryDatabase(path.join(directory, 'bank.sqlite'));
	databases.push(database);
	return database;
}

const vector = () => {
	const value = new Float32Array(384);
	value[0] = 1;
	return value;
};

const memory = (id: string, text: string): ContextualMemory => ({
	id,
	userId: 'owner',
	projectId: 'project',
	projectPath: 'C:/synthetic/project',
	kind: 'decision',
	text,
	rationale: '',
	alternatives: [],
	support: 'explicit',
	status: 'current',
	validFrom: null,
	validTo: null,
	learnedAt: 1,
	pinned: false,
	related: [],
	supersedes: null,
	evidence: [
		{
			id: `evidence-${id}`,
			sourceId: `explicit:${id}`,
			messageId: `turn-${id}`,
			role: 'user',
			text,
			timestamp: null,
			attribution: 'human',
			authorship: 'human',
			provenance: 'conversation',
			durability: 'durable',
		},
	],
});

describe('batched memory store', () => {
	it('stores every memory in the batch', async () => {
		const database = await fixture();
		const ids = database.storeMany([
			{ memory: memory('a', 'The first decision uses SQLite.'), vector: vector() },
			{ memory: memory('b', 'The second decision uses PostgreSQL.'), vector: vector() },
			{ memory: memory('c', 'The third decision uses Redis.'), vector: vector() },
		]);
		expect(ids).toEqual(['a', 'b', 'c']);
		expect(database.find('a')?.text).toBe('The first decision uses SQLite.');
		expect(database.find('c')?.text).toBe('The third decision uses Redis.');
	});

	it('stores the same memories as a per-row store', async () => {
		const database = await fixture();
		const entries = [
			{ memory: memory('a', 'The first decision uses SQLite.'), vector: vector() },
			{ memory: memory('b', 'The second decision uses PostgreSQL.'), vector: vector() },
		];
		database.storeMany(entries);
		const batched = database
			.list('owner', 'project')
			.map((row) => [row.id, row.text, row.status] as const)
			.sort();
		expect(batched).toEqual([
			['a', 'The first decision uses SQLite.', 'current'],
			['b', 'The second decision uses PostgreSQL.', 'current'],
		]);
	});

	it('returns an empty result for an empty batch', async () => {
		const database = await fixture();
		expect(database.storeMany([])).toEqual([]);
	});

	it('leaves no memory behind when one entry in the batch is rejected', async () => {
		const database = await fixture();
		// A memory with no evidence is quarantined rather than admitted, and the
		// whole batch is one transaction.
		const withoutEvidence = { ...memory('b', 'The second decision uses Redis.') };
		withoutEvidence.evidence = [];
		const ids = database.storeMany([
			{ memory: memory('a', 'The first decision uses SQLite.'), vector: vector() },
			{ memory: withoutEvidence, vector: vector() },
		]);
		expect(ids).toEqual(['a', 'b']);
		// The first memory is stored; the second is quarantined, not admitted.
		expect(database.find('a')).not.toBeNull();
		expect(database.find('b')).toBeNull();
	});
});
