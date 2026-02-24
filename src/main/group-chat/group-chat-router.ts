/**
 * @file group-chat-router.ts
 * @description Message routing for Group Chat feature.
 *
 * Routes messages between:
 * - User -> Moderator
 * - Moderator -> Participants (via @mentions)
 * - Participants -> Moderator
 */

import * as os from 'os';
import {
	GroupChatParticipant,
	loadGroupChat,
	updateParticipant,
	addGroupChatHistoryEntry,
	extractFirstSentence,
	getGroupChatDir,
} from './group-chat-storage';
import { appendToLog, readLog } from './group-chat-log';
import {
	type GroupChatMessage,
	mentionMatches,
	normalizeMentionName,
} from '../../shared/group-chat-types';
import {
	IProcessManager,
	getModeratorSessionId,
	isModeratorActive,
	getModeratorSystemPrompt,
	getModeratorSynthesisPrompt,
} from './group-chat-moderator';
import { addParticipant, addFreshParticipant } from './group-chat-agent';
import { AgentDetector, getVisibleAgentDefinitions } from '../agents';
import { powerManager } from '../power-manager';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import {
	buildAgentArgs,
	applyAgentConfigOverrides,
	getContextWindowValue,
} from '../utils/agent-args';
import { groupChatParticipantRequestPrompt } from '../../prompts';
import { wrapSpawnWithSsh } from '../utils/ssh-spawn-wrapper';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import { setGetCustomShellPathCallback, getWindowsSpawnConfig } from './group-chat-config';

// Import emitters from IPC handlers (will be populated after handlers are registered)
import { groupChatEmitters } from '../ipc/handlers/groupChat';

// Import lock and synthesis guards
import {
	acquireChatLock,
	releaseChatLock,
	isSynthesisInProgress,
	markSynthesisStarted,
	clearSynthesisInProgress,
} from './group-chat-lock';

const LOG_CONTEXT = '[GroupChatRouter]';

// Re-export setGetCustomShellPathCallback for index.ts to use
export { setGetCustomShellPathCallback };

/**
 * Session info for matching @mentions to available Maestro sessions.
 */
export interface SessionInfo {
	id: string;
	name: string;
	toolType: string;
	cwd: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	/** SSH remote name for display in participant card */
	sshRemoteName?: string;
	/** Full SSH remote config for remote execution */
	sshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
}

/**
 * Callback type for getting available sessions from the renderer.
 */
export type GetSessionsCallback = () => SessionInfo[];

/**
 * Callback type for getting custom environment variables for an agent.
 */
export type GetCustomEnvVarsCallback = (agentId: string) => Record<string, string> | undefined;
export type GetAgentConfigCallback = (agentId: string) => Record<string, any> | undefined;

// Module-level callback for session lookup
let getSessionsCallback: GetSessionsCallback | null = null;

// Module-level callback for custom env vars lookup
let getCustomEnvVarsCallback: GetCustomEnvVarsCallback | null = null;
let getAgentConfigCallback: GetAgentConfigCallback | null = null;

// Module-level callback for conductor profile lookup
let getConductorProfileCallback: (() => string) | null = null;

// Module-level SSH store for remote execution support
let sshStore: SshRemoteSettingsStore | null = null;

/**
 * Tracks pending participant responses for each group chat.
 * When all pending participants have responded, we spawn a moderator synthesis round.
 * Maps groupChatId -> Set<participantName>
 */
const pendingParticipantResponses = new Map<string, Set<string>>();

/**
 * Tracks read-only mode state for each group chat.
 * Set when user sends a message with readOnly flag, cleared on next non-readOnly message.
 * Maps groupChatId -> boolean
 */
const groupChatReadOnlyState = new Map<string, boolean>();

/**
 * Gets the current read-only state for a group chat.
 */
export function getGroupChatReadOnlyState(groupChatId: string): boolean {
	return groupChatReadOnlyState.get(groupChatId) ?? false;
}

/**
 * Sets the read-only state for a group chat.
 */
export function setGroupChatReadOnlyState(groupChatId: string, readOnly: boolean): void {
	groupChatReadOnlyState.set(groupChatId, readOnly);
}

/**
 * Gets the pending participants for a group chat.
 */
export function getPendingParticipants(groupChatId: string): Set<string> {
	return pendingParticipantResponses.get(groupChatId) || new Set();
}

/**
 * Clears all pending participants for a group chat.
 */
export function clearPendingParticipants(groupChatId: string): void {
	pendingParticipantResponses.delete(groupChatId);
}

/**
 * Marks a participant as having responded (removes from pending).
 * Returns true if this was the last pending participant.
 */
export function markParticipantResponded(groupChatId: string, participantName: string): boolean {
	const pending = pendingParticipantResponses.get(groupChatId);
	if (!pending) return false;

	pending.delete(participantName);

	if (pending.size === 0) {
		pendingParticipantResponses.delete(groupChatId);
		return true; // Last participant responded
	}
	return false;
}

/**
 * Sets the callback for getting available sessions.
 * Called from index.ts during initialization.
 */
export function setGetSessionsCallback(callback: GetSessionsCallback): void {
	getSessionsCallback = callback;
}

/**
 * Sets the callback for getting custom environment variables.
 * Called from index.ts during initialization.
 */
export function setGetCustomEnvVarsCallback(callback: GetCustomEnvVarsCallback): void {
	getCustomEnvVarsCallback = callback;
}

export function setGetAgentConfigCallback(callback: GetAgentConfigCallback): void {
	getAgentConfigCallback = callback;
}

/**
 * Sets the callback for getting the conductor profile.
 * Called from index.ts during initialization.
 */
export function setGetConductorProfileCallback(callback: () => string): void {
	getConductorProfileCallback = callback;
}

/**
 * Sets the SSH store for remote execution support.
 * Called from index.ts during initialization.
 */
export function setSshStore(store: SshRemoteSettingsStore): void {
	sshStore = store;
}

/**
 * Extracts @mentions from text that match known participants.
 * Supports hyphenated names matching participants with spaces.
 *
 * @param text - The text to search for mentions
 * @param participants - List of valid participants
 * @returns Array of participant names that were mentioned (using original names, not hyphenated)
 */
