// VIBES v1.0 Hash Utility — Content-addressed hashing for manifest entries.
// Implements the VIBES SHA-256 hash specification for creating deterministic
// content identifiers used as manifest entry keys.

import { createHash } from 'crypto';

/**
 * Compute a VIBES-compliant SHA-256 hash for a manifest entry context object.
 *
 * Algorithm (per VIBES v1.0 spec):
 * 1. Remove `created_at` field from the context object
 * 2. Serialize to JSON with sorted keys and no whitespace
 * 3. Encode as UTF-8
 * 4. Compute SHA-256
 * 5. Return lowercase hex string (64 characters)
 */
export function computeVibesHash(context: Record<string, unknown>): string {
	// Remove created_at from a shallow copy
	const { created_at: _, ...rest } = context;

	// Serialize with sorted keys and no whitespace
	const serialized = JSON.stringify(rest, Object.keys(rest).sort());

	// SHA-256 → lowercase hex
	return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Return the first 16 hex characters of a hash for display purposes.
 */
export function shortHash(hash: string): string {
	return hash.slice(0, 16);
}
