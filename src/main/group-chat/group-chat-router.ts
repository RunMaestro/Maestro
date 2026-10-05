/**
 * @file group-chat-router.ts
 * @description Message routing for the Group Chat feature, bound to the desktop.
 *
 * Routes messages between:
 * - User -> Moderator
 * - Moderator -> Participants (via @mentions)
 * - Participants -> Moderator
 *
 * The engine lives in the library (`src/shared/maestro-lib/groupchat/router.ts`);
 * `desktop-engine.ts` builds the desktop's one instance over its own storage,
 * emitters, prompts and process manager. This module keeps every function name and
 * signature the main process already imports, each a binding to that instance. The
 * two arguments the engine replaced (`processManager`, `agentDetector`) become a
 * launcher here, built per call.
 */

import type { AgentDetector } from '../agents';
import { setGetCustomShellPathCallback } from './group-chat-config';
import {
	createDesktopTurnStopper,
	desktopGroupChatEngine as engine,
	desktopLauncherFor,
} from './desktop-engine';
import type { IProcessManager } from './group-chat-moderator';

export {
	extractMentions,
	extractAllMentions,
	extractAutoRunDirectives,
	isDeletedGroupChatFailure,
	type AutoRunDirective,
	type GroupChatSessionInfo,
} from '../../shared/maestro-lib/groupchat/router';

export {
	setGetSessionsCallback,
	setGetCustomEnvVarsCallback,
	setGetAgentConfigCallback,
	setGetModeratorSettingsCallback,
	setSshStore,
	type GetSessionsCallback,
	type GetCustomEnvVarsCallback,
	type GetAgentConfigCallback,
	type GetModeratorSettingsCallback,
} from './desktop-engine';

// Re-export setGetCustomShellPathCallback for index.ts to use
export { setGetCustomShellPathCallback };

/**
 * Records proof of life for whichever moderator or participant owns `sessionId`,
 * restarting its silence budget. Unknown or non-group-chat session ids are
 * ignored, so the caller can hand over every chunk it sees without pre-filtering.
 */
export function noteGroupChatActivity(sessionId: string): void {
	engine.noteActivity(sessionId);
}

/** Puts a room back to rest: clears the running state and releases its power block. */
export function settleGroupChatToIdle(groupChatId: string): void {
	engine.settleGroupChatToIdle(groupChatId);
}

/**
 * Registers a silence budget for the moderator. If it goes quiet (or runs past its
 * single-turn limit), its process is killed and the room is reset to idle.
 */
export function setModeratorResponseTimeout(
	groupChatId: string,
	processManager?: IProcessManager,
	sessionId?: string
): void {
	engine.setModeratorResponseTimeout(
		groupChatId,
		processManager ? createDesktopTurnStopper(processManager) : undefined,
		sessionId
	);
}

/** Cancels the moderator response timeout (called when the moderator process exits). */
export function clearModeratorResponseTimeout(groupChatId: string): void {
	engine.clearModeratorResponseTimeout(groupChatId);
}

/** Gets the current read-only state for a group chat. */
export function getGroupChatReadOnlyState(groupChatId: string): boolean {
	return engine.getGroupChatReadOnlyState(groupChatId);
}

/** Clears all pending participants for a group chat (and their timeouts). */
export function clearPendingParticipants(groupChatId: string): void {
	engine.clearPendingParticipants(groupChatId);
}

/** Clears the active task session tracked for a participant. */
export function clearActiveParticipantTaskSession(
	groupChatId: string,
	participantName: string
): void {
	engine.clearActiveParticipantTaskSession(groupChatId, participantName);
}

/**
 * Marks a participant as having responded (removes from pending, cancels timeout).
 * Returns true if this was the last pending participant.
 */
export function markParticipantResponded(groupChatId: string, participantName: string): boolean {
	return engine.markParticipantResponded(groupChatId, participantName);
}

/**
 * Routes a user message to the moderator.
 *
 * Spawns a batch process for the moderator to handle this specific message.
 * The chat history is included in the system prompt for context.
 *
 * @param processManager - The process manager (optional)
 * @param agentDetector - The agent detector for resolving agent commands (optional)
 */
export async function routeUserMessage(
	groupChatId: string,
	message: string,
	processManager?: IProcessManager,
	agentDetector?: AgentDetector,
	readOnly?: boolean,
	images?: string[],
	routingRetry?: Parameters<typeof engine.routeUserMessage>[5]
): Promise<void> {
	await engine.routeUserMessage(
		groupChatId,
		message,
		desktopLauncherFor(processManager, agentDetector),
		readOnly,
		images,
		routingRetry
	);
	// A process manager with no detector can log the message but cannot resolve the
	// moderator's command, which is a caller error rather than a quiet no-op.
	if (processManager && !agentDetector) {
		throw new Error('AgentDetector not available');
	}
}

/**
 * Routes a moderator response, forwarding to mentioned agents.
 *
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
	await engine.routeModeratorResponse(
		groupChatId,
		message,
		desktopLauncherFor(processManager, agentDetector),
		readOnly
	);
}

/**
 * Routes an agent's response back to the moderator: logs it, updates the
 * participant's stats, and records the history entry. The process manager is
 * accepted for API compatibility and unused.
 */
export async function routeAgentResponse(
	groupChatId: string,
	participantName: string,
	message: string,
	_processManager?: IProcessManager
): Promise<void> {
	await engine.routeAgentResponse(groupChatId, participantName, message);
}

/**
 * Spawns a moderator synthesis round to summarize participant responses.
 * Called when the last pending participant has responded.
 */
export async function spawnModeratorSynthesis(
	groupChatId: string,
	processManager: IProcessManager,
	agentDetector: AgentDetector
): Promise<void> {
	const launcher = desktopLauncherFor(processManager, agentDetector);
	if (!launcher) throw new Error('Cannot spawn synthesis without a process manager and detector');
	await engine.spawnModeratorSynthesis(groupChatId, launcher);
}

/**
 * Re-spawn a participant with session recovery context, after its provider session
 * was deleted out of band.
 */
export async function respawnParticipantWithRecovery(
	groupChatId: string,
	participantName: string,
	processManager: IProcessManager,
	agentDetector: AgentDetector
): Promise<void> {
	const launcher = desktopLauncherFor(processManager, agentDetector);
	if (!launcher)
		throw new Error('Cannot respawn a participant without a process manager and detector');
	await engine.respawnParticipantWithRecovery(groupChatId, participantName, launcher);
}
