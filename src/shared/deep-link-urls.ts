/**
 * Deep Link URL Builders & Parser
 *
 * Shared utilities for constructing and parsing maestro:// URLs with proper
 * URI encoding. Used by main process (protocol handler + notification click
 * handlers), renderer (in-app markdown link clicks), and shared modules
 * (template variable substitution).
 */

import type { ParsedDeepLink } from './types';

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
 * Pure parser for `maestro://` URLs. Returns null for malformed or
 * unrecognized inputs. Free of side effects (no logging, no IPC) so it can
 * run in any process — main, renderer, or web/mobile.
 */
export function parseMaestroDeepLink(url: string): ParsedDeepLink | null {
	try {
		// Normalize: strip protocol prefix (handles both maestro:// and maestro: on Windows)
		const normalized = url.replace(/^maestro:\/\//, '').replace(/^maestro:/, '');
		const parts = normalized.split('/').filter(Boolean);

		if (parts.length === 0) return { action: 'focus' };

		const [resource, id, sub, subId] = parts;

		if (resource === 'focus') return { action: 'focus' };

		if (resource === 'session' && id) {
			if (sub === 'tab' && subId) {
				return {
					action: 'session',
					sessionId: decodeURIComponent(id),
					tabId: decodeURIComponent(subId),
				};
			}
			return { action: 'session', sessionId: decodeURIComponent(id) };
		}

		if (resource === 'group' && id) {
			return { action: 'group', groupId: decodeURIComponent(id) };
		}

		return null;
	} catch {
		return null;
	}
}
