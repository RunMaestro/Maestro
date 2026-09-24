/**
 * Classified provider failures.
 *
 * A voice turn fails with no screen in front of the user. "Something went wrong"
 * is therefore worse here than almost anywhere else in Maestro: the person hears
 * silence, has no error text, and cannot tell a dead microphone from an expired
 * API key from a rate limit that will clear on its own. So every failure a
 * provider can PREDICT arrives as one of these, carrying the sentence the user
 * needs and the recovery that goes with it.
 *
 * What is deliberately NOT in here: bugs. A `TypeError` inside a provider is not
 * a `VoiceProviderError` and must not be dressed up as one - it goes to Sentry
 * with the session context, per the repo error policy. The test for whether a
 * failure belongs here is "could a correctly written provider hit this on a
 * healthy build". A revoked key: yes. A 429: yes. `undefined is not a function`:
 * no.
 */

import type { VoiceSessionErrorCode } from './protocol';

/**
 * Why a provider could not do its job.
 *
 *   - `auth`        - the key was rejected. The user has to replace it.
 *   - `quota`       - rate limited or out of credit. Waiting may fix it.
 *   - `network`     - the service was unreachable.
 *   - `timeout`     - it answered too slowly to be useful in a spoken turn.
 *   - `server`      - the service failed on its own side (5xx).
 *   - `request`     - we sent something the service refused (4xx that is not
 *                     auth or quota). Almost always a Maestro bug, but it is
 *                     surfaced rather than thrown so a turn ends honestly.
 *   - `unavailable` - the engine cannot run at all here: model missing, runtime
 *                     will not load, no key configured.
 */
export type VoiceProviderFailureKind =
	| 'auth'
	| 'quota'
	| 'network'
	| 'timeout'
	| 'server'
	| 'request'
	/**
	 * The provider is alive but cannot take this turn right now. Only the
	 * Conductor-as-agent Brain produces it: a real Maestro agent can be mid-turn
	 * when the user speaks, and the honest answer is "ask me again in a moment"
	 * rather than blocking the floor until it finishes.
	 */
	| 'busy'
	| 'unavailable';

/** Which protocol error code each kind travels as. */
const SESSION_CODES: Record<VoiceProviderFailureKind, VoiceSessionErrorCode> = {
	auth: 'provider-auth-failed',
	quota: 'provider-quota-exceeded',
	network: 'provider-network-error',
	timeout: 'provider-network-error',
	server: 'provider-network-error',
	request: 'provider-unavailable',
	busy: 'provider-unavailable',
	unavailable: 'provider-unavailable',
};

/**
 * Whether the user can plausibly do something and try again.
 *
 * `unavailable` is false for the same reason it is in the capability gate: a
 * missing model is not fixed by pressing the button again, it is fixed in Voice
 * Setup, and a HUD that offers Retry for it sends people in a loop.
 */
const RECOVERABLE: Record<VoiceProviderFailureKind, boolean> = {
	auth: true,
	quota: true,
	network: true,
	timeout: true,
	server: true,
	request: false,
	// Recoverable in the most literal sense: wait, then say it again.
	busy: true,
	unavailable: false,
};

export interface VoiceProviderErrorOptions {
	kind: VoiceProviderFailureKind;
	/** The provider id, so the HUD can name the engine that failed. */
	providerId: string;
	/** HTTP status when the failure came from a service. */
	httpStatus?: number;
	/** The underlying error, kept for Sentry breadcrumbs. Never shown verbatim. */
	cause?: unknown;
}

/**
 * A failure a provider predicted. The message is written for a person and is
 * safe to display: it never carries a key, a URL, or a request body.
 */
export class VoiceProviderError extends Error {
	readonly kind: VoiceProviderFailureKind;
	readonly providerId: string;
	readonly httpStatus?: number;

	constructor(message: string, options: VoiceProviderErrorOptions) {
		super(message);
		this.name = 'VoiceProviderError';
		// Assigned rather than passed to `super`: the main bundle's lib target
		// predates the ErrorOptions overload, and losing the cause would cost the
		// one breadcrumb a Sentry report of an unexpected wrapper would have.
		if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
		this.kind = options.kind;
		this.providerId = options.providerId;
		this.httpStatus = options.httpStatus;
	}

	/** The protocol code this failure is announced with. */
	get sessionErrorCode(): VoiceSessionErrorCode {
		return SESSION_CODES[this.kind];
	}

	get recoverable(): boolean {
		return RECOVERABLE[this.kind];
	}
}

export function isVoiceProviderError(error: unknown): error is VoiceProviderError {
	return error instanceof VoiceProviderError;
}
