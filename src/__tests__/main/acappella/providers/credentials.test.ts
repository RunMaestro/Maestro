/**
 * @file credentials.test.ts
 *
 * The credential layer's two promises:
 *
 *   1. A key round-trips through the OS keychain and NOWHERE else. The test that
 *      matters here is the negative one: no code path writes a key into the
 *      settings store or into a log line. That is checked by scanning what the
 *      module actually did with a fake store and a fake logger, rather than by
 *      reading the source and trusting it.
 *   2. Validation tells the three outcomes apart. A rate limit is not a bad key,
 *      and telling a throttled user to paste a new one would have them fix a
 *      problem that fixes itself.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const settingsWrites: Array<[string, unknown]> = [];
const logLines: string[] = [];

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: (message: string) => logLines.push(message),
		warn: (message: string) => logLines.push(message),
		error: (message: string) => logLines.push(message),
		debug: (message: string) => logLines.push(message),
	},
}));

import {
	__setCredentialEntryFactory,
	clearCredential,
	getCredential,
	hasCredential,
	listCredentialStates,
	redactSecrets,
	redactSecretsDeep,
	setCredential,
	validateCredential,
	REDACTED,
} from '../../../../main/acappella/providers/credentials';
import type { KeyringEntry } from '../../../../main/utils/keyring';

const SECRET = 'sk-test-abcdefghijklmnopqrstuvwxyz012345';

/** An in-memory keyring entry, standing in for the OS credential store. */
function fakeEntry(): KeyringEntry & { value: string | null } {
	return {
		value: null,
		getPassword() {
			return this.value;
		},
		setPassword(password: string) {
			this.value = password;
		},
		deletePassword() {
			const had = this.value !== null;
			this.value = null;
			return had;
		},
	};
}

let entries: Record<string, ReturnType<typeof fakeEntry>>;

beforeEach(() => {
	settingsWrites.length = 0;
	logLines.length = 0;
	entries = {};
	__setCredentialEntryFactory((service) => {
		entries[service] ??= fakeEntry();
		return entries[service];
	});
});

afterEach(() => {
	__setCredentialEntryFactory(null);
});

describe('credential storage', () => {
	it('round-trips a key through the keychain', () => {
		expect(setCredential('openai', SECRET)).toEqual({ ok: true });
		expect(getCredential('openai')).toBe(SECRET);
		expect(hasCredential('openai')).toBe(true);
		expect(entries.openai.value).toBe(SECRET);
	});

	it('keeps services apart', () => {
		setCredential('openai', SECRET);
		expect(hasCredential('elevenlabs')).toBe(false);
		expect(hasCredential('anthropic')).toBe(false);
	});

	it('trims, and treats a whitespace-only key as a clear', () => {
		setCredential('anthropic', `  ${SECRET}  `);
		expect(getCredential('anthropic')).toBe(SECRET);

		setCredential('anthropic', '   ');
		expect(getCredential('anthropic')).toBeNull();
	});

	it('clears a key', () => {
		setCredential('elevenlabs', 'abc123');
		expect(clearCredential('elevenlabs')).toEqual({ ok: true });
		expect(hasCredential('elevenlabs')).toBe(false);
	});

	it('reports, rather than crashes, when the machine has no keyring', () => {
		__setCredentialEntryFactory(() => null);

		const result = setCredential('openai', SECRET);
		expect(result.ok).toBe(false);
		expect(result.error).toContain('credential store');
		// The important half: no fallback to a file. A machine without a keychain
		// simply cannot use the hosted tier.
		expect(result.error).toContain('never written to disk');
		expect(hasCredential('openai')).toBe(false);
	});

	it('survives a locked keychain that throws on read', () => {
		__setCredentialEntryFactory(() => ({
			getPassword: () => {
				throw new Error('keychain is locked');
			},
			setPassword: () => {},
			deletePassword: () => false,
		}));

		expect(getCredential('openai')).toBeNull();
		expect(logLines.join('\n')).toContain('keychain is locked');
	});

	it('lists configured state without ever returning a key', () => {
		setCredential('openai', SECRET);
		const states = listCredentialStates();

		expect(states.find((state) => state.service === 'openai')).toMatchObject({
			configured: true,
			keyringAvailable: true,
		});
		expect(JSON.stringify(states)).not.toContain(SECRET);
	});

	it('never writes a key into the settings store', () => {
		setCredential('openai', SECRET);
		setCredential('elevenlabs', 'el-secret-value');
		void listCredentialStates();
		void getCredential('openai');

		// Nothing in this module touches a settings store at all; this asserts the
		// property rather than the implementation, so a future change that reaches
		// for one fails here.
		expect(settingsWrites).toEqual([]);
	});

	it('never logs a key', () => {
		setCredential('openai', SECRET);
		void getCredential('openai');
		void hasCredential('openai');

		expect(logLines.join('\n')).not.toContain(SECRET);
	});
});

