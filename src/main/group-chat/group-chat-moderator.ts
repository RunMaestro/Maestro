/**
 * @file group-chat-moderator.ts
 * @description Moderator management for Group Chat feature.
 *
 * The moderator is an AI agent that coordinates the group chat:
 * - Spawned in read-only mode to prevent unintended modifications
 * - Receives messages from users and dispatches to participants
 * - Aggregates responses and maintains conversation flow
 */

import { GroupChat, loadGroupChat, updateGroupChat } from './group-chat-storage';
import { appendToLog, readLog } from './group-chat-log';
import { groupChatModeratorSystemPrompt, groupChatModeratorSynthesisPrompt } from '../../prompts';
import { powerManager } from '../power-manager';

/**
 * Interface for the process manager dependency.
 * This allows for easy mocking in tests.
 */
export interface IProcessManager {
	spawn(config: {
		sessionId: string;
		toolType: string;
		cwd: string;
		command: string;
		args: string[];
		readOnlyMode?: boolean;
		prompt?: string;
		customEnvVars?: Record<string, string>;
		contextWindow?: number;
		promptArgs?: (prompt: string) => string[];
		noPromptSeparator?: boolean;
	}): { pid: number; success: boolean };

	write(sessionId: string, data: string): boolean;

	kill(sessionId: string): boolean;
}

/**
 * In-memory store for active moderator sessions.
 * Maps groupChatId -> sessionId
 */
const activeModeratorSessions = new Map<string, string>();

/**
 * Stale session threshold in milliseconds (30 minutes).
 * Sessions older than this are considered stale and will be cleaned up.
 */
const STALE_SESSION_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Tracks last activity time for each moderator session.
 * Maps groupChatId -> timestamp
 */
const sessionActivityTimestamps = new Map<string, number>();

/**
 * Cleanup interval reference for clearing on shutdown.
 */
let cleanupIntervalId: NodeJS.Timeout | null = null;

/**
 * Starts periodic cleanup of stale moderator sessions.
 * Should be called once during application initialization.
 */
export function startSessionCleanup(): void {
	if (cleanupIntervalId) return; // Already running

	// Run cleanup every 10 minutes
	cleanupIntervalId = setInterval(
		() => {
			const now = Date.now();
			const staleIds: string[] = [];

			for (const [groupChatId, timestamp] of sessionActivityTimestamps) {
				if (now - timestamp > STALE_SESSION_THRESHOLD_MS) {
					staleIds.push(groupChatId);
				}
			}

			for (const id of staleIds) {
				activeModeratorSessions.delete(id);
				sessionActivityTimestamps.delete(id);
			}

			if (staleIds.length > 0) {
				console.log(`[GroupChatModerator] Cleaned up ${staleIds.length} stale session(s)`);
			}
		},
		10 * 60 * 1000
	);
}

/**
 * Stops the periodic session cleanup.
 * Should be called during application shutdown.
 */
export function stopSessionCleanup(): void {
	if (cleanupIntervalId) {
		clearInterval(cleanupIntervalId);
		cleanupIntervalId = null;
	}
}

/**
 * Updates the activity timestamp for a moderator session.
 * Call this when the session is actively used.
 */
function touchSession(groupChatId: string): void {
	sessionActivityTimestamps.set(groupChatId, Date.now());
}

/**
 * Gets the base system prompt for the moderator.
 * This is combined with participant info and chat history in routeUserMessage.
 * Loaded from src/prompts/group-chat-moderator-system.md
 */
export function getModeratorSystemPrompt(): string {
	return groupChatModeratorSystemPrompt;
}

/**
 * Gets the synthesis prompt for the moderator when reviewing agent responses.
 * The moderator decides whether to continue with agents or return to the user.
 * Loaded from src/prompts/group-chat-moderator-synthesis.md
 */
export function getModeratorSynthesisPrompt(): string {
	return groupChatModeratorSynthesisPrompt;
}

/**
 * Spawns a moderator agent for a group chat.
 *
 * Note: This function is now only used for initial setup and storing the session mapping.
 * The actual moderator process is spawned per-message in batch mode (see routeUserMessage).
 *
 * @param chat - The group chat to spawn a moderator for
 * @param processManager - The process manager (not used for spawning, kept for API compatibility)
 * @param cwd - Working directory for the moderator (defaults to home directory)
 * @returns The session ID prefix that will be used for moderator messages
 */
