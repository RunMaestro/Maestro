/**
 * Sessions domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: get_sessions,
 * create_session, create_worktree_session, delete_session, rename_session,
 * update_session_cwd, update_session_ssh, update_session_config,
 * list_desktop_sessions, get_session_history.
 */

import { AGENT_IDS } from '../../../../shared/agentIds';
import type { CreateSessionConfig } from '../../types';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Known agent types for validation - derived from the canonical AGENT_IDS list.
 * Excludes 'terminal' since it's an internal-only agent type.
 */
const VALID_AGENT_TYPES: Set<string> = new Set(AGENT_IDS.filter((id) => id !== 'terminal'));

export function handleGetSessions(ctx: MessageHandlerContext, client: WebClient): void {
	if (
		ctx.callbacks.getSessions &&
		ctx.callbacks.getLiveSessionInfo &&
		ctx.callbacks.isSessionLive
	) {
		const allSessions = ctx.callbacks.getSessions();
		// Enrich sessions with live info if available
		const sessionsWithLiveInfo = allSessions.map((s) => {
			const liveInfo = ctx.callbacks.getLiveSessionInfo!(s.id);
			return {
				...s,
				agentSessionId: liveInfo?.agentSessionId || s.agentSessionId,
				liveEnabledAt: liveInfo?.enabledAt,
				isLive: ctx.callbacks.isSessionLive!(s.id),
			};
		});
		ctx.send(client, { type: 'sessions_list', sessions: sessionsWithLiveInfo });
	}
}

/**
 * Handle create_session message - create a new agent session
 */
