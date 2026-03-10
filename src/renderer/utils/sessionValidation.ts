import type { Session, ToolType } from '../types';

export interface SessionValidationResult {
	valid: boolean;
	error?: string;
	errorField?: 'name' | 'directory';
	/** Warning about directory conflict (user can acknowledge and proceed) */
	warning?: string;
	warningField?: 'directory';
	/** Names of conflicting agents for display */
	conflictingAgents?: string[];
}

/**
 * Validates that a new session can be created with the given parameters.
 *
 * Rules:
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
	const trimmedName = name.trim();
	const normalizedDir = normalizeDirectory(directory);
	const newRemoteId = sshRemoteId || null;

	// Check for duplicate name (hard error - cannot proceed)
	const duplicateName = existingSessions.find(
		(session) => session.name.toLowerCase() === trimmedName.toLowerCase()
	);
	if (duplicateName) {
		return {
			valid: false,
			error: `An agent named "${duplicateName.name}" already exists`,
			errorField: 'name',
		};
	}

	// Check for duplicate directory with existing agents on the SAME host (warning - user can acknowledge)
	// Agents on different hosts (local vs SSH, or different SSH remotes) are not considered conflicting
	const conflictingAgents = existingSessions.filter((session) => {
		const sessionDir = normalizeDirectory(session.projectRoot || session.cwd);
		if (sessionDir !== normalizedDir) return false;
		const existingRemoteId = session.sshRemoteId || session.sshRemote?.id || null;
		return existingRemoteId === newRemoteId;
	});

	if (conflictingAgents.length > 0) {
		const agentNames = conflictingAgents.map((s) => s.name);
		const agentList =
			agentNames.length === 1 ? `"${agentNames[0]}"` : agentNames.map((n) => `"${n}"`).join(', ');
		return {
			valid: true, // User can proceed after acknowledgment
			warning: `This directory is already used by ${agentList}. Running multiple agents in the same directory may cause them to clobber each other's work.`,
			warningField: 'directory',
			conflictingAgents: agentNames,
		};
	}

	return { valid: true };
}

/**
 * Validates that a session can be edited with the given name.
 *
 * Rules:
 * 1. Session names must be unique across all sessions (excluding the current session)
 */
export function validateEditSession(
	name: string,
	sessionId: string,
	existingSessions: Session[]
): SessionValidationResult {
	const trimmedName = name.trim();

	// Check for duplicate name (excluding the current session)
	const duplicateName = existingSessions.find(
		(session) =>
			session.id !== sessionId && session.name.toLowerCase() === trimmedName.toLowerCase()
	);
	if (duplicateName) {
		return {
			valid: false,
			error: `An agent named "${duplicateName.name}" already exists`,
			errorField: 'name',
		};
	}

	return { valid: true };
}

/**
 * Normalize directory path for comparison.
 * Removes trailing slashes and resolves common variations.
 */
function normalizeDirectory(dir: string): string {
	// Remove trailing slashes
	let normalized = dir.replace(/\/+$/, '');
	// Ensure consistent case on case-insensitive file systems (macOS/Windows)
	// For now, we'll do case-insensitive comparison by lowercasing
	normalized = normalized.toLowerCase();
	return normalized;
}

/**
 * Get a human-readable display name for a provider/tool type.
 */
export function getProviderDisplayName(toolType: ToolType): string {
	const displayNames: Record<ToolType, string> = {
		'claude-code': 'Claude Code',
		opencode: 'OpenCode',
		codex: 'Codex',
		'factory-droid': 'Factory Droid',
		'gemini-cli': 'Gemini CLI',
		'qwen3-coder': 'Qwen3 Coder',
		aider: 'Aider',
		terminal: 'Terminal',
	};
	return displayNames[toolType];
}
