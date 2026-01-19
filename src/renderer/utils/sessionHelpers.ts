/**
 * Session Helper Functions
 *
 * Utilities for creating and managing sessions, particularly for cross-agent
 * context transfers. These helpers encapsulate the logic for:
 * - Creating sessions for different agent types
 * - Building spawn configurations for agents
 * - Handling agent-specific initialization
 */

import type { Session, ToolType, ProcessConfig } from '../types';
import { createMergedSession } from './tabHelpers';

/**
 * Options for creating a session for a specific agent type.
 * Used when transferring context to a different agent.
 */
export interface CreateSessionForAgentOptions {
	/** Target agent type (e.g., 'claude-code', 'opencode', 'codex') */
	agentType: ToolType;
	/** Project root directory for the new session */
	projectRoot: string;
	/** Display name for the session */
	name: string;
	/** Initial context to send to the agent (groomed context from transfer) */
	initialContext: string;
	/** Optional group ID to assign the session to */
	groupId?: string;
	/** Whether to save completions to history (default: true) */
	saveToHistory?: boolean;
}

/**
 * Result of creating a session for an agent.
 */
export interface CreateSessionForAgentResult {
	/** The newly created session */
	session: Session;
	/** The ID of the active tab in the new session */
	tabId: string;
	/** Spawn configuration for initializing the agent */
	spawnConfig: ProcessConfig;
}

/**
 * Options for building spawn configuration.
 */
export interface BuildSpawnConfigOptions {
	/** Session ID for the spawn */
	sessionId: string;
	/** Agent type */
	toolType: ToolType;
	/** Working directory */
	cwd: string;
	/** Initial prompt to send to the agent */
	prompt?: string;
	/** Agent session ID for resume (optional) */
	agentSessionId?: string;
	/** Whether to spawn in read-only/plan mode */
	readOnlyMode?: boolean;
	/** Model ID for agents that support model selection */
	modelId?: string;
	/** Whether to use YOLO/full-access mode */
	yoloMode?: boolean;
	/** Per-session custom path override */
	sessionCustomPath?: string;
	/** Per-session custom args override */
	sessionCustomArgs?: string;
	/** Per-session custom environment variables */
	sessionCustomEnvVars?: Record<string, string>;
	/** Per-session custom model override */
	sessionCustomModel?: string;
	/** Per-session custom context window */
	sessionCustomContextWindow?: number;
	/** Per-session SSH remote config (takes precedence over agent-level SSH config) */
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
}

/**
 * Build spawn configuration for an agent.
 *
 * This function constructs the ProcessConfig needed to spawn an agent process.
 * It fetches the agent configuration from the main process and builds the
 * appropriate command line arguments.
 *
 * @param options - Configuration options for the spawn
 * @returns ProcessConfig ready to pass to window.maestro.process.spawn()
 *
 * @example
 * const spawnConfig = await buildSpawnConfigForAgent({
 *   sessionId: 'session-123',
 *   toolType: 'claude-code',
 *   cwd: '/path/to/project',
 *   prompt: 'Hello, please continue from this context...',
 *   readOnlyMode: false,
 * });
 *
 * await window.maestro.process.spawn(spawnConfig);
 */
export async function buildSpawnConfigForAgent(
	options: BuildSpawnConfigOptions
): Promise<ProcessConfig | null> {
	const {
		sessionId,
		toolType,
		cwd,
		prompt,
		agentSessionId,
		readOnlyMode,
		modelId,
		yoloMode,
		sessionCustomPath,
		sessionCustomArgs,
		sessionCustomEnvVars,
		sessionCustomModel,
		sessionCustomContextWindow,
		sessionSshRemoteConfig,
	} = options;

	// Fetch the agent configuration from main process
	const agentConfig = await window.maestro.agents.get(toolType);

	if (!agentConfig) {
		console.error(`[sessionHelpers] Agent not found: ${toolType}`);
		return null;
	}

	if (!agentConfig.available) {
		console.error(`[sessionHelpers] Agent not available: ${toolType}`);
		return null;
	}

	// Use the agent's path (resolved location) or command
	const command = agentConfig.path || agentConfig.command;

	// Build the spawn config
	// The main process will use the agent's argument builders (resumeArgs, readOnlyArgs, etc.)
	// to construct the final command line arguments
	const spawnConfig: ProcessConfig = {
		sessionId,
		toolType,
		cwd,
		command,
		args: agentConfig.args || [],
		prompt,
		// Generic spawn options - main process builds agent-specific args
		agentSessionId,
		readOnlyMode,
		modelId,
		yoloMode,
		// Per-session config overrides
		sessionCustomPath,
		sessionCustomArgs,
		sessionCustomEnvVars,
		sessionCustomModel,
		sessionCustomContextWindow,
		// Per-session SSH remote config (takes precedence over agent-level SSH config)
		sessionSshRemoteConfig,
	};

	return spawnConfig;
}

