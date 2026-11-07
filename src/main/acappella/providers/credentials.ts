/**
 * A Cappella credentials - API keys in the OS keychain and nowhere else.
 *
 * The rule, in full, because every part of it has been broken by a well-meaning
 * change in some codebase somewhere:
 *
 *   1. **The key never touches `settings.json`.** Settings are plain JSON in
 *      userData, they end up in screenshots and support bundles, and they sync.
 *      A key lives in one place: a per-service entry in the OS credential store.
 *   2. **The key is never logged.** Not at debug level, not "just the prefix" at
 *      a call site that will later be widened, not inside an error message built
 *      from a request URL. {@link redactSecrets} exists so the debug package and
 *      any log line can be scrubbed by a function rather than by discipline.
 *   3. **The key never reaches Sentry.** `beforeSend` cannot know which string is
 *      a key, so nothing that holds one may be attached to a captured exception.
 *      The classified errors this module raises carry a service name, never the
 *      credential.
 *   4. **"Is it valid" is answered by the service, not by a regex.** A key that
 *      is well-formed and revoked looks fine to a pattern and fails at the worst
 *      possible moment - mid-utterance, with no screen to read. So validation is
 *      a real authenticated request against the cheapest endpoint each provider
 *      offers, and its three outcomes are told apart: valid, rejected, and
 *      rate-limited. Rate-limited is NOT invalid; telling a user their key is
 *      wrong because they are briefly over quota would have them paste a new one
 *      to fix a problem that fixes itself.
 *
 * A machine with no usable keyring (headless Linux, a locked login keychain) can
 * still run: {@link setCredential} reports the failure and the hosted providers
 * stay unavailable through the capability gate. There is deliberately no
 * "remember it in a file instead" path.
 */

import {
	VOICE_CREDENTIALS,
	VOICE_CREDENTIAL_SERVICES,
	credentialLabel,
	type VoiceCredentialService,
} from '../../../shared/acappella/provider-catalog';
import { logger } from '../../utils/logger';
import { createKeyringEntry, type KeyringEntry } from '../../utils/keyring';

const LOG_CONTEXT = 'ACappella';

/** The keychain service every A Cappella key is filed under. */
export const CREDENTIAL_KEYRING_SERVICE = 'com.maestro.acappella';

/** Per-request ceiling for a validation call. A key check must not hang a panel. */
const VALIDATE_TIMEOUT_MS = 10_000;

/** What a validation attempt found out. */
export type CredentialValidationStatus =
	| 'valid'
	| 'invalid'
	| 'rate-limited'
	| 'network-error'
	| 'missing';

export interface CredentialValidation {
	service: VoiceCredentialService;
	status: CredentialValidationStatus;
	/** One sentence for the user, naming the next action where there is one. */
	message: string;
	/** HTTP status, when the failure came back from the service. */
	httpStatus?: number;
}

export interface CredentialState {
	service: VoiceCredentialService;
	label: string;
	/** Whether a key is stored. The key itself is never returned to a caller. */
	configured: boolean;
	/** False when this machine has no usable credential store at all. */
	keyringAvailable: boolean;
}

