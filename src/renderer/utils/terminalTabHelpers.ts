/**
 * Terminal tab helper utilities
 * Mirrors the pattern from tabHelpers.ts for AI tabs
 */

import type { Session, TerminalTab, ClosedTerminalTab } from '../types';
import { generateId } from './ids';

/**
 * Get the active terminal tab for a session
 */
export function getActiveTerminalTab(session: Session): TerminalTab | undefined {
	return session.terminalTabs?.find((tab) => tab.id === session.activeTerminalTabId);
}

/**
 * Set the active terminal tab for a session
 */
export function setActiveTerminalTab(session: Session, tabId: string): Session {
	if (session.activeTerminalTabId === tabId) {
		return session;
	}

	return {
		...session,
		activeTerminalTabId: tabId,
	};
}

/**
 * Rename a terminal tab.
 * Empty names are normalized to null.
 */
export function renameTerminalTab(session: Session, tabId: string, name: string): Session {
	const normalizedName = name.trim() || null;
	let didUpdate = false;

	const updatedTabs = session.terminalTabs.map((tab) => {
		if (tab.id !== tabId) {
			return tab;
		}

		if (tab.name === normalizedName) {
			return tab;
		}

		didUpdate = true;
		return {
			...tab,
			name: normalizedName,
		};
	});

	if (!didUpdate) {
		return session;
	}

	return {
		...session,
		terminalTabs: updatedTabs,
	};
}

/**
 * Update terminal tab runtime state.
 * exitCode is persisted only when state is exited.
 */
export function updateTerminalTabState(
	session: Session,
	tabId: string,
	state: TerminalTab['state'],
	exitCode?: number
): Session {
	const nextExitCode = state === 'exited' ? exitCode : undefined;
	let didUpdate = false;

	const updatedTabs = session.terminalTabs.map((tab) => {
		if (tab.id !== tabId) {
			return tab;
		}

		if (tab.state === state && tab.exitCode === nextExitCode) {
			return tab;
		}

		didUpdate = true;
		return {
			...tab,
			state,
			exitCode: nextExitCode,
		};
	});

	if (!didUpdate) {
		return session;
	}

	return {
		...session,
		terminalTabs: updatedTabs,
	};
}

/**
 * Update terminal tab current working directory.
 */
export function updateTerminalTabCwd(session: Session, tabId: string, cwd: string): Session {
	let didUpdate = false;

	const updatedTabs = session.terminalTabs.map((tab) => {
		if (tab.id !== tabId) {
			return tab;
		}

		if (tab.cwd === cwd) {
			return tab;
		}

		didUpdate = true;
		return {
			...tab,
			cwd,
		};
	});

	if (!didUpdate) {
		return session;
	}

	return {
		...session,
		terminalTabs: updatedTabs,
	};
}

/**
 * Update terminal tab process ID.
 */
export function updateTerminalTabPid(session: Session, tabId: string, pid: number): Session {
	let didUpdate = false;

	const updatedTabs = session.terminalTabs.map((tab) => {
		if (tab.id !== tabId) {
			return tab;
		}

		if (tab.pid === pid) {
			return tab;
		}

		didUpdate = true;
		return {
			...tab,
			pid,
		};
	});

	if (!didUpdate) {
		return session;
	}

	return {
		...session,
		terminalTabs: updatedTabs,
	};
}

/**
 * Reorder terminal tabs in a session.
 */
export function reorderTerminalTabs(session: Session, fromIndex: number, toIndex: number): Session {
	if (
		fromIndex === toIndex ||
		fromIndex < 0 ||
		toIndex < 0 ||
		fromIndex >= session.terminalTabs.length ||
		toIndex >= session.terminalTabs.length
	) {
		return session;
	}

	const reorderedTabs = [...session.terminalTabs];
	const [movedTab] = reorderedTabs.splice(fromIndex, 1);
	if (!movedTab) {
		return session;
	}

	reorderedTabs.splice(toIndex, 0, movedTab);

	return {
		...session,
		terminalTabs: reorderedTabs,
	};
}

/**
 * Create a new terminal tab with default values
 */
export function createTerminalTab(
	shellType: string = 'zsh',
	cwd: string = '',
	name: string | null = null
): TerminalTab {
	return {
		id: generateId(),
		name,
		shellType,
		pid: 0,
		cwd,
		createdAt: Date.now(),
		state: 'idle',
	};
}

export interface AddTerminalTabResult {
	tab: TerminalTab;
	session: Session;
}

/**
 * Add a new terminal tab to a session and activate it.
 */
export function addTerminalTab(session: Session, shellType: string = 'zsh'): AddTerminalTabResult {
	const newTab = createTerminalTab(shellType, session.cwd, null);

	return {
		tab: newTab,
		session: {
			...session,
			terminalTabs: [...session.terminalTabs, newTab],
			activeTerminalTabId: newTab.id,
		},
	};
}

/**
 * Create default terminal tab state for a session.
 */
export function createInitialTerminalTabState(
	shellType: string = 'zsh',
	cwd: string = ''
): Pick<Session, 'terminalTabs' | 'activeTerminalTabId' | 'closedTerminalTabHistory'> {
	const defaultTerminalTab = createTerminalTab(shellType, cwd, null);

	return {
		terminalTabs: [defaultTerminalTab],
		activeTerminalTabId: defaultTerminalTab.id,
		closedTerminalTabHistory: [],
	};
}

