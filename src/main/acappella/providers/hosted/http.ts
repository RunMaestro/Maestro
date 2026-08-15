/**
 * The transport every hosted A Cappella provider goes through.
 *
 * Three providers, one set of rules, because the rules are the hard part and
 * three copies of them would drift on the first bug fix:
 *
 *   - **Every request has a deadline.** A voice turn that is still waiting on a
 *     transcript after ten seconds has already failed; the user has been staring
 *     at a listening indicator with nothing coming back. The timeout is enforced
 *     with an `AbortController` so the socket actually closes rather than being
 *     abandoned.
 *   - **Cancellation is real.** A caller's signal is chained into the same
 *     controller, so barge-in aborts the in-flight HTTP request instead of
 *     letting a superseded turn finish paying for itself.
 *   - **Retry is bounded and only for the failures retrying can fix.** 429 and
 *     5xx, with exponential backoff, at most {@link MAX_ATTEMPTS} attempts. A 401
 *     is never retried: the key will not become valid, and hammering an auth
 *     endpoint is how an account gets locked.
 *   - **Failures are classified, never generic.** Auth, quota, network, timeout,
 *     and server come back as distinct {@link VoiceProviderError} kinds so the
 *     session can tell a user which one it is. Anything unexpected is left to
 *     throw as itself and reach Sentry.
 *
 * Nothing in this file logs a request URL with its headers, and no error message
 * built here quotes a request body. See `../credentials.ts` for why.
 */

import {
	VoiceProviderError,
	type VoiceProviderFailureKind,
} from '../../../../shared/acappella/provider-errors';
import {
	credentialLabel,
	type VoiceCredentialService,
} from '../../../../shared/acappella/provider-catalog';

/** Attempts in total, not retries after the first. */
export const MAX_ATTEMPTS = 3;

/** First backoff step. Doubles per attempt. */
const BASE_BACKOFF_MS = 400;

/** Ceiling, so a Retry-After of an hour does not become a wait of an hour. */
const MAX_BACKOFF_MS = 4_000;

/** Injectable transport. Tests pass a stub; production uses global `fetch`. */
export type HostedFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface HostedRequestOptions {
	/** Provider id, so a failure can name the engine the user configured. */
	providerId: string;
	/** Whose key this is, for the message text. */
	service: VoiceCredentialService;
	url: string;
	init?: RequestInit;
	/** Per-request deadline. */
	timeoutMs: number;
	/** Caller's cancellation, chained into the request's own controller. */
	signal?: AbortSignal;
	fetchImpl?: HostedFetch;
	/** Sleep, injectable so tests do not wait out real backoff. */
	delayMs?: (ms: number) => Promise<void>;
	/**
	 * False for a streaming request that must not be replayed. A retried stream
	 * would re-synthesise audio the user already heard the start of.
	 */
	retry?: boolean;
}

/**
 * Perform one hosted request with timeout, cancellation, bounded retry, and
 * classified failures.
 *
 * @returns the `Response`, which the caller owns and must consume or cancel.
 */
export async function hostedRequest(options: HostedRequestOptions): Promise<Response> {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const sleep = options.delayMs ?? defaultDelay;
	const attempts = options.retry === false ? 1 : MAX_ATTEMPTS;

	let lastError: VoiceProviderError | null = null;

	for (let attempt = 0; attempt < attempts; attempt++) {
		throwIfAborted(options);

		let response: Response;
		try {
			response = await withDeadline(options, fetchImpl);
		} catch (error) {
			const classified = classifyTransportError(error, options);
			// A caller-cancelled request is not a fault and must not be retried: the
			// turn it belonged to is already over.
			if (options.signal?.aborted) throw classified;
			lastError = classified;
			if (attempt === attempts - 1) throw classified;
			await sleep(backoffMs(attempt));
			continue;
		}

		if (response.ok) return response;

		const failure = await classifyHttpStatus(response, options);
		// Retryable statuses only. An auth failure retried three times is three
		// chances to trip a lockout for no gain.
		if (!isRetryableStatus(response.status) || attempt === attempts - 1) throw failure;

		lastError = failure;
		await sleep(retryAfterMs(response) ?? backoffMs(attempt));
	}

	// Unreachable: the loop either returns or throws on its final attempt. Kept so
	// a future edit to the loop cannot silently return undefined.
	throw lastError ?? providerError('unavailable', 'The request could not be completed.', options);
}

/**
 * The response body as text, or a classified failure. Used for the small JSON
 * responses; streaming callers read `response.body` themselves.
 */
