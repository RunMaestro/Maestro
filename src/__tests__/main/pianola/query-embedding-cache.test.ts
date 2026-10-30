// Synthetic regressions: no provider requests or model downloads.
import { describe, it, expect } from 'vitest';
import {
	QueryEmbeddingCache,
	type QueryEmbeddingSpace,
} from '../../../main/pianola/query-embedding-cache';
const space: QueryEmbeddingSpace = {
	embeddingSpace: 'synthetic:2',
	model: 'synthetic-model',
	revision: 'r1',
	tokenizerRevision: 'r1',
	dtype: 'f32',
	device: 'cpu',
	pooling: 'mean',
	normalize: true,
	dimensions: 2,
	queryPrefix: 'query: ',
};
describe('query embedding cache synthetic contracts', () => {
	it('shares concurrent work but neither encoder nor caller owns the cached vector', async () => {
		const cache = new QueryEmbeddingCache();
		let calls = 0;
		const original = new Float32Array([1, 0]);
		const load = async () => {
			calls++;
			return original;
		};
		const [first, second] = await Promise.all([
			cache.get('synthetic query', space, load),
			cache.get('synthetic query', space, load),
		]);
		expect(calls).toBe(1);
		first[0] = 9;
		original[0] = 8;
		expect([...second]).toEqual([1, 0]);
		expect([...(await cache.get('synthetic query', space, load))]).toEqual([1, 0]);
	});
	it('separates every embedding semantic and query text in its key', async () => {
		const cache = new QueryEmbeddingCache();
		let calls = 0;
		const load = async () => {
			calls++;
			return new Float32Array([1, 0]);
		};
		await cache.get('one', space, load);
		await cache.get('two', space, load);
		for (const key of Object.keys(space) as (keyof QueryEmbeddingSpace)[]) {
			const changed = {
				...space,
				[key]:
					typeof space[key] === 'boolean'
						? !space[key]
						: typeof space[key] === 'number'
							? 3
							: space[key] + '-different',
			};
			const dimensions = changed.dimensions;
			await cache.get('one', changed, async () => {
				calls++;
				return new Float32Array(dimensions).fill(1);
			});
		}
		expect(calls).toBe(2 + Object.keys(space).length);
	});
	it('evicts least recently used values, expires them, and invalidates pending loads', async () => {
		let now = 0,
			calls = 0;
		const cache = new QueryEmbeddingCache(2, 10, () => now);
		const load = async () => {
			calls++;
			return new Float32Array([1, 0]);
		};
		await cache.get('a', space, load);
		await cache.get('b', space, load);
		await cache.get('a', space, load);
		await cache.get('c', space, load);
		await cache.get('b', space, load);
		expect(calls).toBe(4);
		now = 10;
		await cache.get('b', space, load);
		expect(calls).toBe(5);
		const deferred = Promise.withResolvers<Float32Array>();
		const pending = cache.get('pending', space, () => deferred.promise);
		await Promise.resolve();
		cache.invalidate();
		deferred.resolve(new Float32Array([1, 0]));
		await expect(pending).rejects.toThrow('invalidated');
		await cache.get('b', space, load);
		expect(calls).toBe(6);
	});
	it('does not let an invalidated load delete or populate a newer same-key request', async () => {
		const cache = new QueryEmbeddingCache();
		const old = Promise.withResolvers<Float32Array>();
		const fresh = Promise.withResolvers<Float32Array>();
		const pendingOld = cache.get('same', space, () => old.promise);
		await Promise.resolve();
		cache.invalidate();
		const pendingFresh = cache.get('same', space, () => fresh.promise);
		await Promise.resolve();
		old.resolve(new Float32Array([1, 0]));
		await expect(pendingOld).rejects.toThrow('invalidated');
		const sharedFresh = cache.get('same', space, async () => {
			throw new Error('new request lost its pending entry');
		});
		fresh.resolve(new Float32Array([0, 1]));
		expect([...(await pendingFresh)]).toEqual([0, 1]);
		expect([...(await sharedFresh)]).toEqual([0, 1]);
		expect([...(await cache.get('same', space, async () => new Float32Array([1, 0])))]).toEqual([
			0, 1,
		]);
	});
	it('validates pending vectors against the keyed dimension snapshot, not a mutated descriptor', async () => {
		const cache = new QueryEmbeddingCache();
		const descriptor = { ...space };
		const deferred = Promise.withResolvers<Float32Array>();
		const pending = cache.get('mutable descriptor', descriptor, () => deferred.promise);
		await Promise.resolve();
		descriptor.dimensions = 3;
		deferred.resolve(new Float32Array([1, 0, 0]));
		await expect(pending).rejects.toThrow('Invalid query embedding');
		expect([
			...(await cache.get('mutable descriptor', space, async () => new Float32Array([1, 0]))),
		]).toEqual([1, 0]);
	});
	it('does not poison later attempts after failures or invalid vectors', async () => {
		const cache = new QueryEmbeddingCache();
		await expect(
			cache.get('a', space, async () => {
				throw new Error('synthetic encoder failure');
			})
		).rejects.toThrow('synthetic encoder failure');
		await expect(cache.get('a', space, async () => new Float32Array([NaN, 0]))).rejects.toThrow(
			'Invalid query embedding'
		);
		await expect(cache.get('a', space, async () => new Float32Array([1]))).rejects.toThrow(
			'Invalid query embedding'
		);
		expect([...(await cache.get('a', space, async () => new Float32Array([0, 1])))]).toEqual([
			0, 1,
		]);
	});
});