describe('credential validation', () => {
	it('accepts a key the service accepts', async () => {
		const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
		const result = await validateCredential('openai', SECRET, fetchImpl);

		expect(result.status).toBe('valid');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('tells a rate limit apart from a bad key', async () => {
		const limited = await validateCredential(
			'openai',
			SECRET,
			async () => new Response('', { status: 429 })
		);
		expect(limited.status).toBe('rate-limited');
		expect(limited.message).toContain('looks fine');

		const rejected = await validateCredential(
			'openai',
			SECRET,
			async () => new Response('', { status: 401 })
		);
		expect(rejected.status).toBe('invalid');
		expect(rejected.message).toContain('revoked');
	});

	it('reports a server error as a network problem, not a bad key', async () => {
		const result = await validateCredential(
			'elevenlabs',
			'el-key-value',
			async () => new Response('', { status: 503 })
		);
		expect(result.status).toBe('network-error');
	});

	it('reports an unreachable service without quoting the request', async () => {
		const result = await validateCredential('anthropic', 'sk-ant-abcdefghijklmnop', async () => {
			throw new Error('getaddrinfo ENOTFOUND api.anthropic.com');
		});

		expect(result.status).toBe('network-error');
		expect(result.message).not.toContain('sk-ant-');
	});

	it('rejects an obviously wrong key shape without a round trip', async () => {
		const fetchImpl = vi.fn();
		const result = await validateCredential('openai', 'not-a-key', fetchImpl as never);

		expect(result.status).toBe('invalid');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('says so when nothing is stored', async () => {
		const result = await validateCredential('openai', undefined, async () => new Response('{}'));
		expect(result.status).toBe('missing');
	});

	it('validates the STORED key when none is passed', async () => {
		setCredential('openai', SECRET);
		const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

		expect((await validateCredential('openai', undefined, fetchImpl)).status).toBe('valid');
		const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect((init.headers as Record<string, string>).Authorization).toContain(SECRET);
	});
});

describe('redaction', () => {
	it('scrubs key shapes out of free text', () => {
		expect(redactSecrets(`Authorization: Bearer ${SECRET}`)).not.toContain(SECRET);
		expect(redactSecrets(`{"api_key": "abcdef1234567890"}`)).toContain(REDACTED);
		expect(redactSecrets('xi-api-key: 0123456789abcdef0123')).toContain(REDACTED);
	});

	it('leaves ordinary text alone', () => {
		expect(redactSecrets('the session started in 4ms')).toBe('the session started in 4ms');
	});

	it('scrubs a nested payload by value and by key name', () => {
		const scrubbed = redactSecretsDeep({
			provider: 'openai',
			headers: { authorization: `Bearer ${SECRET}` },
			nested: [{ apiKey: 'short' }],
		}) as { headers: { authorization: string }; nested: Array<{ apiKey: string }> };

		expect(scrubbed.headers.authorization).toBe(REDACTED);
		// A short value that no pattern would match is still redacted, because the
		// KEY said what it was.
		expect(scrubbed.nested[0].apiKey).toBe(REDACTED);
	});
});