export function extractMentions(text: string, participants: GroupChatParticipant[]): string[] {
	const mentions: string[] = [];

	// Match @Name patterns - captures characters after @ excluding:
	// - Whitespace and @
	// - Common punctuation that typically follows mentions: :,;!?()[]{}'"<>
	// This supports names with emojis, Unicode characters, dots, hyphens, underscores, etc.
	// Examples: @RunMaestro.ai, @my-agent, @✅-autorun-wizard, @日本語
	const mentionPattern = /@([^\s@:,;!?()\[\]{}'"<>]+)/g;
	let match;

	while ((match = mentionPattern.exec(text)) !== null) {
		const mentionedName = match[1];
		// Find participant that matches (either exact or normalized)
		const matchingParticipant = participants.find((p) => mentionMatches(mentionedName, p.name));
		if (matchingParticipant && !mentions.includes(matchingParticipant.name)) {
			mentions.push(matchingParticipant.name);
		}
	}

	return mentions;
}

/**
 * Extracts ALL @mentions from text (regardless of whether they're participants).
 *
 * @param text - The text to search for mentions
 * @returns Array of unique names that were mentioned (without @ prefix)
 */
export function extractAllMentions(text: string): string[] {
	const mentions: string[] = [];

	// Match @Name patterns - captures characters after @ excluding:
	// - Whitespace and @
	// - Common punctuation that typically follows mentions: :,;!?()[]{}'"<>
	// This supports names with emojis, Unicode characters, dots, hyphens, underscores, etc.
	// Examples: @RunMaestro.ai, @my-agent, @✅-autorun-wizard, @日本語
	const mentionPattern = /@([^\s@:,;!?()\[\]{}'"<>]+)/g;
	let match;

	while ((match = mentionPattern.exec(text)) !== null) {
		const name = match[1];
		if (!mentions.includes(name)) {
			mentions.push(name);
		}
	}

	return mentions;
}

/**
 * Routes a user message to the moderator.
 *
 * Spawns a batch process for the moderator to handle this specific message.
 * The chat history is included in the system prompt for context.
 *
 * @param groupChatId - The ID of the group chat
 * @param message - The message from the user
 * @param processManager - The process manager (optional)
 * @param agentDetector - The agent detector for resolving agent commands (optional)
 * @param readOnly - Optional flag indicating read-only mode
 */
export async function routeUserMessage(
	groupChatId: string,
	message: string,
	processManager?: IProcessManager,
	agentDetector?: AgentDetector,
	readOnly?: boolean
): Promise<void> {
	let chat = await loadGroupChat(groupChatId);
	if (!chat) {
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	if (!isModeratorActive(groupChatId)) {
		throw new Error(`Moderator is not active for this group chat. Try restarting the moderator.`);
	}

	// Acquire chat lock to prevent concurrent operations (delete, moderator change)
	if (!acquireChatLock(groupChatId, 'processing user message')) {
		throw new Error('Group chat is busy processing a previous message');
	}

	// Auto-add participants mentioned by the user if they match available sessions
	if (processManager && agentDetector && getSessionsCallback) {
		const userMentions = extractAllMentions(message);
		const sessions = getSessionsCallback();
		const existingParticipantNames = new Set(chat.participants.map((p) => p.name));

		for (const mentionedName of userMentions) {
			// Skip if already a participant (check both exact and normalized names)
			const alreadyParticipant = Array.from(existingParticipantNames).some((existingName) =>
				mentionMatches(mentionedName, existingName)
			);
			if (alreadyParticipant) {
				continue;
			}

			// Find matching session by name (supports both exact and hyphenated names)
			const matchingSession = sessions.find(
				(s) => mentionMatches(mentionedName, s.name) && s.toolType !== 'terminal'
			);

			if (matchingSession) {
				try {
					// Use the original session name as the participant name
					const participantName = matchingSession.name;
					// Get custom env vars for this agent type
					const customEnvVars = getCustomEnvVarsCallback?.(matchingSession.toolType);
					const agentConfigValues = getAgentConfigCallback?.(matchingSession.toolType) || {};
					await addParticipant(
						groupChatId,
						participantName,
						matchingSession.toolType,
						processManager,
						matchingSession.cwd,
						agentDetector,
						agentConfigValues,
						customEnvVars,
						// Pass session-specific overrides (customModel, customArgs, customEnvVars, sshRemoteConfig from session)
						{
							customModel: matchingSession.customModel,
							customArgs: matchingSession.customArgs,
							customEnvVars: matchingSession.customEnvVars,
							sshRemoteName: matchingSession.sshRemoteName,
							sshRemoteConfig: matchingSession.sshRemoteConfig,
						},
						// Pass SSH store for remote execution support
						sshStore ?? undefined
					);
					existingParticipantNames.add(participantName);

					// Emit participant changed event so UI updates
					const updatedChatForEmit = await loadGroupChat(groupChatId);
					if (updatedChatForEmit) {
						groupChatEmitters.emitParticipantsChanged?.(
							groupChatId,
							updatedChatForEmit.participants
						);
					}
				} catch (error) {
					logger.error(
						`Failed to auto-add participant ${mentionedName} from user mention`,
						LOG_CONTEXT,
						{ error, groupChatId }
					);
					captureException(error, {
						operation: 'groupChat:autoAddParticipant',
						participantName: mentionedName,
						groupChatId,
					});
					// Continue with other participants even if one fails
				}
			} else {
				// Fall back to agent type lookup from agent definitions
				const agentDef = getVisibleAgentDefinitions().find(
					(def) =>
						mentionMatches(mentionedName, def.name) ||
						def.id.toLowerCase() === mentionedName.toLowerCase()
				);
				if (agentDef) {
					try {
						const agent = await agentDetector.getAgent(agentDef.id);
						if (agent?.available) {
							const participantName = agentDef.name;
							const defaultCwd = os.homedir();
							const agentConfigValues = getAgentConfigCallback?.(agentDef.id) || {};
							await addFreshParticipant(
								groupChatId,
								participantName,
								agentDef.id,
								processManager,
								defaultCwd,
								agentDetector,
								agentConfigValues
							);
							existingParticipantNames.add(participantName);

							// Emit participant changed event so UI updates
							const updatedChatForEmit = await loadGroupChat(groupChatId);
							if (updatedChatForEmit) {
								groupChatEmitters.emitParticipantsChanged?.(
									groupChatId,
									updatedChatForEmit.participants
								);
							}
						}
					} catch (error) {
						logger.error(
							`Failed to auto-add fresh participant ${mentionedName} from agent type`,
							LOG_CONTEXT,
							{ error, groupChatId }
						);
						captureException(error, {
							operation: 'groupChat:autoAddFreshParticipant',
							participantName: mentionedName,
							groupChatId,
						});
						// Continue with other participants even if one fails
					}
				}
			}
		}

		// Reload chat to get updated participants list
		chat = await loadGroupChat(groupChatId);
		if (!chat) {
			throw new Error(`Group chat not found after participant update: ${groupChatId}`);
		}
	}

	// Log the message as coming from user
	await appendToLog(chat.logPath, 'user', message, readOnly);

	// Store the read-only state for this group chat so it can be propagated to participants
	setGroupChatReadOnlyState(groupChatId, readOnly ?? false);

	// Emit message event to renderer so it shows immediately
	const userMessage: GroupChatMessage = {
		timestamp: new Date().toISOString(),
		from: 'user',
		content: message,
		readOnly,
	};
	groupChatEmitters.emitMessage?.(groupChatId, userMessage);

	// Spawn a batch process for the moderator to handle this message
	// The response will be captured via the process:data event handler in index.ts
	if (processManager && agentDetector) {
		const sessionIdPrefix = getModeratorSessionId(groupChatId);

		if (sessionIdPrefix) {
			// Create a unique session ID for this message
			const sessionId = `${sessionIdPrefix}-${Date.now()}`;

			// Resolve the agent configuration to get the executable command
			const agent = await agentDetector.getAgent(chat.moderatorAgentId);

			if (!agent || !agent.available) {
				throw new Error(
					`Agent '${chat.moderatorAgentId}' is not installed or unavailable. Install it or use an available agent.`
				);
			}

			// Use custom path from moderator config if set, otherwise use resolved path
			const command = chat.moderatorConfig?.customPath || agent.path || agent.command;

			// Build participant context
			// Use normalized names (spaces → hyphens) so moderator can @mention them properly
			const participantContext =
				chat.participants.length > 0
					? chat.participants
							.map((p) => `- @${normalizeMentionName(p.name)} (${p.agentId} session)`)
							.join('\n')
					: '(No agents currently in this group chat)';

			// Build available sessions context (sessions that could be added)
			let availableSessionsContext = '';
			if (getSessionsCallback) {
				const sessions = getSessionsCallback();
				const participantNames = new Set(chat.participants.map((p) => p.name));
				const availableSessions = sessions.filter(
					(s) => s.toolType !== 'terminal' && !participantNames.has(s.name)
				);
				if (availableSessions.length > 0) {
					// Use normalized names (spaces → hyphens) so moderator can @mention them properly
					availableSessionsContext = `\n\n## Available Maestro Sessions (EXISTING agents with project context, add via @mention):\n${availableSessions.map((s) => `- @${normalizeMentionName(s.name)} (${s.toolType}) — has existing project context`).join('\n')}`;
				}
			}

			// Build available agent types context (installed agents that can be spawned as fresh participants)
			// Show ALL available agent types even if sessions of the same type exist —
			// the moderator prompt instructs it to ask the user which they prefer when both exist
			let availableAgentTypesContext = '';
			if (agentDetector) {
				const agentDefs = getVisibleAgentDefinitions();
				const participantNames = new Set(chat.participants.map((p) => p.name));
				const freshAgentTypes: string[] = [];
				for (const def of agentDefs) {
					// Skip if already a participant with this exact name
					if (participantNames.has(def.name)) continue;
					try {
						const agentInfo = await agentDetector.getAgent(def.id);
						if (agentInfo?.available) {
							freshAgentTypes.push(
								`- @${normalizeMentionName(def.name)} (${def.id}) — spawns a new instance`
							);
						}
					} catch {
						// Skip unavailable agents
					}
				}
				if (freshAgentTypes.length > 0) {
					availableAgentTypesContext = `\n\n## Available Agent Types (spawn a NEW instance via @mention):\n${freshAgentTypes.join('\n')}`;
				}
			}

			// Wrap untrusted content in XML boundary markers to prevent prompt injection
			const boundedMessage = '<user-message>\n' + message + '\n</user-message>';

			// Check if we can resume the moderator's prior session (token savings)
			// Skip synthetic Codex session IDs (codex-0-*) — they silently start new sessions
			const hasResumableModeratorSession =
				chat.moderatorAgentSessionId && !chat.moderatorAgentSessionId.startsWith('codex-0-');
			const canResumeModerator = !!(hasResumableModeratorSession && agent.resumeArgs);

			let promptToSend: string;
			if (canResumeModerator) {
				// Resume mode: send only new message + current context (skip system prompt + history)
				// The agent CLI loads its prior conversation from disk automatically
				let resumePrompt = `## New User Message${readOnly ? ' (READ-ONLY MODE - do not make changes)' : ''}:\n${boundedMessage}\n\n## Current Participants:\n${participantContext}`;
				if (availableSessionsContext) {
					resumePrompt += availableSessionsContext;
				}
				if (availableAgentTypesContext) {
					resumePrompt += availableAgentTypesContext;
				}
				promptToSend = resumePrompt;
				logger.debug('Moderator resuming session', LOG_CONTEXT, {
					groupChatId,
					agentSessionId: chat.moderatorAgentSessionId,
				});
			} else {
				// Full prompt mode: include system prompt + full history (first turn or no resume support)
				const chatHistory = await readLog(chat.logPath);
				const historyContext = chatHistory
					.slice(-20)
					.map((m) => `[${m.from}]: ${m.content}`)
					.join('\n');
				const boundedHistory = '<chat-history>\n' + historyContext + '\n</chat-history>';

				const conductorProfile = getConductorProfileCallback?.() || '';
				const systemPrompt = getModeratorSystemPrompt().replace(
					'{{CONDUCTOR_PROFILE}}',
					conductorProfile
				);

				promptToSend = `${systemPrompt}

## Current Participants:
${participantContext}${availableSessionsContext}${availableAgentTypesContext}

## Chat History:
${boundedHistory}

## User Request${readOnly ? ' (READ-ONLY MODE - do not make changes)' : ''}:
${boundedMessage}`;
			}

			// Get the base args from the agent configuration
			const args = [...agent.args];
			const agentConfigValues = getAgentConfigCallback?.(chat.moderatorAgentId) || {};
			const baseArgs = buildAgentArgs(agent, {
				baseArgs: args,
				prompt: promptToSend,
				cwd: os.homedir(),
				readOnlyMode: true,
				agentSessionId: canResumeModerator ? chat.moderatorAgentSessionId : undefined,
			});
			const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
				agentConfigValues,
				sessionCustomModel: chat.moderatorConfig?.customModel,
				sessionCustomArgs: chat.moderatorConfig?.customArgs,
				sessionCustomEnvVars: chat.moderatorConfig?.customEnvVars,
			});
			const finalArgs = configResolution.args;

			// Spawn the moderator process in batch mode
			try {
				// Emit state change to show moderator is thinking
				groupChatEmitters.emitStateChange?.(groupChatId, 'moderator-thinking');
				logger.debug('Moderator thinking', LOG_CONTEXT, { groupChatId });

				// Add power block reason to prevent sleep during group chat activity
				powerManager.addBlockReason(`groupchat:${groupChatId}`);

				// Prepare spawn config with potential SSH wrapping
				let spawnCommand = command;
				let spawnArgs = finalArgs;
				let spawnCwd = os.homedir();
				let spawnPrompt: string | undefined = promptToSend;
				let spawnEnvVars =
					configResolution.effectiveCustomEnvVars ??
					getCustomEnvVarsCallback?.(chat.moderatorAgentId);
				let spawnShell: string | undefined;
				let spawnRunInShell = false;

				// Apply SSH wrapping if configured
				if (sshStore && chat.moderatorConfig?.sshRemoteConfig) {
					const sshWrapped = await wrapSpawnWithSsh(
						{
							command,
							args: finalArgs,
							cwd: os.homedir(),
							prompt: promptToSend,
							customEnvVars:
								configResolution.effectiveCustomEnvVars ??
								getCustomEnvVarsCallback?.(chat.moderatorAgentId),
							promptArgs: agent.promptArgs,
							noPromptSeparator: agent.noPromptSeparator,
							agentBinaryName: agent.binaryName,
						},
						chat.moderatorConfig.sshRemoteConfig,
						sshStore
					);
					spawnCommand = sshWrapped.command;
					spawnArgs = sshWrapped.args;
					spawnCwd = sshWrapped.cwd;
					spawnPrompt = sshWrapped.prompt;
					spawnEnvVars = sshWrapped.customEnvVars;
				}

				// Get Windows-specific spawn config (shell, stdin mode) - handles SSH exclusion
				const winConfig = getWindowsSpawnConfig(
					chat.moderatorAgentId,
					chat.moderatorConfig?.sshRemoteConfig
				);
				if (winConfig.shell) {
					spawnShell = winConfig.shell;
					spawnRunInShell = winConfig.runInShell;
				}

				processManager.spawn({
					sessionId,
					toolType: chat.moderatorAgentId,
					cwd: spawnCwd,
					command: spawnCommand,
					args: spawnArgs,
					readOnlyMode: true,
					prompt: spawnPrompt,
					contextWindow: getContextWindowValue(agent, agentConfigValues),
					customEnvVars: spawnEnvVars,
					promptArgs: agent.promptArgs,
					noPromptSeparator: agent.noPromptSeparator,
					shell: spawnShell,
					runInShell: spawnRunInShell,
					sendPromptViaStdin: winConfig.sendPromptViaStdin,
					sendPromptViaStdinRaw: winConfig.sendPromptViaStdinRaw,
				});

				logger.debug('Moderator process spawned', LOG_CONTEXT, { groupChatId, sessionId });
			} catch (error) {
				logger.error(`Failed to spawn moderator for ${groupChatId}`, LOG_CONTEXT, { error });
				captureException(error, { operation: 'groupChat:spawnModerator', groupChatId });
				groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
				// Remove power block reason on error since we're going idle
				powerManager.removeBlockReason(`groupchat:${groupChatId}`);
				releaseChatLock(groupChatId);
				throw new Error(
					`Failed to start ${chat.moderatorAgentId}. Check that it's properly configured and accessible.`
				);
			}
		} else {
			logger.warn('No moderator session ID prefix', LOG_CONTEXT, { groupChatId });
			releaseChatLock(groupChatId);
		}
	} else if (processManager && !agentDetector) {
		logger.error('AgentDetector not available, cannot spawn moderator', LOG_CONTEXT);
		releaseChatLock(groupChatId);
		throw new Error('AgentDetector not available');
	} else {
		releaseChatLock(groupChatId);
	}
}

/**
 * Routes a moderator response, forwarding to mentioned agents.
 *
 * - Logs the message as coming from 'moderator'
 * - Extracts @mentions and auto-adds new participants from available sessions
 * - Forwards message to mentioned participants
 *
 * @param groupChatId - The ID of the group chat
 * @param message - The message from the moderator
 * @param processManager - The process manager (optional)
 * @param agentDetector - The agent detector for resolving agent commands (optional)
 * @param readOnly - Optional flag indicating read-only mode (propagates to participants)
 */
export async function routeModeratorResponse(
	groupChatId: string,
	message: string,
	processManager?: IProcessManager,
	agentDetector?: AgentDetector,
	readOnly?: boolean
): Promise<void> {
	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	// Log the message as coming from moderator
	await appendToLog(chat.logPath, 'moderator', message);

	// Emit message event to renderer so it shows immediately
	const moderatorMessage: GroupChatMessage = {
		timestamp: new Date().toISOString(),
		from: 'moderator',
		content: message,
	};
	groupChatEmitters.emitMessage?.(groupChatId, moderatorMessage);

	// Add history entry for moderator response
	try {
		const summary = extractFirstSentence(message);
		const historyEntry = await addGroupChatHistoryEntry(groupChatId, {
			timestamp: Date.now(),
			summary,
			participantName: 'Moderator',
			participantColor: '#808080', // Gray for moderator
			type: 'response',
			fullResponse: message,
		});

		// Emit history entry event to renderer
		groupChatEmitters.emitHistoryEntry?.(groupChatId, historyEntry);
	} catch (error) {
		logger.error('Failed to add history entry for Moderator', LOG_CONTEXT, { error, groupChatId });
		captureException(error, { operation: 'groupChat:addModeratorHistory', groupChatId });
		// Don't throw - history logging failure shouldn't break the message flow
	}

	// Extract ALL mentions from the message
	const allMentions = extractAllMentions(message);

	const existingParticipantNames = new Set(chat.participants.map((p) => p.name));

	// Track which agent types have been added in THIS response to prevent duplicates.
	// E.g., if an existing claude-code session is added, don't also spawn a fresh claude-code instance.
	const addedAgentTypes = new Set<string>();

	// Also collect the agent types already present as participants
	for (const p of chat.participants) {
		addedAgentTypes.add(p.agentId);
	}

	// Check for mentions that aren't already participants but match available sessions
	if (processManager && getSessionsCallback) {
		const sessions = getSessionsCallback();

		for (const mentionedName of allMentions) {
			// Skip if already a participant (check both exact and normalized names)
			const alreadyParticipant = Array.from(existingParticipantNames).some((existingName) =>
				mentionMatches(mentionedName, existingName)
			);
			if (alreadyParticipant) {
				continue;
			}

			// Find matching session by name (supports both exact and hyphenated names)
			const matchingSession = sessions.find(
				(s) => mentionMatches(mentionedName, s.name) && s.toolType !== 'terminal'
			);

			if (matchingSession) {
				// Skip if we already added an agent of this type in this response
				if (addedAgentTypes.has(matchingSession.toolType)) {
					logger.debug(
						`Skipping duplicate agent type ${matchingSession.toolType} (session: ${matchingSession.name})`,
						LOG_CONTEXT,
						{ groupChatId }
					);
					continue;
				}
				try {
					// Use the original session name as the participant name
					const participantName = matchingSession.name;
					// Get custom env vars for this agent type
					const customEnvVars = getCustomEnvVarsCallback?.(matchingSession.toolType);
					const agentConfigValues = getAgentConfigCallback?.(matchingSession.toolType) || {};
					await addParticipant(
						groupChatId,
						participantName,
						matchingSession.toolType,
						processManager,
						matchingSession.cwd,
						agentDetector,
						agentConfigValues,
						customEnvVars,
						// Pass session-specific overrides (customModel, customArgs, customEnvVars, sshRemoteConfig from session)
						{
							customModel: matchingSession.customModel,
							customArgs: matchingSession.customArgs,
							customEnvVars: matchingSession.customEnvVars,
							sshRemoteName: matchingSession.sshRemoteName,
							sshRemoteConfig: matchingSession.sshRemoteConfig,
						},
						// Pass SSH store for remote execution support
						sshStore ?? undefined
					);
					existingParticipantNames.add(participantName);
					addedAgentTypes.add(matchingSession.toolType);

					// Emit participant changed event so UI updates
					const updatedChatForEmit = await loadGroupChat(groupChatId);
					if (updatedChatForEmit) {
						groupChatEmitters.emitParticipantsChanged?.(
							groupChatId,
							updatedChatForEmit.participants
						);
					}
				} catch (error) {
					logger.error(`Failed to auto-add participant ${mentionedName}`, LOG_CONTEXT, {
						error,
						groupChatId,
					});
					captureException(error, {
						operation: 'groupChat:autoAddParticipant',
						participantName: mentionedName,
						groupChatId,
					});
					// Continue with other participants even if one fails
				}
			} else if (agentDetector) {
				// Fall back to agent type lookup from agent definitions
				const agentDef = getVisibleAgentDefinitions().find(
					(def) =>
						mentionMatches(mentionedName, def.name) ||
						def.id.toLowerCase() === mentionedName.toLowerCase()
				);
				if (agentDef) {
					// Skip if we already added an agent of this type in this response
					if (addedAgentTypes.has(agentDef.id)) {
						logger.debug(
							`Skipping duplicate agent type ${agentDef.id} (fresh spawn: ${agentDef.name})`,
							LOG_CONTEXT,
							{ groupChatId }
						);
						continue;
					}
					try {
						const agent = await agentDetector.getAgent(agentDef.id);
						if (agent?.available) {
							const participantName = agentDef.name;
							const defaultCwd = os.homedir();
							const agentConfigValues = getAgentConfigCallback?.(agentDef.id) || {};
							await addFreshParticipant(
								groupChatId,
								participantName,
								agentDef.id,
								processManager,
								defaultCwd,
								agentDetector,
								agentConfigValues
							);
							existingParticipantNames.add(participantName);
							addedAgentTypes.add(agentDef.id);

							// Emit participant changed event so UI updates
							const updatedChatForEmit = await loadGroupChat(groupChatId);
							if (updatedChatForEmit) {
								groupChatEmitters.emitParticipantsChanged?.(
									groupChatId,
									updatedChatForEmit.participants
								);
							}
						}
					} catch (error) {
						logger.error(
							`Failed to auto-add fresh participant ${mentionedName} from agent type (moderator)`,
							LOG_CONTEXT,
							{ error, groupChatId }
						);
						captureException(error, {
							operation: 'groupChat:autoAddFreshParticipant',
							participantName: mentionedName,
							groupChatId,
						});
						// Continue with other participants even if one fails
					}
				}
			}
		}
	}

	// Now extract mentions that are actual participants (including newly added ones)
	// Reload chat to get updated participants list
	const updatedChat = await loadGroupChat(groupChatId);
	if (!updatedChat) {
		return;
	}

	const mentions = extractMentions(message, updatedChat.participants);

	// Track participants that will need to respond for synthesis round
	const participantsToRespond = new Set<string>();

	// Spawn batch processes for each mentioned participant
	if (processManager && agentDetector && mentions.length > 0) {
		// Get available sessions for cwd lookup
		const sessions = getSessionsCallback?.() || [];

		// Get chat history for context
		const chatHistory = await readLog(updatedChat.logPath);
		const historyContext = chatHistory
			.slice(-15)
			.map(
				(m) => `[${m.from}]: ${m.content.substring(0, 500)}${m.content.length > 500 ? '...' : ''}`
			)
			.join('\n');

		// Wrap untrusted content in XML boundary markers to prevent prompt injection
		const boundedHistory = '<chat-history>\n' + historyContext + '\n</chat-history>';
		const boundedMessage = '<moderator-delegation>\n' + message + '\n</moderator-delegation>';

		for (const participantName of mentions) {
			// Find the participant info
			const participant = updatedChat.participants.find((p) => p.name === participantName);
			if (!participant) {
				logger.warn('Participant not found in chat, skipping', LOG_CONTEXT, {
					participantName,
					groupChatId,
				});
				continue;
			}

			// Find matching session to get cwd
			const matchingSession = sessions.find(
				(s) => mentionMatches(s.name, participantName) || s.name === participantName
			);
			const cwd = matchingSession?.cwd || os.homedir();

			// Resolve agent configuration
			const agent = await agentDetector.getAgent(participant.agentId);

			if (!agent || !agent.available) {
				logger.error('Agent not available for participant', LOG_CONTEXT, {
					agentId: participant.agentId,
					participantName,
				});
				continue;
			}

			// Check if we can resume this participant's prior session (token savings)
			// Skip synthetic Codex session IDs (codex-0-*) — they silently start new sessions
			const hasResumableParticipantSession =
				participant.agentSessionId && !participant.agentSessionId.startsWith('codex-0-');
			const canResumeParticipant = !!(hasResumableParticipantSession && agent.resumeArgs);

			let participantPrompt: string;
			if (canResumeParticipant) {
				// Resume mode: send only the new delegation (skip system prompt + history)
				const readOnlyLabel = readOnly ? ' (READ-ONLY MODE)' : '';
				const readOnlyInstruction = readOnly
					? ' Remember: READ-ONLY mode is active, do not modify any files.'
					: ' If you need to perform any actions, do so and report your findings.';
				participantPrompt = `## New Task in Group Chat "${updatedChat.name}"${readOnlyLabel}:\n${boundedMessage}\n${readOnlyInstruction}`;
				logger.debug('Participant resuming session', LOG_CONTEXT, {
					groupChatId,
					participantName,
					agentSessionId: participant.agentSessionId,
				});
			} else {
				// Full prompt mode (first delegation or no resume support)
				const readOnlyNote = readOnly
					? '\n\n**READ-ONLY MODE:** Do not make any file changes. Only analyze, review, or provide information.'
					: '';
				const readOnlyLabel = readOnly ? ' (READ-ONLY MODE)' : '';
				const readOnlyInstruction = readOnly
					? ' Remember: READ-ONLY mode is active, do not modify any files.'
					: ' If you need to perform any actions, do so and report your findings.';

				// Get the group chat folder path for file access permissions
				const groupChatFolder = getGroupChatDir(groupChatId);

				participantPrompt = groupChatParticipantRequestPrompt
					.replace(/\{\{PARTICIPANT_NAME\}\}/g, participantName)
					.replace(/\{\{GROUP_CHAT_NAME\}\}/g, updatedChat.name)
					.replace(/\{\{READ_ONLY_NOTE\}\}/g, readOnlyNote)
					.replace(/\{\{GROUP_CHAT_FOLDER\}\}/g, groupChatFolder)
					.replace(/\{\{HISTORY_CONTEXT\}\}/g, boundedHistory)
					.replace(/\{\{READ_ONLY_LABEL\}\}/g, readOnlyLabel)
					.replace(/\{\{MESSAGE\}\}/g, boundedMessage)
					.replace(/\{\{READ_ONLY_INSTRUCTION\}\}/g, readOnlyInstruction);
			}

			// Create a unique session ID for this batch process
			const sessionId = `group-chat-${groupChatId}-participant-${participantName}-${Date.now()}`;

			const agentConfigValues = getAgentConfigCallback?.(participant.agentId) || {};
			// Note: Don't pass modelId to buildAgentArgs - it will be handled by applyAgentConfigOverrides
			// via sessionCustomModel to avoid duplicate --model args
			const baseArgs = buildAgentArgs(agent, {
				baseArgs: [...agent.args],
				prompt: participantPrompt,
				cwd,
				readOnlyMode: readOnly ?? false,
				agentSessionId: participant.agentSessionId,
			});
			const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
				agentConfigValues,
				sessionCustomModel: matchingSession?.customModel,
				sessionCustomArgs: matchingSession?.customArgs,
				sessionCustomEnvVars: matchingSession?.customEnvVars,
			});

			try {
				// Emit participant state change to show this participant is working
				groupChatEmitters.emitParticipantState?.(groupChatId, participantName, 'working');

				const spawnCommand = agent.path || agent.command;
				const spawnArgs = configResolution.args;

				// Prepare spawn config with potential SSH wrapping
				let finalSpawnCommand = spawnCommand;
				let finalSpawnArgs = spawnArgs;
				let finalSpawnCwd = cwd;
				let finalSpawnPrompt: string | undefined = participantPrompt;
				let finalSpawnEnvVars =
					configResolution.effectiveCustomEnvVars ??
					getCustomEnvVarsCallback?.(participant.agentId);
				let finalSpawnShell: string | undefined;
				let finalSpawnRunInShell = false;

				// Apply SSH wrapping if configured for this session
				if (sshStore && matchingSession?.sshRemoteConfig) {
					const sshWrapped = await wrapSpawnWithSsh(
						{
							command: spawnCommand,
							args: spawnArgs,
							cwd,
							prompt: participantPrompt,
							customEnvVars:
								configResolution.effectiveCustomEnvVars ??
								getCustomEnvVarsCallback?.(participant.agentId),
							promptArgs: agent.promptArgs,
							noPromptSeparator: agent.noPromptSeparator,
							agentBinaryName: agent.binaryName,
						},
						matchingSession.sshRemoteConfig,
						sshStore
					);
					finalSpawnCommand = sshWrapped.command;
					finalSpawnArgs = sshWrapped.args;
					finalSpawnCwd = sshWrapped.cwd;
					finalSpawnPrompt = sshWrapped.prompt;
					finalSpawnEnvVars = sshWrapped.customEnvVars;
				}

				// Get Windows-specific spawn config (shell, stdin mode) - handles SSH exclusion
				const winConfig = getWindowsSpawnConfig(
					participant.agentId,
					matchingSession?.sshRemoteConfig
				);
				if (winConfig.shell) {
					finalSpawnShell = winConfig.shell;
					finalSpawnRunInShell = winConfig.runInShell;
				}

				processManager.spawn({
					sessionId,
					toolType: participant.agentId,
					cwd: finalSpawnCwd,
					command: finalSpawnCommand,
					args: finalSpawnArgs,
					readOnlyMode: readOnly ?? false, // Propagate read-only mode from caller
					prompt: finalSpawnPrompt,
					contextWindow: getContextWindowValue(agent, agentConfigValues),
					customEnvVars: finalSpawnEnvVars,
					promptArgs: agent.promptArgs,
					noPromptSeparator: agent.noPromptSeparator,
					shell: finalSpawnShell,
					runInShell: finalSpawnRunInShell,
					sendPromptViaStdin: winConfig.sendPromptViaStdin,
					sendPromptViaStdinRaw: winConfig.sendPromptViaStdinRaw,
				});

				logger.debug('Participant process spawned', LOG_CONTEXT, {
					groupChatId,
					participantName,
					sessionId,
				});

				// Track this participant as pending response
				participantsToRespond.add(participantName);
			} catch (error) {
				logger.error(`Failed to spawn participant ${participantName}`, LOG_CONTEXT, {
					error,
					groupChatId,
				});
				captureException(error, {
					operation: 'groupChat:spawnParticipant',
					participantName,
					groupChatId,
				});
				// Reset participant UI state to idle on spawn failure
				groupChatEmitters.emitParticipantState?.(groupChatId, participantName, 'idle');
				// Continue with other participants even if one fails
			}
		}
	} else if (mentions.length === 0) {
		// Set state back to idle since no agents are being spawned
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		logger.debug('No participant mentions, round complete', LOG_CONTEXT, { groupChatId });
		// Remove power block reason since round is complete
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
		// Release chat lock - conversation round is complete
		releaseChatLock(groupChatId);
	}

	// Store pending participants for synthesis tracking (merge with existing to avoid overwriting round 1)
	if (participantsToRespond.size > 0) {
		const existing = pendingParticipantResponses.get(groupChatId) || new Set<string>();
		for (const name of participantsToRespond) {
			existing.add(name);
		}
		pendingParticipantResponses.set(groupChatId, existing);
		// Set state to show agents are working
		groupChatEmitters.emitStateChange?.(groupChatId, 'agent-working');
	}
}

/**
 * Routes an agent's response back to the moderator.
 *
 * - Logs the message as coming from the participant
 * - Notifies the moderator of the response
 *
 * @param groupChatId - The ID of the group chat
 * @param participantName - The name of the responding participant
 * @param message - The message from the participant
 * @param processManager - The process manager (optional)
 */
export async function routeAgentResponse(
	groupChatId: string,
	participantName: string,
	message: string,
	_processManager?: IProcessManager
): Promise<void> {
	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	// Verify participant exists
	const participant = chat.participants.find((p) => p.name === participantName);
	if (!participant) {
		throw new Error(`Participant '${participantName}' not found in group chat`);
	}

	// Log the message as coming from the participant
	await appendToLog(chat.logPath, participantName, message);

	// Emit message event to renderer so it shows immediately
	const agentMessage: GroupChatMessage = {
		timestamp: new Date().toISOString(),
		from: participantName,
		content: message,
	};
	groupChatEmitters.emitMessage?.(groupChatId, agentMessage);

	// Extract summary from first sentence (agents are prompted to start with a summary sentence)
	const summary = extractFirstSentence(message);

	// Update participant stats
	const currentParticipant = participant;
	const newMessageCount = (currentParticipant.messageCount || 0) + 1;

	try {
		await updateParticipant(groupChatId, participantName, {
			lastActivity: Date.now(),
			lastSummary: summary,
			messageCount: newMessageCount,
		});

		// Emit participants changed so UI updates
		const updatedChat = await loadGroupChat(groupChatId);
		if (updatedChat) {
			groupChatEmitters.emitParticipantsChanged?.(groupChatId, updatedChat.participants);
		}
	} catch (error) {
		logger.error(`Failed to update participant stats for ${participantName}`, LOG_CONTEXT, {
			error,
			groupChatId,
		});
		captureException(error, {
			operation: 'groupChat:updateParticipantStats',
			participantName,
			groupChatId,
		});
		// Don't throw - stats update failure shouldn't break the message flow
	}

	// Add history entry for this response
	try {
		const historyEntry = await addGroupChatHistoryEntry(groupChatId, {
			timestamp: Date.now(),
			summary,
			participantName,
			participantColor: participant.color || '#808080', // Default gray if no color assigned
			type: 'response',
			fullResponse: message,
		});

		// Emit history entry event to renderer
		groupChatEmitters.emitHistoryEntry?.(groupChatId, historyEntry);
	} catch (error) {
		logger.error(`Failed to add history entry for ${participantName}`, LOG_CONTEXT, {
			error,
			groupChatId,
		});
		captureException(error, {
			operation: 'groupChat:addParticipantHistory',
			participantName,
			groupChatId,
		});
		// Don't throw - history logging failure shouldn't break the message flow
	}

	// Note: The moderator runs in batch mode (one-shot per message), so we can't write to it.
	// Instead, we track pending responses and spawn a synthesis round after all participants respond.
	// The synthesis is triggered from index.ts when the last pending participant exits.
}

/**
 * Spawns a moderator synthesis round to summarize participant responses.
 * Called from index.ts when the last pending participant has responded.
 *
 * @param groupChatId - The ID of the group chat
 * @param processManager - The process manager for spawning
 * @param agentDetector - The agent detector for resolving agent commands
 */
export async function spawnModeratorSynthesis(
	groupChatId: string,
	processManager: IProcessManager,
	agentDetector: AgentDetector
): Promise<void> {
	// Guard against duplicate synthesis triggers
	if (isSynthesisInProgress(groupChatId)) {
		logger.warn('Synthesis already in progress, skipping duplicate', LOG_CONTEXT, { groupChatId });
		return;
	}
	markSynthesisStarted(groupChatId);

	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		logger.error(`Cannot spawn synthesis - chat not found: ${groupChatId}`, LOG_CONTEXT);
		// Reset UI state and remove power block on early return
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
		clearSynthesisInProgress(groupChatId);
		return;
	}

	if (!isModeratorActive(groupChatId)) {
		logger.error(`Cannot spawn synthesis - moderator not active for: ${groupChatId}`, LOG_CONTEXT);
		// Reset UI state and remove power block on early return
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
		clearSynthesisInProgress(groupChatId);
		return;
	}

	const sessionIdPrefix = getModeratorSessionId(groupChatId);

	if (!sessionIdPrefix) {
		logger.error(
			`Cannot spawn synthesis - no moderator session ID for: ${groupChatId}`,
			LOG_CONTEXT
		);
		// Reset UI state and remove power block on early return
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
		clearSynthesisInProgress(groupChatId);
		return;
	}

	// Create a unique session ID for this synthesis round
	// Note: We use the regular moderator session ID format (no -synthesis- marker)
	// so the exit handler routes through routeModeratorResponse, which will
	// check for @mentions - if present, route to agents; if not, it's the final response
	const sessionId = `${sessionIdPrefix}-${Date.now()}`;

	// Resolve the agent configuration
	const agent = await agentDetector.getAgent(chat.moderatorAgentId);

	if (!agent || !agent.available) {
		logger.error(`Agent '${chat.moderatorAgentId}' is not available for synthesis`, LOG_CONTEXT);
		// Reset UI state and remove power block on early return
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
		clearSynthesisInProgress(groupChatId);
		return;
	}

	// Use custom path from moderator config if set
	const command = chat.moderatorConfig?.customPath || agent.path || agent.command;

	const args = [...agent.args];
	// Build the synthesis prompt with recent chat history
	const chatHistory = await readLog(chat.logPath);

	const historyContext = chatHistory
		.slice(-30)
		.map((m) => {
			// Wrap agent responses in boundary tags to prevent prompt injection
			if (m.from !== 'user' && m.from !== 'moderator' && m.from !== 'system') {
				return `[${m.from}]: <agent-response>${m.content}</agent-response>`;
			}
			return `[${m.from}]: ${m.content}`;
		})
		.join('\n');

	// Wrap full history in boundary tags
	const boundedHistory = '<chat-history>\n' + historyContext + '\n</chat-history>';

	// Build participant context for potential follow-up @mentions
	// Use normalized names (spaces → hyphens) so moderator can @mention them properly
	const participantContext =
		chat.participants.length > 0
			? chat.participants
					.map((p) => `- @${normalizeMentionName(p.name)} (${p.agentId} session)`)
					.join('\n')
			: '(No agents currently in this group chat)';

	// Build available agent types context for synthesis (installed agents that can be spawned as fresh participants)
	// Show ALL available types — moderator prompt instructs asking user when both session + type exist
	let synthesisAgentTypesContext = '';
	const participantNames = new Set(chat.participants.map((p) => p.name));
	const agentDefs = getVisibleAgentDefinitions();
	const freshAgentTypes: string[] = [];
	for (const def of agentDefs) {
		if (participantNames.has(def.name)) continue;
		try {
			const agentInfo = await agentDetector.getAgent(def.id);
			if (agentInfo?.available) {
				freshAgentTypes.push(
					`- @${normalizeMentionName(def.name)} (${def.id}) — spawns a new instance`
				);
			}
		} catch {
			// Skip unavailable agents
		}
	}
	if (freshAgentTypes.length > 0) {
		synthesisAgentTypesContext = `\n\n## Available Agent Types (spawn a NEW instance via @mention):\n${freshAgentTypes.join('\n')}`;
	}

	// Check if we can resume the moderator's prior session for synthesis (token savings)
	// Skip synthetic Codex session IDs (codex-0-*) — they silently start new sessions
	const hasResumableSynthesisSession =
		chat.moderatorAgentSessionId && !chat.moderatorAgentSessionId.startsWith('codex-0-');
	const canResumeSynthesis = !!(hasResumableSynthesisSession && agent.resumeArgs);

	let synthesisPrompt: string;
	if (canResumeSynthesis) {
		// Resume mode: moderator already has system prompt + prior context
		// Just send new participant responses + synthesis instruction
		synthesisPrompt = `${getModeratorSynthesisPrompt()}

## Current Participants (you can @mention these for follow-up):
${participantContext}${synthesisAgentTypesContext}

## Recent Participant Responses:
${boundedHistory}

## Your Task:
Review the agent responses above. Either:
1. Synthesize into a final answer for the user (NO @mentions) if the question is fully answered
2. @mention specific agents for follow-up if you need more information`;
		logger.debug('Synthesis resuming moderator session', LOG_CONTEXT, {
			groupChatId,
			agentSessionId: chat.moderatorAgentSessionId,
		});
	} else {
		// Full prompt mode: include system prompt (first synthesis or no resume support)
		const conductorProfile = getConductorProfileCallback?.() || '';
		const synthesisSystemPrompt = getModeratorSystemPrompt().replace(
			'{{CONDUCTOR_PROFILE}}',
			conductorProfile
		);

		synthesisPrompt = `${synthesisSystemPrompt}

${getModeratorSynthesisPrompt()}

## Current Participants (you can @mention these for follow-up):
${participantContext}${synthesisAgentTypesContext}

## Recent Chat History (including participant responses):
${boundedHistory}

## Your Task:
Review the agent responses above. Either:
1. Synthesize into a final answer for the user (NO @mentions) if the question is fully answered
2. @mention specific agents for follow-up if you need more information`;
	}

	const agentConfigValues = getAgentConfigCallback?.(chat.moderatorAgentId) || {};
	const baseArgs = buildAgentArgs(agent, {
		baseArgs: args,
		prompt: synthesisPrompt,
		cwd: os.homedir(),
		readOnlyMode: true,
		agentSessionId: canResumeSynthesis ? chat.moderatorAgentSessionId : undefined,
	});
	const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
		agentConfigValues,
		sessionCustomModel: chat.moderatorConfig?.customModel,
		sessionCustomArgs: chat.moderatorConfig?.customArgs,
		sessionCustomEnvVars: chat.moderatorConfig?.customEnvVars,
	});
	const finalArgs = configResolution.args;

	// Spawn the synthesis process
	try {
		// Emit state change to show moderator is thinking (synthesizing)
		groupChatEmitters.emitStateChange?.(groupChatId, 'moderator-thinking');
		logger.debug('Synthesis moderator thinking', LOG_CONTEXT, { groupChatId });

		// Prepare spawn config with potential SSH wrapping
		let spawnCommand = command;
		let spawnArgs = finalArgs;
		let spawnCwd = os.homedir();
		let spawnPrompt: string | undefined = synthesisPrompt;
		let spawnEnvVars =
			configResolution.effectiveCustomEnvVars ?? getCustomEnvVarsCallback?.(chat.moderatorAgentId);

		// Apply SSH wrapping if configured
		if (sshStore && chat.moderatorConfig?.sshRemoteConfig) {
			const sshWrapped = await wrapSpawnWithSsh(
				{
					command,
					args: finalArgs,
					cwd: os.homedir(),
					prompt: synthesisPrompt,
					customEnvVars: spawnEnvVars,
					promptArgs: agent.promptArgs,
					noPromptSeparator: agent.noPromptSeparator,
					agentBinaryName: agent.binaryName,
				},
				chat.moderatorConfig.sshRemoteConfig,
				sshStore
			);
			spawnCommand = sshWrapped.command;
			spawnArgs = sshWrapped.args;
			spawnCwd = sshWrapped.cwd;
			spawnPrompt = sshWrapped.prompt;
			spawnEnvVars = sshWrapped.customEnvVars;
		}

		// Get Windows-specific spawn config (shell, stdin mode) - handles SSH exclusion
		const winConfig = getWindowsSpawnConfig(
			chat.moderatorAgentId,
			chat.moderatorConfig?.sshRemoteConfig
		);

		processManager.spawn({
			sessionId,
			toolType: chat.moderatorAgentId,
			cwd: spawnCwd,
			command: spawnCommand,
			args: spawnArgs,
			readOnlyMode: true,
			prompt: spawnPrompt,
			contextWindow: getContextWindowValue(agent, agentConfigValues),
			customEnvVars: spawnEnvVars,
			promptArgs: agent.promptArgs,
			noPromptSeparator: agent.noPromptSeparator,
			shell: winConfig.shell,
			runInShell: winConfig.runInShell,
			sendPromptViaStdin: winConfig.sendPromptViaStdin,
			sendPromptViaStdinRaw: winConfig.sendPromptViaStdinRaw,
		});

		logger.debug('Synthesis moderator spawned', LOG_CONTEXT, { groupChatId, sessionId });
	} catch (error) {
		logger.error(`Failed to spawn moderator synthesis for ${groupChatId}`, LOG_CONTEXT, { error });
		captureException(error, { operation: 'groupChat:spawnSynthesis', groupChatId });
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		// Remove power block reason on synthesis error since we're going idle
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
		clearSynthesisInProgress(groupChatId);
	}
}

