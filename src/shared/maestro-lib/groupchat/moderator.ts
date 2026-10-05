/**
 * @file groupchat/moderator.ts
 * @description Moderator management for Group Chat feature.
 *
 * The moderator is an AI agent that coordinates the group chat:
 * - Spawned in read-only mode to prevent unintended modifications
 * - Receives messages from users and dispatches to participants
 * - Aggregates responses and maintains conversation flow
 *
 * The registry here is only the mapping from a chat to the id prefix its
 * moderator turns run under. The turns themselves are started by the engine
 * (`router.ts`), one process per message.
 */

import { logger } from '../host';
import { appendToLog, readLog } from './log';
import type { GroupChatStore } from './storage';
import type { GroupChat, GroupChatPromptId } from './types';

/**
 * The slice of a process manager the moderator and participant registries use to
 * write to or stop a process. Anything with both methods fits, so the desktop's
 * `ProcessManager` and a test double are passed as they are.
 */
export interface GroupChatProcessControl {
	write(sessionId: string, data: string): boolean;
	kill(sessionId: string): boolean;
}

export interface GroupChatModeratorsOptions {
	store: Pick<GroupChatStore, 'loadGroupChat' | 'updateGroupChat'>;
	prompts: { get(id: GroupChatPromptId): string };
	/** Releases the room's power block when its moderator is killed. */
	power: { unblock(reason: string): void };
}

export function createGroupChatModerators(options: GroupChatModeratorsOptions) {
	const { store, prompts, power } = options;

	/**
	 * In-memory store for active moderator sessions.
	 * Maps groupChatId -> sessionId prefix
	 */
	const activeModeratorSessions = new Map<string, string>();

	/**
	 * Gets the base system prompt for the moderator.
	 * This is combined with participant info and chat history in routeUserMessage.
	 * Loaded from src/prompts/group-chat-moderator-system.md
	 */
	function getModeratorSystemPrompt(): string {
		return prompts.get('group-chat-moderator-system');
	}

	/**
	 * Gets the synthesis prompt for the moderator when reviewing agent responses.
	 * The moderator decides whether to continue with agents or return to the user.
	 * Loaded from src/prompts/group-chat-moderator-synthesis.md
	 */
	function getModeratorSynthesisPrompt(): string {
		return prompts.get('group-chat-moderator-synthesis');
	}

	/**
	 * Registers a moderator for a group chat.
	 *
	 * This is only used for initial setup and storing the session mapping.
	 * The actual moderator process is spawned per-message in batch mode (see routeUserMessage).
	 *
	 * @param chat - The group chat to register a moderator for
	 * @returns The session ID prefix that will be used for moderator messages
	 */
	async function spawnModerator(chat: GroupChat): Promise<string> {
		logger.debug(`[GroupChat:Debug] ========== SPAWNING MODERATOR ==========`);
		logger.debug(`[GroupChat:Debug] Chat ID: ${chat.id}`);
		logger.debug(`[GroupChat:Debug] Chat Name: ${chat.name}`);
		logger.debug(`[GroupChat:Debug] Moderator Agent ID: ${chat.moderatorAgentId}`);

		// Generate a session ID prefix for this group chat's moderator
		// Each message will use this prefix with a timestamp suffix
		const sessionIdPrefix = `group-chat-${chat.id}-moderator`;

		logger.debug(`[GroupChat:Debug] Generated session ID prefix: ${sessionIdPrefix}`);

		// Store the session mapping (using prefix as identifier)
		activeModeratorSessions.set(chat.id, sessionIdPrefix);

		// Update the group chat with the moderator session ID prefix
		await store.updateGroupChat(chat.id, { moderatorSessionId: sessionIdPrefix });

		logger.debug(`[GroupChat:Debug] Moderator initialized and stored in active sessions`);
		logger.debug(
			`[GroupChat:Debug] Active moderator sessions count: ${activeModeratorSessions.size}`
		);
		logger.debug(`[GroupChat:Debug] ==========================================`);

		return sessionIdPrefix;
	}

	/**
	 * Sends a message to the moderator and logs it.
	 *
	 * @param groupChatId - The ID of the group chat
	 * @param message - The message to send
	 * @param control - The process manager (optional, for sending to agent)
	 */
	async function sendToModerator(
		groupChatId: string,
		message: string,
		control?: Pick<GroupChatProcessControl, 'write'>
	): Promise<void> {
		const chat = await store.loadGroupChat(groupChatId);
		if (!chat) {
			throw new Error(`Group chat not found: ${groupChatId}`);
		}

		// Log the message
		await appendToLog(chat.logPath, 'user', message);

		// If a process manager is provided, also send to the moderator session
		if (control) {
			const sessionId = activeModeratorSessions.get(groupChatId);
			if (sessionId) {
				control.write(sessionId, message + '\n');
			}
		}
	}

	/**
	 * Unregisters the moderator for a group chat.
	 *
	 * The registered id is the per-chat PREFIX, which no running process answers
	 * to (every turn appends a timestamp), so the kill here reaches nothing by
	 * itself. The engine's `killModerator` stops the turn that is actually
	 * running, by its full id, before it calls this.
	 *
	 * @param groupChatId - The ID of the group chat
	 * @param control - The process manager (optional, for killing the process)
	 */
	async function killModerator(
		groupChatId: string,
		control?: Pick<GroupChatProcessControl, 'kill'>
	): Promise<void> {
		const sessionId = activeModeratorSessions.get(groupChatId);

		if (sessionId && control) {
			control.kill(sessionId);
		}

		activeModeratorSessions.delete(groupChatId);

		// Remove power block reason when moderator is killed
		power.unblock(`groupchat:${groupChatId}`);

		// Clear the session ID in storage
		try {
			await store.updateGroupChat(groupChatId, { moderatorSessionId: '' });
		} catch {
			// Chat may already be deleted
		}
	}

	/**
	 * Gets the moderator session ID prefix for a group chat.
	 *
	 * @returns The prefix, or undefined if no moderator is active
	 */
	function getModeratorSessionId(groupChatId: string): string | undefined {
		return activeModeratorSessions.get(groupChatId);
	}

	/** Checks if a moderator is currently active for a group chat. */
	function isModeratorActive(groupChatId: string): boolean {
		return activeModeratorSessions.has(groupChatId);
	}

	/**
	 * Clears all active moderator sessions.
	 * Useful for cleanup during shutdown or testing.
	 */
	function clearAllModeratorSessions(): void {
		activeModeratorSessions.clear();
	}

	/**
	 * Gets the chat log for the group chat.
	 * This is useful for providing context to the moderator.
	 */
	async function getModeratorChatLog(groupChatId: string) {
		const chat = await store.loadGroupChat(groupChatId);
		if (!chat) {
			throw new Error(`Group chat not found: ${groupChatId}`);
		}

		return readLog(chat.logPath);
	}

	return {
		getModeratorSystemPrompt,
		getModeratorSynthesisPrompt,
		spawnModerator,
		sendToModerator,
		killModerator,
		getModeratorSessionId,
		isModeratorActive,
		clearAllModeratorSessions,
		getModeratorChatLog,
	};
}

export type GroupChatModerators = ReturnType<typeof createGroupChatModerators>;
