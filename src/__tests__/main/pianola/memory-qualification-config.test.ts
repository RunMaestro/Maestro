// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	DEFAULT_QUALIFICATION,
	LocalMemoryRelevance,
	resolveQualification,
} from '../../../main/pianola/memory-relevance';

const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0))
		fs.rmSync(directory, { recursive: true, force: true });
});

describe('recall qualification configuration', () => {
	it('defaults to the local model on the loopback interface', () => {
		expect(DEFAULT_QUALIFICATION.provider).toBe('local');
		expect(DEFAULT_QUALIFICATION.model).toBe('qwen3:8b');
		expect(resolveQualification(undefined)).toEqual(DEFAULT_QUALIFICATION);
	});

	it('accepts a configured model and provider', () => {
		const resolved = resolveQualification({
			provider: 'hosted',
			model: 'qwen3.6',
			endpoint: 'https://api.nan.builders',
			apiKeyEnv: 'NAN_API_KEY',
		});
		expect(resolved.model).toBe('qwen3.6');
		expect(resolved.endpoint).toBe('https://api.nan.builders');
	});

	it('refuses a local qualification that is not on the loopback interface', () => {
		expect(() =>
			resolveQualification({
				provider: 'local',
				model: 'qwen3:8b',
				endpoint: 'https://api.nan.builders',
			})
		).toThrow('loopback');
	});

	it('requires hosted HTTPS and does not send the NaN fallback to another provider', async () => {
		expect(() =>
			resolveQualification({ provider: 'hosted', model: 'q', endpoint: 'http://example.com' })
		).toThrow('HTTPS');
		const primary = process.env.NAN_API_KEY;
		const fallback = process.env.NAN_BUILDERS_API_KEY;
		const other = process.env.OTHER_PROVIDER_KEY;
		delete process.env.NAN_API_KEY;
		delete process.env.OTHER_PROVIDER_KEY;
		process.env.NAN_BUILDERS_API_KEY = 'synthetic-nan-key';
		try {
			const gate = new LocalMemoryRelevance(vi.fn());
			gate.configure({
				provider: 'hosted',
				model: 'qwen3.6',
				endpoint: 'https://example.com',
				apiKeyEnv: 'OTHER_PROVIDER_KEY',
			});
			await expect(gate.assertAvailable()).rejects.toThrow('OTHER_PROVIDER_KEY');
		} finally {
			if (primary === undefined) delete process.env.NAN_API_KEY;
			else process.env.NAN_API_KEY = primary;
			if (fallback === undefined) delete process.env.NAN_BUILDERS_API_KEY;
			else process.env.NAN_BUILDERS_API_KEY = fallback;
			if (other === undefined) delete process.env.OTHER_PROVIDER_KEY;
			else process.env.OTHER_PROVIDER_KEY = other;
		}
	});

	it('refuses an unsupported provider or a missing model', () => {
		expect(() =>
			resolveQualification({
				provider: 'remote' as never,
				model: 'qwen3:8b',
				endpoint: 'http://127.0.0.1:11434',
			})
		).toThrow('provider');
		expect(() =>
			resolveQualification({
				provider: 'local',
				model: '  ',
				endpoint: 'http://127.0.0.1:11434',
			})
		).toThrow('model');
	});

	it('uses the configured model in the request and checks the model it was given', async () => {
		const requests: { url: string; body: string }[] = [];
		const gate = new LocalMemoryRelevance(async (url, init) => {
			requests.push({ url: url, body: String(init?.body ?? '') });
			return new Response(
				JSON.stringify({
					models: [
						{
							name: 'qwen3:8b',
							digest: '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41',
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		});
		gate.configure({ provider: 'local', model: 'qwen3:8b', endpoint: 'http://127.0.0.1:11434' });
		await gate.assertAvailable();
		expect(requests[0].url).toBe('http://127.0.0.1:11434/api/tags');
	});

	it('requires a credential for a hosted qualification', async () => {
		const previous = process.env.NAN_API_KEY;
		const previousAlt = process.env.NAN_BUILDERS_API_KEY;
		delete process.env.NAN_API_KEY;
		delete process.env.NAN_BUILDERS_API_KEY;
		try {
			const gate = new LocalMemoryRelevance();
			gate.configure({
				provider: 'hosted',
				model: 'qwen3.6',
				endpoint: 'https://api.nan.builders',
			});
			await expect(gate.assertAvailable()).rejects.toThrow('NAN_API_KEY');
		} finally {
			if (previous !== undefined) process.env.NAN_API_KEY = previous;
			if (previousAlt !== undefined) process.env.NAN_BUILDERS_API_KEY = previousAlt;
		}
	});

	it('sends the hosted request to the configured endpoint with the configured model', async () => {
		const previous = process.env.NAN_API_KEY;
		process.env.NAN_API_KEY = 'synthetic-key';
		const requests: { url: string; init: RequestInit }[] = [];
		let call = 0;
		const gate = new LocalMemoryRelevance(async (url, init) => {
			requests.push({ url: url, init: init ?? {} });
			call++;
			// The first call is the facet head, the second is the relations.
			const content =
				call === 1
					? JSON.stringify({ facets: ['Which cipher?'], complete: true })
					: JSON.stringify({ relations: { '0': ['direct_answer'] } });
			return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		gate.configure({
			provider: 'hosted',
			model: 'qwen3.6',
			endpoint: 'https://api.nan.builders',
		});
		try {
			const selections = await gate.selectRelevant('Which cipher?', [
				{
					memory: {
						id: 'a',
						text: 'The cipher is AES-256-GCM.',
						rationale: '',
						alternatives: [],
					},
				},
			]);
			expect(selections).toEqual([{ id: 'a', relevance: 2 }]);
			const chat = requests.find((request) => request.url.endsWith('/v1/chat/completions'));
			expect(chat).toBeDefined();
			expect(chat!.init.headers).toMatchObject({
				Authorization: 'Bearer synthetic-key',
			});
			expect(String(chat!.init.body)).toContain('qwen3.6');
		} finally {
			if (previous === undefined) delete process.env.NAN_API_KEY;
			else process.env.NAN_API_KEY = previous;
		}
	});

	it('accepts the flat relation form a hosted model may return', async () => {
		const previous = process.env.NAN_API_KEY;
		process.env.NAN_API_KEY = 'synthetic-key';
		let call = 0;
		const gate = new LocalMemoryRelevance(async (url) => {
			if (url.endsWith('/api/tags'))
				return new Response(
					JSON.stringify({
						models: [
							{
								name: 'qwen3:8b',
								digest: '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41',
							},
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			call++;
			// The first call is the facet head, the second is the relations.
			const content =
				call === 1
					? JSON.stringify({ facets: ['Which cipher?'], complete: true })
					: JSON.stringify({ '0': 'direct_answer' });
			return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		gate.configure({ provider: 'hosted', model: 'qwen3.6', endpoint: 'https://api.nan.builders' });
		try {
			const selections = await gate.selectRelevant('Which cipher?', [
				{
					memory: {
						id: 'a',
						text: 'The cipher is AES-256-GCM.',
						rationale: '',
						alternatives: [],
					},
				},
			]);
			expect(selections).toEqual([{ id: 'a', relevance: 2 }]);
		} finally {
			if (previous === undefined) delete process.env.NAN_API_KEY;
			else process.env.NAN_API_KEY = previous;
		}
	});

	it('rejects a hosted response that adds its own keys', async () => {
		// A model that invents fields is not a model whose answer can be trusted, so
		// the judgement contract stays strict even for a hosted provider.
		const previous = process.env.NAN_API_KEY;
		process.env.NAN_API_KEY = 'synthetic-key';
		let call = 0;
		const gate = new LocalMemoryRelevance(async () => {
			call++;
			const content =
				call === 1
					? JSON.stringify({ facets: ['Which cipher?'], complete: true })
					: JSON.stringify({ relations: { '0': ['direct_answer'] }, invented: true });
			return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		gate.configure({ provider: 'hosted', model: 'qwen3.6', endpoint: 'https://api.nan.builders' });
		try {
			await expect(
				gate.selectRelevant('Which cipher?', [
					{
						memory: {
							id: 'a',
							text: 'The cipher is AES-256-GCM.',
							rationale: '',
							alternatives: [],
						},
					},
				])
			).rejects.toThrow('relation coverage');
		} finally {
			if (previous === undefined) delete process.env.NAN_API_KEY;
			else process.env.NAN_API_KEY = previous;
		}
	});

	it('paces hosted requests so the provider rate limit is not exceeded', async () => {
		const previous = process.env.NAN_API_KEY;
		process.env.NAN_API_KEY = 'synthetic-key';
		const times: number[] = [];
		let call = 0;
		const gate = new LocalMemoryRelevance(async () => {
			times.push(Date.now());
			call++;
			const content =
				call === 1
					? JSON.stringify({ facets: ['Which cipher?'], complete: true })
					: JSON.stringify({ relations: { '0': ['direct_answer'] } });
			return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		gate.configure({ provider: 'hosted', model: 'qwen3.6', endpoint: 'https://api.nan.builders' });
		try {
			await gate.selectRelevant('Which cipher?', [
				{
					memory: {
						id: 'a',
						text: 'The cipher is AES-256-GCM.',
						rationale: '',
						alternatives: [],
					},
				},
			]);
			// Two calls for one qualification. The provider's measured ceiling is about
			// 30 requests a minute, so the second call waits its turn.
			expect(times).toHaveLength(2);
			expect(times[1] - times[0]).toBeGreaterThanOrEqual(2000);
		} finally {
			if (previous === undefined) delete process.env.NAN_API_KEY;
			else process.env.NAN_API_KEY = previous;
		}
	});

	it('retries a rate-limited hosted request within its deadline', async () => {
		const previous = process.env.NAN_API_KEY;
		process.env.NAN_API_KEY = 'synthetic-key';
		let call = 0;
		const gate = new LocalMemoryRelevance(async () => {
			call++;
			// The first call is rate limited; the retry is the facet head; the
			// relations follow.
			if (call === 1) return new Response('slow down', { status: 429 });
			const content =
				call === 2
					? JSON.stringify({ facets: ['Which cipher?'], complete: true })
					: JSON.stringify({ relations: { '0': ['direct_answer'] } });
			return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		gate.configure({ provider: 'hosted', model: 'qwen3.6', endpoint: 'https://api.nan.builders' });
		try {
			const selections = await gate.selectRelevant('Which cipher?', [
				{
					memory: {
						id: 'a',
						text: 'The cipher is AES-256-GCM.',
						rationale: '',
						alternatives: [],
					},
				},
			]);
			// The rate-limited call, its retry, and the relations call.
			expect(call).toBe(3);
			expect(selections).toEqual([{ id: 'a', relevance: 2 }]);
		} finally {
			if (previous === undefined) delete process.env.NAN_API_KEY;
			else process.env.NAN_API_KEY = previous;
		}
	}, 90_000);

	it('gives up on a rate-limited hosted request after a bounded number of retries', async () => {
		const previous = process.env.NAN_API_KEY;
		process.env.NAN_API_KEY = 'synthetic-key';
		let call = 0;
		const gate = new LocalMemoryRelevance(async () => {
			call++;
			return new Response('slow down', { status: 429 });
		});
		gate.configure({ provider: 'hosted', model: 'qwen3.6', endpoint: 'https://api.nan.builders' });
		try {
			await expect(
				gate.selectRelevant('Which cipher?', [
					{
						memory: {
							id: 'a',
							text: 'The cipher is AES-256-GCM.',
							rationale: '',
							alternatives: [],
						},
					},
				])
			).rejects.toThrow(/HTTP 429/);
			// The original call plus the bounded retries, then the gate gives up.
			expect(call).toBe(4);
		} finally {
			if (previous === undefined) delete process.env.NAN_API_KEY;
			else process.env.NAN_API_KEY = previous;
		}
	}, 180_000);

	it('asks a hosted provider for low reasoning effort and bounds only the judgement', async () => {
		const previous = process.env.NAN_API_KEY;
		process.env.NAN_API_KEY = 'synthetic-key';
		const bodies: string[] = [];
		let call = 0;
		const gate = new LocalMemoryRelevance(async (_url, init) => {
			bodies.push(String(init?.body ?? ''));
			call++;
			const content =
				call === 1
					? JSON.stringify({ facets: ['Which cipher?'], complete: true })
					: JSON.stringify({ relations: { '0': ['direct_answer'] } });
			return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		gate.configure({ provider: 'hosted', model: 'qwen3.6', endpoint: 'https://api.nan.builders' });
		try {
			await gate.selectRelevant('Which cipher?', [
				{
					memory: {
						id: 'a',
						text: 'The cipher is AES-256-GCM.',
						rationale: '',
						alternatives: [],
					},
				},
			]);
			// A reasoning model would otherwise spend its budget thinking, which is
			// slow and is not part of the judgement.
			expect(bodies[0]).toContain('reasoning_effort');
			// The provider enforces the schema. Asking only for a JSON object let the
			// model invent the keys, and it echoed the instruction as its answer.
			expect(bodies[0]).toContain('"type":"json_schema"');
			expect(bodies[0]).toContain('"strict":true');
			// The prompt states the semantics, not the shape.
			expect(bodies[0]).toContain('Answer with your own judgement');
		} finally {
			if (previous === undefined) delete process.env.NAN_API_KEY;
			else process.env.NAN_API_KEY = previous;
		}
	});
});
