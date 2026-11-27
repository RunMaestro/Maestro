/**
 * Deep Link URL Builders & Parser
 *
 * Shared utilities for constructing and parsing maestro:// URLs with proper
 * URI encoding. Used by main process (protocol handler + notification click
 * handlers), renderer (in-app markdown link clicks), and shared modules
 * (template variable substitution).
 */

import type { ParsedDeepLink } from './types';
import { safeDecodeURIComponent } from './stringUtils';

const PROTOCOL = 'maestro://';

/**
 * Build a deep link URL for a session, optionally targeting a specific tab.
 */
export function buildSessionDeepLink(sessionId: string, tabId?: string): string {
	if (tabId) {
		return `${PROTOCOL}session/${encodeURIComponent(sessionId)}/tab/${encodeURIComponent(tabId)}`;
	}
	return `${PROTOCOL}session/${encodeURIComponent(sessionId)}`;
}

/**
 * Build a deep link URL for a group.
 */
export function buildGroupDeepLink(groupId: string): string {
	return `${PROTOCOL}group/${encodeURIComponent(groupId)}`;
}

/**
 * Build a deep link URL for a file at an optional line number, scoped to a
 * specific agent session.
 *
 * The file path is percent-encoded into a single path segment so slashes don't
 * confuse the path-segment parser. Line numbers ride as a `#L<n>` fragment.
 */
export function buildFileDeepLink(sessionId: string, filePath: string, line?: number): string {
	const base = `${PROTOCOL}file/${encodeURIComponent(sessionId)}/${encodeURIComponent(filePath)}`;
	return line !== undefined && Number.isFinite(line) && line > 0 ? `${base}#L${line}` : base;
}

/**
 * Build a Prompt Link URL (`maestro://run/<token>`). The token is opaque and
 * base64url, so it needs no encoding; everything the link does is stored in
 * Maestro under a hash of it (see `shared/promptLinks.ts`).
 */
export function buildPromptLinkUrl(token: string): string {
	return `${PROTOCOL}run/${token}`;
}

/**
 * The same URL with any Prompt Link token cut to its first four characters, for
 * logs. A full token in a log line is a working link for anyone who reads the
 * log; every other `maestro://` URL is returned unchanged.
 */
export function redactDeepLinkUrl(url: string): string {
	return url.replace(/^(maestro:(?:\/\/)?run\/)([^/?#]{0,4})[^/?#]*/, (_m, head, keep) =>
		keep ? `${head}${keep}...` : head
	);
}

/**
 * Pure parser for `maestro://` URLs. Returns null for malformed or
 * unrecognized inputs. Free of side effects (no logging, no IPC) so it can
 * run in any process - main, renderer, or web/mobile.
 */
export function parseMaestroDeepLink(url: string): ParsedDeepLink | null {
	try {
		// Normalize: strip protocol prefix (handles both maestro:// and maestro: on Windows)
		const normalized = url.replace(/^maestro:\/\//, '').replace(/^maestro:/, '');
		// Strip and remember any `#fragment` (used for line numbers on files).
		const hashIdx = normalized.indexOf('#');
		const pathPart = hashIdx >= 0 ? normalized.slice(0, hashIdx) : normalized;
		const hashPart = hashIdx >= 0 ? normalized.slice(hashIdx + 1) : '';
		const parts = pathPart.split('/').filter(Boolean);

		if (parts.length === 0) return { action: 'focus' };

		const [resource, id, sub, subId] = parts;

		if (resource === 'focus') return { action: 'focus' };

		if (resource === 'session' && id) {
			if (sub === 'tab' && subId) {
				return {
					action: 'session',
					sessionId: safeDecodeURIComponent(id),
					tabId: safeDecodeURIComponent(subId),
				};
			}
			return { action: 'session', sessionId: safeDecodeURIComponent(id) };
		}

		if (resource === 'group' && id) {
			return { action: 'group', groupId: safeDecodeURIComponent(id) };
		}

		// A Prompt Link carries one opaque token and nothing else. Extra path
		// segments are refused rather than ignored, so a URL that looks like it
		// says more than it does never runs.
		if (resource === 'run' && id && parts.length === 2) {
			return { action: 'run', token: safeDecodeURIComponent(id) };
		}

		if (resource === 'file' && id && sub) {
			const line = parseLineFragment(hashPart);
			const result: ParsedDeepLink = {
				action: 'file',
				sessionId: safeDecodeURIComponent(id),
				filePath: safeDecodeURIComponent(sub),
			};
			if (line !== undefined) result.line = line;
			return result;
		}

		return null;
	} catch {
		return null;
	}
}

function parseLineFragment(hash: string): number | undefined {
	if (!hash) return undefined;
	const m = hash.match(/^L(\d+)$/);
	if (!m) return undefined;
	const n = Number(m[1]);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}
