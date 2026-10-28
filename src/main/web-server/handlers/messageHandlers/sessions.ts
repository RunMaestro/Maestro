/**
 * Sessions domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: get_sessions,
 * create_session, create_worktree_session, delete_session, rename_session,
 * update_session_cwd, update_session_ssh, update_session_config, provider_translation,
 * list_desktop_sessions, get_session_history.
 */

import { AGENT_IDS } from '../../../../shared/agentIds';
import { readBackgroundField } from '../../../../shared/focusPlacement';
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
	// Provenance for the key above. This allowlist is explicit, so omitting it
	// would silently drop the CLI's `--context-window` intent - the same failure
	// mode as the EDITABLE_KEYS allowlist in the remote patch applier (AD1).
	// Gated on the window actually being accepted: provenance describes a value,
	// so a source-only payload would leave a marker with nothing to describe, and
	// that orphan would then outrank a provider report for whatever window is set
	// later (review of PR #1362).
	if (config.customContextWindow !== undefined && message.contextWindowSource === 'user-edited') {
		config.contextWindowSource = 'user-edited';
	}
	if (message.customProviderPath) config.customProviderPath = message.customProviderPath as string;
	if (message.sessionSshRemoteConfig) {
		config.sessionSshRemoteConfig =
			message.sessionSshRemoteConfig as CreateSessionConfig['sessionSshRemoteConfig'];
	}
	// autoRunFolderPath can be set outside of the agent's cwd (no confinement needed)
	if (message.autoRunFolderPath) config.autoRunFolderPath = message.autoRunFolderPath as string;
	if (typeof message.gatewayUrl === 'string' && message.gatewayUrl) {
		config.gatewayUrl = message.gatewayUrl;
	}
	// Passed as data: the renderer validates it against the provider and the
	// saved sources, and refuses the create for a target it cannot store.
	if (message.runOn !== undefined && message.runOn !== null) config.runOn = message.runOn;
	if (message.seedFromGroup === false) config.seedFromGroup = false;
	// The rest of the New Agent modal's fields, so `duplicate-agent` creates the
	// same agent the modal does. Booleans are copied when present: an explicit
	// `false` is a choice (Adaptive Mode off over SSH, resilience opted out).
	if (Array.isArray(message.additionalDirectories) && message.additionalDirectories.length > 0) {
		config.additionalDirectories =
			message.additionalDirectories as CreateSessionConfig['additionalDirectories'];
	}
	if (typeof message.enableMaestroP === 'boolean') config.enableMaestroP = message.enableMaestroP;
	if (message.maestroPMode === 'interactive' || message.maestroPMode === 'dynamic') {
		config.maestroPMode = message.maestroPMode;
	}
	if (message.maestroPPath) config.maestroPPath = message.maestroPPath as string;
	if (typeof message.retryOnAvailabilityErrors === 'boolean') {
		config.retryOnAvailabilityErrors = message.retryOnAvailabilityErrors;
	}
	if (typeof message.retryOnTokenExhaustion === 'boolean') {
		config.retryOnTokenExhaustion = message.retryOnTokenExhaustion;
	}
	if (message.codexAutoResetOnExhaustion === true) config.codexAutoResetOnExhaustion = true;
	if (message.codexTransport === 'app-server' || message.codexTransport === 'exec') {
		config.codexTransport = message.codexTransport;
	}
	const hasConfig = Object.keys(config).length > 0;

	ctx.callbacks
		.createSession(
			name,
			toolType,
			cwd,
			groupId,
			hasConfig ? config : undefined,
			readBackgroundField(message)
		)
		.then((result) => {
			ctx.send(client, {
				type: 'create_session_result',
				success: !!result,
				sessionId: result?.sessionId,
				seededFromGroup: result?.seededFromGroup ?? null,
				skipped: result?.skipped ?? [],
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
		.createWorktreeSession(parentSessionId, config, readBackgroundField(message))
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
 * The renderer moves `cwd`, `fullPath`, `shellCwd`, `projectRoot`, and an
 * Auto Run folder under the old root together (#1565). Renderer-side
 * validation rejects updates while an agent process is alive - the PTY's cwd
 * is fixed at spawn time.
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
 * vars, model, effort, context window, Claude token-source tri-state) or its
 * Left Bar bookmark. Only the keys present in `configPatch` are applied; a key
 * with value `null` clears that field. The spawn-time settings take effect on
 * the next launch, so unlike cwd/SSH the renderer applies them even while the
 * agent process is alive.
 *
 * A `configPatch.tabId` retargets the patch at one AI tab inside the agent
 * (starred / hasUnread / saveToHistory / readOnlyMode / showThinking /
 * customModel / customEffort / enterToSend - the composer chips). The
 * renderer owns both allowlists and type-checks the tab values.
 */
export function handleUpdateSessionConfig(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage,
	responseType:
		| 'update_session_config_result'
		| 'provider_translation_result' = 'update_session_config_result'
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
				type: responseType,
				success: result.success,
				error: result.error,
				plan: result.plan,
				result: result.result,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to update session config: ${error.message}`);
		});
}

/** Dedicated verb: older desktops reject it instead of applying a destructive toolType patch. */
export function handleProviderTranslation(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const patch = message.configPatch as Record<string, unknown> | undefined;
	if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
		ctx.sendError(client, 'Missing or invalid provider translation request');
		return;
	}
	const allowedKeys = [
		'toolType',
		'tabId',
		'migrationAction',
		'acceptTranslationLimitations',
		'selectedUserResources',
		'migrationPlanId',
		'projectResourcesIntoRepo',
	];
	if (Object.keys(patch).some((key) => !allowedKeys.includes(key))) {
		ctx.sendError(client, 'Provider translation cannot include unrelated settings edits');
		return;
	}
	if (
		typeof patch.migrationAction !== 'string' ||
		!['plan', 'apply', 'status', 'recover', 'rollback', 'switch'].includes(patch.migrationAction)
	) {
		ctx.sendError(client, 'Invalid provider translation action');
		return;
	}
	// `switch` changes the provider WITHOUT converting, so it needs a destination.
	if (patch.migrationAction === 'switch' && patch.toolType === undefined) {
		ctx.sendError(client, 'Switching provider requires a destination provider');
		return;
	}
	if (
		patch.toolType !== undefined &&
		(typeof patch.toolType !== 'string' || !VALID_AGENT_TYPES.has(patch.toolType))
	) {
		ctx.sendError(client, 'Invalid destination provider');
		return;
	}
	if (
		(patch.tabId !== undefined && (typeof patch.tabId !== 'string' || !patch.tabId.trim())) ||
		(patch.projectResourcesIntoRepo !== undefined &&
			typeof patch.projectResourcesIntoRepo !== 'boolean') ||
		(patch.acceptTranslationLimitations !== undefined &&
			typeof patch.acceptTranslationLimitations !== 'boolean') ||
		(patch.migrationPlanId !== undefined &&
			(typeof patch.migrationPlanId !== 'string' || !patch.migrationPlanId.trim())) ||
		(patch.selectedUserResources !== undefined &&
			(!Array.isArray(patch.selectedUserResources) ||
				patch.selectedUserResources.some((resource) => typeof resource !== 'string')))
	) {
		ctx.sendError(client, 'Invalid provider translation options');
		return;
	}
	handleUpdateSessionConfig(ctx, client, message, 'provider_translation_result');
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
		provider: result.provider,
		agentProvider: result.agentProvider,
		tabProvider: result.tabProvider,
		turnProvider: result.turnProvider,
		pendingTranslation: result.pendingTranslation,
		effectiveModel: result.effectiveModel,
		effectiveEffort: result.effectiveEffort,
		runOn: result.runOn,
		projectPath: result.projectPath,
		messages: result.messages,
		requestId: message.requestId,
	});
}
