/**
 * @file group-chat-agent.ts
 * @description Participant (agent) management for the Group Chat feature, bound to the desktop.
 *
 * Participants are AI agents that work together in a group chat:
 * - Each participant has a unique name within the chat
 * - Participants receive messages from the moderator
 * - Participants can collaborate by referencing the shared chat log
 *
 * Participants are registered up front, but their actual work runs in one-shot task
 * processes the engine spawns for each moderator handoff.
 *
 * The registry lives in the library (`src/shared/maestro-lib/groupchat/participants.ts`)
 * and runs inside the desktop's one engine (`desktop-engine.ts`). This module keeps
 * every export, signature included, the main process already imports.
 */

import type { GroupChatParticipant, ParticipantRemovalResult } from './group-chat-storage';
import type { IProcessManager } from './group-chat-moderator';
import { desktopGroupChatEngine as engine } from './desktop-engine';
import type { SessionOverrides } from '../../shared/maestro-lib/groupchat/participants';

export type { SessionOverrides };

/**
 * Record that the user explicitly removed a participant so an in-flight or
 * subsequent moderator turn cannot auto-add them before the user re-adds them.
 */
export function markParticipantRemoved(groupChatId: string, participantName: string): void {
	engine.markParticipantRemoved(groupChatId, participantName);
}

/** Whether the user explicitly removed this participant and has not re-added them. */
export function wasParticipantRecentlyRemoved(
	groupChatId: string,
	participantName: string
): boolean {
	return engine.wasParticipantRecentlyRemoved(groupChatId, participantName);
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
	return engine.getParticipantSystemPrompt(participantName, groupChatName, logPath);
}

/**
 * Adds a participant to a group chat.
 *
 * Every argument between `agentId` and `sessionOverrides` is accepted for API
 * compatibility with existing call sites and unused: a participant's processes are
 * spawned per handoff, not when it joins.
 *
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
	return engine.addParticipant(groupChatId, name, agentId, sessionOverrides);
}

/** Tracks the currently running task session for a participant. */
export function setActiveParticipantSession(
	groupChatId: string,
	participantName: string,
	sessionId: string
): void {
	engine.setActiveParticipantSession(groupChatId, participantName, sessionId);
}

/** Clears the currently running task session for a participant. */
export function clearActiveParticipantSession(groupChatId: string, participantName: string): void {
	engine.clearActiveParticipantSession(groupChatId, participantName);
}

/** Sends a message to a specific participant in a group chat. */
export async function sendToParticipant(
	groupChatId: string,
	participantName: string,
	message: string,
	processManager?: IProcessManager
): Promise<void> {
	return engine.sendToParticipant(groupChatId, participantName, message, processManager);
}

/**
 * Removes a participant from a group chat and kills their session.
 *
 * @returns The persisted removal result, or null if the chat no longer exists
 */
export async function removeParticipant(
	groupChatId: string,
	participantName: string,
	processManager?: IProcessManager
): Promise<ParticipantRemovalResult | null> {
	return engine.removeParticipant(groupChatId, participantName, processManager);
}

/** Gets the session ID of the task a participant is running, or undefined if not active. */
export function getParticipantSessionId(
	groupChatId: string,
	participantName: string
): string | undefined {
	return engine.getParticipantSessionId(groupChatId, participantName);
}

/** Checks if a participant is currently active. */
export function isParticipantActive(groupChatId: string, participantName: string): boolean {
	return engine.isParticipantActive(groupChatId, participantName);
}

/** Gets the names of the participants that are currently active in a group chat. */
export function getActiveParticipants(groupChatId: string): string[] {
	return engine.getActiveParticipants(groupChatId);
}

/** Clears all active participant sessions for a group chat, killing their processes. */
export async function clearAllParticipantSessions(
	groupChatId: string,
	processManager?: IProcessManager
): Promise<void> {
	return engine.clearAllParticipantSessions(groupChatId, processManager);
}

/**
 * Clears ALL active participant sessions (all group chats).
 * Useful for cleanup during shutdown or testing.
 */
export function clearAllParticipantSessionsGlobal(): void {
	engine.clearAllParticipantSessionsGlobal();
}
