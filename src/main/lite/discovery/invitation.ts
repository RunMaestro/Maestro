import { candidate, httpsOrigin, type Candidate } from './types';

const MAX_LIFETIME = 5 * 60000;
const PREFIX = '#maestro-invite=';

/** An expiring location hint, not authentication, an account link, or saved trust. */
export function issueInvitation(
	host: { id: string; name: string; endpoint: string },
	now = Date.now(),
	lifetimeMs = MAX_LIFETIME
): string {
	if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > MAX_LIFETIME)
		throw new Error('Invitation lifetime must be at most five minutes');
	const row = candidate(host.id, host.name, host.endpoint, 'cloudflare', now + lifetimeMs);
	const payload = {
		version: 1,
		id: row.id,
		name: row.name,
		endpoint: row.endpoint,
		expiresAt: row.expiresAt,
	};
	return row.endpoint + '/' + PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function parseInvitation(text: string, now = Date.now()): Candidate {
	if (typeof text !== 'string' || text.length > 4096) throw new Error('Invitation is too large');
	let url: URL;
	try {
		url = new URL(text.trim());
	} catch {
		throw new Error('Paste the complete invitation copied or scanned from the host');
	}
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.pathname !== '/' ||
		url.search ||
		!url.hash.startsWith(PREFIX)
	)
		throw new Error('Expected a host-issued HTTPS invitation, not a Remote Control link');
	const encoded = url.hash.slice(PREFIX.length);
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid invitation encoding');
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
	} catch {
		throw new Error('Invalid invitation payload');
	}
	if (
		!payload ||
		typeof payload !== 'object' ||
		Array.isArray(payload) ||
		payload.version !== 1 ||
		Object.keys(payload).some(
			(key) => !['version', 'id', 'name', 'endpoint', 'expiresAt'].includes(key)
		)
	)
		throw new Error('Unsupported invitation; credentials are not accepted');
	if (httpsOrigin(payload.endpoint) !== url.origin) throw new Error('Invitation origin mismatch');
	if (
		typeof payload.expiresAt !== 'number' ||
		!Number.isSafeInteger(payload.expiresAt) ||
		payload.expiresAt <= now ||
		payload.expiresAt > now + MAX_LIFETIME
	)
		throw new Error('Invitation expired or outside the five-minute window');
	return candidate(payload.id, payload.name, payload.endpoint, 'cloudflare', payload.expiresAt);
}
