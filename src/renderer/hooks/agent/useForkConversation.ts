import { useCallback } from 'react';
import type { Session, LogEntry } from '../../types';
import { createTabAtPosition, getTabDisplayName, getActiveTab } from '../../utils/tabHelpers';
import { notifyToast } from '../../stores/notificationStore';
import { captureException } from '../../utils/sentry';
import { getStdinFlags, prepareMaestroSystemPrompt } from '../../utils/spawnHelpers';

export function useForkConversation(
	sessions: Session[],
	setSessions: (updater: (prev: Session[]) => Session[]) => void,
	activeSessionId: string | null
) {
	return useCallback(
		(logId: string) => {
			const session = sessions.find((s) => s.id === activeSessionId);
			if (!session) return;

			const sourceTab = getActiveTab(session);
			if (!sourceTab) return;

			// 1. Resolve the raw log index from the log ID.
			//    The caller passes a log ID (not a visual index) so that search-filtering
			//    and consecutive-entry collapsing in the UI cannot shift the fork point.
			const rawLogIndex = sourceTab.logs.findIndex((l) => l.id === logId);
			if (rawLogIndex === -1) return;

			// AI responses may span multiple raw stdout entries when chunks arrive
			// more than 500ms apart (see useBatchedSessionUpdates). The UI's
			// `collapsedLogs` merges consecutive non-user/tool/thinking entries into
			// one visual block keyed by the FIRST entry's id, so the clicked logId
			// points at the first chunk. Extend endIndex forward through the rest of
			// that block so the fork context includes the full AI response.
			let endIndex = rawLogIndex;
			const clickedSource = sourceTab.logs[rawLogIndex].source;
			if (clickedSource !== 'user' && clickedSource !== 'tool' && clickedSource !== 'thinking') {
				while (
					endIndex + 1 < sourceTab.logs.length &&
					sourceTab.logs[endIndex + 1].source !== 'user' &&
					sourceTab.logs[endIndex + 1].source !== 'tool' &&
					sourceTab.logs[endIndex + 1].source !== 'thinking'
				) {
					endIndex++;
				}
			}

			const slicedLogs = sourceTab.logs.slice(0, endIndex + 1);
			if (slicedLogs.length === 0) return;

			// 2. Format sliced logs as context (user, ai, stdout, and tool sources).
			//    In AI mode, AI response text is stored with source='stdout'
			//    (see useBatchedSessionUpdates), so stdout maps to 'Assistant' here.
			//    Only source='tool' represents actual tool output.
			const formattedContext = slicedLogs
				.filter(
					(log) =>
						log.text &&
						log.text.trim() &&
						(log.source === 'user' ||
							log.source === 'ai' ||
							log.source === 'stdout' ||
							log.source === 'tool')
				)
				.map((log) => {
					const role =
						log.source === 'user' ? 'User' : log.source === 'tool' ? 'Tool Output' : 'Assistant';
					return `${role}: ${log.text}`;
				})
				.join('\n\n');

			// 3. Build the context message (similar to Send-to-Agent)
			const sourceDisplayName = getTabDisplayName(sourceTab);
			const sessionName = session.name || session.projectRoot.split('/').pop() || 'Unknown';
			const forkTabName = `Forked: ${sourceDisplayName}`;

			const contextMessage = formattedContext
				? `# Forked Conversation

The following is a conversation forked from "${sessionName}" (tab: "${sourceDisplayName}") at message ${rawLogIndex + 1} of ${sourceTab.logs.length}. This is the conversation history up to the fork point.

---

${formattedContext}

---

# Continue

You are continuing this conversation from the fork point above. Briefly acknowledge the context and ask what the user would like to explore from here.`
				: 'No context available from the forked conversation.';

			// 4. Create a new AI tab within the existing session, right after the source tab
			const forkNotice: LogEntry = {
				id: `fork-notice-${Date.now()}`,
				timestamp: Date.now(),
				source: 'system',
				text: `Forked from tab "${sourceDisplayName}" at message ${rawLogIndex + 1} of ${sourceTab.logs.length}`,
			};

			const userContextLog: LogEntry = {
				id: `fork-context-${Date.now()}`,
				timestamp: Date.now(),
				source: 'user',
				text: contextMessage,
			};

			const tabResult = createTabAtPosition(session, {
				afterTabId: sourceTab.id,
				name: forkTabName,
				logs: [forkNotice, userContextLog],
				saveToHistory: sourceTab.saveToHistory,
			});
			if (!tabResult) return;

			const newTabId = tabResult.tab.id;
			const sourceTabId = sourceTab.id;

			// 5. Commit new tab onto the live session (avoid stale snapshot spread).
			//    Mark the tab as busy since we're about to spawn.
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== session.id) return s;
					const hasNewTab = s.aiTabs.some((t) => t.id === newTabId);
					let updatedTabs = s.aiTabs;
					const currentOrder = s.unifiedTabOrder || [];
					let updatedOrder = currentOrder;
					if (!hasNewTab) {
						const sourceIdx = s.aiTabs.findIndex((t) => t.id === sourceTabId);
						const insertIdx = sourceIdx >= 0 ? sourceIdx + 1 : s.aiTabs.length;
						const busyTab = {
							...tabResult.tab,
							state: 'busy' as const,
							thinkingStartTime: Date.now(),
							awaitingSessionId: true,
						};
						updatedTabs = [...s.aiTabs.slice(0, insertIdx), busyTab, ...s.aiTabs.slice(insertIdx)];
						const newTabRef = { type: 'ai' as const, id: newTabId };
						if (!currentOrder.some((ref) => ref.type === 'ai' && ref.id === newTabId)) {
							const sourceOrderIdx = currentOrder.findIndex(
								(ref) => ref.type === 'ai' && ref.id === sourceTabId
							);
							updatedOrder =
								sourceOrderIdx >= 0
									? [
											...currentOrder.slice(0, sourceOrderIdx + 1),
											newTabRef,
											...currentOrder.slice(sourceOrderIdx + 1),
										]
									: [...currentOrder, newTabRef];
						}
					}
					return {
						...s,
						state: 'busy',
						busySource: 'ai',
						thinkingStartTime: Date.now(),
						aiTabs: updatedTabs,
						activeTabId: newTabId,
						activeFileTabId: null,
						activeBrowserTabId: null,
						activeTerminalTabId: null,
						inputMode: 'ai' as const,
						unifiedTabOrder: updatedOrder,
					};
				})
			);

			// 6. Toast
			const estimatedTokens = slicedLogs
				.filter((log) => log.text && log.source !== 'system')
				.reduce((sum, log) => sum + Math.round((log.text?.length || 0) / 4), 0);
			const tokenInfo = estimatedTokens > 0 ? ` (~${estimatedTokens.toLocaleString()} tokens)` : '';

			notifyToast({
				type: 'success',
				title: 'Conversation Forked',
				message: `"${sourceDisplayName}" → "${forkTabName}"${tokenInfo}`,
				sessionId: session.id,
				tabId: newTabId,
			});

			// 7. Spawn agent async (follows Send-to-Agent pattern)
			(async () => {
				try {
					const agent = await window.maestro.agents.get(session.toolType);
					if (!agent) throw new Error(`${session.toolType} agent not found`);

					const baseArgs = agent.args ?? [];
					const commandToUse = agent.path || agent.command;
					if (!commandToUse) {
						throw new Error(`${session.toolType} agent has no command configured`);
					}

					const isSshSession = Boolean(session.sessionSshRemoteConfig?.enabled);
					const { sendPromptViaStdin, sendPromptViaStdinRaw } = getStdinFlags({
						isSshSession,
						supportsStreamJsonInput: agent.capabilities?.supportsStreamJsonInput ?? false,
						hasImages: false,
					});

					const effectivePrompt = contextMessage;

					const appendSystemPrompt = await prepareMaestroSystemPrompt({
						session,
						activeTabId: newTabId,
					});

					const spawnSessionId = `${session.id}-ai-${newTabId}`;
					await window.maestro.process.spawn({
						sessionId: spawnSessionId,
						toolType: session.toolType,
						cwd: session.cwd,
						command: commandToUse,
						args: [...baseArgs],
						prompt: effectivePrompt,
						appendSystemPrompt,
						sessionCustomPath: session.customPath,
						sessionCustomArgs: session.customArgs,
						sessionCustomEnvVars: session.customEnvVars,
						sessionCustomModel: session.customModel,
						sessionCustomEffort: session.customEffort,
						sessionCustomContextWindow: session.customContextWindow,
						sessionSshRemoteConfig: session.sessionSshRemoteConfig,
						sendPromptViaStdin,
						sendPromptViaStdinRaw,
					});
				} catch (error) {
					captureException(error, {
						extra: {
							sessionId: session.id,
							toolType: session.toolType,
							newTabId,
							operation: 'fork-conversation-spawn',
						},
					});
					const errorLog: LogEntry = {
						id: `error-${Date.now()}`,
						timestamp: Date.now(),
						source: 'system',
						text: `Error: Failed to spawn agent - ${(error as Error).message}`,
					};
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== session.id) return s;
							return {
								...s,
								state: 'idle',
								busySource: undefined,
								thinkingStartTime: undefined,
								aiTabs: s.aiTabs.map((tab) =>
									tab.id === newTabId
										? {
												...tab,
												state: 'idle' as const,
												thinkingStartTime: undefined,
												awaitingSessionId: false,
												logs: [...tab.logs, errorLog],
											}
										: tab
								),
							};
						})
					);
				}
			})();
		},
		[sessions, activeSessionId, setSessions]
	);
}
