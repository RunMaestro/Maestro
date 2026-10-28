/**
 * @file model-router.test.ts
 *
 * The embedding router with the embedder stubbed. What is under test is what
 * no real model would make visible:
 *
 *   - **The example vectors are built once per source**, rebuilt when the
 *     source changes, and a new correction embeds only itself.
 *   - **The build is never tied to one caller.** A caller that gives up stops
 *     waiting; the build finishes for the next one.
 *   - **A source that cannot run fails as itself**, and is asked again later.
 *
 * The stub gives each tier a direction. A prompt is routed by the tier its own
 * words name.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ embedTexts: vi.fn(), list: vi.fn() }));

vi.mock('../../../main/local-models/embeddings', () => ({
	embedTexts: mocks.embedTexts,
}));

vi.mock('../../../main/local-models/model-routing-corrections', () => ({
	getModelRoutingCorrectionStore: () => ({ list: mocks.list }),
}));

vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: () => ({}) }),
}));

import { isLocalModelCancelled, LocalModelError } from '../../../main/local-models/errors';
import {
	EmbeddingRouter,
	getEmbeddingRouter,
	type ModelRouterEmbedder,
} from '../../../main/local-models/model-router';
import type { LocalModelSource } from '../../../main/local-models/sources';
import type {
	ModelRoutingCorrection,
	ModelRoutingExample,
} from '../../../shared/local-models/model-routing';
import { MODEL_ROUTING_EXAMPLES } from '../../../shared/local-models/model-routing-examples';

const BGE: LocalModelSource = { type: 'local', modelId: 'bge-small-en-v1.5' };
const GEMMA: LocalModelSource = { type: 'local', modelId: 'embeddinggemma-300m' };
const NOMIC: LocalModelSource = { type: 'endpoint', endpointId: 'ep-1', model: 'nomic' };

/** Two examples per tier. The text says where its vector points. */
const EXAMPLES: readonly ModelRoutingExample[] = [
	{ text: 'low one', tier: 'low', effort: 'low' },
	{ text: 'low two', tier: 'low', effort: 'low' },
	{ text: 'medium one', tier: 'medium', effort: 'medium' },
	{ text: 'medium two', tier: 'medium', effort: 'low' },
	{ text: 'high one', tier: 'high', effort: 'high' },
	{ text: 'high two', tier: 'high', effort: 'high' },
];

const AXES = ['low', 'medium', 'high'];

/** Room for every text a test embeds to have a direction of its own. */
const OWN_AXES = 128;

/** The direction each text was given, in the order the texts were first seen. */
const ownAxis = new Map<string, number>();

/**
 * Half of a text's vector points along the tier its words name, half along a
 * direction no other text has. So a text matches itself exactly (similarity 1),
 * resembles a text of the same tier (0.5), and nothing else (0).
 */
function vectorFor(text: string, extraWidth = 0): Float32Array {
	const vector = new Float32Array(AXES.length + OWN_AXES + extraWidth);
	const tier = AXES.findIndex((name) => text.includes(name));
	if (!ownAxis.has(text)) ownAxis.set(text, ownAxis.size);
	vector[tier === -1 ? 0 : tier] = Math.SQRT1_2;
	vector[AXES.length + (ownAxis.get(text) as number)] = Math.SQRT1_2;
	return vector;
}

interface Stub {
	embed: ReturnType<typeof vi.fn<ModelRouterEmbedder>>;
	/** Every text embedded, one array per call. */
	calls: () => string[][];
}

function stubEmbedder(): Stub {
	const embed = vi.fn<ModelRouterEmbedder>(async (_source, texts) =>
		texts.map((text) => vectorFor(text))
	);
	return { embed, calls: () => embed.mock.calls.map((call) => [...call[1]]) };
}

function router(
	stub: Stub,
	corrections: () => readonly ModelRoutingCorrection[] = () => [],
	examples: readonly ModelRoutingExample[] = EXAMPLES
): EmbeddingRouter {
	return new EmbeddingRouter({
		embed: stub.embed,
		examples,
		corrections: async () => corrections(),
	});
}