/**
 * Ensure a session has terminal tab structure required at runtime.
 * Returns the updated session and whether terminal tabs were migrated.
 */
export function ensureTerminalTabStructure(
	session: Session,
	defaultShell: string = 'zsh'
): { session: Session; didMigrateTerminalTabs: boolean } {
	let nextSession = session;
	let didMigrateTerminalTabs = false;

	if (!nextSession.terminalTabs || nextSession.terminalTabs.length === 0) {
		const defaultTerminalTab = createTerminalTab(defaultShell, nextSession.cwd, null);
		nextSession = {
			...nextSession,
			terminalTabs: [defaultTerminalTab],
			activeTerminalTabId: defaultTerminalTab.id,
			closedTerminalTabHistory: [],
		};
		didMigrateTerminalTabs = true;
	}

	if (!nextSession.closedTerminalTabHistory) {
		nextSession = {
			...nextSession,
			closedTerminalTabHistory: [],
		};
	}

	return { session: nextSession, didMigrateTerminalTabs };
}

/**
 * Get display name for a terminal tab
 * Priority: name > "Terminal N" (by index)
 */
export function getTerminalTabDisplayName(tab: TerminalTab, index: number): string {
	if (tab.name) {
		return tab.name;
	}

	return `Terminal ${index + 1}`;
}

/**
 * Generate the PTY session ID for a terminal tab
 * Format: {sessionId}-terminal-{tabId}
 */
export function getTerminalSessionId(sessionId: string, tabId: string): string {
	return `${sessionId}-terminal-${tabId}`;
}

/**
 * Parse a terminal session ID to extract session ID and tab ID
 * Returns null if the format doesn't match
 */
export function parseTerminalSessionId(
	terminalSessionId: string
): { sessionId: string; tabId: string } | null {
	const match = terminalSessionId.match(/^(.+)-terminal-(.+)$/);
	if (!match) {
		return null;
	}

	return { sessionId: match[1], tabId: match[2] };
}

/**
 * Check if any terminal tab in a session has a running process
 */
export function hasRunningTerminalProcess(session: Session): boolean {
	return session.terminalTabs?.some((tab) => tab.state === 'busy') ?? false;
}

/**
 * Get the count of active (non-exited) terminal tabs
 */
export function getActiveTerminalTabCount(session: Session): number {
	return session.terminalTabs?.filter((tab) => tab.state !== 'exited').length ?? 0;
}

/**
 * Create a closed terminal tab entry for undo stack
 */
export function createClosedTerminalTab(tab: TerminalTab, index: number): ClosedTerminalTab {
	return {
		tab: { ...tab, pid: 0, state: 'idle' },
		index,
		closedAt: Date.now(),
	};
}

export interface CloseTerminalTabResult {
	closedTab: ClosedTerminalTab;
	session: Session;
}

export interface ReopenTerminalTabResult {
	reopenedTab: TerminalTab;
	session: Session;
}

/**
 * Close a terminal tab and update closed-tab history.
 * Terminal sessions always keep at least one open tab.
 */
export function closeTerminalTab(session: Session, tabId: string): CloseTerminalTabResult | null {
	const tabIndex = session.terminalTabs.findIndex((tab) => tab.id === tabId);
	if (tabIndex === -1) {
		return null;
	}

	if (session.terminalTabs.length <= 1) {
		return null;
	}

	const closedTab = createClosedTerminalTab(session.terminalTabs[tabIndex], tabIndex);
	const updatedHistory = [closedTab, ...session.closedTerminalTabHistory].slice(
		0,
		MAX_CLOSED_TERMINAL_TABS
	);
	const updatedTabs = session.terminalTabs.filter((tab) => tab.id !== tabId);

	let updatedActiveTabId = session.activeTerminalTabId;
	if (session.activeTerminalTabId === tabId) {
		const updatedIndex = Math.min(tabIndex, updatedTabs.length - 1);
		updatedActiveTabId = updatedTabs[updatedIndex]?.id || updatedTabs[0]?.id || '';
	}

	return {
		closedTab,
		session: {
			...session,
			terminalTabs: updatedTabs,
			activeTerminalTabId: updatedActiveTabId,
			closedTerminalTabHistory: updatedHistory,
		},
	};
}

/**
 * Reopen the most recently closed terminal tab.
 * Restores shell/cwd/name metadata while creating a fresh runtime tab state.
 */
export function reopenTerminalTab(session: Session): ReopenTerminalTabResult | null {
	if (session.closedTerminalTabHistory.length === 0) {
		return null;
	}

	const [closedEntry, ...remainingHistory] = session.closedTerminalTabHistory;
	const reopenedTab: TerminalTab = {
		...closedEntry.tab,
		id: generateId(),
		pid: 0,
		state: 'idle',
		exitCode: undefined,
		createdAt: Date.now(),
	};

	const insertIndex = Math.max(0, Math.min(closedEntry.index, session.terminalTabs.length));
	const updatedTabs = [...session.terminalTabs];
	updatedTabs.splice(insertIndex, 0, reopenedTab);

	return {
		reopenedTab,
		session: {
			...session,
			terminalTabs: updatedTabs,
			activeTerminalTabId: reopenedTab.id,
			closedTerminalTabHistory: remainingHistory,
		},
	};
}

/**
 * Maximum closed terminal tabs to keep in history
 */
export const MAX_CLOSED_TERMINAL_TABS = 10;
