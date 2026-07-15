import { generateUUID } from '../../shared/uuid';

/**
 * Generate a random unique identifier.
 *
 * Prefers the crypto-secure `crypto.randomUUID()` when available. Safari and
 * other browsers gate that behind a secure context (HTTPS or localhost), so
 * over plain-HTTP origins (Tailscale IPs, LAN URLs) the API is `undefined`
 * and would throw on call. Fall back to the Math.random-based UUID v4 - fine
 * for renderer-side correlation IDs, tab IDs, and request IDs.
 */
export const generateId = (): string => {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return generateUUID();
};

let inputBroadcastOriginId: string | null = null;

export const getInputBroadcastOriginId = (): string => {
	if (!inputBroadcastOriginId) {
		inputBroadcastOriginId = generateId();
	}
	return inputBroadcastOriginId;
};
