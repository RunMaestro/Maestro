/**
 * Vector arithmetic for embeddings.
 *
 * Its own leaf module (no imports) because two things need it and neither
 * should pull in the other: the embedding service normalizes what a model
 * produced, and the embedding store compares what was stored. The store must
 * not load ONNX Runtime wiring to compute a dot product.
 */

/** Scale a vector to unit length in place. A zero vector is returned unchanged. */
export function l2Normalize(vector: Float32Array): Float32Array {
	let sum = 0;
	for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
	const norm = Math.sqrt(sum);
	if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] /= norm;
	return vector;
}

/**
 * Dot product of two vectors of the same length. For unit vectors this IS the
 * cosine similarity, which is why every stored vector is normalized first.
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
	return sum;
}
