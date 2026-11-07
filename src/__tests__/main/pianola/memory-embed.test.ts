// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryModels } from '../../../main/pianola/memory-models';

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
