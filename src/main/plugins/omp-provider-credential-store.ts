/**
 * Host-only credential resolver for packaged Oh My Pi runtimes.
 *
 * This module deliberately has no IPC, renderer, plugin, logger, or process.env
 * dependency. Its only secret-bearing value is an opaque auth environment that
 * can be materialized by the trusted main-process child spawner. JSON and normal
 * enumeration expose only public provider/status metadata.
 */

export const OMP_PROVIDER_ENVIRONMENT_KEYS = {
	anthropic: 'ANTHROPIC_API_KEY',
	openai: 'OPENAI_API_KEY',
	google: 'GEMINI_API_KEY',
	groq: 'GROQ_API_KEY',
	openrouter: 'OPENROUTER_API_KEY',
	xai: 'XAI_API_KEY',
	mistral: 'MISTRAL_API_KEY',
	cerebras: 'CEREBRAS_API_KEY',
	together: 'TOGETHER_API_KEY',
	deepseek: 'DEEPSEEK_API_KEY',
} as const;

export type OmpProviderId = keyof typeof OMP_PROVIDER_ENVIRONMENT_KEYS;
export type OmpAuthStatus = 'ready' | 'auth_required';
export type OmpAuthRequiredReason = 'no_compatible_credential' | 'unknown_model_provider';

const PROVIDER_IDS = Object.freeze(Object.keys(OMP_PROVIDER_ENVIRONMENT_KEYS) as OmpProviderId[]);
const PROVIDER_ALIASES: Readonly<Record<string, OmpProviderId>> = Object.freeze({
	anthropic: 'anthropic',
	openai: 'openai',
	google: 'google',
	gemini: 'google',
	groq: 'groq',
	openrouter: 'openrouter',
	xai: 'xai',
	mistral: 'mistral',
	cerebras: 'cerebras',
	together: 'together',
	deepseek: 'deepseek',
});

const OMP_PROVIDER_CREDENTIALS_SETTING = 'ompProviderCredentials';
const MINIMUM_API_KEY_LENGTH = 8;
const MAXIMUM_API_KEY_LENGTH = 4096;
const MAXIMUM_MODEL_LENGTH = 512;

/** Minimal electron-store surface; credentials are never exposed outside main. */
export interface OmpCredentialSettingsStore {
	get<T>(key: string, defaultValue?: T): T;
	set(key: string, value: unknown): void;
}

/** The subset of Electron safeStorage used to seal dedicated OMP entries. */
export interface OmpSafeStorage {
	isEncryptionAvailable(): boolean;
	encryptString(value: string): Buffer;
	decryptString(value: Buffer): string;
}

export interface OmpAuthPublicStatus {
	status: OmpAuthStatus;
	providerIds: OmpProviderId[];
	reason?: OmpAuthRequiredReason;
}

/**
 * Opaque container for the only secret-bearing data in this flow. It can be
 * materialized for a supervised child only. The closure keeps normal object
 * inspection/enumeration and JSON serialization free of secret values.
 */
export interface OmpAuthEnvironment {
	toChildEnvironment(): Readonly<Record<string, string>>;
	toJSON(): undefined;
}

export interface OmpAuthResolution extends OmpAuthPublicStatus {
	authEnvironment: OmpAuthEnvironment;
	toPublicStatus(): OmpAuthPublicStatus;
	toJSON(): OmpAuthPublicStatus;
}

interface ProviderCredential {
	providerId: OmpProviderId;
	apiKey: string;
}

interface DedicatedCredentialEntry {
	sealedApiKey: string;
	model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeProviderId(value: unknown): OmpProviderId | null {
	if (typeof value !== 'string') return null;
	return PROVIDER_ALIASES[value.trim().toLowerCase()] ?? null;
}

function validApiKey(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	if (value.length < MINIMUM_API_KEY_LENGTH || value.length > MAXIMUM_API_KEY_LENGTH) return null;
	if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) return null;
	return value;
}

