// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { env } from '@huggingface/transformers';
import { MemoryEngine } from '../../../main/pianola/memory-engine';
import { LocalMemoryRelevance } from '../../../main/pianola/memory-relevance';
import type { ContextualMemory } from '../../../shared/pianola/memory';

const engines: MemoryEngine[] = [];
const directories: string[] = [];
const cacheDir = env.cacheDir;
const allowLocalModels = env.allowLocalModels;
afterEach(async () => {
	for (const engine of engines.splice(0)) engine.database.close();
	vi.restoreAllMocks();
	env.cacheDir = cacheDir;
	env.allowLocalModels = allowLocalModels;
	await Promise.all(
		directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
	);
});
async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pianola-recall-'));
	directories.push(directory);
	const engine = new MemoryEngine(directory);
	engines.push(engine);
	engine.database.set('config', {
		...engine.database.config(),
		enabled: true,
		userId: 'owner',
		ongoing: false,
		roots: [
			{
				provider: 'synthetic',
				path: directory,
				userId: 'owner',
				authorship: 'human',
				enabled: true,
			},
		],
	});
	const vector = new Float32Array(384);
	vector[0] = 1;
	vi.spyOn(engine.models, 'embed').mockResolvedValue(vector);
	const text = 'Use SQLite for durable offline storage.';
	const memory: ContextualMemory = {
		id: 'choice',
		userId: 'owner',
		projectId: null,
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
				id: 'evidence',
				sourceId: 'explicit:choice',
				messageId: 'instruction',
				role: 'user',
				text,
				timestamp: null,
				attribution: 'human',
			},
		],
	};
	engine.database.store(memory, vector);
	return engine;
}
it('does not report an empty eligible bank as successful recall when the local qualifier is unavailable', async () => {
	const engine = await fixture();
	engine.database.quarantine('choice', 'owner', 'Synthetic exclusion');
	const qualifier = new LocalMemoryRelevance(async () => new Response('Offline', { status: 503 }));
	vi.spyOn(engine.models, 'selectRelevant').mockImplementation((query, candidates) =>
		qualifier.selectRelevant(query, candidates)
	);
	await expect(
		engine.request({
			action: 'recall',
			query: { query: 'What storage should I use?', intent: { mode: 'current' }, qualify: true },
		})
	).rejects.toThrow('unavailable');
});

it('does not deliver recalled facts after visibility consent changes during local verification', async () => {
	const engine = await fixture();
	vi.spyOn(engine.models, 'selectRelevant').mockImplementation(async () => {
		engine.database.set('config', { ...engine.database.config(), enabled: false });
		return [{ id: 'choice', relevance: 2 }];
	});
	await expect(
		engine.request({
			action: 'recall',
			query: { query: 'What storage should I use?', intent: { mode: 'current' }, qualify: true },
		})
	).rejects.toThrow('visibility changed');
});
it('does not present a newly retired assertion as current after verification completes', async () => {
	const engine = await fixture();
	vi.spyOn(engine.models, 'selectRelevant').mockImplementation(async () => {
		engine.database.retire('choice', new Date(Date.now() - 1).toISOString());
		return [{ id: 'choice', relevance: 2 }];
	});
	const packet = (await engine.request({
		action: 'recall',
		query: { query: 'What storage should I use?', intent: { mode: 'current' }, qualify: true },
	})) as { memories: ContextualMemory[]; context: string };
	expect(packet.memories).toEqual([]);
	expect(packet.context).not.toContain('Use SQLite');
});
it('does not transfer a pending judgment to newly consolidated decision metadata', async () => {
	const engine = await fixture();
	vi.spyOn(engine.models, 'selectRelevant').mockImplementation(async () => {
		const current = engine.database.find('choice')!;
		const vector = new Float32Array(384);
		vector[0] = 1;
		engine.database.store(
			{
				...current,
				rationale: 'Newly consolidated rationale.',
				alternatives: ['Another documented choice'],
			},
			vector
		);
		return [{ id: 'choice', relevance: 2 }];
	});
	const packet = (await engine.request({
		action: 'recall',
		query: { query: 'What storage should I use?', intent: { mode: 'current' }, qualify: true },
	})) as { memories: ContextualMemory[]; context: string };
	expect(packet.memories).toEqual([]);
	expect(packet.context).not.toContain('Newly consolidated rationale');
});

it('returns scoped advisory evidence even when model review rejects the candidate', async () => {
	const engine = await fixture();
	vi.spyOn(LocalMemoryRelevance.prototype, 'selectRelevant').mockResolvedValue([]);
	const packet = (await engine.request({
		action: 'recall',
		query: { query: 'What storage should I use?' },
	})) as { memories: ContextualMemory[]; assessment: { mode: string; answerability: string } };
	expect(packet.assessment).toEqual({ mode: 'advisory-evidence', answerability: 'unassessed' });
	expect(packet.memories.map((memory) => memory.id)).toEqual(['choice']);
	expect(packet.memories[0].evidence[0]).toMatchObject({
		role: 'user',
		attribution: 'human',
		messageId: 'instruction',
	});
});

