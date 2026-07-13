import { describe, expect, it } from 'vitest';
import {
	OmpProviderCredentialStore,
	type OmpCredentialSettingsStore,
	type OmpSafeStorage,
} from '../../../main/plugins/omp-provider-credential-store';

class MemorySettings implements OmpCredentialSettingsStore {
	readonly values: Record<string, unknown>;

	constructor(values: Record<string, unknown> = {}) {
		this.values = { ...values };
	}

	get<T>(key: string, defaultValue?: T): T {
		return (key in this.values ? this.values[key] : defaultValue) as T;
	}

	set(key: string, value: unknown): void {
		this.values[key] = value;
	}
}

function fakeSafeStorage(available = true): OmpSafeStorage {
	return {
		isEncryptionAvailable: () => available,
		encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
		decryptString: (value) => {
			const plaintext = value.toString('utf8');
			if (!plaintext.startsWith('sealed:')) throw new Error('invalid seal');
			return plaintext.slice('sealed:'.length);
		},
	};
}

const ANTHROPIC_KEY = 'test-anthropic-key-12345';
const OPENAI_KEY = 'test-openai-key-12345';

describe('OmpProviderCredentialStore', () => {
	it('maps only an explicitly configured recognized Maestro provider apiKey into the child environment', () => {
		const store = new OmpProviderCredentialStore(
			new MemorySettings({
				llmProvider: 'anthropic',
				modelSlug: 'anthropic/claude-sonnet-4-5',
				apiKey: ANTHROPIC_KEY,
			}),
			fakeSafeStorage()
		);

		const result = store.resolveForPrompt();

		expect(result.status).toBe('ready');
		expect(result.providerIds).toEqual(['anthropic']);
		expect(result.authEnvironment.toChildEnvironment()).toEqual({
			ANTHROPIC_API_KEY: ANTHROPIC_KEY,
		});
	});

	it('uses only exact allowlisted shellEnvVars and ignores unknown or secret-looking extras', () => {
		const store = new OmpProviderCredentialStore(
			new MemorySettings({
				shellEnvVars: {
					OPENAI_API_KEY: OPENAI_KEY,
					AWS_SECRET_ACCESS_KEY: 'never-forward-this',
					CUSTOM_SECRET: 'never-forward-this-either',
					ANTHROPIC_API_KEY_EXTRA: ANTHROPIC_KEY,
				},
			}),
			fakeSafeStorage()
		);

		const result = store.resolveForPrompt('openai/gpt-5.2');

		expect(result.status).toBe('ready');
		expect(result.providerIds).toEqual(['openai']);
		expect(result.authEnvironment.toChildEnvironment()).toEqual({ OPENAI_API_KEY: OPENAI_KEY });
	});

	it('never reads ambient process environment credentials', () => {
		const prior = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = 'ambient-credential-must-not-be-used';
		try {
			const result = new OmpProviderCredentialStore(
				new MemorySettings(),
				fakeSafeStorage()
			).resolveForPrompt();
			expect(result.status).toBe('auth_required');
			expect(result.authEnvironment.toChildEnvironment()).toEqual({});
		} finally {
			if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = prior;
		}
	});

	it.each([
		['missing', undefined],
		['empty', ''],
		['whitespace', '   '],
		['malformed newline', 'test-key\nforbidden'],
		['malformed too short', 'short'],
	])('returns actionable auth_required for %s explicit API keys', (_case, apiKey) => {
		const result = new OmpProviderCredentialStore(
			new MemorySettings({ llmProvider: 'anthropic', apiKey }),
			fakeSafeStorage()
		).resolveForPrompt();

		expect(result).toMatchObject({
			status: 'auth_required',
			reason: 'no_compatible_credential',
			providerIds: [],
		});
		expect(result.authEnvironment.toChildEnvironment()).toEqual({});
	});

	it('does not use an Anthropic key for an OpenAI-qualified model', () => {
		const result = new OmpProviderCredentialStore(
			new MemorySettings({ llmProvider: 'anthropic', apiKey: ANTHROPIC_KEY }),
			fakeSafeStorage()
		).resolveForPrompt('openai/gpt-5.2');

		expect(result).toMatchObject({
			status: 'auth_required',
			reason: 'no_compatible_credential',
			providerIds: ['anthropic'],
		});
	});

	it('rejects unknown qualified model providers without trying a configured credential', () => {
		const result = new OmpProviderCredentialStore(
			new MemorySettings({ llmProvider: 'anthropic', apiKey: ANTHROPIC_KEY }),
			fakeSafeStorage()
		).resolveForPrompt('not-a-provider/model');

		expect(result).toMatchObject({
			status: 'auth_required',
			reason: 'unknown_model_provider',
			providerIds: ['anthropic'],
		});
	});

	it('seals dedicated OMP credentials, observes rotation, and revokes them without retaining plaintext settings', () => {
		const settings = new MemorySettings();
		const store = new OmpProviderCredentialStore(settings, fakeSafeStorage());

		expect(store.setCredential('openai', OPENAI_KEY, 'openai/gpt-5.2')).toBe(true);
		expect(JSON.stringify(settings.values)).not.toContain(OPENAI_KEY);
		expect(store.resolveForPrompt('openai/gpt-5.2').authEnvironment.toChildEnvironment()).toEqual({
			OPENAI_API_KEY: OPENAI_KEY,
		});

		const rotated = 'test-openai-key-rotated-12345';
		expect(store.setCredential('openai', rotated, 'openai/gpt-5.2')).toBe(true);
		expect(store.resolveForPrompt('openai/gpt-5.2').authEnvironment.toChildEnvironment()).toEqual({
			OPENAI_API_KEY: rotated,
		});

		store.revokeCredential('openai');
		expect(store.resolveForPrompt('openai/gpt-5.2')).toMatchObject({
			status: 'auth_required',
			providerIds: [],
		});
	});

	it('fails closed for dedicated credentials when safeStorage is unavailable or encrypted data is malformed', () => {
		const unavailableSettings = new MemorySettings();
		const unavailable = new OmpProviderCredentialStore(unavailableSettings, fakeSafeStorage(false));
		expect(unavailable.setCredential('anthropic', ANTHROPIC_KEY)).toBe(false);
		expect(unavailable.resolveForPrompt()).toMatchObject({
			status: 'auth_required',
			providerIds: [],
		});

		const malformed = new OmpProviderCredentialStore(
			new MemorySettings({
				ompProviderCredentials: { anthropic: { sealedApiKey: 'not-a-valid-seal' } },
			}),
			fakeSafeStorage()
		);
		expect(malformed.resolveForPrompt()).toMatchObject({
			status: 'auth_required',
			providerIds: [],
		});
	});

	it('keeps secrets out of public auth status, JSON serialization, and object enumeration while allowing the trusted child to receive them', () => {
		const result = new OmpProviderCredentialStore(
			new MemorySettings({ llmProvider: 'anthropic', apiKey: ANTHROPIC_KEY }),
			fakeSafeStorage()
		).resolveForPrompt();

		const publicStatus = result.toPublicStatus();
		expect(publicStatus).toEqual({ status: 'ready', providerIds: ['anthropic'] });
		expect(JSON.stringify(result)).not.toContain(ANTHROPIC_KEY);
		expect(JSON.stringify(result.authEnvironment)).toBeUndefined();
		expect(Object.values(result.authEnvironment).join(' ')).not.toContain(ANTHROPIC_KEY);
		expect(result.authEnvironment.toChildEnvironment()).toEqual({
			ANTHROPIC_API_KEY: ANTHROPIC_KEY,
		});
		expect(Object.isFrozen(result.authEnvironment.toChildEnvironment())).toBe(true);
	});
});