/** Injectable transport, so the validation paths are testable without a network. */
export type CredentialFetch = (url: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Entries are cached per service because constructing one is a native call and
 * `has()` is on the capability gate's path, which runs on every Settings render.
 * `undefined` means "not tried yet"; `null` means "this machine has no keyring",
 * which is a real, cacheable answer.
 */
const entries = new Map<VoiceCredentialService, KeyringEntry | null>();

/** Test seam. Replaces the entry factory; pass null to restore the real keyring. */
let entryFactory: ((service: VoiceCredentialService) => KeyringEntry | null) | null = null;

export function __setCredentialEntryFactory(
	factory: ((service: VoiceCredentialService) => KeyringEntry | null) | null
): void {
	entryFactory = factory;
	entries.clear();
}

function entryFor(service: VoiceCredentialService): KeyringEntry | null {
	const cached = entries.get(service);
	if (cached !== undefined) return cached;

	const entry = entryFactory
		? entryFactory(service)
		: createKeyringEntry(CREDENTIAL_KEYRING_SERVICE, service);
	entries.set(service, entry);
	return entry;
}

/** True when this machine has a credential store A Cappella can write to. */
export function isKeyringAvailable(service: VoiceCredentialService): boolean {
	return entryFor(service) !== null;
}

/**
 * The stored key, or null.
 *
 * Main-process only, and deliberately not exposed over IPC: nothing in the
 * renderer needs to read a key back, and a channel that returned one would put
 * it in a renderer heap, a devtools frame, and any crash dump taken afterwards.
 */
export function getCredential(service: VoiceCredentialService): string | null {
	const entry = entryFor(service);
	if (!entry) return null;
	try {
		const value = entry.getPassword();
		return value && value.trim() ? value.trim() : null;
	} catch (error) {
		// A locked keychain throws here. Report the shape of the failure, never the
		// entry contents.
		logger.warn(
			`Could not read the ${credentialLabel(service)} key: ${describe(error)}`,
			LOG_CONTEXT
		);
		return null;
	}
}

/** Whether a key is stored. The cheap question the capability gate asks. */
export function hasCredential(service: VoiceCredentialService): boolean {
	return getCredential(service) !== null;
}

export interface SetCredentialResult {
	ok: boolean;
	/** Present when the write failed. Never contains the key. */
	error?: string;
}

/**
 * Store a key. An empty value clears the entry, which is how the settings panel
 * removes one without a second channel.
 */
export function setCredential(service: VoiceCredentialService, key: string): SetCredentialResult {
	const trimmed = key.trim();
	if (!trimmed) return clearCredential(service);

	const entry = entryFor(service);
	if (!entry) {
		return {
			ok: false,
			error: `This machine has no credential store Maestro can use, so the ${credentialLabel(service)} key cannot be saved. Keys are never written to disk in plain text.`,
		};
	}

	try {
		entry.setPassword(trimmed);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: `Could not save the key: ${describe(error)}` };
	}
}

/** Remove a stored key. Succeeds when there was nothing to remove. */
export function clearCredential(service: VoiceCredentialService): SetCredentialResult {
	const entry = entryFor(service);
	if (!entry) return { ok: true };
	try {
		entry.deletePassword();
		return { ok: true };
	} catch (error) {
		return { ok: false, error: `Could not remove the key: ${describe(error)}` };
	}
}

/** Configured state for every service, for the settings panel. No keys. */
export function listCredentialStates(): CredentialState[] {
	return VOICE_CREDENTIAL_SERVICES.map((service) => ({
		service,
		label: credentialLabel(service),
		configured: hasCredential(service),
		keyringAvailable: isKeyringAvailable(service),
	}));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * The cheapest authenticated endpoint each service offers.
 *
 * A list call rather than an inference call on purpose: it costs nothing, it
 * cannot be mistaken for usage on someone's bill, and it distinguishes a bad key
 * (401/403) from a throttled account (429) without spending a token.
 */
const VALIDATION_ENDPOINTS: Record<VoiceCredentialService, (key: string) => [string, RequestInit]> =
	{
		openai: (key) => [
			'https://api.openai.com/v1/models',
			{ headers: { Authorization: `Bearer ${key}` } },
		],
		elevenlabs: (key) => ['https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': key } }],
		anthropic: (key) => [
			'https://api.anthropic.com/v1/models?limit=1',
			{ headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
		],
	};

/**
 * Verify a key with the service.
 *
 * @param key Optional. Given, the key is checked WITHOUT being stored, which is
 *            what the Test button does before a Save. Omitted, the stored key is
 *            used.
 */
export async function validateCredential(
	service: VoiceCredentialService,
	key?: string,
	fetchImpl: CredentialFetch = globalThis.fetch
): Promise<CredentialValidation> {
	const label = credentialLabel(service);
	const secret = (key ?? getCredential(service) ?? '').trim();

	if (!secret) {
		return { service, status: 'missing', message: `No ${label} key is stored.` };
	}

	const prefix = VOICE_CREDENTIALS[service].keyPrefix;
	if (prefix && !secret.startsWith(prefix)) {
		// Caught locally because it is almost always a paste error, and telling
		// someone their key is invalid after a round trip they did not need is
		// slower and less specific than saying "that is not the right kind of key".
		return {
			service,
			status: 'invalid',
			message: `That does not look like a ${label} key: they start with "${prefix}".`,
		};
	}

	const [url, init] = VALIDATION_ENDPOINTS[service](secret);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);

	try {
		const response = await fetchImpl(url, { ...init, method: 'GET', signal: controller.signal });
		return classifyValidation(service, response.status);
	} catch (error) {
		return {
			service,
			status: 'network-error',
			// The URL is safe to omit and the key must not be in here, so the message
			// says what happened and nothing about what was sent.
			message: `Could not reach ${label}: ${describe(error)}`,
		};
	} finally {
		clearTimeout(timer);
	}
}

