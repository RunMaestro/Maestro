/**
 * @file group-chat-agent.ts
 * @description Participant (agent) management for Group Chat feature.
 *
 * Participants are AI agents that work together in a group chat:
 * - Each participant has a unique name within the chat
 * - Participants receive messages from the moderator
 * - Participants can collaborate by referencing the shared chat log
 */

import { v4 as uuidv4 } from 'uuid';
import {
	GroupChatParticipant,
	loadGroupChat,
	addParticipantToChat,
	removeParticipantFromChat,
	getParticipant,
} from './group-chat-storage';
import { appendToLog } from './group-chat-log';
import { IProcessManager, isModeratorActive } from './group-chat-moderator';
import type { AgentDetector } from '../agent-detector';
import {
	buildAgentArgs,
	applyAgentConfigOverrides,
	getContextWindowValue,
} from '../utils/agent-args';
import { groupChatParticipantPrompt } from '../../prompts';

/**
 * In-memory store for active participant sessions.
 * Maps `${groupChatId}:${participantName}` -> sessionId
 */
const activeParticipantSessions = new Map<string, string>();

/**
 * Generate a key for the participant sessions map.
 */
function getParticipantKey(groupChatId: string, participantName: string): string {
	return `${groupChatId}:${participantName}`;
}

/**
 * Generate the system prompt for a participant.
 * Uses template from src/prompts/group-chat-participant.md
 */
export function getParticipantSystemPrompt(
	participantName: string,
	groupChatName: string,
	logPath: string
): string {
	return groupChatParticipantPrompt
		.replace(/\{\{GROUP_CHAT_NAME\}\}/g, groupChatName)
		.replace(/\{\{PARTICIPANT_NAME\}\}/g, participantName)
		.replace(/\{\{LOG_PATH\}\}/g, logPath);
}

/**
 * Session-specific overrides for participant agent configuration.
 */
export interface SessionOverrides {
	customModel?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	/** SSH remote name for display in participant card */
	sshRemoteName?: string;
}

/**
 * Adds a participant to a group chat and spawns their agent session.
 *
 * @param groupChatId - The ID of the group chat
 * @param name - The participant's name (must be unique within the chat)
 * @param agentId - The agent type to use (e.g., 'claude-code')
 * @param processManager - The process manager to use for spawning
 * @param cwd - Working directory for the agent (defaults to home directory)
 * @param agentDetector - Optional agent detector for resolving agent paths
 * @param agentConfigValues - Optional agent config values (from config store)
 * @param customEnvVars - Optional custom environment variables for the agent (deprecated, use sessionOverrides)
 * @param sessionOverrides - Optional session-specific overrides (customModel, customArgs, customEnvVars)
 * @returns The created participant
 */
