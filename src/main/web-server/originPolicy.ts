/**
 * Origin policy for the web/CLI control server.
 *
 * Every route sits behind the URL token, but the token is only half of the
 * story: a browser will attach a URL the attacker already knows to a request a
 * hostile page makes, and then hand that page the response if CORS says so.
 * So any request that carries an `Origin` header (every browser WebSocket
 * upgrade, every cross-origin fetch, every browser POST) must come from a page
 * this server itself served:
 *
 * - the same host the request was sent to (the web interface talking to the
 *   server that served it, over the LAN address or `127.0.0.1`), or
 * - a trusted origin supplied by the caller (the active Cloudflare tunnel,
 *   whose public hostname need not match the Host header cloudflared forwards).
 *
 * A request with no `Origin` header is allowed. It comes from a non-browser
 * client (`maestro-cli`, curl) or is a same-origin GET, and a third-party page
 * cannot strip the header from a request it makes.
 *
 * `Origin: null` (sandboxed iframes, `file://` pages, opaque redirects) is
 * rejected: any page can produce it on demand.
 */

export interface RequestOriginCheck {
	/** The request's `Origin` header, if any. */
	origin: string | string[] | undefined;
	/** The request's `Host` header, if any. */
	host: string | undefined;
	/** Extra origins to accept, e.g. the active tunnel's `https://...` URL. */
	trustedOrigins?: readonly string[];
}

function originOf(value: string): string | null {
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

/** Whether a request may proceed given its `Origin` and `Host` headers. */
export function isAllowedRequestOrigin({
	origin,
	host,
	trustedOrigins = [],
}: RequestOriginCheck): boolean {
	// Node joins repeated headers for most names, but guard the array shape
	// anyway: more than one Origin is never something a browser sends.
	if (Array.isArray(origin)) return false;
	if (origin === undefined || origin === '') return true;

	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		// Covers the literal "null" origin and anything malformed.
		return false;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

	if (host && parsed.host === host.trim().toLowerCase()) return true;

	return trustedOrigins.some((trusted) => originOf(trusted) === parsed.origin);
}
