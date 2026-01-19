/**
 * @file group-chat-router.ts
 * @description Message routing for Group Chat feature.
 *
 * Routes messages between:
 * - User -> Moderator
 * - Moderator -> Participants (via @mentions)
 * - Participants -> Moderator
 */

import {
	GroupChatParticipant,
	loadGroupChat,
	updateParticipant,
	addGroupChatHistoryEntry,
	extractFirstSentence,
	getGroupChatDir,
} from './group-chat-storage';
import { appendToLog, readLog } from './group-chat-log';
import { type GroupChatMessage, mentionMatches } from '../../shared/group-chat-types';
import {
	IProcessManager,
	getModeratorSessionId,
	isModeratorActive,
	getModeratorSystemPrompt,
	getModeratorSynthesisPrompt,
} from './group-chat-moderator';
import { addParticipant } from './group-chat-agent';
import { AgentDetector } from '../agent-detector';
import { powerManager } from '../power-manager';
import {
	buildAgentArgs,
	applyAgentConfigOverrides,
	getContextWindowValue,
} from '../utils/agent-args';
import { groupChatParticipantRequestPrompt } from '../../prompts';

// Import emitters from IPC handlers (will be populated after handlers are registered)
import { groupChatEmitters } from '../ipc/handlers/groupChat';

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
	console.log(`[GroupChat:Debug] ========== ROUTE USER MESSAGE ==========`);
	console.log(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
	console.log(`[GroupChat:Debug] Message length: ${message.length}`);
	console.log(`[GroupChat:Debug] Read-only: ${readOnly ?? false}`);
	console.log(`[GroupChat:Debug] Has processManager: ${!!processManager}`);
	console.log(`[GroupChat:Debug] Has agentDetector: ${!!agentDetector}`);

	let chat = await loadGroupChat(groupChatId);
	if (!chat) {
		console.log(`[GroupChat:Debug] ERROR: Group chat not found!`);
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	console.log(`[GroupChat:Debug] Chat loaded: "${chat.name}"`);
	console.log(
		`[GroupChat:Debug] Current participants: ${chat.participants.map((p) => p.name).join(', ') || '(none)'}`
	);
	console.log(`[GroupChat:Debug] Moderator Agent ID: ${chat.moderatorAgentId}`);

	if (!isModeratorActive(groupChatId)) {
		console.log(`[GroupChat:Debug] ERROR: Moderator is not active!`);
		throw new Error(`Moderator is not active for group chat: ${groupChatId}`);
	}

	console.log(`[GroupChat:Debug] Moderator is active: true`);

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
					console.log(
						`[GroupChatRouter] Auto-adding participant @${participantName} from user mention @${mentionedName} (session ${matchingSession.id})`
					);
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
						// Pass session-specific overrides (customModel, customArgs, customEnvVars, sshRemoteName from session)
						{
							customModel: matchingSession.customModel,
							customArgs: matchingSession.customArgs,
							customEnvVars: matchingSession.customEnvVars,
							sshRemoteName: matchingSession.sshRemoteName,
						}
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
					console.error(
						`[GroupChatRouter] Failed to auto-add participant ${mentionedName} from user mention:`,
						error
					);
					// Continue with other participants even if one fails
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
		console.log(`[GroupChat:Debug] Preparing to spawn moderator batch process...`);
		const sessionIdPrefix = getModeratorSessionId(groupChatId);
		console.log(`[GroupChat:Debug] Session ID prefix: ${sessionIdPrefix}`);

		if (sessionIdPrefix) {
			// Create a unique session ID for this message
			const sessionId = `${sessionIdPrefix}-${Date.now()}`;
			console.log(`[GroupChat:Debug] Generated full session ID: ${sessionId}`);

			// Resolve the agent configuration to get the executable command
			const agent = await agentDetector.getAgent(chat.moderatorAgentId);
			console.log(`[GroupChat:Debug] Agent resolved: ${agent?.command || 'null'}`);
			console.log(`[GroupChat:Debug] Agent available: ${agent?.available ?? false}`);

			if (!agent || !agent.available) {
				console.log(`[GroupChat:Debug] ERROR: Agent not available!`);
				throw new Error(`Agent '${chat.moderatorAgentId}' is not available`);
			}

			// Use custom path from moderator config if set, otherwise use resolved path
			const command = chat.moderatorConfig?.customPath || agent.path || agent.command;
			console.log(`[GroupChat:Debug] Command to execute: ${command}`);

			// Build participant context
			const participantContext =
				chat.participants.length > 0
					? chat.participants.map((p) => `- @${p.name} (${p.agentId} session)`).join('\n')
					: '(No agents currently in this group chat)';

			// Build available sessions context (sessions that could be added)
			let availableSessionsContext = '';
			if (getSessionsCallback) {
				const sessions = getSessionsCallback();
				console.log(
					`[GroupChat:Debug] Available sessions from callback: ${sessions.map((s) => s.name).join(', ')}`
				);
				const participantNames = new Set(chat.participants.map((p) => p.name));
				const availableSessions = sessions.filter(
					(s) => s.toolType !== 'terminal' && !participantNames.has(s.name)
				);
				if (availableSessions.length > 0) {
					availableSessionsContext = `\n\n## Available Maestro Sessions (can be added via @mention):\n${availableSessions.map((s) => `- @${s.name} (${s.toolType})`).join('\n')}`;
				}
			}

			// Build the prompt with context
			const chatHistory = await readLog(chat.logPath);
			console.log(`[GroupChat:Debug] Chat history entries: ${chatHistory.length}`);

			const historyContext = chatHistory
				.slice(-20)
				.map((m) => `[${m.from}]: ${m.content}`)
				.join('\n');

			const fullPrompt = `${getModeratorSystemPrompt()}

## Current Participants:
${participantContext}${availableSessionsContext}

## Chat History:
${historyContext}

## User Request${readOnly ? ' (READ-ONLY MODE - do not make changes)' : ''}:
${message}`;

			// Get the base args from the agent configuration
			const args = [...agent.args];
			const agentConfigValues = getAgentConfigCallback?.(chat.moderatorAgentId) || {};
			console.log(
				`[GroupChat:Debug] agentConfigValues for ${chat.moderatorAgentId}: ${JSON.stringify(agentConfigValues)}`
			);
			const baseArgs = buildAgentArgs(agent, {
				baseArgs: args,
				prompt: fullPrompt,
				cwd: process.env.HOME || '/tmp',
				readOnlyMode: true,
			});
			const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
				agentConfigValues,
				sessionCustomArgs: chat.moderatorConfig?.customArgs,
				sessionCustomEnvVars: chat.moderatorConfig?.customEnvVars,
			});
			const finalArgs = configResolution.args;
			console.log(`[GroupChat:Debug] Args: ${JSON.stringify(finalArgs)}`);

			console.log(`[GroupChat:Debug] Full prompt length: ${fullPrompt.length} chars`);
			console.log(`[GroupChat:Debug] ========== SPAWNING MODERATOR PROCESS ==========`);
			console.log(`[GroupChat:Debug] Session ID: ${sessionId}`);
			console.log(`[GroupChat:Debug] Tool Type: ${chat.moderatorAgentId}`);
			console.log(`[GroupChat:Debug] CWD: ${process.env.HOME || '/tmp'}`);
			console.log(`[GroupChat:Debug] Command: ${command}`);
			console.log(`[GroupChat:Debug] ReadOnly: true`);

			// Spawn the moderator process in batch mode
			try {
				// Emit state change to show moderator is thinking
				groupChatEmitters.emitStateChange?.(groupChatId, 'moderator-thinking');
				console.log(`[GroupChat:Debug] Emitted state change: moderator-thinking`);

				// Add power block reason to prevent sleep during group chat activity
				powerManager.addBlockReason(`groupchat:${groupChatId}`);

				const spawnResult = processManager.spawn({
					sessionId,
					toolType: chat.moderatorAgentId,
					cwd: process.env.HOME || '/tmp',
					command,
					args: finalArgs,
					readOnlyMode: true,
					prompt: fullPrompt,
					contextWindow: getContextWindowValue(agent, agentConfigValues),
					customEnvVars:
						configResolution.effectiveCustomEnvVars ??
						getCustomEnvVarsCallback?.(chat.moderatorAgentId),
					promptArgs: agent.promptArgs,
					noPromptSeparator: agent.noPromptSeparator,
				});

				console.log(`[GroupChat:Debug] Spawn result: ${JSON.stringify(spawnResult)}`);
				console.log(`[GroupChat:Debug] Moderator process spawned successfully`);
				console.log(`[GroupChat:Debug] promptArgs: ${agent.promptArgs ? 'defined' : 'undefined'}`);
				console.log(`[GroupChat:Debug] noPromptSeparator: ${agent.noPromptSeparator ?? false}`);
				console.log(`[GroupChat:Debug] =================================================`);
			} catch (error) {
				console.error(`[GroupChat:Debug] SPAWN ERROR:`, error);
				console.error(`[GroupChatRouter] Failed to spawn moderator for ${groupChatId}:`, error);
				groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
				// Remove power block reason on error since we're going idle
				powerManager.removeBlockReason(`groupchat:${groupChatId}`);
				throw new Error(
					`Failed to spawn moderator: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		} else {
			console.log(`[GroupChat:Debug] WARNING: No session ID prefix found for moderator`);
		}
	} else if (processManager && !agentDetector) {
		console.error(`[GroupChat:Debug] ERROR: AgentDetector not available!`);
		console.error(`[GroupChatRouter] AgentDetector not available, cannot spawn moderator`);
		throw new Error('AgentDetector not available');
	} else {
		console.log(`[GroupChat:Debug] WARNING: No processManager provided, skipping spawn`);
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
	console.log(`[GroupChat:Debug] ========== ROUTE MODERATOR RESPONSE ==========`);
	console.log(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
	console.log(`[GroupChat:Debug] Message length: ${message.length}`);
	console.log(
		`[GroupChat:Debug] Message preview: "${message.substring(0, 300)}${message.length > 300 ? '...' : ''}"`
	);
	console.log(`[GroupChat:Debug] Read-only: ${readOnly ?? false}`);

	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		console.log(`[GroupChat:Debug] ERROR: Group chat not found!`);
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	console.log(`[GroupChat:Debug] Chat loaded: "${chat.name}"`);

	// Log the message as coming from moderator
	await appendToLog(chat.logPath, 'moderator', message);
	console.log(`[GroupChat:Debug] Message appended to log`);

	// Emit message event to renderer so it shows immediately
	const moderatorMessage: GroupChatMessage = {
		timestamp: new Date().toISOString(),
		from: 'moderator',
		content: message,
	};
	groupChatEmitters.emitMessage?.(groupChatId, moderatorMessage);
	console.log(`[GroupChat:Debug] Emitted moderator message to renderer`);

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
		console.log(
			`[GroupChatRouter] Added history entry for Moderator: ${summary.substring(0, 50)}...`
		);
	} catch (error) {
		console.error(`[GroupChatRouter] Failed to add history entry for Moderator:`, error);
		// Don't throw - history logging failure shouldn't break the message flow
	}

	// Extract ALL mentions from the message
	const allMentions = extractAllMentions(message);
	console.log(`[GroupChat:Debug] Extracted @mentions: ${allMentions.join(', ') || '(none)'}`);

	const existingParticipantNames = new Set(chat.participants.map((p) => p.name));
	console.log(
		`[GroupChat:Debug] Existing participants: ${Array.from(existingParticipantNames).join(', ') || '(none)'}`
	);

	// Check for mentions that aren't already participants but match available sessions
	if (processManager && getSessionsCallback) {
		const sessions = getSessionsCallback();
		console.log(
			`[GroupChat:Debug] Available sessions for auto-add: ${sessions.map((s) => s.name).join(', ')}`
		);

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
				try {
					// Use the original session name as the participant name
					const participantName = matchingSession.name;
					console.log(
						`[GroupChatRouter] Auto-adding participant @${participantName} from moderator mention @${mentionedName} (session ${matchingSession.id})`
					);
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
						// Pass session-specific overrides (customModel, customArgs, customEnvVars, sshRemoteName from session)
						{
							customModel: matchingSession.customModel,
							customArgs: matchingSession.customArgs,
							customEnvVars: matchingSession.customEnvVars,
							sshRemoteName: matchingSession.sshRemoteName,
						}
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
					console.error(
						`[GroupChatRouter] Failed to auto-add participant ${mentionedName}:`,
						error
					);
					// Continue with other participants even if one fails
				}
			}
		}
	}

	// Now extract mentions that are actual participants (including newly added ones)
	// Reload chat to get updated participants list
	const updatedChat = await loadGroupChat(groupChatId);
	if (!updatedChat) {
		console.log(`[GroupChat:Debug] WARNING: Could not reload chat after participant updates`);
		return;
	}

	const mentions = extractMentions(message, updatedChat.participants);
	console.log(
		`[GroupChat:Debug] Valid participant mentions found: ${mentions.join(', ') || '(none)'}`
	);

	// Track participants that will need to respond for synthesis round
	const participantsToRespond = new Set<string>();

	// Spawn batch processes for each mentioned participant
	if (processManager && agentDetector && mentions.length > 0) {
		console.log(`[GroupChat:Debug] ========== SPAWNING PARTICIPANT AGENTS ==========`);
		console.log(`[GroupChat:Debug] Will spawn ${mentions.length} participant agent(s)`);

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

		for (const participantName of mentions) {
			console.log(`[GroupChat:Debug] --- Spawning participant: @${participantName} ---`);

			// Find the participant info
			const participant = updatedChat.participants.find((p) => p.name === participantName);
			if (!participant) {
				console.warn(
					`[GroupChat:Debug] Participant ${participantName} not found in chat - skipping`
				);
				continue;
			}

			console.log(`[GroupChat:Debug] Participant agent ID: ${participant.agentId}`);

			// Find matching session to get cwd
			const matchingSession = sessions.find(
				(s) => mentionMatches(s.name, participantName) || s.name === participantName
			);
			const cwd = matchingSession?.cwd || process.env.HOME || '/tmp';
			console.log(`[GroupChat:Debug] CWD for participant: ${cwd}`);

			// Resolve agent configuration
			const agent = await agentDetector.getAgent(participant.agentId);
			console.log(
				`[GroupChat:Debug] Agent resolved: ${agent?.command || 'null'}, available: ${agent?.available ?? false}`
			);

			if (!agent || !agent.available) {
				console.error(
					`[GroupChat:Debug] ERROR: Agent '${participant.agentId}' not available for ${participantName}`
				);
				continue;
			}

			// Build the prompt with context for this participant
			// Uses template from src/prompts/group-chat-participant-request.md
			const readOnlyNote = readOnly
				? '\n\n**READ-ONLY MODE:** Do not make any file changes. Only analyze, review, or provide information.'
				: '';
			const readOnlyLabel = readOnly ? ' (READ-ONLY MODE)' : '';
			const readOnlyInstruction = readOnly
				? ' Remember: READ-ONLY mode is active, do not modify any files.'
				: ' If you need to perform any actions, do so and report your findings.';

			// Get the group chat folder path for file access permissions
			const groupChatFolder = getGroupChatDir(groupChatId);

			const participantPrompt = groupChatParticipantRequestPrompt
				.replace(/\{\{PARTICIPANT_NAME\}\}/g, participantName)
				.replace(/\{\{GROUP_CHAT_NAME\}\}/g, updatedChat.name)
				.replace(/\{\{READ_ONLY_NOTE\}\}/g, readOnlyNote)
				.replace(/\{\{GROUP_CHAT_FOLDER\}\}/g, groupChatFolder)
				.replace(/\{\{HISTORY_CONTEXT\}\}/g, historyContext)
				.replace(/\{\{READ_ONLY_LABEL\}\}/g, readOnlyLabel)
				.replace(/\{\{MESSAGE\}\}/g, message)
				.replace(/\{\{READ_ONLY_INSTRUCTION\}\}/g, readOnlyInstruction);

			// Create a unique session ID for this batch process
			const sessionId = `group-chat-${groupChatId}-participant-${participantName}-${Date.now()}`;
			console.log(`[GroupChat:Debug] Generated session ID: ${sessionId}`);

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
				console.log(`[GroupChat:Debug] Emitted participant state: working`);

				// Log spawn details for debugging
				const spawnCommand = agent.path || agent.command;
				const spawnArgs = configResolution.args;
				console.log(`[GroupChat:Debug] Spawn command: ${spawnCommand}`);
				console.log(`[GroupChat:Debug] Spawn args: ${JSON.stringify(spawnArgs)}`);
				console.log(
					`[GroupChat:Debug] Session customModel: ${matchingSession?.customModel || '(none)'}`
				);
				console.log(
					`[GroupChat:Debug] Config model source: ${configResolution.modelSource || 'unknown'}`
				);
				console.log(`[GroupChat:Debug] Prompt length: ${participantPrompt.length}`);
				console.log(
					`[GroupChat:Debug] CustomEnvVars: ${JSON.stringify(configResolution.effectiveCustomEnvVars || {})}`
				);

				const spawnResult = processManager.spawn({
					sessionId,
					toolType: participant.agentId,
					cwd,
					command: spawnCommand,
					args: spawnArgs,
					readOnlyMode: readOnly ?? false, // Propagate read-only mode from caller
					prompt: participantPrompt,
					contextWindow: getContextWindowValue(agent, agentConfigValues),
					customEnvVars:
						configResolution.effectiveCustomEnvVars ??
						getCustomEnvVarsCallback?.(participant.agentId),
					promptArgs: agent.promptArgs,
					noPromptSeparator: agent.noPromptSeparator,
				});

				console.log(
					`[GroupChat:Debug] Spawn result for ${participantName}: ${JSON.stringify(spawnResult)}`
				);
				console.log(`[GroupChat:Debug] promptArgs: ${agent.promptArgs ? 'defined' : 'undefined'}`);
				console.log(`[GroupChat:Debug] noPromptSeparator: ${agent.noPromptSeparator ?? false}`);

				// Track this participant as pending response
				participantsToRespond.add(participantName);
				console.log(
					`[GroupChat:Debug] Spawned batch process for participant @${participantName} (session ${sessionId}, readOnly=${readOnly ?? false})`
				);
			} catch (error) {
				console.error(`[GroupChat:Debug] SPAWN ERROR for ${participantName}:`, error);
				// Continue with other participants even if one fails
			}
		}
		console.log(`[GroupChat:Debug] =================================================`);
	} else if (mentions.length === 0) {
		console.log(`[GroupChat:Debug] No participant @mentions found - moderator response is final`);
		// Set state back to idle since no agents are being spawned
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		console.log(`[GroupChat:Debug] Emitted state change: idle`);
		// Remove power block reason since round is complete
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
	}

	// Store pending participants for synthesis tracking
	if (participantsToRespond.size > 0) {
		pendingParticipantResponses.set(groupChatId, participantsToRespond);
		console.log(
			`[GroupChat:Debug] Waiting for ${participantsToRespond.size} participant(s) to respond: ${[...participantsToRespond].join(', ')}`
		);
		// Set state to show agents are working
		groupChatEmitters.emitStateChange?.(groupChatId, 'agent-working');
		console.log(`[GroupChat:Debug] Emitted state change: agent-working`);
	}
	console.log(`[GroupChat:Debug] ===================================================`);
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
	console.log(`[GroupChat:Debug] ========== ROUTE AGENT RESPONSE ==========`);
	console.log(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
	console.log(`[GroupChat:Debug] Participant: ${participantName}`);
	console.log(`[GroupChat:Debug] Message length: ${message.length}`);
	console.log(
		`[GroupChat:Debug] Message preview: "${message.substring(0, 200)}${message.length > 200 ? '...' : ''}"`
	);

	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		console.log(`[GroupChat:Debug] ERROR: Group chat not found!`);
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	// Verify participant exists
	const participant = chat.participants.find((p) => p.name === participantName);
	if (!participant) {
		console.log(`[GroupChat:Debug] ERROR: Participant '${participantName}' not found!`);
		throw new Error(`Participant '${participantName}' not found in group chat`);
	}

	console.log(
		`[GroupChat:Debug] Participant verified: ${participantName} (agent: ${participant.agentId})`
	);

	// Log the message as coming from the participant
	await appendToLog(chat.logPath, participantName, message);
	console.log(`[GroupChat:Debug] Message appended to log`);

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
		console.error(
			`[GroupChatRouter] Failed to update participant stats for ${participantName}:`,
			error
		);
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
		console.log(
			`[GroupChatRouter] Added history entry for ${participantName}: ${summary.substring(0, 50)}...`
		);
	} catch (error) {
		console.error(`[GroupChatRouter] Failed to add history entry for ${participantName}:`, error);
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
	console.log(`[GroupChat:Debug] ========== SPAWN MODERATOR SYNTHESIS ==========`);
	console.log(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
	console.log(`[GroupChat:Debug] All participants have responded, starting synthesis round...`);

	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		console.error(`[GroupChat:Debug] ERROR: Chat not found for synthesis!`);
		console.error(`[GroupChatRouter] Cannot spawn synthesis - chat not found: ${groupChatId}`);
		return;
	}

	console.log(`[GroupChat:Debug] Chat loaded: "${chat.name}"`);

	if (!isModeratorActive(groupChatId)) {
		console.error(`[GroupChat:Debug] ERROR: Moderator not active for synthesis!`);
		console.error(
			`[GroupChatRouter] Cannot spawn synthesis - moderator not active for: ${groupChatId}`
		);
		return;
	}

	const sessionIdPrefix = getModeratorSessionId(groupChatId);
	console.log(`[GroupChat:Debug] Session ID prefix: ${sessionIdPrefix}`);

	if (!sessionIdPrefix) {
		console.error(`[GroupChat:Debug] ERROR: No session ID prefix for synthesis!`);
		console.error(
			`[GroupChatRouter] Cannot spawn synthesis - no moderator session ID for: ${groupChatId}`
		);
		return;
	}

	// Create a unique session ID for this synthesis round
	// Note: We use the regular moderator session ID format (no -synthesis- marker)
	// so the exit handler routes through routeModeratorResponse, which will
	// check for @mentions - if present, route to agents; if not, it's the final response
	const sessionId = `${sessionIdPrefix}-${Date.now()}`;
	console.log(`[GroupChat:Debug] Generated synthesis session ID: ${sessionId}`);

	// Resolve the agent configuration
	const agent = await agentDetector.getAgent(chat.moderatorAgentId);
	console.log(
		`[GroupChat:Debug] Agent resolved: ${agent?.command || 'null'}, available: ${agent?.available ?? false}`
	);

	if (!agent || !agent.available) {
		console.error(`[GroupChat:Debug] ERROR: Agent not available for synthesis!`);
		console.error(
			`[GroupChatRouter] Agent '${chat.moderatorAgentId}' is not available for synthesis`
		);
		return;
	}

	// Use custom path from moderator config if set
	const command = chat.moderatorConfig?.customPath || agent.path || agent.command;
	console.log(`[GroupChat:Debug] Command: ${command}`);

	const args = [...agent.args];
	// Build the synthesis prompt with recent chat history
	const chatHistory = await readLog(chat.logPath);
	console.log(`[GroupChat:Debug] Chat history entries for synthesis: ${chatHistory.length}`);

	const historyContext = chatHistory
		.slice(-30)
		.map((m) => `[${m.from}]: ${m.content}`)
		.join('\n');

	// Build participant context for potential follow-up @mentions
	const participantContext =
		chat.participants.length > 0
			? chat.participants.map((p) => `- @${p.name} (${p.agentId} session)`).join('\n')
			: '(No agents currently in this group chat)';

	const synthesisPrompt = `${getModeratorSystemPrompt()}

${getModeratorSynthesisPrompt()}

## Current Participants (you can @mention these for follow-up):
${participantContext}

## Recent Chat History (including participant responses):
${historyContext}

## Your Task:
Review the agent responses above. Either:
1. Synthesize into a final answer for the user (NO @mentions) if the question is fully answered
2. @mention specific agents for follow-up if you need more information`;

	const agentConfigValues = getAgentConfigCallback?.(chat.moderatorAgentId) || {};
	const baseArgs = buildAgentArgs(agent, {
		baseArgs: args,
		prompt: synthesisPrompt,
		cwd: process.env.HOME || '/tmp',
		readOnlyMode: true,
	});
	const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
		agentConfigValues,
		sessionCustomArgs: chat.moderatorConfig?.customArgs,
		sessionCustomEnvVars: chat.moderatorConfig?.customEnvVars,
	});
	const finalArgs = configResolution.args;
	console.log(`[GroupChat:Debug] Args: ${JSON.stringify(finalArgs)}`);

	console.log(`[GroupChat:Debug] Synthesis prompt length: ${synthesisPrompt.length} chars`);

	// Spawn the synthesis process
	try {
		console.log(`[GroupChat:Debug] Spawning synthesis moderator process...`);
		// Emit state change to show moderator is thinking (synthesizing)
		groupChatEmitters.emitStateChange?.(groupChatId, 'moderator-thinking');
		console.log(`[GroupChat:Debug] Emitted state change: moderator-thinking`);

		const spawnResult = processManager.spawn({
			sessionId,
			toolType: chat.moderatorAgentId,
			cwd: process.env.HOME || '/tmp',
			command,
			args: finalArgs,
			readOnlyMode: true,
			prompt: synthesisPrompt,
			contextWindow: getContextWindowValue(agent, agentConfigValues),
			customEnvVars:
				configResolution.effectiveCustomEnvVars ??
				getCustomEnvVarsCallback?.(chat.moderatorAgentId),
			promptArgs: agent.promptArgs,
			noPromptSeparator: agent.noPromptSeparator,
		});

		console.log(`[GroupChat:Debug] Synthesis spawn result: ${JSON.stringify(spawnResult)}`);
		console.log(`[GroupChat:Debug] Synthesis moderator process spawned successfully`);
		console.log(`[GroupChat:Debug] promptArgs: ${agent.promptArgs ? 'defined' : 'undefined'}`);
		console.log(`[GroupChat:Debug] noPromptSeparator: ${agent.noPromptSeparator ?? false}`);
		console.log(`[GroupChat:Debug] ================================================`);
	} catch (error) {
		console.error(`[GroupChat:Debug] SYNTHESIS SPAWN ERROR:`, error);
		console.error(
			`[GroupChatRouter] Failed to spawn moderator synthesis for ${groupChatId}:`,
			error
		);
		groupChatEmitters.emitStateChange?.(groupChatId, 'idle');
		// Remove power block reason on synthesis error since we're going idle
		powerManager.removeBlockReason(`groupchat:${groupChatId}`);
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
	console.log(`[GroupChat:Debug] ========== RESPAWN WITH RECOVERY ==========`);
	console.log(`[GroupChat:Debug] Group Chat: ${groupChatId}`);
	console.log(`[GroupChat:Debug] Participant: ${participantName}`);

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
		throw new Error(`Agent not available: ${participant.agentId}`);
	}

	// Build recovery context with the agent's prior statements
	const recoveryContext = await buildRecoveryContext(groupChatId, participantName, 30);
	console.log(`[GroupChat:Debug] Recovery context length: ${recoveryContext.length}`);

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
	const cwd = matchingSession?.cwd || process.env.HOME || '/tmp';

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
	console.log(`[GroupChat:Debug] Full recovery prompt length: ${fullPrompt.length}`);

	// Create a unique session ID for this recovery spawn
	const sessionId = `group-chat-${groupChatId}-participant-${participantName}-recovery-${Date.now()}`;
	console.log(`[GroupChat:Debug] Recovery session ID: ${sessionId}`);

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

	// Spawn the recovery process
	const spawnCommand = agent.path || agent.command;
	console.log(`[GroupChat:Debug] Recovery spawn command: ${spawnCommand}`);
	console.log(`[GroupChat:Debug] Recovery spawn args count: ${configResolution.args.length}`);

	const spawnResult = processManager.spawn({
		sessionId,
		toolType: participant.agentId,
		cwd,
		command: spawnCommand,
		args: configResolution.args,
		readOnlyMode: readOnly ?? false,
		prompt: fullPrompt,
		contextWindow: getContextWindowValue(agent, agentConfigValues),
		customEnvVars:
			configResolution.effectiveCustomEnvVars ?? getCustomEnvVarsCallback?.(participant.agentId),
		promptArgs: agent.promptArgs,
		noPromptSeparator: agent.noPromptSeparator,
	});

	console.log(`[GroupChat:Debug] Recovery spawn result: ${JSON.stringify(spawnResult)}`);
	console.log(`[GroupChat:Debug] promptArgs: ${agent.promptArgs ? 'defined' : 'undefined'}`);
	console.log(`[GroupChat:Debug] =============================================`);
}