/** A promise and the handles that settle it. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	ownAxis.clear();
	mocks.embedTexts.mockReset();
	mocks.list.mockReset();
});

describe('EmbeddingRouter.route', () => {
	it('routes a prompt to the tier and effort of its nearest neighbours', async () => {
		const decision = await router(stubEmbedder()).route(BGE, 'a high stakes redesign');
		expect(decision.tier).toBe('high');
		expect(decision.effort).toBe('high');
		expect(decision.source).toBe(BGE);
		expect(decision.exampleCount).toBe(EXAMPLES.length);
	});

	it('reports the neighbours that voted, nearest first, and the vote margin', async () => {
		const decision = await router(stubEmbedder()).route(BGE, 'a medium change');
		expect(decision.neighbours).toHaveLength(5);
		const similarities = decision.neighbours.map((neighbour) => neighbour.similarity);
		expect(similarities).toEqual([...similarities].sort((a, b) => b - a));
		expect(decision.neighbours.slice(0, 2).map((neighbour) => neighbour.tier)).toEqual([
			'medium',
			'medium',
		]);
		expect(decision.neighbours[0].origin).toBe('shipped');
		expect(decision.tier).toBe('medium');
		// Two medium neighbours at weight 2, two low and one high at weight 1.
		expect(decision.tierConfidence).toBeCloseTo(2 / 7, 5);
	});

	it('lets only as many neighbours vote as it is told to', async () => {
		const stub = stubEmbedder();
		const one = new EmbeddingRouter({
			embed: stub.embed,
			examples: EXAMPLES,
			corrections: async () => [],
			neighbours: 1,
		});
		const decision = await one.route(BGE, 'a low effort rename');
		expect(decision.neighbours).toHaveLength(1);
		expect(decision.tierConfidence).toBe(1);
	});

	it('embeds the prompt and the examples the same way', async () => {
		const stub = stubEmbedder();
		await router(stub).route(BGE, 'a low effort rename');
		expect(stub.embed.mock.calls.map((call) => call[2].mode)).toEqual(['query', 'query']);
	});

	it('routes the text as it would be stored: trimmed and with secrets replaced', async () => {
		const stub = stubEmbedder();
		await router(stub).route(BGE, `  low: deploy with sk-${'a'.repeat(40)}  `);
		const [prompt] = stub.calls()[1];
		expect(prompt.startsWith('low: deploy with ')).toBe(true);
		expect(prompt).not.toContain('sk-aaaa');
	});

	it('refuses a prompt with no text as a caller bug, before anything is embedded', async () => {
		const stub = stubEmbedder();
		await expect(router(stub).route(BGE, '  \n ')).rejects.toThrow(/no text to route/);
		expect(stub.embed).not.toHaveBeenCalled();
	});

	it('says so when there is nothing to compare with', async () => {
		await expect(router(stubEmbedder(), () => [], []).route(BGE, 'low')).rejects.toThrow(
			/no labeled examples/
		);
	});
});

describe('the example vectors', () => {
	it('are embedded once, then only the prompt is', async () => {
		const stub = stubEmbedder();
		const subject = router(stub);
		await subject.route(BGE, 'low first');
		await subject.route(BGE, 'high second');
		expect(stub.calls()).toEqual([
			EXAMPLES.map((example) => example.text),
			['low first'],
			['high second'],
		]);
	});

	it('are rebuilt when the embedding model changes', async () => {
		const stub = stubEmbedder();
		const subject = router(stub);
		await subject.route(BGE, 'low first');
		await subject.route(GEMMA, 'low second');
		const texts = EXAMPLES.map((example) => example.text);
		expect(stub.calls()).toEqual([texts, ['low first'], texts, ['low second']]);
		expect(stub.embed.mock.calls[2][0]).toBe(GEMMA);
	});

	it('are kept for one source at a time', async () => {
		const stub = stubEmbedder();
		const subject = router(stub);
		await subject.route(BGE, 'low first');
		await subject.route(NOMIC, 'low second');
		await subject.route(BGE, 'low third');
		expect(stub.calls().filter((texts) => texts.length === EXAMPLES.length)).toHaveLength(3);
	});

	it('are built ahead of the first prompt by warm', async () => {
		const stub = stubEmbedder();
		const subject = router(stub);
		await subject.warm(BGE);
		expect(stub.calls()).toEqual([EXAMPLES.map((example) => example.text)]);
		await subject.route(BGE, 'low first');
		expect(stub.calls()).toHaveLength(2);
	});

	it('are dropped by reset', async () => {
		const stub = stubEmbedder();
		const subject = router(stub);
		await subject.warm(BGE);
		subject.reset();
		await subject.warm(BGE);
		expect(stub.calls()).toHaveLength(2);
	});

	it('are shared by prompts that arrive during the build', async () => {
		const stub = stubEmbedder();
		const subject = router(stub);
		const decisions = await Promise.all([
			subject.route(BGE, 'low first'),
			subject.route(BGE, 'high second'),
		]);
		expect(decisions.map((decision) => decision.tier)).toEqual(['low', 'high']);
		expect(stub.calls().filter((texts) => texts.length === EXAMPLES.length)).toHaveLength(1);
	});

	it('are rebuilt once when a source starts answering in another width', async () => {
		let extraWidth = 0;
		const embed = vi.fn<ModelRouterEmbedder>(async (_source, texts) =>
			texts.map((text) => vectorFor(text, extraWidth))
		);
		const subject = new EmbeddingRouter({ embed, examples: EXAMPLES, corrections: async () => [] });
		await subject.route(NOMIC, 'low first');
		extraWidth = 1;
		const decision = await subject.route(NOMIC, 'high second');
		expect(decision.tier).toBe('high');
		expect(decision.neighbours.every((neighbour) => Number.isFinite(neighbour.similarity))).toBe(
			true
		);
		// Built, prompt, prompt (wrong width), rebuilt, prompt.
		expect(embed).toHaveBeenCalledTimes(5);
	});

	it('fail by name when a source keeps answering in more than one width', async () => {
		const embed = vi.fn<ModelRouterEmbedder>(async (_source, texts) =>
			texts.map((text) => vectorFor(text, texts.length === 1 ? 1 : 0))
		);
		const subject = new EmbeddingRouter({ embed, examples: EXAMPLES, corrections: async () => [] });
		await expect(subject.route(NOMIC, 'low first')).rejects.toThrow(
			'endpoint:ep-1:nomic returned embeddings of more than one width.'
		);
	});
});

describe('corrections', () => {
	it('change what the corrected prompt routes to', async () => {
		const corrections: ModelRoutingCorrection[] = [];
		const subject = router(stubEmbedder(), () => corrections);
		expect((await subject.route(BGE, 'low looking, but it is a migration')).tier).toBe('low');

		corrections.push({ text: 'low looking, but it is a migration', tier: 'high', recordedAt: 1 });
		const decision = await subject.route(BGE, 'low looking, but it is a migration');
		expect(decision.tier).toBe('high');
		expect(decision.neighbours[0]).toMatchObject({ origin: 'correction', tier: 'high' });
		expect(decision.neighbours[0].similarity).toBeCloseTo(1, 5);
		expect(decision.exampleCount).toBe(EXAMPLES.length + 1);
	});

	it('embed only themselves when they are new', async () => {
		const corrections: ModelRoutingCorrection[] = [];
		const stub = stubEmbedder();
		const subject = router(stub, () => corrections);
		await subject.route(BGE, 'low first');
		corrections.push({ text: 'medium correction', tier: 'high', recordedAt: 1 });
		await subject.route(BGE, 'low second');
		expect(stub.calls()).toEqual([
			EXAMPLES.map((example) => example.text),
			['low first'],
			['medium correction'],
			['low second'],
		]);
	});

	it('leave the effort to the labeled neighbours when they carry none', async () => {
		const subject = router(stubEmbedder(), () => [
			{ text: 'low looking migration', tier: 'high', recordedAt: 1 },
		]);
		const decision = await subject.route(BGE, 'low looking migration');
		expect(decision.tier).toBe('high');
		expect(decision.effort).toBe('low');
	});

	it('stop voting once they are cleared', async () => {
		let corrections: ModelRoutingCorrection[] = [
			{ text: 'low looking migration', tier: 'high', recordedAt: 1 },
		];
		const subject = router(stubEmbedder(), () => corrections);
		expect((await subject.route(BGE, 'low looking migration')).tier).toBe('high');
		corrections = [];
		const decision = await subject.route(BGE, 'low looking migration');
		expect(decision.tier).toBe('low');
		expect(decision.exampleCount).toBe(EXAMPLES.length);
	});
});

describe('a caller that stops waiting', () => {
	it('is cancelled, and the build finishes for the next prompt', async () => {
		const build = deferred<Float32Array[]>();
		const embed = vi.fn<ModelRouterEmbedder>(async (_source, texts) =>
			texts.length === 1 ? texts.map((text) => vectorFor(text)) : build.promise
		);
		const subject = new EmbeddingRouter({ embed, examples: EXAMPLES, corrections: async () => [] });

		const controller = new AbortController();
		const first = subject.route(BGE, 'low first', { signal: controller.signal });
		await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
		controller.abort();
		const error = await first.catch((caught) => caught);
		expect(isLocalModelCancelled(error)).toBe(true);

		// The build was started without the caller's signal, so it is still running.
		expect(embed.mock.calls[0][2].signal).toBeUndefined();
		build.resolve(EXAMPLES.map((example) => vectorFor(example.text)));

		const decision = await subject.route(BGE, 'high second');
		expect(decision.tier).toBe('high');
		expect(embed.mock.calls.filter((call) => call[1].length === EXAMPLES.length)).toHaveLength(1);
	});

	it('is cancelled at once when its signal was already aborted', async () => {
		const stub = stubEmbedder();
		const controller = new AbortController();
		controller.abort();
		const error = await router(stub)
			.route(BGE, 'low first', { signal: controller.signal })
			.catch((caught) => caught);
		expect(isLocalModelCancelled(error)).toBe(true);
	});

	it('hands its signal to the embedding of its own prompt', async () => {
		const stub = stubEmbedder();
		const controller = new AbortController();
		await router(stub).route(BGE, 'low first', { signal: controller.signal });
		expect(stub.embed.mock.calls[1][2].signal).toBe(controller.signal);
	});
});

describe('a source that cannot run', () => {
	it('fails as itself, and is asked again by the next prompt', async () => {
		const failure = new LocalModelError('BGE Small is not downloaded.', {
			code: 'model-not-installed',
			recovery: 'Download it in Settings, Models.',
			consumerId: 'local-models:embeddings',
		});
		const stub = stubEmbedder();
		stub.embed.mockRejectedValueOnce(failure);
		const subject = router(stub);

		await expect(subject.route(BGE, 'low first')).rejects.toBe(failure);
		expect((await subject.route(BGE, 'low second')).tier).toBe('low');
		expect(stub.calls().filter((texts) => texts.length === EXAMPLES.length)).toHaveLength(2);
	});

	it('fails every prompt that was waiting on the same build', async () => {
		const failure = new Error('server down');
		const stub = stubEmbedder();
		stub.embed.mockRejectedValueOnce(failure);
		const subject = router(stub);
		const results = await Promise.allSettled([
			subject.route(BGE, 'low first'),
			subject.route(BGE, 'high second'),
		]);
		expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
	});

	it('is a bug in the embedder when it returns the wrong number of vectors', async () => {
		const embed = vi.fn<ModelRouterEmbedder>(async () => [vectorFor('low')]);
		const subject = new EmbeddingRouter({ embed, examples: EXAMPLES, corrections: async () => [] });
		await expect(subject.route(BGE, 'low first')).rejects.toThrow(
			'local:bge-small-en-v1.5 returned 1 embeddings for 6 texts.'
		);
	});
});

describe('getEmbeddingRouter', () => {
	it('is one router over embedTexts, the shipped examples and the corrections store', async () => {
		mocks.embedTexts.mockImplementation(async (_source: LocalModelSource, texts: string[]) =>
			texts.map((text) => vectorFor(text))
		);
		mocks.list.mockResolvedValue([]);
		const subject = getEmbeddingRouter();
		expect(getEmbeddingRouter()).toBe(subject);

		const decision = await subject.route(BGE, 'rename this variable');
		expect(decision.exampleCount).toBe(MODEL_ROUTING_EXAMPLES.length);
		expect(mocks.list).toHaveBeenCalled();
		expect(mocks.embedTexts.mock.calls[0][1]).toHaveLength(MODEL_ROUTING_EXAMPLES.length);
	});
});