it('reranks only on request and keeps the result advisory', async () => {
	const engine = await fixture();
	const original = engine.database.find('choice')!;
	const text = 'Use PostgreSQL for durable storage.';
	const alternativeVector = new Float32Array(384);
	alternativeVector[0] = 0.8;
	alternativeVector[1] = 0.6;
	engine.database.store(
		{
			...original,
			id: 'alternative',
			text,
			learnedAt: 0,
			evidence: [
				{
					...original.evidence[0],
					id: 'alternative-evidence',
					sourceId: 'explicit:alternative',
					text,
				},
			],
		},
		alternativeVector
	);
	const rerank = vi
		.spyOn(engine.models, 'rerank')
		.mockImplementation(async (_query, candidates) =>
			candidates.map((candidate) => (candidate.memory.id === 'alternative' ? 1 : 0))
		);
	const reranked = (await engine.request({
		action: 'recall',
		query: { query: 'What storage should I use?', rerank: true, limit: 2 },
	})) as {
		memories: ContextualMemory[];
		assessment: { mode: string; answerability: string };
		ranking: { id: string; rerankScore?: number }[];
	};
	expect(reranked.memories.map((memory) => memory.id)).toEqual(['alternative', 'choice']);
	expect(reranked.ranking.map((row) => [row.id, row.rerankScore])).toEqual([
		['alternative', 1],
		['choice', 0],
	]);
	expect(reranked.assessment).toEqual({ mode: 'advisory-evidence', answerability: 'unassessed' });
	const advisory = (await engine.request({
		action: 'recall',
		query: { query: 'What storage should I use?', limit: 2 },
	})) as { memories: ContextualMemory[] };
	expect(advisory.memories.map((memory) => memory.id)).toEqual(['choice', 'alternative']);
	expect(rerank).toHaveBeenCalledTimes(1);
});

it('does not reuse a cached positive review after the canonical rationale changes', async () => {
	const engine = await fixture();
	vi.spyOn(LocalMemoryRelevance.prototype, 'assertAvailable').mockResolvedValue();
	vi.spyOn(LocalMemoryRelevance.prototype, 'selectRelevant')
		.mockResolvedValueOnce([{ id: 'choice', relevance: 2 }])
		.mockResolvedValue([]);
	const request = {
		action: 'recall' as const,
		query: {
			query: 'What storage should I use?',
			intent: { mode: 'current' as const },
			qualify: true,
		},
	};
	const first = (await engine.request(request)) as { memories: ContextualMemory[] };
	expect(first.memories.map((memory) => memory.id)).toEqual(['choice']);
	const vector = new Float32Array(384);
	vector[0] = 1;
	engine.database.store(
		{ ...engine.database.find('choice')!, rationale: 'A newly consolidated claim without review' },
		vector
	);
	const second = (await engine.request(request)) as {
		memories: ContextualMemory[];
		assessment: { answerability: string };
	};
	expect(second.memories).toEqual([]);
	expect(second.assessment.answerability).toBe('abstained');
});

it.each([1, 2, 5])(
	'merges vector-only evidence ahead of weak mixed-channel lexical hits before limit %i',
	async (limit) => {
		const engine = await fixture();
		const template = engine.database.find('choice')!;
		engine.database.quarantine('choice', 'owner', 'Independent ranking fixture');
		const store = (id: string, text: string, similarity: number, pinned = false) => {
			const vector = new Float32Array(384);
			vector[0] = similarity;
			vector[1] = Math.sqrt(1 - similarity * similarity);
			engine.database.store(
				{
					...template,
					id,
					text,
					pinned,
					evidence: [
						{ ...template.evidence[0], id: 'evidence-' + id, sourceId: 'explicit:' + id, text },
					],
				},
				vector
			);
		};
		store('lexical-a', 'Cobalt forwarding queue dashboard reference', 0.1, true);
		store('lexical-b', 'Cobalt forwarding queue dashboard appendix', 0.2, true);
		const expected = ['delivery', 'retry', 'ordering', 'retention', 'ownership', 'recovery'];
		for (let index = 0; index < expected.length; index++)
			store(expected[index], 'Invented relay policy for ' + expected[index], 1 - index * 0.02);
		const vector = new Float32Array(384);
		vector[0] = 1;
		const candidates = engine.database.retrieveCandidates(
			'owner',
			null,
			'cobalt forwarding queue',
			vector
		);
		expect(candidates.find((row) => row.memory.id === 'delivery')!.lexicalRank).toBeUndefined();
		expect(candidates.find((row) => row.memory.id === 'lexical-a')).toMatchObject({
			lexicalRank: expect.any(Number),
			vectorRank: expect.any(Number),
		});
		const packet = (await engine.request({
			action: 'recall',
			query: { query: 'cobalt forwarding queue', qualify: false, limit, maxCharacters: 10000 },
		})) as { memories: ContextualMemory[]; assessment: { mode: string; answerability: string } };
		expect(packet.memories.map((row) => row.id)).toEqual(expected.slice(0, limit));
		expect(packet.assessment).toEqual({ mode: 'advisory-evidence', answerability: 'unassessed' });
	}
);
