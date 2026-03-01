// Terminal tab helper functions — pure functions for managing TerminalTab state in Maestro sessions.
// Follows the same pattern as tabHelpers.ts: take a Session, return a new Session (immutable).
// No React hooks, no side effects, no IPC.

import { Session, TerminalTab, ClosedTabEntry, UnifiedTabRef } from '../types';
import { generateId } from './ids';

/** Maximum number of closed terminal tab entries to expose via the public API (e.g., for UI limits). */
export const MAX_CLOSED_TERMINAL_TABS = 10;

/** Maximum entries in unifiedClosedTabHistory — matches tabHelpers.ts MAX_CLOSED_TAB_HISTORY. */
const MAX_CLOSED_UNIFIED_HISTORY = 25;

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a new TerminalTab with default values.
 * The tab is not yet associated with a PTY (pid=0); the PTY is spawned lazily on first render.
 *
 * @param shellType - Shell binary name (default: 'zsh')
 * @param cwd - Initial working directory (default: '')
 * @param name - User-defined name; null displays "Terminal N" (default: null)
 * @returns A new TerminalTab ready to be added to a session
 */
export function createTerminalTab(
	shellType?: string,
	cwd?: string,
	name?: string | null
): TerminalTab {
	return {
		id: generateId(),
		name: name ?? null,
		shellType: shellType ?? 'zsh',
		pid: 0,
		cwd: cwd ?? '',
		createdAt: Date.now(),
		state: 'idle',
	};
}

// ─── Selectors ───────────────────────────────────────────────────────────────

/**
 * Get the currently active terminal tab for a session.
 * Returns undefined if there are no terminal tabs or activeTerminalTabId is null.
 */
export function getActiveTerminalTab(session: Session): TerminalTab | undefined {
	if (!session.activeTerminalTabId || !session.terminalTabs) {
		return undefined;
	}
	return session.terminalTabs.find((tab) => tab.id === session.activeTerminalTabId);
}

/**
 * Get the display name for a terminal tab.
 * Returns tab.name if set, otherwise "Terminal N" (1-indexed by position).
 *
 * @param tab - The terminal tab
 * @param index - Zero-based index of the tab in the terminal tabs array
 */
export function getTerminalTabDisplayName(tab: TerminalTab, index: number): string {
	return tab.name ?? `Terminal ${index + 1}`;
}

/**
 * Returns true if any terminal tab in the session has an active (busy) PTY process.
 * Used to gate UI actions that require no running processes.
 */
export function hasRunningTerminalProcess(session: Session): boolean {
	return (session.terminalTabs || []).some((tab) => tab.state === 'busy');
}

// ─── Session ID Helpers ──────────────────────────────────────────────────────

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

// ─── CRUD Mutations ──────────────────────────────────────────────────────────

/**
 * Add a terminal tab to a session.
 * Appends the tab to terminalTabs, adds it to unifiedTabOrder, and makes it the active terminal tab.
 *
 * @param session - The Maestro session to add the tab to
 * @param tab - The TerminalTab to add (created via createTerminalTab)
 * @returns New session with the tab added and set as active
 */
export function addTerminalTab(session: Session, tab: TerminalTab): Session {
	const newTabRef: UnifiedTabRef = { type: 'terminal', id: tab.id };
	return {
		...session,
		terminalTabs: [...(session.terminalTabs || []), tab],
		activeTerminalTabId: tab.id,
		unifiedTabOrder: [...(session.unifiedTabOrder || []), newTabRef],
	};
}

/**
 * Close a terminal tab and add it to the unified closed tab history (for Cmd+Shift+T undo).
 * Refuses to close the last terminal tab (returns session unchanged).
 * When closing the active terminal tab, selects the adjacent tab to the left (or right if at index 0).
 *
 * @param session - The Maestro session containing the terminal tab
 * @param tabId - The ID of the terminal tab to close
 * @returns New session with the tab removed, or the original session if closing is not allowed
 */
export function closeTerminalTab(session: Session, tabId: string): Session {
	const terminalTabs = session.terminalTabs || [];

	// Refuse to close the last terminal tab
	if (terminalTabs.length <= 1) {
		return session;
	}

	const tabToClose = terminalTabs.find((tab) => tab.id === tabId);
	if (!tabToClose) {
		return session;
	}

	const tabIndex = terminalTabs.findIndex((tab) => tab.id === tabId);
	const unifiedOrder = session.unifiedTabOrder || [];
	const unifiedIndex = unifiedOrder.findIndex(
		(ref) => ref.type === 'terminal' && ref.id === tabId
	);

	// Build the closed tab entry for unified history
	const closedTabEntry: ClosedTabEntry = {
		type: 'terminal',
		tab: { ...tabToClose },
		unifiedIndex: unifiedIndex !== -1 ? unifiedIndex : unifiedOrder.length,
		closedAt: Date.now(),
	};

	// Remove from terminalTabs and unifiedTabOrder
	const updatedTerminalTabs = terminalTabs.filter((tab) => tab.id !== tabId);
	const updatedUnifiedTabOrder = unifiedOrder.filter(
		(ref) => !(ref.type === 'terminal' && ref.id === tabId)
	);

	// Select adjacent terminal tab when closing the active tab
	let newActiveTerminalTabId = session.activeTerminalTabId;
	if (session.activeTerminalTabId === tabId) {
		const newIndex = Math.max(0, tabIndex - 1);
		newActiveTerminalTabId = updatedTerminalTabs[newIndex]?.id ?? null;
	}

	// Prepend to unified closed history, capped at MAX_CLOSED_UNIFIED_HISTORY
	const updatedUnifiedHistory = [
		closedTabEntry,
		...(session.unifiedClosedTabHistory || []),
	].slice(0, MAX_CLOSED_UNIFIED_HISTORY);

	return {
		...session,
		terminalTabs: updatedTerminalTabs,
		activeTerminalTabId: newActiveTerminalTabId,
		unifiedTabOrder: updatedUnifiedTabOrder,
		unifiedClosedTabHistory: updatedUnifiedHistory,
	};
}

