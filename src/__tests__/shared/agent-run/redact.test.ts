import { describe, expect, it } from 'vitest';
import { redactPrompt } from '../../../shared/agent-run/redact';

/**
 * redactPrompt scrubs secret-shaped substrings to [redacted] and caps length
 * before a prompt is persisted. Contract under test: each known secret shape is
 * replaced while surrounding context is preserved, a clean prompt is returned
 * untouched, an over-long prompt is capped with a truncation marker, and an
 * absent/empty prompt collapses to undefined.
 *
 * Each fixture below matches exactly one secret pattern (its surrounding text
 * is plain), so dropping any single pattern reddens exactly its row.
 */

const PLACEHOLDER = '[redacted]';

describe('redactPrompt - secret shapes are replaced, context preserved', () => {
	const cases: { name: string; secret: string }[] = [
		{ name: 'sk- provider key', secret: 'sk-ABCDEFGHIJKLMNOP1234' },
		{ name: 'ghp_ github token', secret: 'ghp_wxyzWXYZ0123456789abcd' },
		{ name: 'github_pat_ fine-grained token', secret: 'github_pat_11ABCDEFGHIJ0123456789KL' },
		{ name: 'xoxb- slack token', secret: 'xoxb-1234567890-abcdefghij' },
		{ name: 'AKIA aws access key id', secret: 'AKIAIOSFODNN7EXAMPLE' },
		{ name: 'Bearer token', secret: 'Bearer abcdefghij1234567890' },
		{ name: 'api_key=value', secret: 'api_key=SuperSecretValue123' },
		{ name: 'password: value', secret: 'password: hunter2SecretPwd' },
		{ name: 'token=value', secret: 'token=SuperSecretXyz' },
		{
			name: 'long hex blob',
			secret: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
		},
	];

	it.each(cases)('$name is redacted in the middle of a sentence', ({ secret }) => {
		const input = `before the ${secret} after the`;
		expect(redactPrompt(input)).toBe(`before the ${PLACEHOLDER} after the`);
	});

	it.each(cases)('$name is redacted at the start of the prompt', ({ secret }) => {
		expect(redactPrompt(`${secret} trailing`)).toBe(`${PLACEHOLDER} trailing`);
	});
});

describe('redactPrompt - multiple secrets in one prompt', () => {
	it('redacts every secret and keeps the plain text between them', () => {
		const input = 'use sk-ABCDEFGHIJKLMNOP1234 then ghp_wxyzWXYZ0123456789abcd done';
		expect(redactPrompt(input)).toBe(`use ${PLACEHOLDER} then ${PLACEHOLDER} done`);
	});
});

describe('redactPrompt - clean prompts pass through unchanged', () => {
	it('leaves an ordinary prompt with no secret shapes untouched', () => {
		const clean = 'Refactor the auth module and add unit tests for the happy path.';
		expect(redactPrompt(clean)).toBe(clean);
	});

	it('does not redact a short hex string below the long-blob threshold', () => {
		// 12 hex chars: well under the 40-char credential-blob floor.
		const clean = 'commit abc123def456 landed';
		expect(redactPrompt(clean)).toBe(clean);
	});

	it('does not redact a short sk- fragment below the key-length floor', () => {
		// Only 4 chars after sk-, under the 16-char minimum.
		const clean = 'the sk-abcd token label';
		expect(redactPrompt(clean)).toBe(clean);
	});
});

describe('redactPrompt - length cap', () => {
	it('caps a prompt longer than 4000 chars and appends the truncation marker', () => {
		// Use a non-hex, non-secret char so only the cap (not redaction) applies.
		const long = 'x'.repeat(5000);
		const result = redactPrompt(long);
		expect(result).toBe(`${'x'.repeat(4000)}...[truncated 1000 chars]`);
		expect(result?.startsWith('x'.repeat(4000))).toBe(true);
		expect(result).toContain('...[truncated 1000 chars]');
	});

	it('does not truncate a prompt of exactly 4000 chars', () => {
		const exact = 'y'.repeat(4000);
		const result = redactPrompt(exact);
		expect(result).toBe(exact);
		expect(result).not.toContain('[truncated');
	});

	it('reports the truncated count against the post-redaction length', () => {
		// 4100 plain chars -> redacted length unchanged (no secrets) -> 100 over cap.
		const result = redactPrompt('z'.repeat(4100));
		expect(result).toBe(`${'z'.repeat(4000)}...[truncated 100 chars]`);
	});
});

describe('redactPrompt - absent input', () => {
	it('returns undefined for undefined', () => {
		expect(redactPrompt(undefined)).toBeUndefined();
	});

	it('returns undefined for an empty string', () => {
		expect(redactPrompt('')).toBeUndefined();
	});
});
