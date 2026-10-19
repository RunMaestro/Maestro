/**
 * tabRename - rename one tab of one agent, whatever kind it is.
 *
 * The rename modal's handler (`useSessionLifecycle.handleRenameTab`) resolves
 * the active agent and the tab the modal was opened for, then calls this. A tab
 * window's owner calls it with the agent and tab the `renameTab` intent names,
 * because a popped tab is never its active tab (Tab Windows). One body for both.
 */

import { selectSessionById, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { renameTerminalTab as renameTerminalTabHelper } from '../utils/terminalTabHelpers';
import {
	collectLeafTabRefs,
	generateGroupName,
	renameGroup as renameGroupHelper,
	resolveTabRefTitle,
} from '../utils/panelLayout';
import { captureException } from '../utils/sentry';

/**
 * Rename the tab `tabId` of agent `sessionId`. `tabId` may name a tiled group,
 * a terminal, file, browser, or AI tab. An empty name clears a user-assigned
 * label (the tab falls back to its automatic one). An AI tab's name is also
 * saved with its provider session and its History entries.
 */
export function renameTabInSession(sessionId: string, tabId: string, newName: string): void {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!session) return;

	// If this is a tiled tab group, rename the group. Resolve the auto-name
	// fallback from the group's first pane title (matching the chip rename), so
	// clearing the field never leaves an unnamed group.
	const group = session.tabGroups?.find((g) => g.id === tabId);
	if (group) {
		const firstRef = collectLeafTabRefs(group.layout)[0];
		const fallback = firstRef
			? generateGroupName(resolveTabRefTitle(session, firstRef))
			: group.name || 'Group';
		updateSessionWith(session.id, (s) => renameGroupHelper(s, tabId, newName, fallback));
		return;
	}

	// If this is a terminal tab, delegate to terminal tab rename helper
	if (session.terminalTabs?.some((t) => t.id === tabId)) {
		updateSessionWith(session.id, (s) => renameTerminalTabHelper(s, tabId, newName));
		return;
	}

	// If this is a file preview tab, set a user-assigned name that locks the
	// displayed label. An empty value clears it, falling back to the filename
	// (and the ambiguity-disambiguated label) again.
	if (session.filePreviewTabs?.some((t) => t.id === tabId)) {
		const nextCustomName = newName.trim() || undefined;
		updateSessionWith(session.id, (s) => ({
			...s,
			filePreviewTabs: (s.filePreviewTabs || []).map((t) =>
				t.id === tabId ? { ...t, customName: nextCustomName } : t
			),
		}));
		return;
	}

	// If this is a browser tab, set a user-assigned name that locks the
	// displayed label. An empty value clears it, letting the website set the
	// tab title again. We never touch `title` so the live page title stays
	// tracked underneath and reappears once the custom name is cleared.
	if (session.browserTabs?.some((t) => t.id === tabId)) {
		const nextCustomTitle = newName.trim() || undefined;
		updateSessionWith(session.id, (s) => ({
			...s,
			browserTabs: (s.browserTabs || []).map((t) =>
				t.id === tabId ? { ...t, customTitle: nextCustomTitle } : t
			),
		}));
		return;
	}

	updateSessionWith(session.id, (s) => {
		// Find the tab to get its agentSessionId for persistence
		const tab = s.aiTabs.find((t) => t.id === tabId);
		const oldName = tab?.name;

		window.maestro.logger.log(
			'info',
			`Tab renamed: "${oldName || '(auto)'}" → "${newName || '(cleared)'}"`,
			'TabNaming',
			{
				tabId,
				sessionId: session.id,
				agentSessionId: tab?.agentSessionId,
				oldName,
				newName: newName || null,
			}
		);

		if (tab?.agentSessionId) {
			// Persist name to agent session metadata (async, fire and forget)
			// Use projectRoot (not cwd) for consistent session storage access
			const agentId = s.toolType || 'claude-code';
			if (agentId === 'claude-code') {
				window.maestro.claude
					.updateSessionName(s.projectRoot, tab.agentSessionId, newName || '')
					.catch((err) => {
						captureException(err, {
							extra: {
								tabId,
								agentSessionId: tab.agentSessionId,
								operation: 'persist-tab-name-claude',
							},
						});
					});
			} else {
				window.maestro.agentSessions
					.setSessionName(agentId, s.projectRoot, tab.agentSessionId, newName || null)
					.catch((err) => {
						captureException(err, {
							extra: {
								tabId,
								agentSessionId: tab.agentSessionId,
								agentType: agentId,
								operation: 'persist-tab-name-agent',
							},
						});
					});
			}
			// Also update past history entries with this agentSessionId
			window.maestro.history.updateSessionName(tab.agentSessionId, newName || '').catch((err) => {
				captureException(err, {
					extra: {
						agentSessionId: tab.agentSessionId,
						operation: 'update-history-session-name',
					},
				});
			});
		} else {
			window.maestro.logger.log(
				'info',
				'Tab renamed (no agentSessionId, skipping persistence)',
				'TabNaming',
				{ tabId }
			);
		}
		return {
			...s,
			aiTabs: s.aiTabs.map((t) =>
				// Clear isGeneratingName to cancel any in-progress automatic naming
				t.id === tabId ? { ...t, name: newName || null, isGeneratingName: false } : t
			),
		};
	});
}
