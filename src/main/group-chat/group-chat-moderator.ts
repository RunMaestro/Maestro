/**
 * @file group-chat-moderator.ts
 * @description Moderator management for the Group Chat feature, bound to the desktop.
 *
 * The moderator is an AI agent that coordinates the group chat:
 * - Spawned in read-only mode to prevent unintended modifications
 * - Receives messages from users and dispatches to participants
 * - Aggregates responses and maintains conversation flow
 *
 * The registry lives in the library (`src/shared/maestro-lib/groupchat/moderator.ts`)
 * and runs inside the desktop's one engine (`desktop-engine.ts`). This module keeps
 * every export the main process already imports.
 */

import * as os from 'os';
import type { GroupChat } from './group-chat-storage';
import { desktopGroupChatEngine as engine } from './desktop-engine';

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
		/** Global shell env vars from Settings → Shell Configuration (merged by envBuilder). */
		shellEnvVars?: Record<string, string>;
		contextWindow?: number;
		promptArgs?: (prompt: string) => string[];
		noPromptSeparator?: boolean;
		/** Shell to use for spawning (Windows: PowerShell preferred over cmd.exe) */
		shell?: string;
		/** Whether to run the command in a shell */
		runInShell?: boolean;
		/** Send prompt via stdin in JSON format (for stream-json agents on Windows) */
		sendPromptViaStdin?: boolean;
		/** Send prompt via stdin as raw text (for non-stream-json agents on Windows) */
		sendPromptViaStdinRaw?: boolean;
		/** Script to send via stdin for SSH execution (bypasses shell escaping) */
		sshStdinScript?: string;
		/** Human-readable remote agent invocation (shown in Process Details for SSH spawns) */
		sshRemoteCommand?: string;
	}): { pid: number; success: boolean };

	write(sessionId: string, data: string): boolean;

	kill(sessionId: string): boolean;
}

/**
 * Stops the periodic session cleanup. The registry no longer runs one (nothing
 * ever started it), so this is kept for the shutdown call that still names it.
 */
export function stopSessionCleanup(): void {}

/**
 * Gets the base system prompt for the moderator.
 * Loaded from src/prompts/group-chat-moderator-system.md
 */
export function getModeratorSystemPrompt(): string {
	return engine.getModeratorSystemPrompt();
}

/**
 * Gets the synthesis prompt for the moderator when reviewing agent responses.
 * Loaded from src/prompts/group-chat-moderator-synthesis.md
 */
export function getModeratorSynthesisPrompt(): string {
	return engine.getModeratorSynthesisPrompt();
}

/**
 * Registers a moderator for a group chat.
 *
 * Only used for initial setup and storing the session mapping. The moderator
 * process itself is spawned per message in batch mode (see routeUserMessage).
 * The process manager and cwd are accepted for API compatibility.
 *
 * @returns The session ID prefix that will be used for moderator messages
 */
export async function spawnModerator(
	chat: GroupChat,
	_processManager: IProcessManager,
	_cwd: string = os.homedir()
): Promise<string> {
	return engine.spawnModerator(chat);
}

/**
 * Sends a message to the moderator and logs it.
 *
 * @param processManager - The process manager (optional, for sending to agent)
 */
export async function sendToModerator(
	groupChatId: string,
	message: string,
	processManager?: IProcessManager
): Promise<void> {
	return engine.sendToModerator(groupChatId, message, processManager);
}

/**
 * Stops the moderator for a group chat: the turn that is running (by its full
 * process id), then the registration.
 *
 * @param processManager - The process manager (optional, for killing the process)
 */
export async function killModerator(
	groupChatId: string,
	processManager?: IProcessManager
): Promise<void> {
	return engine.killModerator(groupChatId, processManager);
}

/** Gets the moderator session ID prefix for a group chat, or undefined if no moderator is active. */
export function getModeratorSessionId(groupChatId: string): string | undefined {
	return engine.getModeratorSessionId(groupChatId);
}

/** Checks if a moderator is currently active for a group chat. */
export function isModeratorActive(groupChatId: string): boolean {
	return engine.isModeratorActive(groupChatId);
}

/** Clears all active moderator sessions. Useful for cleanup during shutdown or testing. */
export function clearAllModeratorSessions(): void {
	engine.clearAllModeratorSessions();
}

/** Gets the chat log for the group chat, to give context to the moderator. */
export async function getModeratorChatLog(groupChatId: string) {
	return engine.getModeratorChatLog(groupChatId);
}
