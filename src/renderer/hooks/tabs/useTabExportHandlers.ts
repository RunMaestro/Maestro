/**
 * useTabExportHandlers — extracted from App.tsx
 *
 * Provides handlers for tab content export operations:
 *   - Copy tab context to clipboard
 *   - Export tab as HTML file
 *   - Publish tab as GitHub Gist
 *
 * Reads from: sessionStore (sessions, activeSessionId), tabStore, modalStore
 */

import { useCallback } from 'react';
import type { Session, Theme, AITab } from '../../types';
import { useTabStore } from '../../stores/tabStore';
import { formatLogsForClipboard } from '../../utils/contextExtractor';
import { notifyToast } from '../../stores/notificationStore';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';
import { logger } from '../../utils/logger';
import { getModalActions } from '../../stores/modalStore';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseTabExportHandlersDeps {
	/** Ref to latest sessions array */
	sessionsRef: React.RefObject<Session[]>;
	/** Ref to latest active session ID */
	activeSessionIdRef: React.RefObject<string | null>;
	/** Ref to latest theme */
	themeRef: React.RefObject<Theme>;
	/** Open the gist publish modal (local App.tsx state) */
	setGistPublishModalOpen: (open: boolean) => void;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseTabExportHandlersReturn {
	/** Copy tab conversation to clipboard */
	handleCopyContext: (tabId: string) => void;
	/** Export tab as HTML file download */
	handleExportHtml: (tabId: string) => Promise<void>;
	/** Open Gist publish modal with tab content */
	handlePublishTabGist: (tabId: string) => void;
	/** Copy arbitrary text (e.g. a terminal buffer) to the clipboard with a toast. */
	handleCopyText: (text: string, subject?: string) => void;
	/** Queue arbitrary text for the Gist publish modal and open it. */
	handlePublishTextAsGist: (text: string, filenameStem: string) => void;
	/** Queue arbitrary text for transfer via the Send to Agent modal. */
	handleSendTextToAgent: (text: string, sourceName: string) => void;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useTabExportHandlers(deps: UseTabExportHandlersDeps): UseTabExportHandlersReturn {
	const { sessionsRef, activeSessionIdRef, themeRef, setGistPublishModalOpen } = deps;

	/**
	 * Resolve the active session and the specified tab.
	 * Returns null if session/tab is missing or tab has no logs.
	 */
	const resolveSessionAndTab = (tabId: string): { session: Session; tab: AITab } | null => {
		const currentSession = sessionsRef.current?.find((s) => s.id === activeSessionIdRef.current);
		if (!currentSession) return null;
		const tab = currentSession.aiTabs.find((t) => t.id === tabId);
		if (!tab || !tab.logs || tab.logs.length === 0) return null;
		return { session: currentSession, tab };
	};

	const handleCopyContext = useCallback((tabId: string) => {
		const resolved = resolveSessionAndTab(tabId);
		if (!resolved) return;

		const text = formatLogsForClipboard(resolved.tab.logs);
		if (!text.trim()) {
			notifyToast({
				type: 'warning',
				title: 'Nothing to Copy',
				message: 'No user or assistant messages to copy.',
			});
			return;
		}

		navigator.clipboard
			.writeText(text)
			.then(() => {
				flashCopiedToClipboard(undefined, 'Conversation Copied');
			})
			.catch((err) => {
				logger.error('Failed to copy context:', undefined, err);
				notifyToast({
					type: 'error',
					title: 'Copy Failed',
					message: 'Failed to copy context to clipboard.',
				});
			});
	}, []);

	const handleExportHtml = useCallback(async (tabId: string) => {
		const resolved = resolveSessionAndTab(tabId);
		if (!resolved) return;

		if (!themeRef.current) return;

		try {
			const { downloadTabExport } = await import('../../utils/tabExport');
			await downloadTabExport(
				resolved.tab,
				{
					name: resolved.session.name,
					cwd: resolved.session.cwd,
					toolType: resolved.session.toolType,
				},
				themeRef.current
			);
			notifyToast({
				type: 'success',
				title: 'Export Complete',
				message: 'Conversation exported as HTML.',
			});
		} catch (err) {
			logger.error('Failed to export tab:', undefined, err);
			notifyToast({
				type: 'error',
				title: 'Export Failed',
				message: 'Failed to export conversation as HTML.',
			});
		}
	}, []);

	const handlePublishTabGist = useCallback((tabId: string) => {
		const resolved = resolveSessionAndTab(tabId);
		if (!resolved) return;

		// Convert logs to markdown-like text format
		const content = formatLogsForClipboard(resolved.tab.logs);
		if (!content.trim()) {
			notifyToast({
				type: 'warning',
				title: 'Nothing to Publish',
				message: 'No user or assistant messages to publish.',
			});
			return;
		}

		// Generate filename based on tab name or session ID
		const tabName =
			resolved.tab.name || (resolved.tab.agentSessionId?.slice(0, 8) ?? 'conversation');
		const filename = `${tabName.replace(/[^a-zA-Z0-9-_]/g, '_')}_context.md`;

		// Set content and open the modal
		useTabStore.getState().setTabGistContent({ filename, content });
		setGistPublishModalOpen(true);
	}, []);

	const handleCopyText = useCallback((text: string, subject = 'Buffer') => {
		if (!text.trim()) {
			notifyToast({
				type: 'warning',
				title: 'Nothing to Copy',
				message: `${subject} is empty.`,
			});
			return;
		}

		navigator.clipboard
			.writeText(text)
			.then(() => {
				flashCopiedToClipboard(undefined, `${subject} Copied`);
			})
			.catch((err) => {
				console.error('Failed to copy text:', err);
				notifyToast({
					type: 'error',
					title: 'Copy Failed',
					message: `Failed to copy ${subject.toLowerCase()} to clipboard.`,
				});
			});
	}, []);

	const handlePublishTextAsGist = useCallback((text: string, filenameStem: string) => {
		if (!text.trim()) {
			notifyToast({
				type: 'warning',
				title: 'Nothing to Publish',
				message: 'Buffer is empty.',
			});
			return;
		}
		const safeStem = filenameStem.replace(/[^a-zA-Z0-9-_]/g, '_') || 'terminal';
		const filename = `${safeStem}_buffer.txt`;
		useTabStore.getState().setTabGistContent({ filename, content: text });
		setGistPublishModalOpen(true);
	}, []);

	const handleSendTextToAgent = useCallback((text: string, sourceName: string) => {
		if (!text.trim()) {
			notifyToast({
				type: 'warning',
				title: 'Nothing to Send',
				message: 'Buffer is empty.',
			});
			return;
		}
		useTabStore.getState().setPendingTerminalBufferSend({ content: text, sourceName });
		getModalActions().setSendToAgentModalOpen(true);
	}, []);

	return {
		handleCopyContext,
		handleExportHtml,
		handlePublishTabGist,
		handleCopyText,
		handlePublishTextAsGist,
		handleSendTextToAgent,
	};
}
