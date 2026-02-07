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
 * Maximum closed terminal tabs to keep in history
 */
export const MAX_CLOSED_TERMINAL_TABS = 10;
