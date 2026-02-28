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
import type { Session, Theme } from '../../types';
import { useTabStore } from '../../stores/tabStore';
import { formatLogsForClipboard } from '../../utils/contextExtractor';
import { notifyToast } from '../../stores/notificationStore';

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
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useTabExportHandlers(deps: UseTabExportHandlersDeps): UseTabExportHandlersReturn {
	const { sessionsRef, activeSessionIdRef, themeRef, setGistPublishModalOpen } = deps;

	const handleCopyContext = useCallback((tabId: string) => {
		const currentSession = sessionsRef.current?.find((s) => s.id === activeSessionIdRef.current);
		if (!currentSession) return;
		const tab = currentSession.aiTabs.find((t) => t.id === tabId);
		if (!tab || !tab.logs || tab.logs.length === 0) return;

		const text = formatLogsForClipboard(tab.logs);
		navigator.clipboard
			.writeText(text)
			.then(() => {
				notifyToast({
					type: 'success',
					title: 'Context Copied',
					message: 'Conversation copied to clipboard.',
				});
			})
			.catch((err) => {
				console.error('Failed to copy context:', err);
				notifyToast({
					type: 'error',
					title: 'Copy Failed',
					message: 'Failed to copy context to clipboard.',
				});
			});
	}, []);

	const handleExportHtml = useCallback(async (tabId: string) => {
		const currentSession = sessionsRef.current?.find((s) => s.id === activeSessionIdRef.current);
		if (!currentSession) return;
		const tab = currentSession.aiTabs.find((t) => t.id === tabId);
		if (!tab || !tab.logs || tab.logs.length === 0) return;

		if (!themeRef.current) return;

		try {
			const { downloadTabExport } = await import('../../utils/tabExport');
			await downloadTabExport(
				tab,
				{
					name: currentSession.name,
					cwd: currentSession.cwd,
					toolType: currentSession.toolType,
				},
				themeRef.current
			);
			notifyToast({
				type: 'success',
				title: 'Export Complete',
				message: 'Conversation exported as HTML.',
			});
		} catch (err) {
			console.error('Failed to export tab:', err);
			notifyToast({
				type: 'error',
				title: 'Export Failed',
				message: 'Failed to export conversation as HTML.',
			});
		}
	}, []);

	const handlePublishTabGist = useCallback((tabId: string) => {
		const currentSession = sessionsRef.current?.find((s) => s.id === activeSessionIdRef.current);
		if (!currentSession) return;
		const tab = currentSession.aiTabs.find((t) => t.id === tabId);
		if (!tab || !tab.logs || tab.logs.length === 0) return;

		// Convert logs to markdown-like text format
		const content = formatLogsForClipboard(tab.logs);
		// Generate filename based on tab name or session ID
		const tabName = tab.name || (tab.agentSessionId?.slice(0, 8) ?? 'conversation');
		const filename = `${tabName.replace(/[^a-zA-Z0-9-_]/g, '_')}_context.md`;

		// Set content and open the modal
		useTabStore.getState().setTabGistContent({ filename, content });
		setGistPublishModalOpen(true);
	}, []);

	return {
		handleCopyContext,
		handleExportHtml,
		handlePublishTabGist,
	};
}
