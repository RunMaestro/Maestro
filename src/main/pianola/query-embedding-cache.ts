import crypto from 'node:crypto';

export interface QueryEmbeddingSpace {
	embeddingSpace: string;
	model: string;
	revision: string;
	tokenizerRevision: string;
	dtype: string;
	device: string;
	pooling: string;
	normalize: boolean;
	dimensions: number;
	queryPrefix: string;
}

/** Process-local, bounded LRU. Retains digests, never query text; callers own their vectors. */
export class QueryEmbeddingCache {
	private readonly entries = new Map<string, { vector: Float32Array; expires: number }>();
	private readonly pending = new Map<string, Promise<Float32Array>>();
	private generation = 0;
	constructor(
		private readonly capacity = 128,
		private readonly ttlMs = 300_000,
		private readonly now: () => number = Date.now
	) {
		if (!Number.isInteger(capacity) || capacity < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0)
			throw new Error('Invalid query embedding cache bounds');
	}
	invalidate(): void {
		this.generation++;
		this.entries.clear();
		this.pending.clear();
	}
	async get(
		text: string,
		space: QueryEmbeddingSpace,
		load: () => Promise<Float32Array>
	): Promise<Float32Array> {
		const { dimensions, embeddingSpace } = space;
		const key = crypto
			.createHash('sha256')
			.update(
				JSON.stringify([
					space.embeddingSpace,
					space.model,
					space.revision,
					space.tokenizerRevision,
					space.dtype,
					space.device,
					space.pooling,
					space.normalize,
					space.dimensions,
					space.queryPrefix,
				])
			)
			.update('\0')
			.update(text)
			.digest('hex');
		const cached = this.entries.get(key);
		if (cached && cached.expires > this.now()) {
			this.entries.delete(key);
			this.entries.set(key, cached);
			return cached.vector.slice();
		}
		this.entries.delete(key);
		let promise = this.pending.get(key);
		if (!promise) {
			const generation = this.generation;
			promise = Promise.resolve()
				.then(load)
				.then((vector) => {
					if (generation !== this.generation)
						throw new Error('Query embedding invalidated during encoding');
					if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))
						throw new Error('Invalid query embedding from ' + embeddingSpace);
					const owned = vector.slice();
					this.entries.set(key, { vector: owned, expires: this.now() + this.ttlMs });
					while (this.entries.size > this.capacity)
						this.entries.delete(this.entries.keys().next().value!);
					return owned;
				});
			// More than capacity concurrent unique misses may encode, but never grow retained state.
			if (this.pending.size < this.capacity) this.pending.set(key, promise);
		}
		try {
			return (await promise).slice();
		} finally {
			if (this.pending.get(key) === promise) this.pending.delete(key);
		}
	}
}
