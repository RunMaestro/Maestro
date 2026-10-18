/**
 * Per-link browser routing hints.
 *
 * An ordinary http(s) URL can carry a scheme prefix that decides where it
 * opens, regardless of the `useSystemBrowser` setting or any modifier key:
 *
 *   maestro+https://host/path  -> always a Maestro browser tab
 *   system+https://host/path   -> always the system browser
 *
 * The prefix is stripped before the URL is opened, so the destination never
 * sees it. A prefix (rather than a `#maestro` fragment or `?maestro=1` query)
 * keeps real anchors, SPA hash routes, cache keys and signed URLs intact, and
 * follows the `git+https` convention.
 *
 * Only http(s) may sit behind a hint. `maestro+file:`, `maestro+javascript:`,
 * `system+ssh:` and friends parse as `invalid` and must open nothing: the
 * fallback for an unknown scheme is `shell.openExternal`, which would hand
 * the OS whatever the link names.
 */

export type UrlRoutingHint = 'maestro' | 'system';

export type ParsedUrlRoutingHint =
	/** No hint: `url` is the input, untouched. */
	| { kind: 'none'; url: string }
	/** A valid hint: `url` is the stripped http(s) URL. */
	| { kind: 'hinted'; hint: UrlRoutingHint; url: string }
	/** A hint in front of something that is not http(s). Open nothing. */
	| { kind: 'invalid' };

/** Regex source for the optional hint prefix, for callers that detect URLs in text. */
export const URL_ROUTING_HINT_PREFIX_SOURCE = '(?:maestro|system)\\+';

const HINT_PREFIX_RE = /^(maestro|system)\+/i;
const WEB_URL_RE = /^https?:\/\//i;

export function parseUrlRoutingHint(url: string): ParsedUrlRoutingHint {
	const match = HINT_PREFIX_RE.exec(url);
	if (!match) return { kind: 'none', url };
	const rest = url.slice(match[0].length);
	if (!WEB_URL_RE.test(rest)) return { kind: 'invalid' };
	return { kind: 'hinted', hint: match[1].toLowerCase() as UrlRoutingHint, url: rest };
}

/** True for `http(s)://...`, with or without a valid routing hint. */
export function isWebUrl(url: string): boolean {
	const parsed = parseUrlRoutingHint(url);
	return parsed.kind !== 'invalid' && WEB_URL_RE.test(parsed.url);
}

/** True for a URL that carries a valid routing hint. */
export function hasUrlRoutingHint(url: string): boolean {
	return parseUrlRoutingHint(url).kind === 'hinted';
}

/**
 * The URL with any valid hint removed: what "Copy Link" should copy and what
 * the destination should see. An invalid hint is returned unchanged.
 */
export function stripUrlRoutingHint(url: string): string {
	const parsed = parseUrlRoutingHint(url);
	return parsed.kind === 'hinted' ? parsed.url : url;
}
