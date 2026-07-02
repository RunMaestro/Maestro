/**
 * parseQrPayload - Parse Maestro pairing QR code / URL payloads
 *
 * The desktop app exposes two QR codes that a mobile device can use to pair:
 *
 *  1. The "Pair New Device" modal generates a short-lived pairing code wrapped
 *     in a custom URL scheme:
 *
 *         maestro://pair?host=<host>&port=<port>&code=<code>
 *
 *     The mobile app exchanges <code> with the desktop's
 *     POST /api/mobile-pairing/redeem endpoint for a long-lived (90-day) token.
 *
 *  2. The "Persistent Web Link" section shows the underlying web URL containing
 *     the server's security token in the URL path:
 *
 *         http(s)://<host>:<port>/<token>[/optional-path]
 *
 *     That token is already a valid credential for the WebSocket route
 *     (`src/main/web-server/routes/wsRoute.ts`), so the mobile app can use it
 *     directly without going through the pair-code redemption flow.
 *
 * The parser returns a discriminated union so the caller knows which auth flow
 * to run. Returning `null` means the input doesn't match either format.
 *
 * Part of M3 Mobile Expo App implementation.
 */

/** Pairing payload from the `maestro://pair?...` QR. Needs to be redeemed. */
export interface PairCodePayload {
	kind: 'pair-code';
	host: string;
	port: number;
	code: string;
}

/** Pairing payload from a desktop web URL. Token is already usable. */
export interface WebLinkPayload {
	kind: 'web-link';
	host: string;
	port: number;
	token: string;
}

/** Discriminated union of the two accepted QR / URL formats. */
export type QrPairPayload = PairCodePayload | WebLinkPayload;

/**
 * Parse the raw string from a QR scan or manual entry field. Accepts both
 * the `maestro://pair?...` pairing-code URL and the desktop's persistent web
 * link URL. Returns null if neither format is recognised.
 */
export function parseQrPayload(data: string): QrPairPayload | null {
	if (!data) return null;

	const trimmed = data.trim();
	if (!trimmed) return null;

	if (trimmed.startsWith('maestro://pair')) {
		return parsePairCodeUrl(trimmed);
	}

	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
		return parseWebLinkUrl(trimmed);
	}

	return null;
}

/**
 * Parse `maestro://pair?host=<host>&port=<port>&code=<code>`.
 */
function parsePairCodeUrl(data: string): PairCodePayload | null {
	let url: URL;
	try {
		url = new URL(data);
	} catch {
		return null;
	}

	const host = url.searchParams.get('host');
	const portStr = url.searchParams.get('port');
	const code = url.searchParams.get('code');
	if (!host || !portStr || !code) return null;

	const port = parsePort(portStr);
	if (port === null) return null;

	if (code.trim().length === 0) return null;

	return { kind: 'pair-code', host, port, code };
}

/**
 * Parse `http(s)://<host>:<port>/<token>[/...]`. The token is the first path
 * segment and must be a UUID v4 (the same shape the desktop generates via
 * `crypto.randomUUID()` in `web-server-factory.ts`). Requiring UUID v4 keeps
 * us from accepting random URLs like `http://example.com/about` as credentials.
 */
function parseWebLinkUrl(data: string): WebLinkPayload | null {
	let url: URL;
	try {
		url = new URL(data);
	} catch {
		return null;
	}

	const host = url.hostname;
	if (!host) return null;

	// The desktop web URL always carries an explicit port. `URL.port` is empty
	// for the default port (80 / 443), but the desktop binds to an ephemeral
	// port, so a missing port means this URL is not the desktop web link.
	if (!url.port) return null;
	const port = parsePort(url.port);
	if (port === null) return null;

	// First non-empty path segment is the token; ignore any trailing path.
	const segments = url.pathname.split('/').filter((s) => s.length > 0);
	const token = segments[0];
	if (!token) return null;
	if (!UUID_V4_REGEX.test(token)) return null;

	return { kind: 'web-link', host, port, token };
}

/**
 * Strict integer port parser. Rejects floats (parseInt would truncate
 * `8080.5` to `8080`) and out-of-range values.
 */
function parsePort(value: string): number | null {
	const port = parseInt(value, 10);
	if (isNaN(port) || port <= 0 || port > 65535) return null;
	if (value !== String(port)) return null;
	return port;
}

/**
 * UUID v4 shape, matching the regex the desktop's web-server-factory uses to
 * validate its own token. Lowercase and uppercase both accepted.
 */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
