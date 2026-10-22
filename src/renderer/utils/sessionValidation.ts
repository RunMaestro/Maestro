import type { Session, ToolType } from '../types';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import {
	validateAgentRename,
	validateNewAgent,
	type AgentValidationResult,
} from '../../shared/maestro-lib/agents/rules';

/** What the new-agent and edit-agent validators report. The rules live in the library, shared with the TUI. */
export type SessionValidationResult = AgentValidationResult;

/**
 * Validates that a new session can be created with the given parameters.
 *
 * Rules (`validateNewAgent` in `src/shared/maestro-lib/agents/rules.ts`):
 * 1. Session names must be unique across all sessions (hard error)
 * 2. Home directories (projectRoot) shared with any existing agent on the same host produce a warning
 *    - Users can acknowledge the risk and proceed
 *    - Multiple agents in the same directory may clobber each other's work
 *    - Agents on different hosts (local vs SSH, or different SSH remotes) are not considered conflicting
 */
export function validateNewSession(
	name: string,
	directory: string,
	_toolType: ToolType,
	existingSessions: Session[],
	sshRemoteId?: string | null
): SessionValidationResult {
	return validateNewAgent(name, directory, existingSessions, sshRemoteId);
}

/**
 * Validates that a session can be edited with the given name.
 *
 * Rules (`validateAgentRename`):
 * 1. Session names must be unique across all sessions (excluding the current session)
 */
export function validateEditSession(
	name: string,
	sessionId: string,
	existingSessions: Session[]
): SessionValidationResult {
	return validateAgentRename(name, sessionId, existingSessions);
}

/**
 * Get a human-readable display name for a provider/tool type.
 */
export function getProviderDisplayName(toolType: ToolType): string {
	return getAgentDisplayName(toolType);
}
