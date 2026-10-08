/**
 * @file group-chat-agent.ts
 * @description Participant (agent) management for Group Chat feature.
 *
 * Participants are AI agents that work together in a group chat:
 * - Each participant has a unique name within the chat
 * - Participants receive messages from the moderator
 * - Participants can collaborate by referencing the shared chat log
 *
 * Participants are registered up front, but their actual work runs in
 * one-shot task processes spawned by the router for each moderator handoff.
 */

import { v4 as uuidv4 } from 'uuid';
import {
	GroupChatParticipant,
	loadGroupChat,
	addParticipantToChat,
	removeParticipantFromChatWithResult,
	getParticipant,
	type ParticipantRemovalResult,
} from './group-chat-storage';
import { appendToLog } from './group-chat-log';
import { IProcessManager, isModeratorActive } from './group-chat-moderator';
import { getPrompt } from '../prompt-manager';
import { logger } from '../utils/logger';

/**
 * In-memory store for active participant sessions.
 * Maps `${groupChatId}:${participantName}` -> currently running task sessionId
 */
const activeParticipantSessions = new Map<string, string>();

/**
 * Generate a key for the participant sessions map.
 */
function getParticipantKey(groupChatId: string, participantName: string): string {
	return `${groupChatId}:${participantName}`;
}

/**
 * Participants the user has explicitly removed this session, keyed like
 * activeParticipantSessions. The moderator's turn-completion handler auto-adds
 * any @mentioned session that isn't currently a participant. Without this
 * guard, a moderator turn that was already in flight when the user removed a
 * participant would re-add them the moment it finished (and its output almost
 * always @mentions that participant), silently reverting the removal on disk.
 * The race window is wider the larger the chat - long moderator turns and a
 * removed participant that is more likely to be mentioned - which is why the
 * removal appeared not to persist in large group chats (issue #1100). The
 * entry is cleared once the participant is added back through any path.
 */
const recentlyRemovedParticipants = new Set<string>();

/**
 * Record that the user explicitly removed a participant so an in-flight or
 * subsequent moderator turn cannot auto-add them before the user re-adds them.
 */
export function markParticipantRemoved(groupChatId: string, participantName: string): void {
	recentlyRemovedParticipants.add(getParticipantKey(groupChatId, participantName));
}

/**
 * Whether the user explicitly removed this participant and has not re-added them.
 */
export function wasParticipantRecentlyRemoved(
	groupChatId: string,
	participantName: string
): boolean {
	return recentlyRemovedParticipants.has(getParticipantKey(groupChatId, participantName));
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
	return getPrompt('group-chat-participant')
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
	/** Full SSH remote config for remote execution */
	sshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
}

/**
 * Adds a participant to a group chat.
 *
 * @param groupChatId - The ID of the group chat
 * @param name - The participant's name (must be unique within the chat)
 * @param agentId - The agent type to use (e.g., 'claude-code')
 * @param processManager - Unused, kept for API compatibility with existing call sites
 * @returns The created participant
 */