/**
 * Create a new session configured for a specific agent type.
 *
 * This function creates a complete session structure ready for agent initialization.
 * It handles:
 * 1. Creating the session with appropriate structure
 * 2. Building the spawn configuration for the target agent
 * 3. Setting up the initial context as a system message
 *
 * The caller is responsible for:
 * - Adding the session to app state
 * - Calling window.maestro.process.spawn() with the returned spawnConfig
 * - Handling the agent's output
 *
 * @param options - Configuration for the new session
 * @returns Session, tab ID, and spawn configuration, or null if agent not available
 *
 * @example
 * const result = await createSessionForAgent({
 *   agentType: 'opencode',
 *   projectRoot: '/path/to/project',
 *   name: 'Context Transfer → OpenCode',
 *   initialContext: groomedContextText,
 *   groupId: sourceSession.groupId,
 * });
 *
 * if (result) {
 *   // Add session to state
 *   setSessions(prev => [...prev, result.session]);
 *
 *   // Spawn the agent with the initial context
 *   await window.maestro.process.spawn(result.spawnConfig);
 * }
 */
export async function createSessionForAgent(
	options: CreateSessionForAgentOptions
): Promise<CreateSessionForAgentResult | null> {
	const { agentType, projectRoot, name, initialContext, groupId, saveToHistory = true } = options;

	// Verify the agent is available
	const agentConfig = await window.maestro.agents.get(agentType);

	if (!agentConfig) {
		console.error(`[sessionHelpers] Agent not found: ${agentType}`);
		return null;
	}

	if (!agentConfig.available) {
		console.error(`[sessionHelpers] Agent not available: ${agentType}`);
		return null;
	}

	// Create the session structure using the existing helper
	// We pass empty mergedLogs since the context will be sent as a prompt
	const { session, tabId } = createMergedSession({
		name,
		projectRoot,
		toolType: agentType,
		mergedLogs: [], // Context is sent as initial prompt, not as pre-existing logs
		groupId,
		saveToHistory,
	});

	// Build the spawn configuration
	const spawnConfig = await buildSpawnConfigForAgent({
		sessionId: session.id,
		toolType: agentType,
		cwd: projectRoot,
		prompt: initialContext,
		// New session - no resume, no read-only mode by default
		readOnlyMode: false,
	});

	if (!spawnConfig) {
		return null;
	}

	return {
		session,
		tabId,
		spawnConfig,
	};
}

/**
 * Check if an agent type supports context transfer (can receive merged context).
 *
 * @param agentType - The agent type to check
 * @returns True if the agent supports receiving transferred context
 */
export async function agentSupportsContextTransfer(agentType: ToolType): Promise<boolean> {
	const capabilities = await window.maestro.agents.getCapabilities(agentType);
	return capabilities?.supportsContextMerge ?? false;
}

/**
 * Get display information for an agent type.
 *
 * @param agentType - The agent type
 * @returns Agent name and availability status
 */
export async function getAgentInfo(agentType: ToolType): Promise<{
	name: string;
	available: boolean;
	capabilities: any;
} | null> {
	const agentConfig = await window.maestro.agents.get(agentType);

	if (!agentConfig) {
		return null;
	}

	return {
		name: agentConfig.name,
		available: agentConfig.available,
		capabilities: agentConfig.capabilities,
	};
}

/**
 * Minimal session shape for SSH remote ID extraction.
 * Used to avoid importing full Session type in places where only SSH info is needed.
 */
export interface SessionSshInfo {
	/** SSH remote ID set after AI agent spawns */
	sshRemoteId?: string;
	/** SSH remote config set before spawn (user configuration) */
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
}

/**
 * Get the effective SSH remote ID from a session.
 *
 * IMPORTANT: This function handles a common pitfall in the codebase.
 * `sshRemoteId` is only populated AFTER the AI agent spawns (via onSshRemote callback).
 * For terminal-only SSH sessions (no AI agent), it remains undefined.
 *
 * Always use this function instead of accessing `session.sshRemoteId` directly
 * to ensure SSH operations work correctly for all session types.
 *
 * @param session - Session object or partial with SSH fields
 * @returns The effective SSH remote ID, or undefined for local sessions
 *
 * @example
 * // WRONG - fails for terminal-only SSH sessions
 * const sshId = session.sshRemoteId;
 *
 * // CORRECT - works for all SSH sessions
 * const sshId = getSessionSshRemoteId(session);
 *
 * // Use for SSH operations
 * await window.maestro.fs.readFile(path, getSessionSshRemoteId(session));
 * await gitService.isRepo(path, getSessionSshRemoteId(session));
 */
export function getSessionSshRemoteId(
	session: SessionSshInfo | null | undefined
): string | undefined {
	if (!session) return undefined;
	return session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;
}

/**
 * Check if a session is connected to an SSH remote.
 *
 * This handles the same pitfall as getSessionSshRemoteId - `sshRemoteId` is only
 * set after AI agent spawns, so we also check `sessionSshRemoteConfig.enabled`.
 *
 * @param session - Session object or partial with SSH fields
 * @returns True if the session is an SSH remote session
 *
 * @example
 * // WRONG - fails for terminal-only SSH sessions
 * const isRemote = !!session.sshRemoteId;
 *
 * // CORRECT - works for all SSH sessions
 * const isRemote = isSessionRemote(session);
 */
export function isSessionRemote(session: SessionSshInfo | null | undefined): boolean {
	if (!session) return false;
	return !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled;
}
