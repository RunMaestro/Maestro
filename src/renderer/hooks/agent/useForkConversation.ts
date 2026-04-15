import { useCallback } from 'react';
import type { Session, LogEntry } from '../../types';
import { createMergedSession, getTabDisplayName, getActiveTab } from '../../utils/tabHelpers';
import { notifyToast } from '../../stores/notificationStore';
import { captureException } from '../../utils/sentry';
import { getStdinFlags, prepareMaestroSystemPrompt } from '../../utils/spawnHelpers';

export function useForkConversation(
	sessions: Session[],
	setSessions: (updater: (prev: Session[]) => Session[]) => void,
	activeSessionId: string | null,
	setActiveSessionId: (id: string) => void
) {
	return useCallback(
		(logId: string) => {
			const session = sessions.find((s) => s.id === activeSessionId);
			if (!session) return;

			const sourceTab = getActiveTab(session);
			if (!sourceTab) return;

			// 1. Resolve the raw log index from the log ID
			//    The caller passes a log ID (not a visual index) so that search-filtering
			//    and consecutive-entry collapsing in the UI cannot shift the fork point.
			const rawLogIndex = sourceTab.logs.findIndex((l) => l.id === logId);
			if (rawLogIndex === -1) return;

			const slicedLogs = sourceTab.logs.slice(0, rawLogIndex + 1);
			if (slicedLogs.length === 0) return;

			// 2. Format sliced logs as context (user, ai, stdout, and tool sources)
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
						log.source === 'user'
							? 'User'
							: log.source === 'stdout' || log.source === 'tool'
								? 'Tool Output'
								: 'Assistant';
					return `${role}: ${log.text}`;
				})
				.join('\n\n');

			// 3. Build the context message (similar to Send-to-Agent)
			const sourceDisplayName = getTabDisplayName(sourceTab);
			const sessionName = session.name || session.projectRoot.split('/').pop() || 'Unknown';
			const forkName = `Forked: ${sessionName}`;

			const contextMessage = formattedContext
				? `# Forked Conversation

The following is a conversation forked from "${sessionName}" (tab: "${sourceDisplayName}") at message ${rawLogIndex + 1} of ${sourceTab.logs.length}. This is the conversation history up to the fork point.

---

${formattedContext}

---

# Continue

You are continuing this conversation from the fork point above. Briefly acknowledge the context and ask what the user would like to explore from here.`
				: 'No context available from the forked conversation.';

			// 4. Create new session via createMergedSession
			const forkNotice: LogEntry = {
				id: `fork-notice-${Date.now()}`,
				timestamp: Date.now(),
				source: 'system',
				text: `Forked from "${sessionName}" (tab: "${sourceDisplayName}") at message ${rawLogIndex + 1} of ${sourceTab.logs.length}`,
			};

			const userContextLog: LogEntry = {
				id: `fork-context-${Date.now()}`,
				timestamp: Date.now(),
				source: 'user',
				text: contextMessage,
			};

			const { session: newSession, tabId: newTabId } = createMergedSession({
				name: forkName,
				projectRoot: session.projectRoot,
				toolType: session.toolType,
				mergedLogs: [forkNotice, userContextLog],
				saveToHistory: true,
			});

			// 5. Mark the new tab as busy (we're about to spawn)
			const newTab = newSession.aiTabs[0];
			newTab.state = 'busy';
			newTab.thinkingStartTime = Date.now();
			newTab.awaitingSessionId = true;

			// Copy relevant session config from source
			newSession.cwd = session.cwd;
			newSession.fullPath = session.fullPath;
			newSession.shellCwd = session.shellCwd || session.cwd;
			// Update the initial terminal tab's cwd to match the source session
			if (newSession.terminalTabs?.[0]) {
				newSession.terminalTabs[0].cwd = session.shellCwd || session.cwd;
			}
			newSession.isGitRepo = session.isGitRepo;
			newSession.customPath = session.customPath;
			newSession.customArgs = session.customArgs;
			newSession.customEnvVars = session.customEnvVars;
			newSession.customModel = session.customModel;
			newSession.customContextWindow = session.customContextWindow;
			newSession.customEffort = session.customEffort;
			newSession.sessionSshRemoteConfig = session.sessionSshRemoteConfig;
			newSession.groupId = session.groupId;

			// 6. Add new session to state and navigate
			setSessions((prev) => [
				...prev,
				{
					...newSession,
					state: 'busy',
					busySource: 'ai',
					thinkingStartTime: Date.now(),
				},
			]);
			setActiveSessionId(newSession.id);

			// 7. Toast
			const estimatedTokens = slicedLogs
				.filter((log) => log.text && log.source !== 'system')
				.reduce((sum, log) => sum + Math.round((log.text?.length || 0) / 4), 0);
			const tokenInfo = estimatedTokens > 0 ? ` (~${estimatedTokens.toLocaleString()} tokens)` : '';

			notifyToast({
				type: 'success',
				title: 'Conversation Forked',
				message: `"${sessionName}" → "${forkName}"${tokenInfo}`,
				sessionId: newSession.id,
				tabId: newTabId,
			});

			// 8. Spawn agent async (follows Send-to-Agent pattern)
			(async () => {
				try {
					const agent = await window.maestro.agents.get(session.toolType);
					if (!agent) throw new Error(`${session.toolType} agent not found`);

					const baseArgs = agent.args ?? [];
					const commandToUse = agent.path || agent.command;

					const isSshSession = Boolean(session.sessionSshRemoteConfig?.enabled);
					const { sendPromptViaStdin, sendPromptViaStdinRaw } = getStdinFlags({
						isSshSession,
						supportsStreamJsonInput: agent.capabilities?.supportsStreamJsonInput ?? false,
						hasImages: false,
					});

					const effectivePrompt = contextMessage;

					const appendSystemPrompt = await prepareMaestroSystemPrompt({
						session: newSession,
						activeTabId: newTabId,
					});

					const spawnSessionId = `${newSession.id}-ai-${newTabId}`;
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
							newSessionId: newSession.id,
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
							if (s.id !== newSession.id) return s;
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
		[sessions, activeSessionId, setSessions, setActiveSessionId]
	);
}