export async function addParticipant(
	groupChatId: string,
	name: string,
	agentId: string,
	_processManager: IProcessManager,
	_cwd?: string,
	_agentDetector?: unknown,
	_agentConfigValues?: Record<string, any>,
	_customEnvVars?: Record<string, string>,
	sessionOverrides?: SessionOverrides,
	_sshStore?: unknown
): Promise<GroupChatParticipant> {
	logger.debug(`[GroupChat:Debug] ========== ADD PARTICIPANT ==========`);
	logger.debug(`[GroupChat:Debug] Group Chat ID: ${groupChatId}`);
	logger.debug(`[GroupChat:Debug] Participant Name: ${name}`);
	logger.debug(`[GroupChat:Debug] Agent ID: ${agentId}`);

	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		logger.debug(`[GroupChat:Debug] ERROR: Group chat not found!`);
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	logger.debug(`[GroupChat:Debug] Chat loaded: "${chat.name}"`);

	// Check if moderator is active
	if (!isModeratorActive(groupChatId)) {
		logger.debug(`[GroupChat:Debug] ERROR: Moderator not active!`);
		throw new Error(
			`Moderator must be active before adding participants to group chat: ${groupChatId}`
		);
	}

	logger.debug(`[GroupChat:Debug] Moderator is active: true`);

	// Idempotent: if participant already exists, return it without spawning a new process
	const existingParticipant = chat.participants.find((p) => p.name === name);
	if (existingParticipant) {
		logger.debug(`[GroupChat:Debug] Participant '${name}' already exists, returning existing`);
		return existingParticipant;
	}

	// Generate a stable participant record ID. Actual task runs use separate
	// batch session IDs created by the router per moderator handoff.
	const sessionId = `group-chat-${groupChatId}-participant-${name}-${uuidv4()}`;
	logger.debug(`[GroupChat:Debug] Generated participant record ID: ${sessionId}`);

	// Create participant record
	const participant: GroupChatParticipant = {
		name,
		agentId,
		sessionId,
		addedAt: Date.now(),
		sshRemoteName: sessionOverrides?.sshRemoteName,
	};

	// Add participant to the group chat
	await addParticipantToChat(groupChatId, participant);
	// The participant is a member again, so drop any removal guard. This keeps
	// the guard from going stale and lets an explicit re-add (or a user @mention)
	// override an earlier removal. The moderator auto-add path checks the guard
	// before it ever reaches here, so this cannot defeat that block.
	recentlyRemovedParticipants.delete(getParticipantKey(groupChatId, name));
	logger.debug(`[GroupChat:Debug] Participant added to chat storage`);
	logger.debug(`[GroupChat:Debug] =====================================`);

	return participant;
}

/**
 * Tracks the currently running task session for a participant.
 */
export function setActiveParticipantSession(
	groupChatId: string,
	participantName: string,
	sessionId: string
): void {
	activeParticipantSessions.set(getParticipantKey(groupChatId, participantName), sessionId);
}

/**
 * Clears the currently running task session for a participant.
 */
export function clearActiveParticipantSession(groupChatId: string, participantName: string): void {
	activeParticipantSessions.delete(getParticipantKey(groupChatId, participantName));
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
 * @returns The persisted removal result, or null if the chat no longer exists
 */
export async function removeParticipant(
	groupChatId: string,
	participantName: string,
	processManager?: IProcessManager
): Promise<ParticipantRemovalResult | null> {
	// Removal is idempotent: the UI may fire this for a stale participant that was
	// already removed (e.g. a duplicate click, or removal via another code path).
	// Treat chat-missing and participant-missing as no-ops rather than throwing.
	const chat = await loadGroupChat(groupChatId);
	if (!chat) return null;

	// Get the session ID from our active sessions map
	const key = getParticipantKey(groupChatId, participantName);
	const sessionId = activeParticipantSessions.get(key);

	// Kill the session if process manager provided and session exists
	if (processManager && sessionId) {
		processManager.kill(sessionId);
	}

	// Remove from active sessions
	activeParticipantSessions.delete(key);

	// Remove from group chat and return the persisted state to callers.
	// The pre-check above and this write run under separate awaits, so the chat
	// can disappear in between (the storage helper reloads and throws if so).
	// Preserve the idempotent "chat-missing is a no-op" contract rather than
	// leaking that race to IPC callers.
	try {
		const result = await removeParticipantFromChatWithResult(groupChatId, participantName);
		// Guard against the moderator's turn-completion auto-add re-adding this
		// participant before the user re-adds them (issue #1100).
		markParticipantRemoved(groupChatId, participantName);
		return result;
	} catch (error) {
		if (error instanceof Error && error.message === `Group chat not found: ${groupChatId}`) {
			return null;
		}
		throw error;
	}
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
