/**
 * What an AI tab is called on screen.
 *
 * The desktop's tab strip and the TUI's tab switcher share this, so a tab the
 * user never named reads the same in both: its provider session id, shortened
 * to the form each provider's ids take.
 */

/** The two tab fields the label depends on. */
export interface TabLabelFields {
	name?: string | null;
	agentSessionId?: string | null;
}

/**
 * Format a session/tab ID into a short display label.
 */
export function formatSessionId(id: string): string {
	// OpenCode format: ses_XXXX... or SES_XXXX...
	if (id.toLowerCase().startsWith('ses_')) {
		return `SES_${id.slice(4, 8).toUpperCase()}`;
	}
	// Codex format: thread_XXXX...
	if (id.toLowerCase().startsWith('thread_')) {
		return `THR_${id.slice(7, 11).toUpperCase()}`;
	}
	// UUID format: has dashes, return first octet
	if (id.includes('-')) {
		return id.split('-')[0].toUpperCase();
	}
	// Generic fallback: first 8 chars uppercase
	return id.slice(0, 8).toUpperCase();
}

/**
 * The display name for a tab. Strictly per-tab: the title only reflects THIS
 * tab's own state, never another tab's id from the agent level.
 *
 * Resolution order:
 *   1. `tab.name` if set (auto-rename or manual rename)
 *   2. `tab.agentSessionId` formatted (e.g. `SES_4BCD`, `THR_ABC1`, first UUID octet)
 *   3. "New Session"
 */
export function getTabDisplayName(tab: TabLabelFields): string {
	if (tab.name) return tab.name;
	if (tab.agentSessionId) return formatSessionId(tab.agentSessionId);
	return 'New Session';
}
