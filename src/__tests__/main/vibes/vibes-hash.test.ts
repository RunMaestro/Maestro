/**
 * Tests for src/main/vibes/vibes-hash.ts
 * Validates the VIBES v1.0 hash specification: SHA-256 content-addressed
 * hashing with sorted keys, created_at removal, and short hash display.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { computeVibesHash, shortHash } from '../../../main/vibes/vibes-hash';

describe('vibes-hash', () => {
	// ========================================================================
	// computeVibesHash
	// ========================================================================
	describe('computeVibesHash', () => {
		it('should return a 64-character lowercase hex string', () => {
			const hash = computeVibesHash({ type: 'environment', tool_name: 'test' });
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should exclude created_at from the hash', () => {
			const context = {
				type: 'environment',
				tool_name: 'maestro',
				created_at: '2026-01-01T00:00:00Z',
			};
			const hashWithDate = computeVibesHash(context);

			const contextDifferentDate = {
				...context,
				created_at: '2026-12-31T23:59:59Z',
			};
			const hashWithDifferentDate = computeVibesHash(contextDifferentDate);

			expect(hashWithDate).toBe(hashWithDifferentDate);
		});

		it('should produce the same hash regardless of key order', () => {
			const contextA = {
				type: 'environment',
				tool_name: 'maestro',
				tool_version: '1.0',
				model_name: 'claude',
			};
			const contextB = {
				model_name: 'claude',
				tool_version: '1.0',
				type: 'environment',
				tool_name: 'maestro',
			};

			expect(computeVibesHash(contextA)).toBe(computeVibesHash(contextB));
		});

		it('should produce different hashes for different content', () => {
			const hashA = computeVibesHash({ type: 'environment', tool_name: 'maestro' });
			const hashB = computeVibesHash({ type: 'environment', tool_name: 'codex' });

			expect(hashA).not.toBe(hashB);
		});

		it('should handle empty objects', () => {
			const hash = computeVibesHash({});
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
			// SHA-256 of "{}" should be deterministic
			const expected = createHash('sha256').update('{}', 'utf8').digest('hex');
			expect(hash).toBe(expected);
		});

		it('should handle objects with only created_at', () => {
			const hash = computeVibesHash({ created_at: '2026-01-01T00:00:00Z' });
			const emptyHash = computeVibesHash({});
			expect(hash).toBe(emptyHash);
		});

		it('should produce a valid SHA-256 for a known input', () => {
			// Manually compute expected hash for verification
			const context = { model_name: 'claude', type: 'environment' };
			// Sorted keys: model_name, type → {"model_name":"claude","type":"environment"}
			const serialized = '{"model_name":"claude","type":"environment"}';
			const expected = createHash('sha256').update(serialized, 'utf8').digest('hex');

			expect(computeVibesHash(context)).toBe(expected);
		});

		it('should handle nested objects', () => {
			const context = {
				type: 'environment',
				model_parameters: { temperature: 0.7, top_p: 0.9 },
				created_at: '2026-01-01T00:00:00Z',
			};
			const hash = computeVibesHash(context);
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should handle arrays in values', () => {
			const context = {
				type: 'environment',
				tool_extensions: ['ext1', 'ext2'],
			};
			const hash = computeVibesHash(context);
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should handle unicode strings', () => {
			const context = {
				type: 'prompt',
				prompt_text: 'Hello \u4e16\u754c \ud83c\udf0d',
			};
			const hash = computeVibesHash(context);
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should handle null and undefined values', () => {
			const contextA = { type: 'command', value: null };
			const contextB = { type: 'command', value: undefined };

			// null serializes to "null", undefined is omitted by JSON.stringify
			const hashA = computeVibesHash(contextA);
			const hashB = computeVibesHash(contextB);
			expect(hashA).not.toBe(hashB);
		});

		it('should handle numeric values', () => {
			const context = {
				type: 'command',
				command_exit_code: 0,
				created_at: '2026-01-01T00:00:00Z',
			};
			const hash = computeVibesHash(context);
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it('should be deterministic across multiple calls', () => {
			const context = {
				type: 'environment',
				tool_name: 'maestro',
				tool_version: '2.0',
				model_name: 'claude-4',
				model_version: 'opus',
				created_at: '2026-02-10T12:00:00Z',
			};

			const hash1 = computeVibesHash(context);
			const hash2 = computeVibesHash(context);
			const hash3 = computeVibesHash(context);

			expect(hash1).toBe(hash2);
			expect(hash2).toBe(hash3);
		});
	});

	// ========================================================================
	// shortHash
	// ========================================================================
	describe('shortHash', () => {
		it('should return the first 16 characters of a hash', () => {
			const fullHash = 'a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890';
			expect(shortHash(fullHash)).toBe('a1b2c3d4e5f67890');
		});

		it('should handle hashes shorter than 16 characters', () => {
			expect(shortHash('abcdef')).toBe('abcdef');
		});

		it('should handle empty string', () => {
			expect(shortHash('')).toBe('');
		});

		it('should return exactly 16 characters for a 64-char hash', () => {
			const hash = computeVibesHash({ type: 'test' });
			const short = shortHash(hash);
			expect(short).toHaveLength(16);
			expect(hash.startsWith(short)).toBe(true);
		});

		it('should work with computeVibesHash output', () => {
			const context = {
				type: 'environment',
				tool_name: 'maestro',
				created_at: '2026-01-01T00:00:00Z',
			};
			const hash = computeVibesHash(context);
			const short = shortHash(hash);

			expect(short).toHaveLength(16);
			expect(short).toMatch(/^[0-9a-f]{16}$/);
		});
	});
});
