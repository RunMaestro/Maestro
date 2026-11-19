// Source: src/__tests__/main/pianola/memory-embed.test.ts
// Source: src/__tests__/main/pianola/memory-rerank.test.ts
import { afterEach } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryModels } from '../../../main/pianola/memory-models';
import { MemoryReranker } from '../../../main/pianola/memory-rerank';
import { DEFAULT_RERANK } from '../../../main/pianola/memory-rerank';
import { resolveRerank } from '../../../main/pianola/memory-rerank';
import type { MemoryCandidate } from '../../../main/pianola/memory-candidates';
describe('memory-embed', () => {
	const directories: string[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const directory of directories.splice(0))
			fs.rmSync(directory, { recursive: true, force: true });
	});

	/**
	 * The encoder is the dominant cost of building a memory bank, so the models embed
	 * several texts in one call. The single-text and batch paths must agree, and the
	 * two must not call each other.
	 */
	it('embeds a batch in one encoder call and agrees with the single-text path', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-embed-'));
		directories.push(directory);
		const models = new MemoryModels(path.join(directory, 'models'));
		const calls: string[][] = [];
		// A deterministic stand-in for the encoder: the vector is derived from the text.
		const injected = models as unknown as {
			encoder: Promise<(texts: string[]) => Promise<{ data: Float32Array }>>;
		};
		injected.encoder = Promise.resolve(async (texts: string[]) => {
			calls.push(texts);
			const data = new Float32Array(texts.length * 384);
			for (let index = 0; index < texts.length; index++)
				for (let dimension = 0; dimension < 384; dimension++)
					data[index * 384 + dimension] = texts[index].length + dimension;
			return { data };
		});

		const texts = ['first assertion about payment retry', 'second assertion about cache eviction'];
		const batched = await models.embedMany(texts);
		expect(batched).toHaveLength(2);
		// One encoder call for the whole batch.
		expect(calls).toHaveLength(1);
		expect(calls[0]).toHaveLength(2);

		// The single-text path produces the same vector as the batch.
		const single = await models.embed(texts[0]);
		expect(Array.from(single)).toEqual(Array.from(batched[0]));
	});

	it('does not call the single-text embed from the batch path', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-embed-'));
		directories.push(directory);
		const models = new MemoryModels(path.join(directory, 'models'));
		const injected = models as unknown as {
			encoder: Promise<(texts: string[]) => Promise<{ data: Float32Array }>>;
		};
		injected.encoder = Promise.resolve(async (texts: string[]) => {
			const data = new Float32Array(texts.length * 384);
			for (let index = 0; index < texts.length; index++) data[index * 384] = 1;
			return { data };
		});
		// If the single path delegated to the batch path and back, this would recurse.
		const embed = vi.spyOn(models, 'embed');
		await models.embedMany(['a', 'b']);
		expect(embed).not.toHaveBeenCalled();
	});

	it('keeps the query cache working for repeated queries', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-embed-'));
		directories.push(directory);
		const models = new MemoryModels(path.join(directory, 'models'));
		let encodes = 0;
		const injected = models as unknown as {
			encoder: Promise<(texts: string[]) => Promise<{ data: Float32Array }>>;
		};
		injected.encoder = Promise.resolve(async (texts: string[]) => {
			encodes++;
			const data = new Float32Array(texts.length * 384);
			for (let index = 0; index < texts.length; index++) data[index * 384] = 1;
			return { data };
		});
		const first = await models.embed('same question', true);
		const second = await models.embed('same question', true);
		expect(Array.from(first)).toEqual(Array.from(second));
		expect(encodes).toBe(1);
	});
});
describe('memory-rerank', () => {
	const originalKey = process.env.NAN_API_KEY;
	const originalAltKey = process.env.NAN_BUILDERS_API_KEY;
	const directories: string[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		if (originalKey === undefined) delete process.env.NAN_API_KEY;
		else process.env.NAN_API_KEY = originalKey;
		if (originalAltKey === undefined) delete process.env.NAN_BUILDERS_API_KEY;
		else process.env.NAN_BUILDERS_API_KEY = originalAltKey;
		for (const directory of directories.splice(0))
			fs.rmSync(directory, { recursive: true, force: true });
	});

	const candidates: MemoryCandidate[] = ['first', 'second'].map((id) => ({
		memory: {
			id,
			userId: 'owner',
			projectId: null,
			kind: 'project',
			text: id === 'first' ? 'Use SQLite for storage.' : 'Use PostgreSQL for storage.',
			support: 'explicit',
			status: 'current',
			validFrom: null,
			validTo: null,
			learnedAt: 1,
			pinned: false,
			supersedes: null,
		},
	}));

	it('defaults to the measured hosted reranker and rejects insecure or unsupported endpoints', () => {
		expect(resolveRerank(undefined)).toEqual(DEFAULT_RERANK);
		expect(() =>
			resolveRerank({ provider: 'local' as never, model: 'rerank', endpoint: 'http://127.0.0.1' })
		).toThrow('hosted');
		expect(() =>
			resolveRerank({ provider: 'hosted', model: 'rerank', endpoint: 'http://example.com' })
		).toThrow('HTTPS');
	});

	it('maps out-of-order hosted results back to candidate positions', async () => {
		process.env.NAN_API_KEY = 'synthetic-key';
		let requestUrl = '';
		let requestBody: { model: string; query: string; documents: string[] } | null = null;
		const reranker = new MemoryReranker(async (url, init) => {
			requestUrl = url;
			requestBody = JSON.parse(String(init?.body));
			expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-key' });
			return new Response(
				JSON.stringify({
					results: [
						{ index: 1, relevance_score: 0.25 },
						{ index: 0, relevance_score: 0.75 },
					],
				})
			);
		});
		await expect(reranker.score('Which store?', candidates)).resolves.toEqual([0.75, 0.25]);
		expect(requestUrl).toBe('https://api.nan.builders/v1/rerank');
		expect(requestBody).toEqual({
			model: 'rerank',
			query: 'Which store?',
			documents: ['Use SQLite for storage.', 'Use PostgreSQL for storage.'],
		});
	});

	it('requires a credential even when the eligible shortlist is empty', async () => {
		delete process.env.NAN_API_KEY;
		delete process.env.NAN_BUILDERS_API_KEY;
		await expect(new MemoryReranker().score('question', [])).rejects.toThrow('NAN_API_KEY');
	});

	it.each([
		{ results: [{ index: 0, relevance_score: 1 }] },
		{
			results: [
				{ index: 0, relevance_score: 1 },
				{ index: 0, relevance_score: 0.5 },
			],
		},
		{
			results: [
				{ index: 0, relevance_score: 1 },
				{ index: 1, relevance_score: 'high' },
			],
		},
		{
			results: [
				{ index: 0, relevance_score: 1 },
				{ index: 2, relevance_score: 0.5 },
			],
		},
	])('rejects incomplete or invalid rerank coverage %j', async (body) => {
		process.env.NAN_API_KEY = 'synthetic-key';
		const reranker = new MemoryReranker(async () => new Response(JSON.stringify(body)));
		await expect(reranker.score('question', candidates)).rejects.toThrow(
			'Memory rerank capability'
		);
	});

	it('surfaces provider failures instead of falling back to the embedding', async () => {
		process.env.NAN_API_KEY = 'synthetic-key';
		const reranker = new MemoryReranker(async () => new Response('limited', { status: 429 }));
		await expect(reranker.score('question', candidates)).rejects.toThrow('HTTP 429');
	});

	it('keys cached scores by model and refuses cached results without a credential', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-rerank-cache-'));
		directories.push(directory);
		process.env.NAN_API_KEY = 'synthetic-key';
		let calls = 0;
		vi.stubGlobal('fetch', async () => {
			calls++;
			return new Response(
				JSON.stringify({
					results: candidates.map((_, index) => ({ index, relevance_score: index })),
				})
			);
		});
		const models = new MemoryModels(path.join(directory, 'models'));
		await models.rerank('question', candidates);
		await models.rerank('question', candidates);
		expect(calls).toBe(1);
		models.configureRerank({
			provider: 'hosted',
			model: 'different',
			endpoint: DEFAULT_RERANK.endpoint,
		});
		await models.rerank('question', candidates);
		expect(calls).toBe(2);
		delete process.env.NAN_API_KEY;
		delete process.env.NAN_BUILDERS_API_KEY;
		await expect(models.rerank('question', candidates)).rejects.toThrow('NAN_API_KEY');
		expect(calls).toBe(2);
	});
});