export async function addParticipant(
	groupChatId: string,
	name: string,
	agentId: string,
	processManager: IProcessManager,
	cwd: string = process.env.HOME || '/tmp',
	agentDetector?: AgentDetector,
	agentConfigValues?: Record<string, any>,
	customEnvVars?: Record<string, string>,
	sessionOverrides?: SessionOverrides
): Promise<GroupChatParticipant> {
	console.log(`[GroupChat:Debug] ========== ADD PARTICIPANT ==========`);
	console.log(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
	console.log(`[GroupChat:Debug] Participant Name: ${name}`);
	console.log(`[GroupChat:Debug] Agent ID: ${agentId}`);
	console.log(`[GroupChat:Debug] CWD: ${cwd}`);

	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		console.log(`[GroupChat:Debug] ERROR: Group chat not found!`);
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	console.log(`[GroupChat:Debug] Chat loaded: "${chat.name}"`);

	// Check if moderator is active
	if (!isModeratorActive(groupChatId)) {
		console.log(`[GroupChat:Debug] ERROR: Moderator not active!`);
		throw new Error(
			`Moderator must be active before adding participants to group chat: ${groupChatId}`
		);
	}

	console.log(`[GroupChat:Debug] Moderator is active: true`);

	// Check for duplicate name
	if (chat.participants.some((p) => p.name === name)) {
		console.log(`[GroupChat:Debug] ERROR: Duplicate participant name!`);
		throw new Error(`Participant with name '${name}' already exists in group chat`);
	}

	// Resolve the agent configuration to get the executable command
	let command = agentId;
	let args: string[] = [];
	let agentConfig: Awaited<ReturnType<AgentDetector['getAgent']>> | null = null;

	if (agentDetector) {
		agentConfig = await agentDetector.getAgent(agentId);
		console.log(
			`[GroupChat:Debug] Agent resolved: ${agentConfig?.command || 'null'}, available: ${agentConfig?.available ?? false}`
		);
		if (!agentConfig || !agentConfig.available) {
			console.log(`[GroupChat:Debug] ERROR: Agent not available!`);
			throw new Error(`Agent '${agentId}' is not available`);
		}
		command = agentConfig.path || agentConfig.command;
		args = [...agentConfig.args];
	}

	const prompt = getParticipantSystemPrompt(name, chat.name, chat.logPath);
	// Note: Don't pass modelId to buildAgentArgs - it will be handled by applyAgentConfigOverrides
	// via sessionCustomModel to avoid duplicate --model args
	const baseArgs = buildAgentArgs(agentConfig, {
		baseArgs: args,
		prompt,
		cwd,
		readOnlyMode: false,
	});
	// Merge customEnvVars with sessionOverrides.customEnvVars (sessionOverrides takes precedence)
	const effectiveEnvVars = sessionOverrides?.customEnvVars ?? customEnvVars;
	const configResolution = applyAgentConfigOverrides(agentConfig, baseArgs, {
		agentConfigValues: agentConfigValues || {},
		sessionCustomModel: sessionOverrides?.customModel,
		sessionCustomArgs: sessionOverrides?.customArgs,
		sessionCustomEnvVars: effectiveEnvVars,
	});

	console.log(`[GroupChat:Debug] Command: ${command}`);
	console.log(`[GroupChat:Debug] Args: ${JSON.stringify(configResolution.args)}`);

	// Generate session ID for this participant
	const sessionId = `group-chat-${groupChatId}-participant-${name}-${uuidv4()}`;
	console.log(`[GroupChat:Debug] Generated session ID: ${sessionId}`);

	// Spawn the participant agent
	console.log(`[GroupChat:Debug] Spawning participant agent...`);
	const result = processManager.spawn({
		sessionId,
		toolType: agentId,
		cwd,
		command,
		args: configResolution.args,
		readOnlyMode: false, // Participants can make changes
		prompt,
		contextWindow: getContextWindowValue(agentConfig, agentConfigValues || {}),
		customEnvVars: configResolution.effectiveCustomEnvVars ?? effectiveEnvVars,
		promptArgs: agentConfig?.promptArgs,
		noPromptSeparator: agentConfig?.noPromptSeparator,
	});

	console.log(`[GroupChat:Debug] Spawn result: ${JSON.stringify(result)}`);
	console.log(`[GroupChat:Debug] promptArgs: ${agentConfig?.promptArgs ? 'defined' : 'undefined'}`);
	console.log(`[GroupChat:Debug] noPromptSeparator: ${agentConfig?.noPromptSeparator ?? false}`);

	if (!result.success) {
		console.log(`[GroupChat:Debug] ERROR: Spawn failed!`);
		throw new Error(`Failed to spawn participant '${name}' for group chat ${groupChatId}`);
	}

	// Create participant record
	const participant: GroupChatParticipant = {
		name,
		agentId,
		sessionId,
		addedAt: Date.now(),
		sshRemoteName: sessionOverrides?.sshRemoteName,
	};

	// Store the session mapping
	activeParticipantSessions.set(getParticipantKey(groupChatId, name), sessionId);
	console.log(`[GroupChat:Debug] Session stored in active map`);

	// Add participant to the group chat
	await addParticipantToChat(groupChatId, participant);
	console.log(`[GroupChat:Debug] Participant added to chat storage`);
	console.log(`[GroupChat:Debug] =====================================`);

	return participant;
}

/**
 * Sends a message to a specific participant in a group chat.
 *
 * @param groupChatId - The ID of the group chat
 * @param participantName - The name of the participant
 * @param message - The message to send
 * @param processManager - The process manager (optional)
 */
export async function sendToParticipant(
	groupChatId: string,
	participantName: string,
	message: string,
	processManager?: IProcessManager
): Promise<void> {
	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	// Find the participant
	const participant = await getParticipant(groupChatId, participantName);
	if (!participant) {
		throw new Error(`Participant '${participantName}' not found in group chat`);
	}

	// Get the session ID
	const sessionId = activeParticipantSessions.get(getParticipantKey(groupChatId, participantName));
	if (!sessionId && processManager) {
		throw new Error(`No active session for participant '${participantName}'`);
	}

	// Log the message as coming from the moderator to this participant
	await appendToLog(chat.logPath, `moderator->${participantName}`, message);

	// Send to the participant's session if process manager is provided
	if (processManager && sessionId) {
		processManager.write(sessionId, message + '\n');
	}
}

/**
 * Removes a participant from a group chat and kills their session.
 *
 * @param groupChatId - The ID of the group chat
 * @param participantName - The name of the participant to remove
 * @param processManager - The process manager (optional, for killing the process)
 */
export async function removeParticipant(
	groupChatId: string,
	participantName: string,
	processManager?: IProcessManager
): Promise<void> {
	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	// Find the participant to get session info before removal
	const participant = await getParticipant(groupChatId, participantName);
	if (!participant) {
		throw new Error(`Participant '${participantName}' not found in group chat`);
	}

	// Get the session ID from our active sessions map
	const key = getParticipantKey(groupChatId, participantName);
	const sessionId = activeParticipantSessions.get(key);

	// Kill the session if process manager provided and session exists
	if (processManager && sessionId) {
		processManager.kill(sessionId);
	}

	// Remove from active sessions
	activeParticipantSessions.delete(key);

	// Remove from group chat
	await removeParticipantFromChat(groupChatId, participantName);
}

/**
 * Gets the session ID for a participant.
 *
 * @param groupChatId - The ID of the group chat
 * @param participantName - The name of the participant
 * @returns The session ID, or undefined if not active
 */
export function getParticipantSessionId(
	groupChatId: string,
	participantName: string
): string | undefined {
	return activeParticipantSessions.get(getParticipantKey(groupChatId, participantName));
}

/**
 * Checks if a participant is currently active.
 *
 * @param groupChatId - The ID of the group chat
 * @param participantName - The name of the participant
 * @returns True if the participant is active
 */
export function isParticipantActive(groupChatId: string, participantName: string): boolean {
	return activeParticipantSessions.has(getParticipantKey(groupChatId, participantName));
}

/**
 * Gets all active participants for a group chat.
 *
 * @param groupChatId - The ID of the group chat
 * @returns Array of participant names that are currently active
 */
export function getActiveParticipants(groupChatId: string): string[] {
	const prefix = `${groupChatId}:`;
	const participants: string[] = [];

	for (const key of activeParticipantSessions.keys()) {
		if (key.startsWith(prefix)) {
			participants.push(key.slice(prefix.length));
		}
	}

	return participants;
}

/**
 * Clears all active participant sessions for a group chat.
 *
 * @param groupChatId - The ID of the group chat
 * @param processManager - The process manager (optional, for killing processes)
 */
export async function clearAllParticipantSessions(
	groupChatId: string,
	processManager?: IProcessManager
): Promise<void> {
	const prefix = `${groupChatId}:`;
	const keysToDelete: string[] = [];

	for (const [key, sessionId] of activeParticipantSessions.entries()) {
		if (key.startsWith(prefix)) {
			if (processManager) {
				processManager.kill(sessionId);
			}
			keysToDelete.push(key);
		}
	}

	for (const key of keysToDelete) {
		activeParticipantSessions.delete(key);
	}
}

/**
 * Clears ALL active participant sessions (all group chats).
 * Useful for cleanup during shutdown or testing.
 */
export function clearAllParticipantSessionsGlobal(): void {
	activeParticipantSessions.clear();
}