function validModel(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const model = value.trim();
	if (!model || model.length > MAXIMUM_MODEL_LENGTH || /[\u0000-\u001f\u007f]/.test(model))
		return null;
	return model;
}

function requestedProvider(model: string | undefined): OmpProviderId | 'unknown' | null {
	if (!model || !model.includes('/')) return null;
	const [prefix] = model.split('/', 1);
	return normalizeProviderId(prefix) ?? 'unknown';
}

function createAuthEnvironment(values: Record<string, string>): OmpAuthEnvironment {
	const childValues = Object.freeze({ ...values });
	return Object.freeze({
		toChildEnvironment: () => childValues,
		toJSON: () => undefined,
	});
}

function createResolution(
	status: OmpAuthStatus,
	providerIds: OmpProviderId[],
	authEnvironment: OmpAuthEnvironment,
	reason?: OmpAuthRequiredReason
): OmpAuthResolution {
	const publicStatus = Object.freeze(
		reason === undefined
			? { status, providerIds: [...providerIds] }
			: { status, providerIds: [...providerIds], reason }
	);
	return Object.freeze({
		...publicStatus,
		authEnvironment,
		toPublicStatus: () => ({ ...publicStatus, providerIds: [...publicStatus.providerIds] }),
		toJSON: () => ({ ...publicStatus, providerIds: [...publicStatus.providerIds] }),
	});
}

/**
 * Resolves *only* explicit Maestro settings into an opaque environment for a
 * trusted OMP child. There is no ambient environment fallback by design.
 */
export class OmpProviderCredentialStore {
	constructor(
		private readonly settingsStore: OmpCredentialSettingsStore,
		private readonly safeStorage: OmpSafeStorage
	) {}

	/**
	 * Seal an OMP-specific provider key in electron-store. This is a host-only
	 * write seam for a future settings UI; no plaintext is persisted by this API.
	 */
	setCredential(provider: string, apiKey: string, model?: string): boolean {
		const providerId = normalizeProviderId(provider);
		const key = validApiKey(apiKey);
		const normalizedModel = model === undefined ? undefined : validModel(model);
		if (!providerId || !key || (model !== undefined && !normalizedModel)) return false;
		if (
			normalizedModel &&
			requestedProvider(normalizedModel) !== null &&
			requestedProvider(normalizedModel) !== providerId
		) {
			return false;
		}
		if (!this.safeStorageAvailable()) return false;

		try {
			const entries = this.readDedicatedEntries();
			entries[providerId] = {
				sealedApiKey: this.safeStorage.encryptString(key).toString('base64'),
				...(normalizedModel ? { model: normalizedModel } : {}),
			};
			this.settingsStore.set(OMP_PROVIDER_CREDENTIALS_SETTING, entries);
			return true;
		} catch {
			return false;
		}
	}

	/** Remove a sealed provider entry immediately; subsequent resolution re-reads settings. */
	revokeCredential(provider: string): void {
		const providerId = normalizeProviderId(provider);
		if (!providerId) return;
		const entries = this.readDedicatedEntries();
		delete entries[providerId];
		this.settingsStore.set(OMP_PROVIDER_CREDENTIALS_SETTING, entries);
	}

