/**
 * The process id of a terminal tab's PTY: `{sessionId}-terminal-{tabId}`.
 *
 * Shared because both ends name the PTY: the renderer spawns, writes, and
 * resizes it, and the main process holds the Tab Windows terminal handoff for
 * it (`src/main/terminal-handoff.ts`). The renderer imports these through
 * `src/renderer/utils/terminalTabHelpers.ts`.
 */

/**
 * Get the composite terminal session ID that identifies a specific terminal tab within a Maestro session.
 * Format: "{sessionId}-terminal-{tabId}"
 * Distinguishes terminal sessions from AI sessions ("{sessionId}-ai-{tabId}").
 */
export function getTerminalSessionId(sessionId: string, tabId: string): string {
	return `${sessionId}-terminal-${tabId}`;
}

/**
 * Parse a composite terminal session ID back into its component parts.
 * Returns null if the string doesn't match the expected "-terminal-" format.
 */
export function parseTerminalSessionId(
	terminalSessionId: string
): { sessionId: string; tabId: string } | null {
	const separator = '-terminal-';
	const separatorIndex = terminalSessionId.indexOf(separator);
	if (separatorIndex === -1) {
		return null;
	}
	const sessionId = terminalSessionId.substring(0, separatorIndex);
	const tabId = terminalSessionId.substring(separatorIndex + separator.length);
	if (!sessionId || !tabId) {
		return null;
	}
	return { sessionId, tabId };
}
