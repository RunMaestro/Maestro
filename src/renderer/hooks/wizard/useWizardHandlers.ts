/**
 * useWizardHandlers — extracted from App.tsx
 *
 * Orchestrates all wizard-related handlers:
 *   - Inline wizard lifecycle (start, complete, thinking toggle)
 *   - Wizard state syncing (context → tab state)
 *   - Wizard message routing with thinking content extraction
 *   - Slash command discovery for active sessions
 *   - /history command (synopsis generation + history entry)
 *   - /skills command (lists Claude Code skills)
 *   - /wizard command (starts inline wizard)
 *   - Wizard tab launching from Auto Run panel
 *   - Onboarding wizard → session creation
 *
 * Reads from: sessionStore, settingsStore, modalStore, groupChatStore
 * Contexts: useInlineWizardContext, useWizard, useInputContext
 */

import { useCallback, useEffect, useMemo } from 'react';
import type {
	ToolType,
	LogEntry,
	Session,
	AITab,
	BatchRunConfig,
	WizardMode,
	SessionWizardState,
} from '../../types';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { getModalActions } from '../../stores/modalStore';
import { notifyToast } from '../../stores/notificationStore';
import { getActiveTab, createTab } from '../../utils/tabHelpers';
import { generateId } from '../../utils/ids';
import { getSlashCommandDescription } from '../../constants/app';
import { validateNewSession } from '../../utils/sessionValidation';
import { autorunSynopsisPrompt } from '../../../prompts';
import { parseSynopsis } from '../../../shared/synopsis';
import { formatRelativeTime } from '../../../shared/formatters';
import { gitService } from '../../services/git';
import { AUTO_RUN_FOLDER_NAME } from '../../components/Wizard';
import { DEFAULT_BATCH_PROMPT } from '../../components/BatchRunnerModal';
import type { PreviousUIState, UseInlineWizardReturn } from '../batch/useInlineWizard';
import type { WizardState } from '../../components/Wizard/WizardContext';
import type { HistoryEntryInput } from '../agent/useAgentSessionManagement';
import type { AgentSpawnResult } from '../agent/useAgentExecution';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseWizardHandlersDeps {
	/** Inline wizard context — the full return value from useInlineWizard */
	inlineWizardContext: UseInlineWizardReturn;
	/** Onboarding wizard context — state, completeWizard, clearResumeState */
	wizardContext: {
		state: WizardState;
		completeWizard: (sessionId: string | null) => void;
		clearResumeState: () => void;
	};
	/** Spawn a background synopsis for /history command */
	spawnBackgroundSynopsis: (
		sessionId: string,
		cwd: string,
		resumeAgentSessionId: string,
		prompt: string,
		toolType?: ToolType,
		sessionConfig?: {
			customPath?: string;
			customArgs?: string;
			customEnvVars?: Record<string, string>;
			customModel?: string;
			customContextWindow?: number;
			sessionSshRemoteConfig?: {
				enabled: boolean;
				remoteId: string | null;
				workingDirOverride?: string;
			};
		}
	) => Promise<AgentSpawnResult>;
	/** Add a history entry */
	addHistoryEntry: (entry: HistoryEntryInput) => void;
	/** Start a batch run */
	startBatchRun: (sessionId: string, config: BatchRunConfig, folderPath: string) => void;
	/** Ref to handleAutoRunRefresh (set after useAutoRunHandlers) */
	handleAutoRunRefreshRef: React.MutableRefObject<(() => void) | null>;
	/** Ref to setInputValue (set after useInputHandlers) */
	setInputValueRef: React.MutableRefObject<((value: string) => void) | null>;
	/** Ref to main input element (for focusing after wizard launch) */
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

// ============================================================================
// Type helpers (local-only types not available from imports)
// ============================================================================

// (All major types are now imported from their source modules above)

// ============================================================================
// Return type
// ============================================================================

export interface UseWizardHandlersReturn {
	/** Wrapper for sendInlineWizardMessage that routes thinking chunks to tab state */
	sendWizardMessageWithThinking: (content: string, images?: string[]) => Promise<void>;
	/** Handler for /history command — spawns synopsis and saves to history */
	handleHistoryCommand: () => Promise<void>;
	/** Handler for /skills command — lists Claude Code skills */
	handleSkillsCommand: () => Promise<void>;
	/** Handler for /wizard command — starts inline wizard */
	handleWizardCommand: (args: string) => void;
	/** Launch wizard in a new tab from Auto Run panel */
	handleLaunchWizardTab: () => void;
	/** Whether wizard is active on the current tab */
	isWizardActiveForCurrentTab: boolean;
	/** Converts wizard tab to normal session with context */
	handleWizardComplete: () => void;
	/** Generates documents for active tab */
	handleWizardLetsGo: () => void;
	/** Toggles thinking display on wizard tab */
	handleToggleWizardShowThinking: () => void;
	/** Creates a new session from onboarding wizard with Auto Run configured */
	handleWizardLaunchSession: (wantsTour: boolean) => Promise<void>;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useWizardHandlers(deps: UseWizardHandlersDeps): UseWizardHandlersReturn {
	const {
		inlineWizardContext,
		wizardContext,
		spawnBackgroundSynopsis,
		addHistoryEntry,
		startBatchRun,
		handleAutoRunRefreshRef,
		setInputValueRef,
		inputRef,
	} = deps;

	// --- Store subscriptions (reactive) ---
	const activeSession = useSessionStore(selectActiveSession);

	// --- Store actions (stable) ---
	const { setSessions, setActiveSessionId } = useMemo(() => useSessionStore.getState(), []);
	const { setActiveRightTab, setActiveFocus } = useUIStore.getState();

	// --- Modal actions ---
	const { setTourOpen, setTourFromWizard } = getModalActions();

	// --- Inline wizard context ---
	const {
		startWizard: startInlineWizard,
		endWizard: endInlineWizard,
		generateDocuments: generateInlineWizardDocuments,
		sendMessage: sendInlineWizardMessage,
		isWizardActive: inlineWizardActive,
		wizardTabId: inlineWizardTabId,
		getStateForTab: getInlineWizardStateForTab,
	} = inlineWizardContext;

	// --- Onboarding wizard context ---
	const { state: wizardState, completeWizard, clearResumeState } = wizardContext;

	// ========================================================================
	// Slash command discovery effect
	// ========================================================================
	useEffect(() => {
		const currentSession = useSessionStore
			.getState()
			.sessions.find((s) => s.id === activeSession?.id);
		if (!currentSession) return;
		if (currentSession.toolType !== 'claude-code') return;
		if (currentSession.agentCommands && currentSession.agentCommands.length > 0) return;

		const sessionId = currentSession.id;
		const projectRoot = currentSession.projectRoot;
		let cancelled = false;

		const mergeCommands = (
			existing: { command: string; description: string }[],
			newCmds: { command: string; description: string }[]
		) => {
			const merged = [...existing];
			for (const cmd of newCmds) {
				if (!merged.some((c) => c.command === cmd.command)) {
					merged.push(cmd);
				}
			}
			return merged;
		};

		const fetchCustomCommands = async () => {
			try {
				const customClaudeCommands = await (window as any).maestro.claude.getCommands(projectRoot);
				if (cancelled) return;

				const customCommandObjects = (customClaudeCommands || []).map(
					(cmd: { command: string; description: string }) => ({
						command: cmd.command,
						description: cmd.description,
					})
				);

				if (customCommandObjects.length > 0) {
					useSessionStore.getState().setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							const existingCommands = s.agentCommands || [];
							return {
								...s,
								agentCommands: mergeCommands(existingCommands, customCommandObjects),
							};
						})
					);
				}
			} catch (error) {
				if (!cancelled) {
					console.error('[SlashCommandDiscovery] Failed to fetch custom commands:', error);
				}
			}
		};

		const discoverAgentCommands = async () => {
			try {
				const agentSlashCommands = await (window as any).maestro.agents.discoverSlashCommands(
					currentSession.toolType,
					currentSession.cwd,
					currentSession.customPath
				);
				if (cancelled) return;

				const agentCommandObjects = ((agentSlashCommands || []) as string[]).map((cmd) => ({
					command: cmd.startsWith('/') ? cmd : `/${cmd}`,
					description: getSlashCommandDescription(cmd),
				}));

				if (agentCommandObjects.length > 0) {
					useSessionStore.getState().setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							const existingCommands = s.agentCommands || [];
							return {
								...s,
								agentCommands: mergeCommands(existingCommands, agentCommandObjects),
							};
						})
					);
				}
			} catch (error) {
				if (!cancelled) {
					console.error('[SlashCommandDiscovery] Failed to discover agent commands:', error);
				}
			}
		};

		fetchCustomCommands();
		discoverAgentCommands();

		return () => {
			cancelled = true;
		};
	}, [
		activeSession?.id,
		activeSession?.toolType,
		activeSession?.cwd,
		activeSession?.customPath,
		activeSession?.agentCommands,
		activeSession?.projectRoot,
	]);

	// ========================================================================
	// Wizard state sync effect (context → tab state)
	// ========================================================================
	useEffect(() => {
		if (!activeSession) return;

		const activeTab = getActiveTab(activeSession);
		const activeTabId = activeTab?.id;
		if (!activeTabId) return;

		const tabWizardState = getInlineWizardStateForTab(activeTabId);
		const hasWizardOnThisTab = tabWizardState?.isActive || tabWizardState?.isGeneratingDocs;
		const currentTabWizardState = activeTab?.wizardState;

		if (!hasWizardOnThisTab && !currentTabWizardState) {
			return;
		}

		if (!hasWizardOnThisTab && currentTabWizardState) {
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== activeSession.id) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === activeTabId ? { ...tab, wizardState: undefined } : tab
						),
					};
				})
			);
			return;
		}

		if (!tabWizardState) {
			return;
		}

		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSession.id) return s;

				const latestTab = s.aiTabs.find((tab) => tab.id === activeTabId);
				const latestWizardState = latestTab?.wizardState;

				const newWizardState: SessionWizardState = {
					isActive: tabWizardState.isActive,
					isWaiting: tabWizardState.isWaiting,
					mode: (tabWizardState.mode === 'ask' ? 'new' : tabWizardState.mode) as WizardMode,
					goal: tabWizardState.goal ?? undefined,
					confidence: tabWizardState.confidence,
					ready: tabWizardState.ready,
					conversationHistory: tabWizardState.conversationHistory.map((msg) => ({
						id: msg.id,
						role: msg.role as 'user' | 'assistant' | 'system',
						content: msg.content,
						timestamp: msg.timestamp,
						confidence: msg.confidence,
						ready: msg.ready,
						images: msg.images,
					})),
					previousUIState: tabWizardState.previousUIState ?? {
						readOnlyMode: false,
						saveToHistory: true,
						showThinking: 'off',
					},
					error: tabWizardState.error,
					isGeneratingDocs: tabWizardState.isGeneratingDocs,
					generatedDocuments: tabWizardState.generatedDocuments.map((doc) => ({
						filename: doc.filename,
						content: doc.content,
						taskCount: doc.taskCount,
						savedPath: doc.savedPath,
					})),
					streamingContent: tabWizardState.streamingContent,
					currentDocumentIndex: tabWizardState.currentDocumentIndex,
					currentGeneratingIndex: tabWizardState.generationProgress?.current,
					totalDocuments: tabWizardState.generationProgress?.total,
					autoRunFolderPath: tabWizardState.projectPath
						? `${tabWizardState.projectPath}/Auto Run Docs`
						: undefined,
					subfolderPath: tabWizardState.subfolderPath ?? undefined,
					agentSessionId: tabWizardState.agentSessionId ?? undefined,
					subfolderName: tabWizardState.subfolderName ?? undefined,
					showWizardThinking: latestWizardState?.showWizardThinking ?? false,
					thinkingContent: latestWizardState?.thinkingContent ?? '',
				};

				return {
					...s,
					aiTabs: s.aiTabs.map((tab) =>
						tab.id === activeTabId ? { ...tab, wizardState: newWizardState } : tab
					),
				};
			})
		);
	}, [activeSession?.id, activeSession?.activeTabId, getInlineWizardStateForTab, setSessions]);

	// ========================================================================
	// sendWizardMessageWithThinking
	// ========================================================================
	const sendWizardMessageWithThinking = useCallback(
		async (content: string, images?: string[]) => {
			const currentSession = useSessionStore
				.getState()
				.sessions.find((s) => s.id === activeSession?.id);
			if (!currentSession) return;

			const activeTab = getActiveTab(currentSession);
			if (activeTab?.wizardState) {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== currentSession.id) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((tab) => {
								if (tab.id !== activeTab.id) return tab;
								if (!tab.wizardState) return tab;
								return {
									...tab,
									wizardState: {
										...tab.wizardState,
										thinkingContent: '',
										toolExecutions: [],
									},
								};
							}),
						};
					})
				);
			}

			const sessionId = currentSession.id;
			const tabId = activeTab?.id;

			await sendInlineWizardMessage(content, images, {
				onThinkingChunk: (chunk) => {
					if (!sessionId || !tabId) return;

					const trimmed = chunk.trim();
					if (
						trimmed.startsWith('{"') &&
						(trimmed.includes('"confidence"') || trimmed.includes('"message"'))
					) {
						return;
					}

					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							const tab = s.aiTabs.find((t) => t.id === tabId);

							if (!tab?.wizardState?.showWizardThinking) {
								return s;
							}

							return {
								...s,
								aiTabs: s.aiTabs.map((t) => {
									if (t.id !== tabId) return t;
									if (!t.wizardState) return t;
									return {
										...t,
										wizardState: {
											...t.wizardState,
											thinkingContent: (t.wizardState.thinkingContent || '') + chunk,
										},
									};
								}),
							};
						})
					);
				},
				onToolExecution: (toolEvent) => {
					if (!sessionId || !tabId) return;

					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== sessionId) return s;
							const tab = s.aiTabs.find((t) => t.id === tabId);

							if (!tab?.wizardState?.showWizardThinking) {
								return s;
							}

							return {
								...s,
								aiTabs: s.aiTabs.map((t) => {
									if (t.id !== tabId) return t;
									if (!t.wizardState) return t;
									return {
										...t,
										wizardState: {
											...t.wizardState,
											toolExecutions: [...(t.wizardState.toolExecutions || []), toolEvent],
										},
									};
								}),
							};
						})
					);
				},
			});
		},
		[activeSession?.id, sendInlineWizardMessage, setSessions]
	);

	// ========================================================================
	// handleHistoryCommand — /history slash command
	// ========================================================================
	const handleHistoryCommand = useCallback(async () => {
		const currentSession = useSessionStore
			.getState()
			.sessions.find((s) => s.id === activeSession?.id);
		if (!currentSession) {
			console.warn('[handleHistoryCommand] No active session');
			return;
		}

		const activeTab = getActiveTab(currentSession);
		const agentSessionId = activeTab?.agentSessionId;
		const addLogToTab = useSessionStore.getState().addLogToTab;

		if (!agentSessionId) {
			const errorLog: LogEntry = {
				id: generateId(),
				timestamp: Date.now(),
				source: 'system',
				text: 'No active agent session. Start a conversation first before using /history.',
			};
			addLogToTab(currentSession.id, errorLog);
			return;
		}

		const pendingLog: LogEntry = {
			id: generateId(),
			timestamp: Date.now(),
			source: 'system',
			text: 'Generating history synopsis...',
		};
		addLogToTab(currentSession.id, pendingLog);

		try {
			let synopsisPrompt: string;
			if (activeTab.lastSynopsisTime) {
				const timeAgo = formatRelativeTime(activeTab.lastSynopsisTime);
				synopsisPrompt = `${autorunSynopsisPrompt}\n\nIMPORTANT: Only synopsize work done since the last synopsis (${timeAgo}). Do not repeat previous work.`;
			} else {
				synopsisPrompt = autorunSynopsisPrompt;
			}
			const synopsisTime = Date.now();

			const result = await spawnBackgroundSynopsis(
				currentSession.id,
				currentSession.cwd,
				agentSessionId,
				synopsisPrompt,
				currentSession.toolType,
				{
					customPath: currentSession.customPath,
					customArgs: currentSession.customArgs,
					customEnvVars: currentSession.customEnvVars,
					customModel: currentSession.customModel,
					customContextWindow: currentSession.customContextWindow,
					sessionSshRemoteConfig: currentSession.sessionSshRemoteConfig,
				}
			);

			if (result.success && result.response) {
				const parsed = parseSynopsis(result.response);

				if (parsed.nothingToReport) {
					setSessions((prev) =>
						prev.map((s) => {
							if (s.id !== currentSession.id) return s;
							return {
								...s,
								aiTabs: s.aiTabs.map((tab) => {
									if (tab.id !== activeTab.id) return tab;
									return {
										...tab,
										logs: tab.logs.map((log) =>
											log.id === pendingLog.id
												? { ...log, text: 'Nothing to report - no history entry created.' }
												: log
										),
									};
								}),
							};
						})
					);
					return;
				}

				const currentGroups = useSessionStore.getState().groups;
				const group = currentGroups.find((g) => g.id === currentSession.groupId);
				const groupName = group?.name || 'Ungrouped';

				const elapsedTimeMs = activeTab.lastSynopsisTime
					? synopsisTime - activeTab.lastSynopsisTime
					: synopsisTime - activeTab.createdAt;

				addHistoryEntry({
					type: 'AUTO',
					summary: parsed.shortSummary,
					fullResponse: parsed.fullSynopsis,
					agentSessionId,
					sessionId: currentSession.id,
					projectPath: currentSession.cwd,
					sessionName: activeTab.name || undefined,
					usageStats: result.usageStats,
					elapsedTimeMs,
				});

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== currentSession.id) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((tab) => {
								if (tab.id !== activeTab.id) return tab;
								return {
									...tab,
									lastSynopsisTime: synopsisTime,
									logs: tab.logs.map((log) =>
										log.id === pendingLog.id
											? { ...log, text: `Synopsis saved to history: ${parsed.shortSummary}` }
											: log
									),
								};
							}),
						};
					})
				);

				notifyToast({
					type: 'success',
					title: 'History Entry Added',
					message: parsed.shortSummary,
					group: groupName,
					project: currentSession.name,
					sessionId: currentSession.id,
					tabId: activeTab.id,
					tabName: activeTab.name || undefined,
				});
			} else {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== currentSession.id) return s;
						return {
							...s,
							aiTabs: s.aiTabs.map((tab) => {
								if (tab.id !== activeTab.id) return tab;
								return {
									...tab,
									logs: tab.logs.map((log) =>
										log.id === pendingLog.id
											? { ...log, text: 'Failed to generate history synopsis. Try again.' }
											: log
									),
								};
							}),
						};
					})
				);
			}
		} catch (error) {
			console.error('[handleHistoryCommand] Error:', error);
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== currentSession.id) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) => {
							if (tab.id !== activeTab!.id) return tab;
							return {
								...tab,
								logs: tab.logs.map((log) =>
									log.id === pendingLog.id
										? { ...log, text: `Error generating synopsis: ${(error as Error).message}` }
										: log
								),
							};
						}),
					};
				})
			);
		}
	}, [activeSession?.id, spawnBackgroundSynopsis, addHistoryEntry, setSessions]);

	// ========================================================================
	// handleSkillsCommand — /skills slash command
	// ========================================================================
	const handleSkillsCommand = useCallback(async () => {
		const currentSession = useSessionStore
			.getState()
			.sessions.find((s) => s.id === activeSession?.id);
		if (!currentSession) {
			console.warn('[handleSkillsCommand] No active session');
			return;
		}

		if (currentSession.toolType !== 'claude-code') {
			console.warn('[handleSkillsCommand] Skills command only available for Claude Code');
			return;
		}

		const activeTab = getActiveTab(currentSession);
		if (!activeTab) {
			console.warn('[handleSkillsCommand] No active tab');
			return;
		}

		const addLogToTab = useSessionStore.getState().addLogToTab;

		try {
			const userLog: LogEntry = {
				id: generateId(),
				timestamp: Date.now(),
				source: 'user',
				text: '/skills',
			};
			addLogToTab(currentSession.id, userLog);

			const skills = await (window as any).maestro.claude.getSkills(currentSession.projectRoot);

			let skillsMessage: string;
			if (skills.length === 0) {
				skillsMessage =
					'## Skills\n\nNo Claude Code skills were found in this project.\n\nTo add skills, create `.claude/skills/<skill-name>/skill.md` files in your project.';
			} else {
				const formatTokenCount = (tokens: number): string => {
					if (tokens >= 1000) {
						return `~${(tokens / 1000).toFixed(1)}k`;
					}
					return `~${tokens}`;
				};

				const projectSkills = skills.filter((s: { source: string }) => s.source === 'project');
				const userSkills = skills.filter((s: { source: string }) => s.source === 'user');

				const lines: string[] = [
					`## Skills`,
					'',
					`${skills.length} skill${skills.length !== 1 ? 's' : ''} available`,
					'',
				];

				if (projectSkills.length > 0) {
					lines.push('### Project Skills');
					lines.push('');
					lines.push('| Skill | Tokens | Description |');
					lines.push('|-------|--------|-------------|');
					for (const skill of projectSkills) {
						const desc =
							skill.description && skill.description !== 'No description' ? skill.description : '—';
						lines.push(`| **${skill.name}** | ${formatTokenCount(skill.tokenCount)} | ${desc} |`);
					}
					lines.push('');
				}

				if (userSkills.length > 0) {
					lines.push('### User Skills');
					lines.push('');
					lines.push('| Skill | Tokens | Description |');
					lines.push('|-------|--------|-------------|');
					for (const skill of userSkills) {
						const desc =
							skill.description && skill.description !== 'No description' ? skill.description : '—';
						lines.push(`| **${skill.name}** | ${formatTokenCount(skill.tokenCount)} | ${desc} |`);
					}
				}

				skillsMessage = lines.join('\n');
			}

			const skillsLog: LogEntry = {
				id: generateId(),
				timestamp: Date.now(),
				source: 'system',
				text: skillsMessage,
			};
			addLogToTab(currentSession.id, skillsLog);
		} catch (error) {
			console.error('[handleSkillsCommand] Error:', error);
			const errorLog: LogEntry = {
				id: generateId(),
				timestamp: Date.now(),
				source: 'system',
				text: `Error listing skills: ${(error as Error).message}`,
			};
			addLogToTab(currentSession.id, errorLog);
		}
	}, [activeSession?.id]);

	// ========================================================================
	// handleWizardCommand — /wizard slash command
	// ========================================================================
	const handleWizardCommand = useCallback(
		(args: string) => {
			const currentSession = useSessionStore
				.getState()
				.sessions.find((s) => s.id === activeSession?.id);
			if (!currentSession) {
				console.warn('[handleWizardCommand] No active session');
				return;
			}

			const activeTab = getActiveTab(currentSession);
			if (!activeTab) {
				console.warn('[handleWizardCommand] No active tab');
				return;
			}

			const currentUIState: PreviousUIState = {
				readOnlyMode: activeTab.readOnlyMode ?? false,
				saveToHistory: activeTab.saveToHistory ?? true,
				showThinking: activeTab.showThinking ?? 'off',
			};

			const currentConductorProfile = useSettingsStore.getState().conductorProfile;

			startInlineWizard(
				args || undefined,
				currentUIState,
				currentSession.projectRoot || currentSession.cwd,
				currentSession.toolType,
				currentSession.name,
				activeTab.id,
				currentSession.id,
				currentSession.autoRunFolderPath,
				currentSession.sessionSshRemoteConfig,
				currentConductorProfile,
				{
					customPath: currentSession.customPath,
					customArgs: currentSession.customArgs,
					customEnvVars: currentSession.customEnvVars,
					customModel: currentSession.customModel,
				}
			);

			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== currentSession.id) return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((tab) =>
							tab.id === activeTab.id ? { ...tab, name: 'Wizard' } : tab
						),
					};
				})
			);

			const wizardLog: LogEntry = {
				id: generateId(),
				timestamp: Date.now(),
				source: 'system',
				text: args
					? `Starting wizard with: "${args}"`
					: 'Starting wizard for Auto Run documents...',
			};
			useSessionStore.getState().addLogToTab(currentSession.id, wizardLog);
		},
		[activeSession?.id, startInlineWizard, setSessions]
	);

	// ========================================================================
	// handleLaunchWizardTab — launches wizard in a new tab
	// ========================================================================
	const handleLaunchWizardTab = useCallback(() => {
		const currentSession = useSessionStore
			.getState()
			.sessions.find((s) => s.id === activeSession?.id);
		if (!currentSession) {
			console.warn('[handleLaunchWizardTab] No active session');
			return;
		}

		const currentDefaults = useSettingsStore.getState();
		const result = createTab(currentSession, {
			name: 'Wizard',
			saveToHistory: currentDefaults.defaultSaveToHistory,
			showThinking: currentDefaults.defaultShowThinking,
		});
		if (!result) {
			console.warn('[handleLaunchWizardTab] Failed to create new tab');
			return;
		}

		const newTab = result.tab;
		const updatedSession = result.session;

		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== currentSession.id) return s;
				return {
					...updatedSession,
					activeTabId: newTab.id,
				};
			})
		);

		const currentUIState: PreviousUIState = {
			readOnlyMode: false,
			saveToHistory: currentDefaults.defaultSaveToHistory,
			showThinking: currentDefaults.defaultShowThinking,
		};

		const currentConductorProfile = useSettingsStore.getState().conductorProfile;
		const addLogToTab = useSessionStore.getState().addLogToTab;

		setTimeout(() => {
			startInlineWizard(
				undefined,
				currentUIState,
				currentSession.projectRoot || currentSession.cwd,
				currentSession.toolType,
				currentSession.name,
				newTab.id,
				currentSession.id,
				currentSession.autoRunFolderPath,
				currentSession.sessionSshRemoteConfig,
				currentConductorProfile,
				{
					customPath: currentSession.customPath,
					customArgs: currentSession.customArgs,
					customEnvVars: currentSession.customEnvVars,
					customModel: currentSession.customModel,
				}
			);

			const wizardLog = {
				source: 'system' as const,
				text: 'Starting wizard for Auto Run documents...',
			};
			addLogToTab(currentSession.id, wizardLog, newTab.id);
		}, 0);
	}, [activeSession?.id, startInlineWizard, setSessions]);

	// ========================================================================
	// isWizardActiveForCurrentTab — derived value
	// ========================================================================
	const isWizardActiveForCurrentTab = useMemo(() => {
		if (!activeSession || !inlineWizardActive) return false;
		const activeTab = getActiveTab(activeSession);
		return activeTab?.id === inlineWizardTabId;
	}, [activeSession, activeSession?.activeTabId, inlineWizardActive, inlineWizardTabId]);

	// ========================================================================
	// handleWizardComplete — converts wizard tab to normal session
	// ========================================================================
	const handleWizardComplete = useCallback(() => {
		const currentSession = useSessionStore
			.getState()
			.sessions.find((s) => s.id === activeSession?.id);
		if (!currentSession) return;
		const activeTabLocal = getActiveTab(currentSession);
		const wizState = activeTabLocal?.wizardState;
		if (!wizState) return;

		const wizardLogEntries: LogEntry[] = wizState.conversationHistory.map((msg) => ({
			id: `wizard-${msg.id}`,
			timestamp: msg.timestamp,
			source: msg.role === 'user' ? 'user' : 'ai',
			text: msg.content,
			images: msg.images,
			delivered: true,
		}));

		const generatedDocs = wizState.generatedDocuments || [];
		const totalTasks = generatedDocs.reduce((sum, doc) => sum + doc.taskCount, 0);
		const docNames = generatedDocs.map((d) => d.filename).join(', ');

		const summaryMessage: LogEntry = {
			id: `wizard-summary-${Date.now()}`,
			timestamp: Date.now(),
			source: 'ai',
			text:
				`## Wizard Complete\n\n` +
				`Created ${generatedDocs.length} document${
					generatedDocs.length !== 1 ? 's' : ''
				} with ${totalTasks} task${totalTasks !== 1 ? 's' : ''}:\n` +
				`${docNames}\n\n` +
				`**Next steps:**\n` +
				`1. Open the **Auto Run** tab in the right panel to view your playbook\n` +
				`2. Review and edit tasks as needed\n` +
				`3. Click **Run** to start executing tasks automatically\n\n` +
				`You can continue chatting to iterate on your playbook - the AI has full context of what was created.`,
			delivered: true,
		};

		const subfolderName = wizState.subfolderName || '';
		const tabName = subfolderName || 'Wizard';
		const wizardAgentSessionId = wizState.agentSessionId;
		const activeTabId = activeTabLocal.id;

		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== currentSession.id) return s;
				const updatedTabs = s.aiTabs.map((tab) => {
					if (tab.id !== activeTabId) return tab;
					return {
						...tab,
						logs: [...tab.logs, ...wizardLogEntries, summaryMessage],
						agentSessionId: wizardAgentSessionId || tab.agentSessionId,
						name: tabName,
						wizardState: undefined,
					};
				});
				return { ...s, aiTabs: updatedTabs };
			})
		);

		endInlineWizard();
		handleAutoRunRefreshRef.current?.();
		setInputValueRef.current?.('');
	}, [activeSession?.id, setSessions, endInlineWizard, handleAutoRunRefreshRef, setInputValueRef]);

	// ========================================================================
	// handleWizardLetsGo — generates documents for active tab
	// ========================================================================
	const handleWizardLetsGo = useCallback(() => {
		const currentSession = useSessionStore
			.getState()
			.sessions.find((s) => s.id === activeSession?.id);
		const activeTabLocal = currentSession ? getActiveTab(currentSession) : null;
		if (activeTabLocal) {
			generateInlineWizardDocuments(undefined, activeTabLocal.id);
		}
	}, [activeSession?.id, generateInlineWizardDocuments]);

	// ========================================================================
	// handleToggleWizardShowThinking
	// ========================================================================
	const handleToggleWizardShowThinking = useCallback(() => {
		const currentSession = useSessionStore
			.getState()
			.sessions.find((s) => s.id === activeSession?.id);
		if (!currentSession) return;
		const activeTabLocal = getActiveTab(currentSession);
		if (!activeTabLocal?.wizardState) return;
		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== currentSession.id) return s;
				return {
					...s,
					aiTabs: s.aiTabs.map((tab) => {
						if (tab.id !== activeTabLocal.id) return tab;
						if (!tab.wizardState) return tab;
						return {
							...tab,
							wizardState: {
								...tab.wizardState,
								showWizardThinking: !tab.wizardState.showWizardThinking,
								thinkingContent: !tab.wizardState.showWizardThinking
									? ''
									: tab.wizardState.thinkingContent,
							},
						};
					}),
				};
			})
		);
	}, [activeSession?.id, setSessions]);

	// ========================================================================
	// handleWizardLaunchSession — creates session from onboarding wizard
	// ========================================================================
	const handleWizardLaunchSession = useCallback(
		async (wantsTour: boolean) => {
			const {
				selectedAgent,
				directoryPath,
				agentName,
				generatedDocuments,
				customPath,
				customArgs,
				customEnvVars,
				sessionSshRemoteConfig,
			} = wizardState;

			if (!selectedAgent || !directoryPath) {
				console.error('Wizard launch failed: missing agent or directory');
				throw new Error('Missing required wizard data');
			}

			const currentSessions = useSessionStore.getState().sessions;

			const newId = generateId();
			const sessionName = agentName || `${selectedAgent} Session`;

			const validation = validateNewSession(
				sessionName,
				directoryPath,
				selectedAgent as ToolType,
				currentSessions
			);
			if (!validation.valid) {
				console.error(`Wizard session validation failed: ${validation.error}`);
				notifyToast({
					type: 'error',
					title: 'Session Creation Failed',
					message: validation.error || 'Cannot create duplicate session',
				});
				throw new Error(validation.error || 'Session validation failed');
			}

			const agent = await (window as any).maestro.agents.get(selectedAgent);
			if (!agent) {
				throw new Error(`Agent not found: ${selectedAgent}`);
			}
			const aiPid = 0;

			const wizardSshRemoteId = sessionSshRemoteConfig?.remoteId || undefined;
			const isGitRepo = await gitService.isRepo(directoryPath, wizardSshRemoteId);
			let gitBranches: string[] | undefined;
			let gitTags: string[] | undefined;
			let gitRefsCacheTime: number | undefined;
			if (isGitRepo) {
				[gitBranches, gitTags] = await Promise.all([
					gitService.getBranches(directoryPath, wizardSshRemoteId),
					gitService.getTags(directoryPath, wizardSshRemoteId),
				]);
				gitRefsCacheTime = Date.now();
			}

			const initialTabId = generateId();
			const currentDefaults = useSettingsStore.getState();
			const initialTab: AITab = {
				id: initialTabId,
				agentSessionId: null,
				name: null,
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: Date.now(),
				state: 'idle',
				saveToHistory: currentDefaults.defaultSaveToHistory,
				showThinking: currentDefaults.defaultShowThinking,
			};

			const autoRunFolderPath = `${directoryPath}/${AUTO_RUN_FOLDER_NAME}`;
			const firstDoc = generatedDocuments[0];
			const autoRunSelectedFile = firstDoc ? firstDoc.filename.replace(/\.md$/, '') : undefined;

			const newSession: Session = {
				id: newId,
				name: sessionName,
				toolType: selectedAgent as ToolType,
				state: 'idle',
				cwd: directoryPath,
				fullPath: directoryPath,
				projectRoot: directoryPath,
				isGitRepo,
				gitBranches,
				gitTags,
				gitRefsCacheTime,
				aiLogs: [],
				shellLogs: [
					{
						id: generateId(),
						timestamp: Date.now(),
						source: 'system',
						text: 'Shell Session Ready.',
					},
				],
				workLog: [],
				contextUsage: 0,
				inputMode: 'ai',
				aiPid,
				terminalPid: 0,
				port: 3000 + Math.floor(Math.random() * 100),
				isLive: false,
				changedFiles: [],
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				fileTreeAutoRefreshInterval: 180,
				shellCwd: directoryPath,
				aiCommandHistory: [],
				shellCommandHistory: [],
				executionQueue: [],
				activeTimeMs: 0,
				aiTabs: [initialTab],
				activeTabId: initialTabId,
				closedTabHistory: [],
				filePreviewTabs: [],
				activeFileTabId: null,
				unifiedTabOrder: [{ type: 'ai' as const, id: initialTabId }],
				unifiedClosedTabHistory: [],
				autoRunFolderPath,
				autoRunSelectedFile,
				customPath,
				customArgs,
				customEnvVars,
				sessionSshRemoteConfig,
			};

			setSessions((prev) => [...prev, newSession]);
			setActiveSessionId(newId);
			(window as any).maestro.stats.recordSessionCreated({
				sessionId: newId,
				agentType: selectedAgent,
				projectPath: directoryPath,
				createdAt: Date.now(),
				isRemote: !!sessionSshRemoteConfig?.enabled,
			});

			clearResumeState();
			completeWizard(newId);
			setActiveRightTab('autorun');

			if (wantsTour) {
				setTimeout(() => {
					setTourFromWizard(true);
					setTourOpen(true);
				}, 300);
			}

			setActiveFocus('main');
			setTimeout(() => inputRef.current?.focus(), 100);

			const firstDocWithTasks = generatedDocuments.find((doc) => doc.taskCount > 0);
			if (firstDocWithTasks && autoRunFolderPath) {
				const batchConfig: BatchRunConfig = {
					documents: [
						{
							id: generateId(),
							filename: firstDocWithTasks.filename.replace(/\.md$/, ''),
							resetOnCompletion: false,
							isDuplicate: false,
						},
					],
					prompt: DEFAULT_BATCH_PROMPT,
					loopEnabled: false,
				};

				setTimeout(() => {
					console.log(
						'[Wizard] Auto-starting batch run with first document:',
						firstDocWithTasks.filename
					);
					startBatchRun(newId, batchConfig, autoRunFolderPath);
				}, 500);
			}
		},
		[
			wizardState,
			setSessions,
			setActiveSessionId,
			clearResumeState,
			completeWizard,
			setActiveRightTab,
			setTourOpen,
			setTourFromWizard,
			setActiveFocus,
			startBatchRun,
			inputRef,
		]
	);

	return {
		sendWizardMessageWithThinking,
		handleHistoryCommand,
		handleSkillsCommand,
		handleWizardCommand,
		handleLaunchWizardTab,
		isWizardActiveForCurrentTab,
		handleWizardComplete,
		handleWizardLetsGo,
		handleToggleWizardShowThinking,
		handleWizardLaunchSession,
	};
}
