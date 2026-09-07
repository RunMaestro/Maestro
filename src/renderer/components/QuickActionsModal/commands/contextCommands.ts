import type React from 'react';
import { buildSessionDeepLink } from '../../../../shared/deep-link-urls';
import { requestFileDeletion } from '../../../services/fileDeletion';
import { talkWithDocument } from '../../../services/documentVoice';
import { isTalkableDocumentPath } from '../../../../shared/fileKinds';
import type { Session } from '../../../types';
import type { MainPanelHandle } from '../../MainPanel/types';
import type { ActiveTabInfo, QuickAction } from '../types';

interface BuildActiveTabContextCommandsArgs {
	activeSession: Session | undefined;
	activeSessionId: string;
	/**
	 * Resolved type of the active tab. Selects the action noun and command set:
	 * Context (ai) / Buffer (terminal) / Content (browser) / none (file).
	 */
	activeTabType?: ActiveTabInfo['activeTabType'];
	/** The A Cappella Encore flag. False drops the voice entry entirely. */
	voiceEnabled?: boolean;
	ghCliAvailable?: boolean;
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	setQuickActionOpen: (open: boolean) => void;
	safeClipboardWrite: (text: string) => Promise<boolean>;
	flashCopiedToClipboard: (value: string, message?: string) => void;
	onCopyTabContext?: (tabId: string) => void;
	onExportTabHtml?: (tabId: string) => void;
	onPublishTabGist?: (tabId: string) => void;
	/** Imperative handle used to run terminal Buffer / browser Content actions. */
	mainPanelRef?: React.RefObject<MainPanelHandle | null>;
	toggleTabStarShortcut?: QuickAction['shortcut'];
	toggleTabUnreadShortcut?: QuickAction['shortcut'];
}

export function buildActiveTabContextCommands({
	activeSession,
	activeSessionId,
	activeTabType,
	voiceEnabled = false,
	ghCliAvailable,
	setSessions,
	setQuickActionOpen,
	safeClipboardWrite,
	flashCopiedToClipboard,
	onCopyTabContext,
	onExportTabHtml,
	onPublishTabGist,
	mainPanelRef,
	toggleTabStarShortcut,
	toggleTabUnreadShortcut,
}: BuildActiveTabContextCommandsArgs): QuickAction[] {
	if (!activeSession) return [];
	const commands: QuickAction[] = [];

	// Terminal tab -> "Buffer" actions on the live scrollback (via MainPanel).
	if (activeTabType === 'terminal') {
		if (!mainPanelRef) return commands;
		commands.push({
			id: 'copyTerminalBuffer',
			label: 'Buffer: Copy to Clipboard',
			action: () => {
				mainPanelRef.current?.copyActiveTerminalBuffer();
				setQuickActionOpen(false);
			},
		});
		commands.push({
			id: 'sendTerminalBufferToAgent',
			label: 'Buffer: Send to Agent',
			action: () => {
				mainPanelRef.current?.sendActiveTerminalBufferToAgent();
				setQuickActionOpen(false);
			},
		});
		if (ghCliAvailable) {
			commands.push({
				id: 'publishTerminalBufferGist',
				label: 'Buffer: Publish as GitHub Gist',
				action: () => {
					mainPanelRef.current?.publishActiveTerminalBufferGist();
					setQuickActionOpen(false);
				},
			});
		}
		return commands;
	}

	// Browser tab -> "Content" actions on the rendered page text (via MainPanel).
	if (activeTabType === 'browser') {
		if (!mainPanelRef) return commands;
		commands.push({
			id: 'copyBrowserContent',
			label: 'Content: Copy to Clipboard',
			action: () => {
				mainPanelRef.current?.copyActiveBrowserContent();
				setQuickActionOpen(false);
			},
		});
		commands.push({
			id: 'sendBrowserContentToAgent',
			label: 'Content: Send to Agent',
			action: () => {
				mainPanelRef.current?.sendActiveBrowserContentToAgent();
				setQuickActionOpen(false);
			},
		});
		return commands;
	}

	// File preview tab -> destructive file action. Only offered while a preview
	// is actually open, and it routes through the same confirmation the
	// toolbar's trash button raises.
	if (activeTabType === 'file') {
		// inputMode gates the render too: a file tab can be selected while the
		// main panel is showing a terminal, and there is no preview to act on then.
		const fileTab =
			activeSession.inputMode === 'ai'
				? activeSession.filePreviewTabs.find((tab) => tab.id === activeSession.activeFileTabId)
				: undefined;
		if (fileTab) {
			// Talk with Document is the palette's copy of the toolbar microphone and
			// the Files panel menu entry, and the only one of the three that works
			// when the toolbar button has been hidden in Settings. Same text-only
			// gate as the other two: an image or a binary has nothing to talk about.
			if (voiceEnabled && isTalkableDocumentPath(fileTab.path)) {
				commands.push({
					id: 'talkWithPreviewedDocument',
					keywords: ['voice', 'acappella', 'a cappella', 'talk', 'speak', 'mic'],
					label: 'File: Talk with Document',
					subtext: `${fileTab.name}${fileTab.extension}`,
					action: () => {
						setQuickActionOpen(false);
						void talkWithDocument({ path: fileTab.path, sessionId: activeSession.id });
					},
				});
			}
			commands.push({
				id: 'deletePreviewedFile',
				label: 'File: Delete',
				subtext: `${fileTab.name}${fileTab.extension}`,
				action: () => {
					setQuickActionOpen(false);
					requestFileDeletion({
						path: fileTab.path,
						sshRemoteId: fileTab.sshRemoteId,
						sessionId: activeSession.id,
					});
				},
			});
		}
		return commands;
	}

	// Only AI tabs get Context actions.
	if (activeTabType !== 'ai') return commands;

	const activeTab = activeSession.aiTabs.find((tab) => tab.id === activeSession.activeTabId);

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