export async function spawnModerator(
	chat: GroupChat,
	_processManager: IProcessManager,
	_cwd: string = process.env.HOME || '/tmp'
): Promise<string> {
	console.log(`[GroupChat:Debug] ========== SPAWNING MODERATOR ==========`);
	console.log(`[GroupChat:Debug] Chat ID: ${chat.id}`);
	console.log(`[GroupChat:Debug] Chat Name: ${chat.name}`);
	console.log(`[GroupChat:Debug] Moderator Agent ID: ${chat.moderatorAgentId}`);

	// Generate a session ID prefix for this group chat's moderator
	// Each message will use this prefix with a timestamp suffix
	const sessionIdPrefix = `group-chat-${chat.id}-moderator`;

	console.log(`[GroupChat:Debug] Generated session ID prefix: ${sessionIdPrefix}`);

	// Store the session mapping (using prefix as identifier)
	activeModeratorSessions.set(chat.id, sessionIdPrefix);

	// Track session activity for cleanup
	touchSession(chat.id);

	// Update the group chat with the moderator session ID prefix
	await updateGroupChat(chat.id, { moderatorSessionId: sessionIdPrefix });

	console.log(`[GroupChat:Debug] Moderator initialized and stored in active sessions`);
	console.log(`[GroupChat:Debug] Active moderator sessions count: ${activeModeratorSessions.size}`);
	console.log(`[GroupChat:Debug] ==========================================`);

	return sessionIdPrefix;
}

/**
 * Sends a message to the moderator and logs it.
 *
 * @param groupChatId - The ID of the group chat
 * @param message - The message to send
 * @param processManager - The process manager (optional, for sending to agent)
 */
export async function sendToModerator(
	groupChatId: string,
	message: string,
	processManager?: IProcessManager
): Promise<void> {
	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	// Log the message
	await appendToLog(chat.logPath, 'user', message);

	// Update session activity
	touchSession(groupChatId);

	// If process manager is provided, also send to the moderator session
	if (processManager) {
		const sessionId = activeModeratorSessions.get(groupChatId);
		if (sessionId) {
			processManager.write(sessionId, message + '\n');
		}
	}
}

/**
 * Kills the moderator session for a group chat.
 *
 * @param groupChatId - The ID of the group chat
 * @param processManager - The process manager (optional, for killing the process)
 */
export async function killModerator(
	groupChatId: string,
	processManager?: IProcessManager
): Promise<void> {
	const sessionId = activeModeratorSessions.get(groupChatId);

	if (sessionId && processManager) {
		processManager.kill(sessionId);
	}

	activeModeratorSessions.delete(groupChatId);
	sessionActivityTimestamps.delete(groupChatId);

	// Remove power block reason when moderator is killed
	powerManager.removeBlockReason(`groupchat:${groupChatId}`);

	// Clear the session ID in storage
	try {
		await updateGroupChat(groupChatId, { moderatorSessionId: '' });
	} catch {
		// Chat may already be deleted
	}
}

/**
 * Gets the moderator session ID for a group chat.
 *
 * @param groupChatId - The ID of the group chat
 * @returns The session ID, or undefined if no moderator is active
 */
export function getModeratorSessionId(groupChatId: string): string | undefined {
	return activeModeratorSessions.get(groupChatId);
}

/**
 * Checks if a moderator is currently active for a group chat.
 *
 * @param groupChatId - The ID of the group chat
 * @returns True if a moderator is active
 */
export function isModeratorActive(groupChatId: string): boolean {
	return activeModeratorSessions.has(groupChatId);
}

/**
 * Clears all active moderator sessions.
 * Useful for cleanup during shutdown or testing.
 */
export function clearAllModeratorSessions(): void {
	activeModeratorSessions.clear();
	sessionActivityTimestamps.clear();
}

/**
 * Gets the chat log for the group chat.
 * This is useful for providing context to the moderator.
 *
 * @param groupChatId - The ID of the group chat
 * @returns Array of messages from the chat log
 */
export async function getModeratorChatLog(groupChatId: string) {
	const chat = await loadGroupChat(groupChatId);
	if (!chat) {
		throw new Error(`Group chat not found: ${groupChatId}`);
	}

	return readLog(chat.logPath);
}