	/**
	 * Build the host-only auth projection for one prompt/model. A qualified model
	 * receives credentials for its exact recognized provider only; unqualified
	 * models may use every explicitly configured recognized provider.
	 */
	resolveForPrompt(model?: string): OmpAuthResolution {
		const configured = this.readConfiguredCredentials();
		const providerIds = PROVIDER_IDS.filter((providerId) => configured.has(providerId));
		const effectiveModel =
			validModel(model) ??
			validModel(this.settingsStore.get<unknown>('modelSlug', undefined)) ??
			undefined;
		const requiredProvider = requestedProvider(effectiveModel);

		if (requiredProvider === 'unknown') {
			return createResolution(
				'auth_required',
				providerIds,
				createAuthEnvironment({}),
				'unknown_model_provider'
			);
		}

		const compatibleProviders =
			requiredProvider === null ? providerIds : providerIds.filter((id) => id === requiredProvider);
		const childEnvironment: Record<string, string> = {};
		for (const providerId of compatibleProviders) {
			const credential = configured.get(providerId);
			if (credential)
				childEnvironment[OMP_PROVIDER_ENVIRONMENT_KEYS[providerId]] = credential.apiKey;
		}

		if (compatibleProviders.length === 0) {
			return createResolution(
				'auth_required',
				providerIds,
				createAuthEnvironment({}),
				'no_compatible_credential'
			);
		}
		return createResolution('ready', compatibleProviders, createAuthEnvironment(childEnvironment));
	}

	private safeStorageAvailable(): boolean {
		try {
			return this.safeStorage.isEncryptionAvailable();
		} catch {
			return false;
		}
	}

	private readConfiguredCredentials(): Map<OmpProviderId, ProviderCredential> {
		const credentials = new Map<OmpProviderId, ProviderCredential>();
		this.readShellCredentials(credentials);
		this.readGlobalProviderCredential(credentials);
		this.readDedicatedCredentials(credentials);
		return credentials;
	}

	private readShellCredentials(credentials: Map<OmpProviderId, ProviderCredential>): void {
		const rawShellEnvVars = this.settingsStore.get<unknown>('shellEnvVars', undefined);
		if (!isRecord(rawShellEnvVars)) return;
		for (const providerId of PROVIDER_IDS) {
			const apiKey = validApiKey(rawShellEnvVars[OMP_PROVIDER_ENVIRONMENT_KEYS[providerId]]);
			if (apiKey) credentials.set(providerId, { providerId, apiKey });
		}
	}

	private readGlobalProviderCredential(credentials: Map<OmpProviderId, ProviderCredential>): void {
		const providerId = normalizeProviderId(
			this.settingsStore.get<unknown>('llmProvider', undefined)
		);
		const apiKey = validApiKey(this.settingsStore.get<unknown>('apiKey', undefined));
		if (providerId && apiKey) credentials.set(providerId, { providerId, apiKey });
	}

	private readDedicatedCredentials(credentials: Map<OmpProviderId, ProviderCredential>): void {
		if (!this.safeStorageAvailable()) return;
		const entries = this.readDedicatedEntries();
		for (const providerId of PROVIDER_IDS) {
			const entry = entries[providerId];
			if (!entry) continue;
			try {
				const apiKey = validApiKey(
					this.safeStorage.decryptString(Buffer.from(entry.sealedApiKey, 'base64'))
				);
				if (apiKey) credentials.set(providerId, { providerId, apiKey });
			} catch {
				// A malformed, foreign, or unavailable encrypted value is never usable.
			}
		}
	}

	private readDedicatedEntries(): Partial<Record<OmpProviderId, DedicatedCredentialEntry>> {
		const rawEntries = this.settingsStore.get<unknown>(OMP_PROVIDER_CREDENTIALS_SETTING, undefined);
		if (!isRecord(rawEntries)) return {};
		const entries: Partial<Record<OmpProviderId, DedicatedCredentialEntry>> = {};
		for (const providerId of PROVIDER_IDS) {
			const rawEntry = rawEntries[providerId];
			if (!isRecord(rawEntry) || typeof rawEntry.sealedApiKey !== 'string') continue;
			const model = validModel(rawEntry.model);
			if (rawEntry.model !== undefined && !model) continue;
			if (model && requestedProvider(model) !== null && requestedProvider(model) !== providerId)
				continue;
			entries[providerId] = {
				sealedApiKey: rawEntry.sealedApiKey,
				...(model ? { model } : {}),
			};
		}
		return entries;
	}
}