export function handleCreateSession(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const name = message.name as string;
	const toolType = message.toolType as string;
	const cwd = message.cwd as string;
	const groupId = message.groupId as string | undefined;

	if (!name || typeof name !== 'string') {
		ctx.sendError(client, 'Missing or invalid name');
		return;
	}

	if (!toolType || !VALID_AGENT_TYPES.has(toolType)) {
		ctx.sendError(client, `Invalid toolType. Must be one of: ${[...VALID_AGENT_TYPES].join(', ')}`);
		return;
	}

	if (!cwd || typeof cwd !== 'string') {
		ctx.sendError(client, 'Missing or invalid cwd');
		return;
	}

	if (!ctx.callbacks.createSession) {
		ctx.sendError(client, 'Session creation not configured');
		return;
	}

	// Extract optional config fields
	const config: CreateSessionConfig = {};
	if (message.nudgeMessage) config.nudgeMessage = message.nudgeMessage as string;
	if (message.newSessionMessage) config.newSessionMessage = message.newSessionMessage as string;
	if (message.customPath) config.customPath = message.customPath as string;
	if (message.customArgs) config.customArgs = message.customArgs as string;
	if (message.customEnvVars) config.customEnvVars = message.customEnvVars as Record<string, string>;
	if (message.customModel) config.customModel = message.customModel as string;
	if (message.customEffort) config.customEffort = message.customEffort as string;
	if (message.customContextWindow)
		config.customContextWindow = message.customContextWindow as number;
	if (message.customProviderPath) config.customProviderPath = message.customProviderPath as string;
	if (message.sessionSshRemoteConfig) {
		config.sessionSshRemoteConfig =
			message.sessionSshRemoteConfig as CreateSessionConfig['sessionSshRemoteConfig'];
	}
	// autoRunFolderPath can be set outside of the agent's cwd (no confinement needed)
	if (message.autoRunFolderPath) config.autoRunFolderPath = message.autoRunFolderPath as string;
	const hasConfig = Object.keys(config).length > 0;

	ctx.callbacks
		.createSession(name, toolType, cwd, groupId, hasConfig ? config : undefined)
		.then((result) => {
			ctx.send(client, {
				type: 'create_session_result',
				success: !!result,
				sessionId: result?.sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to create session: ${error.message}`);
		});
}

/**
 * Handle create_worktree_session message - create a new agent in a git
 * worktree branched off an existing parent agent, without an Auto Run
 * playbook. The desktop creates the worktree, builds a child session linked
 * to the parent, and returns the new agent's session id.
 */
export function handleCreateWorktreeSession(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const parentSessionId = message.parentSessionId as string;
	const branchName = message.branchName as string;

	if (!parentSessionId || typeof parentSessionId !== 'string') {
		ctx.sendError(client, 'Missing or invalid parentSessionId');
		return;
	}

	if (!branchName || typeof branchName !== 'string' || branchName.trim() === '') {
		ctx.sendError(client, 'Missing or invalid branchName');
		return;
	}

	if (message.baseBranch !== undefined && typeof message.baseBranch !== 'string') {
		ctx.sendError(client, 'baseBranch must be a string');
		return;
	}

	if (!ctx.callbacks.createWorktreeSession) {
		ctx.sendError(client, 'Worktree session creation not configured');
		return;
	}

	const config = {
		branchName: branchName.trim(),
		baseBranch: (message.baseBranch as string | undefined)?.trim() || undefined,
	};

	ctx.callbacks
		.createWorktreeSession(parentSessionId, config)
		.then((result) => {
			ctx.send(client, {
				type: 'create_worktree_session_result',
				success: result.success,
				sessionId: result.sessionId,
				error: result.error,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to create worktree session: ${error.message}`);
		});
}

/**
 * Handle delete_session message - delete an agent session
 */
export function handleDeleteSession(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.deleteSession) {
		ctx.sendError(client, 'Session deletion not configured');
		return;
	}

	ctx.callbacks
		.deleteSession(sessionId)
		.then((success) => {
			ctx.send(client, {
				type: 'delete_session_result',
				success,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to delete session: ${error.message}`);
		});
}

/**
 * Handle rename_session message - rename an agent session
 */
export function handleRenameSession(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const newName = message.newName as string;

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!newName || typeof newName !== 'string' || newName.length === 0) {
		ctx.sendError(client, 'Missing or empty newName');
		return;
	}

	if (newName.length > 100) {
		ctx.sendError(client, 'newName must be 100 characters or less');
		return;
	}

	if (!ctx.callbacks.renameSession) {
		ctx.sendError(client, 'Session renaming not configured');
		return;
	}

	ctx.callbacks
		.renameSession(sessionId, newName)
		.then((success) => {
			ctx.send(client, {
				type: 'rename_session_result',
				success,
				sessionId,
				newName,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to rename session: ${error.message}`);
		});
}

/**
 * Handle update_session_cwd message - update an agent's working directory.
 * The desktop's `projectRoot` (used for provider session storage) is left
 * untouched so historical conversations stay addressable; only the UI-facing
 * `cwd`/`fullPath` move. Renderer-side validation rejects updates while an
 * agent process is alive - the PTY's cwd is fixed at spawn time.
 */
export function handleUpdateSessionCwd(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const newCwd = message.newCwd as string;

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!newCwd || typeof newCwd !== 'string' || newCwd.trim() === '') {
		ctx.sendError(client, 'Missing or empty newCwd');
		return;
	}

	if (!ctx.callbacks.updateSessionCwd) {
		ctx.sendError(client, 'Session cwd updates not configured');
		return;
	}

	ctx.callbacks
		.updateSessionCwd(sessionId, newCwd)
		.then((result) => {
			ctx.send(client, {
				type: 'update_session_cwd_result',
				success: result.success,
				error: result.error,
				sessionId,
				newCwd,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to update session cwd: ${error.message}`);
		});
}

/**
 * Handle update_session_ssh message - update an agent's SSH execution config
 * (remote selection, working-dir override, history-sync flags). Only the
 * fields present in `sshPatch` are merged onto the existing config. Like
 * cwd updates, the renderer refuses while the agent process is alive because
 * the spawn target is fixed at launch time.
 */
export function handleUpdateSessionSsh(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const sshPatch = message.sshPatch as Record<string, unknown> | undefined;

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!sshPatch || typeof sshPatch !== 'object') {
		ctx.sendError(client, 'Missing or invalid sshPatch');
		return;
	}

	if (!ctx.callbacks.updateSessionSsh) {
		ctx.sendError(client, 'Session SSH updates not configured');
		return;
	}

	ctx.callbacks
		.updateSessionSsh(sessionId, sshPatch)
		.then((result) => {
			ctx.send(client, {
				type: 'update_session_ssh_result',
				success: result.success,
				error: result.error,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to update session SSH config: ${error.message}`);
		});
}

/**
 * Handle update_session_config message - update an agent's editable
 * per-session config (nudge / new-session message, custom path / args / env
 * vars, model, effort, context window, Claude token-source tri-state). Only
 * the keys present in `configPatch` are applied; a key with value `null`
 * clears that field. These are spawn-time settings (they take effect on the
 * next launch), so unlike cwd/SSH the renderer applies them even while the
 * agent process is alive.
 */
export function handleUpdateSessionConfig(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const configPatch = message.configPatch as Record<string, unknown> | undefined;

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!configPatch || typeof configPatch !== 'object') {
		ctx.sendError(client, 'Missing or invalid configPatch');
		return;
	}

	if (!ctx.callbacks.updateSessionConfig) {
		ctx.sendError(client, 'Session config updates not configured');
		return;
	}

	ctx.callbacks
		.updateSessionConfig(sessionId, configPatch)
		.then((result) => {
			ctx.send(client, {
				type: 'update_session_config_result',
				success: result.success,
				error: result.error,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to update session config: ${error.message}`);
		});
}

/**
 * Handle list_desktop_sessions message - enumerate every open AI tab across
 * desktop agents. Stateless read backed by the persisted session store; no
 * subscription side-effects so external pollers (Maestro-Discord, Cue) can
 * call this every few seconds without leaking state into the desktop.
 */
export function handleListDesktopSessions(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessions = ctx.callbacks.listDesktopSessions ? ctx.callbacks.listDesktopSessions() : [];
	ctx.send(client, {
		type: 'desktop_sessions_list',
		success: true,
		sessions,
		requestId: message.requestId,
	});
}

/**
 * Handle get_session_history message - return the conversation log for a
 * tab, optionally filtered by `sinceMs` (poll cursor) and/or `tail` (cap).
 * Errors are returned in the same response type rather than as a generic
 * `error` so the CLI's request/response pairing stays deterministic.
 */
export function handleGetSessionHistory(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const tabId = typeof message.tabId === 'string' ? message.tabId : undefined;
	if (!tabId) {
		ctx.send(client, {
			type: 'session_history_result',
			success: false,
			error: 'Missing tabId',
			code: 'MISSING_TAB_ID',
			requestId: message.requestId,
		});
		return;
	}

	if (!ctx.callbacks.getSessionHistory) {
		ctx.send(client, {
			type: 'session_history_result',
			success: false,
			error: 'Session history not configured',
			code: 'NOT_CONFIGURED',
			requestId: message.requestId,
		});
		return;
	}

	const sinceMs =
		typeof message.sinceMs === 'number' && Number.isFinite(message.sinceMs)
			? message.sinceMs
			: undefined;
	const tail =
		typeof message.tail === 'number' && Number.isFinite(message.tail) && message.tail >= 0
			? Math.floor(message.tail)
			: undefined;

	const result = ctx.callbacks.getSessionHistory(tabId, { sinceMs, tail });
	if (!result) {
		ctx.send(client, {
			type: 'session_history_result',
			success: false,
			error: `Tab not found: ${tabId}`,
			code: 'TAB_NOT_FOUND',
			requestId: message.requestId,
		});
		return;
	}

	ctx.send(client, {
		type: 'session_history_result',
		success: true,
		tabId: result.tabId,
		sessionId: result.sessionId,
		agentId: result.agentId,
		agentSessionId: result.agentSessionId,
		projectPath: result.projectPath,
		messages: result.messages,
		requestId: message.requestId,
	});
}