/**
 * Set the active terminal tab for a session.
 * Clears activeFileTabId so that the terminal view takes focus (only one non-AI tab active at a time).
 *
 * @param session - The Maestro session
 * @param tabId - The ID of the terminal tab to make active
 * @returns New session with the terminal tab active, or original session if tab not found
 */
export function selectTerminalTab(session: Session, tabId: string): Session {
	const tab = (session.terminalTabs || []).find((t) => t.id === tabId);
	if (!tab) {
		return session;
	}
	return {
		...session,
		activeTerminalTabId: tabId,
		activeFileTabId: null,
	};
}

/**
 * Rename a terminal tab.
 * An empty string sets the name back to null (restores auto-generated "Terminal N" display).
 *
 * @param session - The Maestro session
 * @param tabId - The ID of the terminal tab to rename
 * @param name - New display name; empty string resets to null (auto-name)
 * @returns New session with the tab renamed, or original session if tab not found
 */
export function renameTerminalTab(session: Session, tabId: string, name: string): Session {
	const terminalTabs = session.terminalTabs || [];
	if (!terminalTabs.find((tab) => tab.id === tabId)) {
		return session;
	}
	return {
		...session,
		terminalTabs: terminalTabs.map((tab) =>
			tab.id === tabId ? { ...tab, name: name === '' ? null : name } : tab
		),
	};
}

/**
 * Reorder terminal tabs within the terminalTabs array.
 * Note: The visual order in the tab bar is determined by unifiedTabOrder and is reordered separately
 * (via reorderUnifiedTabs in tabHelpers.ts). This function updates the underlying array order.
 *
 * @param session - The Maestro session
 * @param fromIndex - Zero-based index of the tab to move
 * @param toIndex - Zero-based destination index
 * @returns New session with reordered terminalTabs, or original session if indices are invalid
 */
export function reorderTerminalTabs(
	session: Session,
	fromIndex: number,
	toIndex: number
): Session {
	const terminalTabs = [...(session.terminalTabs || [])];

	if (
		fromIndex < 0 ||
		fromIndex >= terminalTabs.length ||
		toIndex < 0 ||
		toIndex >= terminalTabs.length ||
		fromIndex === toIndex
	) {
		return session;
	}

	const [movedTab] = terminalTabs.splice(fromIndex, 1);
	terminalTabs.splice(toIndex, 0, movedTab);

	return {
		...session,
		terminalTabs,
	};
}

// ─── State Updates ───────────────────────────────────────────────────────────

/**
 * Update the PTY lifecycle state of a terminal tab.
 * Optionally sets the exitCode when transitioning to 'exited'.
 *
 * @param session - The Maestro session
 * @param tabId - The ID of the terminal tab to update
 * @param state - New state ('idle' | 'busy' | 'exited')
 * @param exitCode - Exit code (only meaningful when state === 'exited')
 * @returns New session with the tab state updated
 */
export function updateTerminalTabState(
	session: Session,
	tabId: string,
	state: TerminalTab['state'],
	exitCode?: number
): Session {
	const terminalTabs = session.terminalTabs || [];
	return {
		...session,
		terminalTabs: terminalTabs.map((tab) =>
			tab.id === tabId
				? { ...tab, state, ...(exitCode !== undefined ? { exitCode } : {}) }
				: tab
		),
	};
}

/**
 * Update the PTY process ID for a terminal tab.
 * Called after the PTY is spawned and the PID is known.
 *
 * @param session - The Maestro session
 * @param tabId - The ID of the terminal tab to update
 * @param pid - The PTY process ID (0 means not yet spawned)
 * @returns New session with the tab PID updated
 */
export function updateTerminalTabPid(session: Session, tabId: string, pid: number): Session {
	const terminalTabs = session.terminalTabs || [];
	return {
		...session,
		terminalTabs: terminalTabs.map((tab) => (tab.id === tabId ? { ...tab, pid } : tab)),
	};
}

/**
 * Update the current working directory for a terminal tab.
 * Called when the shell reports a directory change (e.g., via OSC sequences or shell integration).
 *
 * @param session - The Maestro session
 * @param tabId - The ID of the terminal tab to update
 * @param cwd - New working directory path
 * @returns New session with the tab CWD updated
 */
export function updateTerminalTabCwd(session: Session, tabId: string, cwd: string): Session {
	const terminalTabs = session.terminalTabs || [];
	return {
		...session,
		terminalTabs: terminalTabs.map((tab) => (tab.id === tabId ? { ...tab, cwd } : tab)),
	};
}
