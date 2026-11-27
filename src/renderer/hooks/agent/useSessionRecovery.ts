import {
	captureQueuedTurnSettings,
	projectTabProvider,
	resolveTurnProvider,
} from '../../utils/providerTabSessions';
/**
 * useSessionRecovery - in-place recovery for session_not_found errors.
 *
 * When the agent reports session_not_found, `useAgentErrorListener` clears the
 * stale `agentSessionId` and stamps a `recoveryAction` onto the system log
 * entry carrying the failed prompt. The inline SessionRecoveryCard surfaces a
 * "Send to Session" action that calls back into this hook.
 *
 * The hook:
 *   1. Extracts the tab's prior conversation via `extractTabContext`.
 *   2. Optionally grooms it through the shared `contextGroomingService` (same
 *      machinery used by SendToAgent / MergeSession).
 *   3. Formats the result into a `pendingMergedContext` block that
 *      `useInputProcessing` already knows how to prepend to the next message.
 *   4. Re-sends the failed prompt via `processInputRef`. Because the tab's
 *      `agentSessionId` is null, the existing spawn path starts a fresh
 *      session in place - tab id, tab name, and sidebar entry are preserved.
 */

import type { ProcessInputOptions } from '../input/useInputProcessing';
import { useCallback, useState } from 'react';
import type { LogEntry } from '../../types';
import { useSessionStore, updateSessionWith } from '../../stores/sessionStore';
import { contextGroomingService, buildContextTransferPrompt } from '../../services/contextGroomer';
import { extractTabContext } from '../../utils/contextExtractor';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[SessionRecovery]';

export interface StartRecoveryOptions {
	sessionId: string;
	tabId: string;
	lastUserPrompt: string;
	groomContext: boolean;
}

export interface UseSessionRecoveryDeps {
	processInputRef: React.MutableRefObject<(text?: string, options?: ProcessInputOptions) => void>;
}

export interface UseSessionRecoveryResult {
	startRecovery: (opts: StartRecoveryOptions) => Promise<void>;
	isRecovering: boolean;
	recoveryError: string | null;
}

function getSessionDisplayName(name?: string, projectRoot?: string): string {
	return name || projectRoot?.split('/').pop() || 'Unnamed Session';
}

function formatLogsAsConversation(logs: LogEntry[]): string {
	return logs
		.filter((log) => log.text && log.text.trim() && log.source !== 'system')
		.map((log) => {
			const role =
				log.source === 'user'
					? 'User'
					: log.source === 'ai'
						? 'Assistant'
						: log.source.toUpperCase();
			return `${role}: ${log.text}`;
		})
		.join('\n\n');
}

export function useSessionRecovery(deps: UseSessionRecoveryDeps): UseSessionRecoveryResult {
	const [isRecovering, setIsRecovering] = useState(false);
	const [recoveryError, setRecoveryError] = useState<string | null>(null);

	const startRecovery = useCallback(
		async (opts: StartRecoveryOptions): Promise<void> => {
			const { sessionId, tabId, lastUserPrompt, groomContext } = opts;
			setIsRecovering(true);
			setRecoveryError(null);

			try {
				const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
				if (!session) throw new Error('Session not found in store');
				const tab = session.aiTabs.find((t) => t.id === tabId);
				if (!tab) throw new Error('Tab not found in session');
				const { agent: recoverySession, tab: recoveryTab } = projectTabProvider(
					session,
					tab,
					resolveTurnProvider(tab, session)
				);
				const turnSettings = captureQueuedTurnSettings(recoveryTab, recoverySession);

				const sourceContext = extractTabContext(
					recoveryTab!,
					getSessionDisplayName(session.name, session.projectRoot),
					recoverySession
				);

				let conversationText: string;
				if (groomContext) {
					const transferPrompt = buildContextTransferPrompt(
						recoverySession.toolType,
						recoverySession.toolType
					);
					const result = await contextGroomingService.groomContexts(
						{
							sources: [sourceContext],
							targetAgent: recoverySession.toolType,
							targetProjectRoot: session.projectRoot,
							groomingPrompt: transferPrompt,
						},
						() => {
							/* progress not surfaced in the inline card */
						}
					);
					if (!result.success) {
						throw new Error(result.error || 'Context grooming failed');
					}
					conversationText = formatLogsAsConversation(result.groomedLogs);
					logger.info('Recovery context groomed', LOG_CONTEXT, {
						sessionId,
						tabId,
						tokensSaved: result.tokensSaved,
					});
				} else {
					conversationText = formatLogsAsConversation(sourceContext.logs);
				}

				const pendingMergedContext = conversationText
					? `# Prior Conversation (Session Recovered)

The previous agent session was not found - likely deleted by the provider. Below is the prior conversation on this tab. Use it as context to continue from where things left off.

---

${conversationText}

---`
					: undefined;

				if (
					!useSessionStore
						.getState()
						.sessions.find((s) => s.id === sessionId)
						?.aiTabs.some((t) => t.id === tabId)
				)
					throw new Error('Recovery tab was closed');

				if (pendingMergedContext) {
					updateSessionWith(sessionId, (s) => ({
						...s,
						aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, pendingMergedContext } : t)),
					}));
				}

				// Defer one tick so the store update flushes before processInput reads it.
				await new Promise((resolve) => setTimeout(resolve, 0));

				// Pin session/tab from recovery start - the user may have switched focus
				// during grooming.
				if (
					!useSessionStore
						.getState()
						.sessions.find((s) => s.id === sessionId)
						?.aiTabs.some((t) => t.id === tabId)
				)
					throw new Error('Recovery tab was closed');
				deps.processInputRef.current(lastUserPrompt, { sessionId, tabId, turnSettings });
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown recovery error';
				setRecoveryError(message);
				logger.error('Session recovery failed', LOG_CONTEXT, { error: message });
			} finally {
				setIsRecovering(false);
			}
		},
		[deps.processInputRef]
	);

	return { startRecovery, isRecovering, recoveryError };
}