export async function hostedJson<T>(options: HostedRequestOptions): Promise<T> {
	const response = await hostedRequest(options);
	try {
		return (await response.json()) as T;
	} catch (error) {
		throw providerError(
			'server',
			`${credentialLabel(options.service)} returned a response Maestro could not read.`,
			options,
			error
		);
	}
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Run one attempt under a deadline, with the caller's cancellation chained in.
 *
 * `AbortSignal.any` would be the tidy way to do this and is too new to rely on
 * across the Node versions Electron has shipped, so the two signals are wired by
 * hand and the listener is always removed - an abandoned listener on a long-lived
 * caller signal is a leak that only shows up after a few hundred turns.
 */
async function withDeadline(
	options: HostedRequestOptions,
	fetchImpl: HostedFetch
): Promise<Response> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	options.signal?.addEventListener('abort', onAbort, { once: true });

	const timer = setTimeout(() => controller.abort(new DeadlineExceeded()), options.timeoutMs);

	try {
		return await fetchImpl(options.url, { ...options.init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', onAbort);
	}
}

/** Marker for our own deadline, so it can be told from a caller's cancellation. */
class DeadlineExceeded extends Error {
	constructor() {
		super('Deadline exceeded');
		this.name = 'DeadlineExceeded';
	}
}

function throwIfAborted(options: HostedRequestOptions): void {
	if (!options.signal?.aborted) return;
	throw providerError('network', 'The request was cancelled.', options);
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function backoffMs(attempt: number): number {
	return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
}

/** `Retry-After` in ms, when the service gave one we can honour. */
function retryAfterMs(response: Response): number | null {
	const header = response.headers?.get?.('retry-after');
	if (!header) return null;
	const seconds = Number(header);
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	return Math.min(MAX_BACKOFF_MS, seconds * 1000);
}

async function classifyHttpStatus(
	response: Response,
	options: HostedRequestOptions
): Promise<VoiceProviderError> {
	const label = credentialLabel(options.service);
	const status = response.status;

	// The body is read and discarded rather than quoted: it can echo the request,
	// and the request carried the key.
	await response.text().catch(() => '');

	if (status === 401 || status === 403) {
		return providerError(
			'auth',
			`${label} rejected the API key. Add a current key in Settings > Plugins > A Cappella > Voice Providers.`,
			options,
			undefined,
			status
		);
	}
	if (status === 429) {
		return providerError(
			'quota',
			`${label} is rate limiting this key. Wait a moment, or switch this slot to a local model.`,
			options,
			undefined,
			status
		);
	}
	if (status === 402) {
		return providerError(
			'quota',
			`The ${label} account is out of credit. Top it up, or switch this slot to a local model.`,
			options,
			undefined,
			status
		);
	}
	if (status >= 500) {
		return providerError(
			'server',
			`${label} is having a problem on their side (${status}). Try again shortly.`,
			options,
			undefined,
			status
		);
	}
	return providerError(
		'request',
		`${label} refused the request (${status}). This is a Maestro bug rather than something you can fix.`,
		options,
		undefined,
		status
	);
}

function classifyTransportError(error: unknown, options: HostedRequestOptions): VoiceProviderError {
	const label = credentialLabel(options.service);

	if (error instanceof DeadlineExceeded || isAbortForDeadline(error)) {
		return providerError(
			'timeout',
			`${label} did not answer within ${Math.round(options.timeoutMs / 1000)}s.`,
			options,
			error
		);
	}
	if (options.signal?.aborted) {
		return providerError('network', 'The request was cancelled.', options, error);
	}
	return providerError(
		'network',
		`Could not reach ${label}. Check your connection, or switch this slot to a local model.`,
		options,
		error
	);
}

/**
 * Whether an abort came from our deadline.
 *
 * Undici reports the abort REASON on modern runtimes and a bare `AbortError` on
 * older ones, so both shapes are checked. Getting this wrong only mislabels a
 * timeout as a network failure, but those two have different recoveries and the
 * user reads the difference.
 */
function isAbortForDeadline(error: unknown): boolean {
	if ((error as { cause?: unknown })?.cause instanceof DeadlineExceeded) return true;
	return (error as { name?: string })?.name === 'TimeoutError';
}

function providerError(
	kind: VoiceProviderFailureKind,
	message: string,
	options: HostedRequestOptions,
	cause?: unknown,
	httpStatus?: number
): VoiceProviderError {
	return new VoiceProviderError(message, {
		kind,
		providerId: options.providerId,
		httpStatus,
		cause,
	});
}

function defaultDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The key for a hosted provider, or a classified `unavailable` failure.
 *
 * Every hosted provider starts with this call, which is what makes "no key
 * configured" a stated refusal at the top of a turn rather than a 401 three
 * hundred milliseconds later.
 */
export function requireCredential(
	providerId: string,
	service: VoiceCredentialService,
	read: (service: VoiceCredentialService) => string | null
): string {
	const key = read(service);
	if (key) return key;
	throw new VoiceProviderError(
		`No ${credentialLabel(service)} API key is configured. Add one in Settings > Plugins > A Cappella > Voice Providers, or switch this slot to a local model.`,
		{ kind: 'unavailable', providerId }
	);
}
