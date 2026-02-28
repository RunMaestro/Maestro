import type { AITab } from '../types';

/**
 * Get the display name for a tab.
 * Priority: name > truncated session ID > "New Session"
 *
 * Handles different agent session ID formats:
 * - Claude UUID: "abc123-def456-ghi789" → "ABC123" (first octet)
 * - OpenCode: "SES_4BCDFE8C5FFE4KC1UV9NSMYEDB" → "SES_4BCD" (prefix + 4 chars)
 * - Codex: "thread_abc123..." → "THR_ABC1" (prefix + 4 chars)
 */
export function getTabDisplayName(tab: Pick<AITab, 'name' | 'agentSessionId'>): string {
	const normalizedName = tab.name?.trim();
	if (normalizedName) {
		return normalizedName;
	}
	if (tab.agentSessionId) {
		const id = tab.agentSessionId;

		// OpenCode format: ses_XXXX... or SES_XXXX...
		if (id.toLowerCase().startsWith('ses_')) {
			// Return "SES_" + first 4 chars of the ID portion
			return `SES_${id.slice(4, 8).toUpperCase()}`;
		}

		// Codex format: thread_XXXX...
		if (id.toLowerCase().startsWith('thread_')) {
			// Return "THR_" + first 4 chars of the ID portion
			return `THR_${id.slice(7, 11).toUpperCase()}`;
		}

		// Claude UUID format: has dashes, return first octet
		if (id.includes('-')) {
			return id.split('-')[0].toUpperCase();
		}

		// Generic fallback: first 8 chars uppercase
		return id.slice(0, 8).toUpperCase();
	}
	return 'New Session';
}
