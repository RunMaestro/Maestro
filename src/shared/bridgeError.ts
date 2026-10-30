/** Expected bridge outages are control flow, not application failures. */
export type BridgeErrorCode =
	| 'BRIDGE_RECONNECTING'
	| 'BRIDGE_RESTORING'
	| 'BRIDGE_DISCONNECTED'
	| 'BRIDGE_TIMEOUT'
	| 'BRIDGE_RECOVERY_PENDING'
	| 'BRIDGE_SUBMISSION_UNCERTAIN';

export type BridgeSubmissionState = 'not-sent' | 'read-only' | 'unknown';

/** Carries transport state and whether a failed request could have reached the host. */
export class BridgeTransportError extends Error {
	readonly name = 'BridgeTransportError';
	constructor(
		message: string,
		readonly code: BridgeErrorCode,
		readonly submission: BridgeSubmissionState = 'not-sent',
		readonly channel?: string
	) {
		super(message);
	}
}

/** Recognize typed transport failures, including serialized errors from another realm. */
export function isBridgeTransportError(error: unknown): error is BridgeTransportError {
	return (
		error instanceof BridgeTransportError ||
		(!!error &&
			typeof error === 'object' &&
			'name' in error &&
			error.name === 'BridgeTransportError' &&
			'code' in error &&
			typeof error.code === 'string' &&
			/^BRIDGE_(?:RECONNECTING|RESTORING|DISCONNECTED|TIMEOUT|RECOVERY_PENDING|SUBMISSION_UNCERTAIN)$/.test(
				error.code
			) &&
			'submission' in error &&
			(error.submission === 'not-sent' ||
				error.submission === 'read-only' ||
				error.submission === 'unknown'))
	);
}

/** Do not suppress uncertain mutations: callers must reconcile before retrying. */
export function isExpectedBridgeError(error: unknown): boolean {
	if (isBridgeTransportError(error))
		return error.submission !== 'unknown' && error.code !== 'BRIDGE_SUBMISSION_UNCERTAIN';
	// Older host/client bundles can still produce plain Errors during an upgrade.
	const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	return (
		/^Not submitted: (?:reconnecting to the host|restoring authoritative host state)\./.test(
			message
		) ||
		/^bridge disconnected: (?:host connection is unavailable|request was not submitted|connection lost before response to )/.test(
			message
		) ||
		/^Bridge connection timed out; request was not submitted$/.test(message) ||
		/^Bridge request timed out: [^:]+:(?:get|list|read|has|is|detect|discover|search|check|count|inspect|query)(?:$|[A-Z:-])/.test(
			message
		)
	);
}

export const WEB_BRIDGE_STATE_EVENT = 'maestro:bridge-state';

/** Native Electron has no bridge state. Browser work resumes after reconciliation. */
export function isBridgeTransportReady(): boolean {
	const bridgeWindow = (globalThis as unknown as { window?: Record<string, unknown> }).window;
	const state = bridgeWindow?.__MAESTRO_BRIDGE_STATE__;
	return state === undefined || state === 'connected';
}
