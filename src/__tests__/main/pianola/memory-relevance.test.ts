import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	LocalMemoryRelevance,
	MEMORY_RELEVANCE_DIGEST,
} from '../../../main/pianola/memory-relevance';
import type { MemoryCandidate } from '../../../main/pianola/memory-candidates';
import type { fetchWithTimeout } from '../../../main/utils/fetchWithTimeout';

afterEach(() => {
	vi.unstubAllEnvs();
});

const candidates: MemoryCandidate[] = [
	{
		memory: {
			id: 'known',
			userId: 'synthetic',
			projectId: null,
			kind: 'project',
			text: 'Use AES-256-GCM for stored records.',
			support: 'explicit',
			status: 'current',
			validFrom: null,
			validTo: null,
			learnedAt: 1,
			pinned: false,
			supersedes: null,
		},
	},
];
function gate(
	value: unknown,
	head: unknown = { facets: ['Which cipher protects stored records?'], complete: true },
	digest = MEMORY_RELEVANCE_DIGEST,
	doneReason = 'stop',
	model = 'qwen3:8b',
	remote = false
) {
	const request: typeof fetchWithTimeout = async (url, options) => {
		const body = options?.body
			? (JSON.parse(String(options.body)) as { format: { properties?: { complete?: unknown } } })
			: null;
		const output = body?.format.properties?.complete ? head : value;
		return new Response(
			JSON.stringify(
				url.endsWith('/api/tags')
					? {
							models: [
								{
									name: model,
									digest,
									...(remote
										? { remote_model: 'qwen3.6-cloud', remote_host: 'https://ollama.com:443' }
										: {}),
								},
							],
						}
					: {
							model,
							done: true,
							done_reason: doneReason,
							message: { content: JSON.stringify(output) },
						}
			)
		);
	};
	return new LocalMemoryRelevance(request);
}
describe('local memory semantic qualification contract', () => {
	it('distinguishes successful no-evidence judgments from unavailable capability', async () => {
		await expect(
			gate({ relations: { 0: ['related_background'] } }).selectRelevant('Which cipher?', candidates)
		).resolves.toEqual([]);
		const unavailable = new LocalMemoryRelevance(async () => {
			throw new Error('offline');
		});
		await expect(unavailable.selectRelevant('Which cipher?', candidates)).rejects.toThrow(
			'unavailable'
		);
		await expect(unavailable.selectRelevant('Which cipher?', [])).rejects.toThrow('unavailable');
		await expect(gate({}).selectRelevant('Which cipher?', [])).resolves.toEqual([]);
		await expect(
			gate({}, undefined, 'different-digest').selectRelevant('Which cipher?', [])
		).rejects.toThrow('digest');
	});
	it('accepts the installed digest of a deliberately selected local model', async () => {
		const selected = gate(
			{ relations: { 0: ['related_background'] } },
			undefined,
			'selected-model-digest',
			'stop',
			'qwen3.6'
		);
		selected.configure({
			provider: 'local',
			model: 'qwen3.6',
			endpoint: 'http://127.0.0.1:11434',
		});
		await expect(selected.selectRelevant('Which cipher?', candidates)).resolves.toEqual([]);
	});
	it('rejects cloud-backed Ollama tags when local qualification is selected', async () => {
		const selected = gate(
			{ relations: { 0: ['related_background'] } },
			undefined,
			'selected-model-digest',
			'stop',
			'qwen3.6',
			true
		);
		selected.configure({
			provider: 'local',
			model: 'qwen3.6',
			endpoint: 'http://127.0.0.1:11434',
		});
		await expect(selected.selectRelevant('Which cipher?', candidates)).rejects.toThrow(
			/cloud|local/
		);
	});
	it.each([
		{ relations: [] },
		{ relations: { 0: ['invented'] } },
		{ relations: { 0: 'direct_answer' } },
		{ relations: { 0: ['direct_answer'] }, id: 'invented' },
		{ relations: { 0: ['direct_answer'], 1: ['direct_answer'] } },
		{ relations: { 1: ['direct_answer'] } },
		{ relations: { 0: [2] } },
		{ relations: { 0: ['direct_answer'], known: ['direct_answer'] } },
		{ relations: { 0: ['direct_answer'] }, relation: 'direct_answer' },
	])('rejects malformed, incomplete or hallucinated semantic judgments %j', async (value) => {
		await expect(gate(value).selectRelevant('Which cipher?', candidates)).rejects.toThrow(
			/relation|ID/
		);
	});
	it('requires all declared facets and distinguishes partial requested evidence from a complete answer', async () => {
		const head = {
			facets: ['Which cipher protects stored records?', 'What rotation period applies?'],
			complete: true,
		};
		await expect(
			gate({ relations: { 0: ['direct_answer', 'related_background'] } }, head).selectRelevant(
				'Which cipher and what rotation period?',
				candidates
			)
		).resolves.toEqual([{ id: 'known', relevance: 1 }]);
		await expect(
			gate({ relations: { 0: ['direct_answer', 'direct_answer'] } }, head).selectRelevant(
				'Which cipher and what rotation period?',
				candidates
			)
		).resolves.toEqual([{ id: 'known', relevance: 2 }]);
		await expect(
			gate({ relations: { 0: ['direct_answer'] } }, head).selectRelevant(
				'Which cipher and what rotation period?',
				candidates
			)
		).rejects.toThrow('coverage');
	});
	it('binds classifications to input identity by exact position, not object order, and rejects omitted rows', async () => {
		const rows = [
			{
				memory: {
					...candidates[0].memory,
					id: 'background',
					text: 'Documents are exported as PDF.',
				},
			},
			candidates[0],
		];
		await expect(
			gate({ relations: { 1: ['direct_answer'], 0: ['unrelated'] } }).selectRelevant(
				'Which cipher?',
				rows
			)
		).resolves.toEqual([{ id: 'known', relevance: 2 }]);
		await expect(
			gate({ relations: { 1: ['direct_answer'] } }).selectRelevant('Which cipher?', rows)
		).rejects.toThrow('coverage');
		await expect(
			gate({ relations: { 0: ['unrelated'], known: ['direct_answer'] } }).selectRelevant(
				'Which cipher?',
				rows
			)
		).rejects.toThrow('ID');
	});
	it.each([
		{ facets: [], complete: true },
		{ facets: ['Which cipher?'], complete: false },
		{ facets: ['Which cipher?'], complete: 'true' },
		{ facets: ['Which cipher?', 'Which cipher?'], complete: true },
		{ facets: ['Which cipher?'], complete: true, extra: true },
	])('rejects incomplete or invalid request decomposition %j', async (head) => {
		await expect(gate({}, head).selectRelevant('Which cipher?', candidates)).rejects.toThrow(
			'facets'
		);
	});
	it('rejects missing model digest and token-truncated model responses', async () => {
		await expect(
			gate({}, undefined, 'different-digest').selectRelevant('Which cipher?', candidates)
		).rejects.toThrow('digest');
		await expect(
			gate({}, undefined, MEMORY_RELEVANCE_DIGEST, 'length').selectRelevant(
				'Which cipher?',
				candidates
			)
		).rejects.toThrow('incomplete');
	});
	it('states what the completeness flag means and does not send a truncated instruction', async () => {
		// The local provider is given the schema rather than a strict response
		// format, so the meaning of `complete` has to be in the prompt. Without it
		// the local model answers `complete=false` for a single-property question it
		// decomposed correctly, and the gate discards a faithful decomposition.
		// The instruction also used to end mid-word, which told the model nothing
		// about the last rule at all.
		const systems: string[] = [];
		const request: typeof fetchWithTimeout = async (url, options) => {
			const body = options?.body
				? (JSON.parse(String(options.body)) as {
						format: { properties?: { complete?: unknown } };
						messages?: { content: string }[];
					})
				: null;
			if (body?.format.properties?.complete) {
				systems.push(body.messages?.[0]?.content ?? '');
				return new Response(
					JSON.stringify({
						model: 'qwen3:8b',
						done: true,
						done_reason: 'stop',
						message: {
							content: JSON.stringify({
								facets: ['Which cipher protects stored records?'],
								complete: true,
							}),
						},
					})
				);
			}
			return new Response(
				JSON.stringify(
					url.endsWith('/api/tags')
						? { models: [{ name: 'qwen3:8b', digest: MEMORY_RELEVANCE_DIGEST }] }
						: {
								model: 'qwen3:8b',
								done: true,
								done_reason: 'stop',
								message: { content: JSON.stringify({ relations: { 0: ['direct_answer'] } }) },
							}
				)
			);
		};
		await new LocalMemoryRelevance(request).selectRelevant('Which cipher?', candidates);
		expect(systems).toHaveLength(1);
		const system = systems[0];
		expect(system).toContain('complete=true');
		expect(system).toContain('complete=false');
		// The single-property case is the one the local model got wrong.
		expect(system).toMatch(/single thing|single propert/i);
		// An ellipsis is a truncated instruction, not a rule.
		expect(system).not.toContain('…');
		expect(system.trimEnd().endsWith('.')).toBe(true);
	});
	it('asks the local model not to think on the relation judgment', async () => {
		// Ollama draws the reasoning section from the same output budget as the
		// answer, so a thinking model can return an empty answer and the gate
		// reports a malformed judgment. Measured over the real shortlists,
		// thinking cost 7.4x the wall clock and 8x the tokens for the same
		// selections.
		const bodies: { think?: unknown }[] = [];
		const request: typeof fetchWithTimeout = async (url, options) => {
			const body = options?.body
				? (JSON.parse(String(options.body)) as {
						think?: unknown;
						format: { properties?: { complete?: unknown } };
					})
				: null;
			if (body?.format.properties?.complete) {
				return new Response(
					JSON.stringify({
						model: 'qwen3:8b',
						done: true,
						done_reason: 'stop',
						message: {
							content: JSON.stringify({
								facets: ['Which cipher protects stored records?'],
								complete: true,
							}),
						},
					})
				);
			}
			if (!url.endsWith('/api/tags')) bodies.push({ think: body?.think });
			return new Response(
				JSON.stringify(
					url.endsWith('/api/tags')
						? { models: [{ name: 'qwen3:8b', digest: MEMORY_RELEVANCE_DIGEST }] }
						: {
								model: 'qwen3:8b',
								done: true,
								done_reason: 'stop',
								message: { content: JSON.stringify({ relations: { 0: ['direct_answer'] } }) },
							}
				)
			);
		};
		await new LocalMemoryRelevance(request).selectRelevant('Which cipher?', candidates);
		expect(bodies).toHaveLength(1);
		expect(bodies[0].think).toBe(false);
	});
	it('bounds canonical text, rationale and alternatives without silent clipping', async () => {
		for (const memory of [
			{ ...candidates[0].memory, text: 'x'.repeat(4001) },
			{ ...candidates[0].memory, rationale: 'x'.repeat(4001) },
			{ ...candidates[0].memory, alternatives: ['x'.repeat(1001)] },
		])
			await expect(gate({}).selectRelevant('Which cipher?', [{ memory }])).rejects.toThrow(
				'oversized candidate'
			);
		await expect(gate({}).selectRelevant('x'.repeat(16001), candidates)).rejects.toThrow(
			'oversized shortlist/query'
		);
		await expect(gate({}).selectRelevant('界'.repeat(10000), candidates)).rejects.toThrow(
			'bounded local context'
		);
	});
	it('rejects a Unicode batch that fits character limits but exceeds the serialized local context', async () => {
		const unicodeRows = Array.from({ length: 4 }, (_, index) => ({
			memory: { ...candidates[0].memory, id: 'unicode-' + index, text: '界'.repeat(3000) },
		}));
		await expect(gate({}).selectRelevant('Recall project facts.', unicodeRows)).rejects.toThrow(
			'bounded local context'
		);
	});
	it('normalizes valid as-of dates and rejects conflicting, impossible and extra intent fields', async () => {
		await expect(
			gate({ mode: 'as-of', at: '2024-06-12' }).interpretRecallIntent(
				'What applied on June 12, 2024?'
			)
		).resolves.toEqual({ mode: 'as-of', at: '2024-06-12T00:00:00.000Z' });
		for (const value of [
			{ mode: 'current', at: '2024-06-12' },
			{ mode: 'as-of', at: 'not-a-date' },
			{ mode: 'as-of', at: '2024-02-30' },
			{ mode: 'current', at: null, extra: true },
			{ mode: 'invented', at: null },
		]) {
			await expect(gate(value).interpretRecallIntent('What applies?')).rejects.toThrow(
				'invalid intent'
			);
		}
	});
	it('reuses a question decomposition across different candidate sets', async () => {
		// The facets depend on the question alone, so the same question must not
		// cost a second decomposition when the candidates change.
		const heads: string[] = [];
		let relations = 0;
		const request: typeof fetchWithTimeout = async (url, options) => {
			const body = options?.body
				? (JSON.parse(String(options.body)) as {
						format: { properties?: { complete?: unknown } };
						messages?: { content: string }[];
					})
				: null;
			if (url.endsWith('/api/tags'))
				return new Response(
					JSON.stringify({ models: [{ name: 'qwen3:8b', digest: MEMORY_RELEVANCE_DIGEST }] })
				);
			if (body?.format.properties?.complete) {
				heads.push(body.messages?.[0]?.content ?? '');
				return new Response(
					JSON.stringify({
						model: 'qwen3:8b',
						done: true,
						done_reason: 'stop',
						message: {
							content: JSON.stringify({
								facets: ['Which cipher protects stored records?'],
								complete: true,
							}),
						},
					})
				);
			}
			relations++;
			return new Response(
				JSON.stringify({
					model: 'qwen3:8b',
					done: true,
					done_reason: 'stop',
					message: {
						content: JSON.stringify({ relations: { 0: ['direct_answer'] } }),
					},
				})
			);
		};
		const relevance = new LocalMemoryRelevance(request);
		await relevance.selectRelevant('Which cipher?', candidates);
		await relevance.selectRelevant('Which cipher?', candidates);
		expect(heads).toHaveLength(1);
		expect(relations).toBe(2);
	});
	it('does not reuse a decomposition for a different question', async () => {
		let heads = 0;
		const request: typeof fetchWithTimeout = async (url, options) => {
			const body = options?.body
				? (JSON.parse(String(options.body)) as {
						format: { properties?: { complete?: unknown } };
					})
				: null;
			if (url.endsWith('/api/tags'))
				return new Response(
					JSON.stringify({ models: [{ name: 'qwen3:8b', digest: MEMORY_RELEVANCE_DIGEST }] })
				);
			if (body?.format.properties?.complete) {
				heads++;
				return new Response(
					JSON.stringify({
						model: 'qwen3:8b',
						done: true,
						done_reason: 'stop',
						message: {
							content: JSON.stringify({
								facets: ['Which cipher?'],
								complete: true,
							}),
						},
					})
				);
			}
			return new Response(
				JSON.stringify({
					model: 'qwen3:8b',
					done: true,
					done_reason: 'stop',
					message: { content: JSON.stringify({ relations: { 0: ['direct_answer'] } }) },
				})
			);
		};
		const relevance = new LocalMemoryRelevance(request);
		await relevance.selectRelevant('Which cipher?', candidates);
		await relevance.selectRelevant('Which key?', candidates);
		expect(heads).toBe(2);
	});
	it('drops a cached decomposition when the model changes', async () => {
		vi.stubEnv('NAN_API_KEY', 'synthetic-hosted-key');
		let heads = 0;
		const request: typeof fetchWithTimeout = async (url, options) => {
			const body = options?.body
				? (JSON.parse(String(options.body)) as {
						format?: { properties?: { complete?: unknown } };
						response_format?: {
							json_schema?: { schema?: { properties?: { complete?: unknown } } };
						};
					})
				: null;
			if (url.endsWith('/api/tags'))
				return new Response(
					JSON.stringify({ models: [{ name: 'qwen3:8b', digest: MEMORY_RELEVANCE_DIGEST }] })
				);
			const isHead =
				body?.format?.properties?.complete !== undefined ||
				body?.response_format?.json_schema?.schema?.properties?.complete !== undefined;
			const content = isHead
				? JSON.stringify({ facets: ['Which cipher?'], complete: true })
				: JSON.stringify({ relations: { 0: ['direct_answer'] } });
			if (isHead) heads++;
			// The hosted provider answers in the OpenAI shape, the local one in
			// Ollama's shape.
			if (url.includes('/v1/chat/completions'))
				return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
			return new Response(
				JSON.stringify({
					model: 'qwen3:8b',
					done: true,
					done_reason: 'stop',
					message: { content },
				})
			);
		};
		const relevance = new LocalMemoryRelevance(request);
		await relevance.selectRelevant('Which cipher?', candidates);
		relevance.configure({
			provider: 'hosted',
			model: 'qwen3.6',
			endpoint: 'https://api.nan.builders',
		});
		await relevance.selectRelevant('Which cipher?', candidates);
		expect(heads).toBe(2);
	});
	it('rejects oversized output rather than converting failure to abstention', async () => {
		await expect(
			gate({}, { huge: 'x'.repeat(40000) }).selectRelevant('Which cipher?', candidates)
		).rejects.toThrow('bounded output');
	});
	it('bounds the whole pipeline using monotonic time rather than resetting per-call budgets', async () => {
		const clock = vi
			.spyOn(performance, 'now')
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(120001);
		try {
			await expect(gate({}).selectRelevant('Which cipher?', candidates)).rejects.toThrow(
				'overall inference deadline'
			);
		} finally {
			clock.mockRestore();
		}
	});
});
