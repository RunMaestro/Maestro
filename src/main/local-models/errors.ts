/**
 * Classified Local Models failures.
 *
 * Every consumer of the core (A Cappella today; tab naming, AI command mode,
 * semantic search and the Cue gate later) has its own error vocabulary and its
 * own way of telling a person what went wrong. The core cannot speak any of
 * them, so it speaks one of its own: a stable `code` a consumer can switch on
 * and a `recovery` sentence written for a person. A consumer maps this onto its
 * own error at its boundary (A Cappella turns it into a `VoiceProviderError`).
 *
 * What is NOT in here: bugs. An unknown model id handed to the store is a
 * programming error and stays a plain `Error`, so it reaches Sentry as one.
 */

import type { ModelServerErrorCode } from '../../shared/local-models/model-server';
import type { SystemOneEngineId, SystemOneErrorCode } from '../../shared/local-models/system-one';

/**
 * Why a local model could not be used.
 *
 *   - `runtime-unavailable` - the native runtime the model needs will not load
 *                             here: not downloaded, no build for this platform,
 *                             or the dlopen failed.
 *   - `model-unsupported`   - the model id is not a catalog model this call can
 *                             run (an assignment naming a model that is not, or
 *                             is no longer, of the kind the task needs).
 *   - `model-not-installed` - the model is in the catalog but its files are not
 *                             on disk, or are the wrong length.
 *   - `generation-failed`   - the model would not open, or failed mid-call
 *                             (a generation turn, an embedding or classifier run).
 *   - `cancelled`           - the caller aborted. Not a fault; never shown as one.
 */
export type LocalModelErrorCode =
	| 'runtime-unavailable'
	| 'model-unsupported'
	| 'model-not-installed'
	| 'generation-failed'
	| 'cancelled';

export interface LocalModelErrorOptions {
	code: LocalModelErrorCode;
	/** What the user can do about it. One sentence, safe to display. */
	recovery: string;
	/** Who asked, so a consumer can name the engine that failed. */
	consumerId: string;
	/** The underlying failure, kept for Sentry breadcrumbs. Never shown verbatim. */
	cause?: unknown;
}

/** A failure the core predicted. The message is written for a person. */
export class LocalModelError extends Error {
	readonly code: LocalModelErrorCode;
	readonly recovery: string;
	readonly consumerId: string;

	constructor(message: string, options: LocalModelErrorOptions) {
		super(message);
		this.name = 'LocalModelError';
		// Assigned rather than passed to `super`: the main bundle's lib target
		// predates the ErrorOptions overload.
		if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
		this.code = options.code;
		this.recovery = options.recovery;
		this.consumerId = options.consumerId;
	}
}

export function isLocalModelError(error: unknown): error is LocalModelError {
	return error instanceof LocalModelError;
}

/** The error a local-model call throws when its caller aborted. */
export function localModelCancelledError(consumerId: string): LocalModelError {
	return new LocalModelError('The request was cancelled.', {
		code: 'cancelled',
		recovery: 'Nothing to do: it was stopped on purpose.',
		consumerId,
	});
}

/** Throw {@link localModelCancelledError} when `signal` has fired. */
export function throwIfLocalModelCancelled(
	signal: AbortSignal | undefined,
	consumerId: string
): void {
	if (signal?.aborted) throw localModelCancelledError(consumerId);
}

/**
 * True when a failure from any local-model call (a local model, an endpoint or
 * a System One engine) means the caller cancelled, which is never a fault to
 * report.
 */
export function isLocalModelCancelled(error: unknown): boolean {
	if (isLocalModelError(error) || isSystemOneError(error)) return error.code === 'cancelled';
	return (error as { kind?: unknown } | null)?.kind === 'cancelled';
}

/**
 * Why a call to a user-run model server failed.
 *
 *   - `missing-key` - the endpoint names an API key variable that is not set in
 *                     Settings -> Environment, so the request was never sent.
 *   - `auth`        - the server answered 401 or 403.
 *   - `not-found`   - the server answered 404: the path does not exist there
 *                     (wrong kind, wrong base URL) or the model is unknown.
 *   - `http`        - any other non-2xx answer.
 *   - `timeout`     - no response headers inside the request budget.
 *   - `network`     - the server could not be reached at all.
 *   - `cancelled`   - the caller aborted. Not a fault; never shown as one.
 *   - `malformed`   - a 2xx answer whose body was not the shape this kind serves.
 *   - `no-models`   - the server answered, but serves no model to test against.
 *   - `invalid`     - the endpoint record or id handed in is not usable (an
 *                     unknown id, a record that fails validation), so nothing
 *                     was sent.
 */
export type LocalModelEndpointErrorKind =
	| 'missing-key'
	| 'auth'
	| 'not-found'
	| 'http'
	| 'timeout'
	| 'network'
	| 'cancelled'
	| 'malformed'
	| 'no-models'
	| 'invalid';

export interface LocalModelEndpointErrorOptions {
	kind: LocalModelEndpointErrorKind;
	endpointId: string;
	endpointName: string;
	/** The URL that was requested. Carries no credentials: those are refused at save time. */
	url: string;
	httpStatus?: number;
	cause?: unknown;
}

/**
 * A failure talking to a configured endpoint. The message names the endpoint
 * and, for an HTTP failure, the status, so a person can tell "Ollama is not
 * running" from "LiteLLM rejected the key" without opening a log.
 */
export class LocalModelEndpointError extends Error {
	readonly kind: LocalModelEndpointErrorKind;
	readonly endpointId: string;
	readonly endpointName: string;
	readonly url: string;
	readonly httpStatus?: number;

	constructor(message: string, options: LocalModelEndpointErrorOptions) {
		super(message);
		this.name = 'LocalModelEndpointError';
		if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
		this.kind = options.kind;
		this.endpointId = options.endpointId;
		this.endpointName = options.endpointName;
		this.url = options.url;
		this.httpStatus = options.httpStatus;
	}
}

export function isLocalModelEndpointError(error: unknown): error is LocalModelEndpointError {
	return error instanceof LocalModelEndpointError;
}

/**
 * A failure of the Maestro model server (`server/supervisor.ts`). The message is
 * written for a person and ends with what to do; `code` is for a caller that
 * switches on the reason (a launch that must refuse by name, the CLI's exit).
 */
export class ModelServerError extends Error {
	readonly code: ModelServerErrorCode;

	constructor(message: string, code: ModelServerErrorCode, cause?: unknown) {
		super(message);
		this.name = 'ModelServerError';
		if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
		this.code = code;
	}
}

export function isModelServerError(error: unknown): error is ModelServerError {
	return error instanceof ModelServerError;
}

export interface SystemOneErrorOptions {
	code: SystemOneErrorCode;
	/** The engine that was asked. A failure never names a different one. */
	engine: SystemOneEngineId;
	httpStatus?: number;
	cause?: unknown;
}

/**
 * A System One request with no answer. The message names the engine and is
 * written for a person; `code` is what a task's fail policy and the CLI's exit
 * switch on. The codes are documented on `SystemOneErrorCode`.
 */
export class SystemOneError extends Error {
	readonly code: SystemOneErrorCode;
	readonly engine: SystemOneEngineId;
	readonly httpStatus?: number;

	constructor(message: string, options: SystemOneErrorOptions) {
		super(message);
		this.name = 'SystemOneError';
		if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
		this.code = options.code;
		this.engine = options.engine;
		this.httpStatus = options.httpStatus;
	}
}

export function isSystemOneError(error: unknown): error is SystemOneError {
	return error instanceof SystemOneError;
}
