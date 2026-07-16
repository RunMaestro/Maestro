/**
 * Request-specific response channels used only for coworking main-to-renderer round trips.
 * Their UUID component prevents a renderer response for one request from matching another.
 */
export const COWORKING_RESPONSE_CHANNEL_PREFIX = 'coworking:response:';

export type CoworkingResponseKind = 'buffer' | 'browser-op';

export type CoworkingResponseChannel<Kind extends CoworkingResponseKind = CoworkingResponseKind> =
	`${typeof COWORKING_RESPONSE_CHANNEL_PREFIX}${Kind}:${string}`;

const RESPONSE_CHANNEL_PATTERN =
	/^coworking:response:(buffer|browser-op):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createCoworkingResponseChannel<Kind extends CoworkingResponseKind>(
	kind: Kind,
	requestId: string
): CoworkingResponseChannel<Kind> {
	return `${COWORKING_RESPONSE_CHANNEL_PREFIX}${kind}:${requestId}`;
}

export function isCoworkingResponseChannel<Kind extends CoworkingResponseKind>(
	value: unknown,
	kind: Kind
): value is CoworkingResponseChannel<Kind> {
	if (typeof value !== 'string') return false;
	const match = RESPONSE_CHANNEL_PATTERN.exec(value);
	return match?.[1] === kind;
}
