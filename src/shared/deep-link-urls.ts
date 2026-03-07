/**
 * Deep Link URL Builders
 *
 * Shared utilities for constructing maestro:// URLs with proper URI encoding.
 * Used by both main process (notification click handlers) and shared modules
 * (template variable substitution).
 */

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
 * Build a deep link URL that simply brings the window to foreground.
 */
export function buildFocusDeepLink(): string {
	return `${PROTOCOL}focus`;
}
