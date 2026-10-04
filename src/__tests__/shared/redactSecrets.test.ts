import { describe, expect, it } from 'vitest';
import { passesLuhn, redactSecrets } from '../../shared/redactSecrets';

describe('redactSecrets - typed placeholders', () => {
	it.each([
		['sk- provider key', 'use sk-ABCDEFGHIJKLMNOP1234 now', 'use [REDACTED_API_KEY] now'],
		[
			'sk-proj style key with dashes',
			'k sk-proj-abcDEF1234567890xyz end',
			'k [REDACTED_API_KEY] end',
		],
		['ghp_ token', 'tok ghp_wxyzWXYZ0123456789abcd x', 'tok [REDACTED_API_KEY] x'],
		['github_pat_ token', 'a github_pat_11ABCDEFGHIJ0123456789KL b', 'a [REDACTED_API_KEY] b'],
		['slack token', 'xoxb-1234567890-abcdefghij here', '[REDACTED_API_KEY] here'],
		['AWS access key id', 'id AKIAIOSFODNN7EXAMPLE ok', 'id [REDACTED_AWS_ACCESS_KEY] ok'],
		['AWS temporary key id', 'id ASIAIOSFODNN7EXAMPLE ok', 'id [REDACTED_AWS_ACCESS_KEY] ok'],
		[
			'Authorization header',
			'Authorization: Bearer abcdefghij1234567890',
			'Authorization: Bearer [REDACTED_BEARER_TOKEN]',
		],
		['password: value', 'password: hunter2SecretPwd', 'password: [REDACTED_SECRET]'],
		['prefixed env key', 'OPENAI_API_KEY=sk-openai-secret-key', 'OPENAI_API_KEY=[REDACTED_SECRET]'],
		['quoted value', 'api_key: "two words"', 'api_key: [REDACTED_SECRET]'],
		[
			'aws secret access key',
			'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG',
			'aws_secret_access_key = [REDACTED_SECRET]',
		],
	])('%s', (_name, input, expected) => {
		const result = redactSecrets(input);
		expect(result.text).toBe(expected);
		expect(result.redacted).toBe(true);
	});

	it('redacts a JWT', () => {
		const jwt =
			'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
		expect(redactSecrets(`cookie ${jwt} end`).text).toBe('cookie [REDACTED_SECRET] end');
	});

	it('redacts a private key block, including one cut off without an END line', () => {
		const block =
			'-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
		expect(redactSecrets(`before\n${block}\nafter`).text).toBe('before\n[REDACTED_SECRET]\nafter');
		expect(redactSecrets('x -----BEGIN PRIVATE KEY-----\nMIIEvQ').text).toBe('x [REDACTED_SECRET]');
	});

	it('redacts Luhn-valid card numbers, grouped or not', () => {
		expect(redactSecrets('card 4111 1111 1111 1111 exp').text).toBe(
			'card [REDACTED_CREDIT_CARD] exp'
		);
		expect(redactSecrets('card 4111-1111-1111-1111').text).toBe('card [REDACTED_CREDIT_CARD]');
		expect(redactSecrets('amex 378282246310005.').text).toBe('amex [REDACTED_CREDIT_CARD].');
	});

	it('leaves digit runs that fail Luhn, are too short, or are one repeated digit', () => {
		for (const clean of [
			'order 4111 1111 1111 1112',
			'phone 1-800-555-1234',
			'id 0000 0000 0000 0000',
			'build 1234567890123456789012345',
		]) {
			expect(redactSecrets(clean)).toEqual({ text: clean, redacted: false });
		}
	});

	it('leaves git SHAs alone by default and redacts hex blobs only on request', () => {
		const sha = 'commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef landed';
		expect(redactSecrets(sha).text).toBe(sha);
		expect(redactSecrets(sha, { hexBlobs: true }).text).toBe('commit [REDACTED_SECRET] landed');
	});

	it('leaves ordinary text untouched', () => {
		const clean = 'Refactor the auth module; the sk-abcd label and token count are fine.';
		expect(redactSecrets(clean)).toEqual({ text: clean, redacted: false });
		expect(redactSecrets('')).toEqual({ text: '', redacted: false });
	});
});

describe('redactSecrets - options', () => {
	it('placeholder replaces the whole match, key included', () => {
		expect(
			redactSecrets('the password: x1 and Bearer abcdefghij1234567890', { placeholder: '#' }).text
		).toBe('the # and #');
	});

	it('labels relabel a kind but keep the prefix', () => {
		const out = redactSecrets(
			'Authorization: Bearer abcdefghij1234567890 ghp_wxyzWXYZ0123456789abcd',
			{
				labels: { bearer: '[REDACTED]', github_token: '[REDACTED_GITHUB_TOKEN]' },
			}
		);
		expect(out.text).toBe('Authorization: Bearer [REDACTED] [REDACTED_GITHUB_TOKEN]');
	});
});

describe('passesLuhn', () => {
	it('validates known numbers', () => {
		expect(passesLuhn('4111111111111111')).toBe(true);
		expect(passesLuhn('4111111111111112')).toBe(false);
		expect(passesLuhn('41x1')).toBe(false);
	});
});

describe('redactSecrets - adversarial input stays linear (ReDoS)', () => {
	const K = 64 * 1024;
	const adversarial: Record<string, string> = {
		'hyphen chain': 'a-'.repeat(K / 2),
		'hyphen chain ending in a key name': `${'a-'.repeat(K / 2)}password`,
		'underscore chain': 'a_'.repeat(K / 2),
		'repeated eyJ- (JWT starts)': 'eyJ-'.repeat(K / 4),
		'JWT-like dotted runs': 'eyJaaaaaaaaaa.'.repeat(Math.floor(K / 14)),
		'repeated sk-': 'sk-'.repeat(Math.floor(K / 3)),
		'repeated xoxb-': 'xoxb-'.repeat(Math.floor(K / 5)),
		'repeated Bearer': 'Bearer '.repeat(Math.floor(K / 7)),
		'PEM header parts': '-----BEGIN A '.repeat(Math.floor(K / 13)),
		'unterminated PEM headers': '-----BEGIN PRIVATE KEY-----'.repeat(Math.floor(K / 27)),
		'spaced digits': '1 '.repeat(K / 2),
		'dashed digits': '1-'.repeat(K / 2),
		'repeated token=': 'token='.repeat(K / 6),
		'hex-ish hyphen chain': 'ab-'.repeat(Math.floor(K / 3)),
		'one long word': 'a'.repeat(K),
	};

	it.each(Object.entries(adversarial))('%s redacts in under 50 ms', (_name, input) => {
		const start = performance.now();
		redactSecrets(input, { hexBlobs: true });
		expect(performance.now() - start).toBeLessThan(50);
	});
});