function classifyValidation(
	service: VoiceCredentialService,
	httpStatus: number
): CredentialValidation {
	const label = credentialLabel(service);

	if (httpStatus >= 200 && httpStatus < 300) {
		return { service, status: 'valid', message: `${label} key works.`, httpStatus };
	}
	if (httpStatus === 429) {
		// Explicitly NOT invalid. The key is fine; the account is busy.
		return {
			service,
			status: 'rate-limited',
			message: `${label} is rate limiting this key right now. The key itself looks fine - try again in a moment.`,
			httpStatus,
		};
	}
	if (httpStatus === 401 || httpStatus === 403) {
		return {
			service,
			status: 'invalid',
			message: `${label} rejected this key. Check that it is current and has not been revoked.`,
			httpStatus,
		};
	}
	if (httpStatus >= 500) {
		return {
			service,
			status: 'network-error',
			message: `${label} returned a server error (${httpStatus}). That is on their side; try again shortly.`,
			httpStatus,
		};
	}
	return {
		service,
		status: 'network-error',
		message: `${label} answered with an unexpected status (${httpStatus}).`,
		httpStatus,
	};
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Key shapes, for scrubbing text that may quote one.
 *
 * Pattern-based rather than "replace the keys we know we stored", because the
 * text being scrubbed is usually a support bundle written on a machine whose
 * keys this process may not be able to read (locked keychain), and a key pasted
 * into a log by a third-party library was never in our map anyway.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
	// OpenAI and Anthropic: sk-, sk-ant-, sk-proj-, plus the long opaque tail.
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	// ElevenLabs: a bare 32-hex key, usually behind its own header name.
	/\b(xi-api-key["'\s:=]+)([A-Za-z0-9]{16,})/gi,
	// Anything that named itself. Catches `"api_key": "..."` in a copied payload.
	/\b(api[_-]?key["'\s:=]+)([A-Za-z0-9_-]{12,})/gi,
	/\b(authorization["'\s:=]+bearer\s+)([A-Za-z0-9._-]{12,})/gi,
];

/** The stand-in every scrubbed secret becomes. */
export const REDACTED = '[redacted]';

/**
 * Replace anything that looks like a credential.
 *
 * Called by the debug package before a bundle is written and available to any
 * log site that is about to print something a key could have landed in. It is
 * intentionally eager: a false positive costs a support engineer one unreadable
 * token, and a false negative ships someone's key to a bug tracker.
 */
export function redactSecrets(text: string): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		out = out.replace(pattern, (_match, prefix?: string) =>
			prefix ? `${prefix}${REDACTED}` : REDACTED
		);
	}
	return out;
}

/**
 * Deep-scrub a JSON-shaped value. Strings are run through
 * {@link redactSecrets}; a key whose NAME says it holds a secret is redacted
 * whole, because a value that does not match a pattern is not thereby safe.
 */
export function redactSecretsDeep<T>(value: T): T {
	return scrub(value) as T;
}

const SECRET_KEY_NAMES = /(api[_-]?key|secret|token|password|authorization)/i;

function scrub(value: unknown): unknown {
	if (typeof value === 'string') return redactSecrets(value);
	if (Array.isArray(value)) return value.map(scrub);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
			out[key] = SECRET_KEY_NAMES.test(key) && typeof inner === 'string' ? REDACTED : scrub(inner);
		}
		return out;
	}
	return value;
}

function describe(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	// Belt and braces: an error thrown by a transport can quote the request it
	// failed on, and that request carried the key.
	return redactSecrets(message);
}