/**
 * Re-spawn a participant with session recovery context.
 *
 * This is called when a participant's session was not found (deleted out of band).
 * It builds rich context including the agent's prior statements and re-spawns
 * the participant to continue the conversation.
 *
 * @param groupChatId - The group chat ID
 * @param participantName - The participant who needs recovery
 * @param processManager - The process manager for spawning
 * @param agentDetector - The agent detector for agent configuration
 */
export async function respawnParticipantWithRecovery(
	groupChatId: string,
	participantName: string,
	processManager: IProcessManager,
	agentDetector: AgentDetector
): Promise<void> {
	// Import buildRecoveryContext here to avoid circular dependencies
	const { buildRecoveryContext } = await import('./session-recovery');

	// Load the chat and find the participant
	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	const participant = chat.participants.find((p) => p.name === participantName);
	if (!participant) {
		throw new Error(`Participant not found: ${participantName}`);
	}

	// Get the agent configuration
	const agent = await agentDetector.getAgent(participant.agentId);
	if (!agent || !agent.available) {
		throw new Error(
			`Agent '${participant.agentId}' is not installed or unavailable. Install it or use an available agent.`
		);
	}

	// Build recovery context with the agent's prior statements
	const recoveryContext = await buildRecoveryContext(groupChatId, participantName, 30);

	// Get the read-only state
	const readOnly = getGroupChatReadOnlyState(groupChatId);

	// Get chat history for additional context
	const chatHistory = await readLog(chat.logPath);
	const historyContext = chatHistory
		.slice(-15)
		.map((m) => `[${m.from}]: ${m.content.substring(0, 500)}${m.content.length > 500 ? '...' : ''}`)
		.join('\n');

	// Find matching session for cwd
	const sessions = getSessionsCallback?.() || [];
	const matchingSession = sessions.find(
		(s) => mentionMatches(s.name, participantName) || s.name === participantName
	);
	const cwd = matchingSession?.cwd || os.homedir();

	// Build the prompt with recovery context
	const readOnlyNote = readOnly
		? '\n\n**READ-ONLY MODE:** Do not make any file changes. Only analyze, review, or provide information.'
		: '';
	const readOnlyLabel = readOnly ? ' (READ-ONLY MODE)' : '';
	const readOnlyInstruction = readOnly
		? ' Remember: READ-ONLY mode is active, do not modify any files.'
		: ' If you need to perform any actions, do so and report your findings.';

	const groupChatFolder = getGroupChatDir(groupChatId);

	// Build the recovery prompt - includes standard prompt plus recovery context
	const basePrompt = groupChatParticipantRequestPrompt
		.replace(/\{\{PARTICIPANT_NAME\}\}/g, participantName)
		.replace(/\{\{GROUP_CHAT_NAME\}\}/g, chat.name)
		.replace(/\{\{READ_ONLY_NOTE\}\}/g, readOnlyNote)
		.replace(/\{\{GROUP_CHAT_FOLDER\}\}/g, groupChatFolder)
		.replace(/\{\{HISTORY_CONTEXT\}\}/g, historyContext)
		.replace(/\{\{READ_ONLY_LABEL\}\}/g, readOnlyLabel)
		.replace(
			/\{\{MESSAGE\}\}/g,
			'Please continue from where you left off based on the recovery context below.'
		)
		.replace(/\{\{READ_ONLY_INSTRUCTION\}\}/g, readOnlyInstruction);

	// Prepend recovery context
	const fullPrompt = `${recoveryContext}\n\n${basePrompt}`;

	// Create a unique session ID for this recovery spawn
	const sessionId = `group-chat-${groupChatId}-participant-${participantName}-recovery-${Date.now()}`;

	// Build args - note: no agentSessionId since we're starting fresh
	const agentConfigValues = getAgentConfigCallback?.(participant.agentId) || {};
	const baseArgs = buildAgentArgs(agent, {
		baseArgs: [...agent.args],
		prompt: fullPrompt,
		cwd,
		readOnlyMode: readOnly ?? false,
		// No agentSessionId - we're starting fresh after session recovery
	});

	const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
		agentConfigValues,
		sessionCustomModel: matchingSession?.customModel,
		sessionCustomArgs: matchingSession?.customArgs,
		sessionCustomEnvVars: matchingSession?.customEnvVars,
	});

	// Emit participant state change to show this participant is working
	groupChatEmitters.emitParticipantState?.(groupChatId, participantName, 'working');

	// Spawn the recovery process — with SSH wrapping if configured
	let finalSpawnCommand = agent.path || agent.command;
	let finalSpawnArgs = configResolution.args;
	let finalSpawnCwd = cwd;
	let finalSpawnPrompt: string | undefined = fullPrompt;
	let finalSpawnEnvVars =
		configResolution.effectiveCustomEnvVars ?? getCustomEnvVarsCallback?.(participant.agentId);
	let finalSpawnShell: string | undefined;
	let finalSpawnRunInShell = false;

	// Apply SSH wrapping if configured for this session
	if (sshStore && matchingSession?.sshRemoteConfig) {
		const sshWrapped = await wrapSpawnWithSsh(
			{
				command: finalSpawnCommand,
				args: finalSpawnArgs,
				cwd,
				prompt: fullPrompt,
				customEnvVars: finalSpawnEnvVars,
				promptArgs: agent.promptArgs,
				noPromptSeparator: agent.noPromptSeparator,
				agentBinaryName: agent.binaryName,
			},
			matchingSession.sshRemoteConfig,
			sshStore
		);
		finalSpawnCommand = sshWrapped.command;
		finalSpawnArgs = sshWrapped.args;
		finalSpawnCwd = sshWrapped.cwd;
		finalSpawnPrompt = sshWrapped.prompt;
		finalSpawnEnvVars = sshWrapped.customEnvVars;
	}

	// Get Windows-specific spawn config (shell, stdin mode) - handles SSH exclusion
	const winConfig = getWindowsSpawnConfig(participant.agentId, matchingSession?.sshRemoteConfig);
	if (winConfig.shell) {
		finalSpawnShell = winConfig.shell;
		finalSpawnRunInShell = winConfig.runInShell;
	}

	processManager.spawn({
		sessionId,
		toolType: participant.agentId,
		cwd: finalSpawnCwd,
		command: finalSpawnCommand,
		args: finalSpawnArgs,
		readOnlyMode: readOnly ?? false,
		prompt: finalSpawnPrompt,
		contextWindow: getContextWindowValue(agent, agentConfigValues),
		customEnvVars: finalSpawnEnvVars,
		promptArgs: agent.promptArgs,
		noPromptSeparator: agent.noPromptSeparator,
		shell: finalSpawnShell,
		runInShell: finalSpawnRunInShell,
		sendPromptViaStdin: winConfig.sendPromptViaStdin,
		sendPromptViaStdinRaw: winConfig.sendPromptViaStdinRaw,
	});

	logger.debug('Recovery process spawned', LOG_CONTEXT, {
		groupChatId,
		participantName,
		sessionId,
	});
}
