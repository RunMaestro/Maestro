import type React from 'react';
import { buildSessionDeepLink } from '../../../../shared/deep-link-urls';
import type { Session } from '../../../types';
import type { QuickAction } from '../types';

interface BuildActiveTabContextCommandsArgs {
	activeSession: Session | undefined;
	activeSessionId: string;
	isAiMode?: boolean;
	ghCliAvailable?: boolean;
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	setQuickActionOpen: (open: boolean) => void;
	safeClipboardWrite: (text: string) => Promise<boolean>;
	flashCopiedToClipboard: (value: string, message?: string) => void;
	onCopyTabContext?: (tabId: string) => void;
	onExportTabHtml?: (tabId: string) => void;
	onPublishTabGist?: (tabId: string) => void;
	toggleTabStarShortcut?: QuickAction['shortcut'];
	toggleTabUnreadShortcut?: QuickAction['shortcut'];
}

export function buildActiveTabContextCommands({
	activeSession,
	activeSessionId,
	isAiMode,
	ghCliAvailable,
	setSessions,
	setQuickActionOpen,
	safeClipboardWrite,
	flashCopiedToClipboard,
	onCopyTabContext,
	onExportTabHtml,
	onPublishTabGist,
	toggleTabStarShortcut,
	toggleTabUnreadShortcut,
}: BuildActiveTabContextCommandsArgs): QuickAction[] {
	if (!isAiMode || !activeSession) return [];
	const activeTab = activeSession.aiTabs.find((tab) => tab.id === activeSession.activeTabId);
	const commands: QuickAction[] = [];

	if (activeTab?.agentSessionId) {
		commands.push({
			id: 'copySessionId',
			label: 'Copy Session ID',
			subtext: activeTab.agentSessionId,
			action: async () => {
				if (await safeClipboardWrite(activeTab.agentSessionId!)) {
					flashCopiedToClipboard(activeTab.agentSessionId!, 'Session ID Copied');
				}
				setQuickActionOpen(false);
			},
		});

		commands.push({
			id: 'copyDeepLink',
			label: 'Copy Deep Link',
			action: async () => {
				const deepLink = buildSessionDeepLink(activeSession.id, activeTab.id);
				if (await safeClipboardWrite(deepLink)) {
					flashCopiedToClipboard(deepLink, 'Deep Link Copied');
				}
				setQuickActionOpen(false);
			},
		});

		commands.push({
			id: 'toggleStarTab',
			label: activeTab.starred ? 'Unstar Session' : 'Star Session',
			shortcut: toggleTabStarShortcut,
			action: () => {
				setSessions((prev) =>
					prev.map((session) => {
						if (session.id !== activeSessionId) return session;
						return {
							...session,
							aiTabs: session.aiTabs.map((tab) =>
								tab.id === activeTab.id ? { ...tab, starred: !tab.starred } : tab
							),
						};
					})
				);
				setQuickActionOpen(false);
			},
		});

		commands.push({
			id: 'markTabUnread',
			label: 'Mark as Unread',
			shortcut: toggleTabUnreadShortcut,
			action: () => {
				setSessions((prev) =>
					prev.map((session) => {
						if (session.id !== activeSessionId) return session;
						return {
							...session,
							aiTabs: session.aiTabs.map((tab) =>
								tab.id === activeTab.id ? { ...tab, hasUnread: true } : tab
							),
						};
					})
				);
				setQuickActionOpen(false);
			},
		});
	}

	if (activeTab && (activeTab.logs?.length ?? 0) >= 1) {
		if (onExportTabHtml) {
			commands.push({
				id: 'exportTabHtml',
				label: 'Export as HTML',
				action: () => {
					onExportTabHtml(activeTab.id);
					setQuickActionOpen(false);
				},
			});
		}

		if (onCopyTabContext) {
			commands.push({
				id: 'copyTabContext',
				label: 'Context: Copy to Clipboard',
				action: () => {
					onCopyTabContext(activeTab.id);
					setQuickActionOpen(false);
				},
			});
		}

		if (ghCliAvailable && onPublishTabGist) {
			commands.push({
				id: 'publishTabGist',
				label: 'Context: Publish as GitHub Gist',
				action: () => {
					onPublishTabGist(activeTab.id);
					setQuickActionOpen(false);
				},
			});
		}
	}

	return commands;
}
