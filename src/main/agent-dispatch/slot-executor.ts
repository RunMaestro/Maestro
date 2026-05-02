/**
 * Slot Executor
 *
 * When a work item is claimed for a role, this module spawns a fresh agent
 * process for that claim and tears it down on completion.
 *
 * Key design points:
 * - Looks up the slot's agentId in sessionsStore to get the agent's stored
 *   config (toolType, SSH remote, customPath, customArgs, customEnvVars,
 *   customModel, customEffort).
 * - Applies slot-level modelOverride / effortOverride on top of the agent's
 *   stored defaults — same precedence as the session UI overrides.
 * - Uses WorkItem.projectPath as cwd.
 * - Reads the role's prompt template from src/prompts/dispatch-role-<role>.md.
 * - Spawns via ProcessManager.spawn() — the same path Maestro uses for regular
 *   agent sessions and Cue prompts.  SSH wrapping is applied when the agent's
 *   sessionSshRemoteConfig is enabled (wrapSpawnWithSsh pattern from
 *   context-groomer / group-chat).
 * - Lifecycle events (spawn-start, spawn-complete, spawn-error, claim-released,
 *   pipeline-advanced) are written to the audit log via the provided callback.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import type { DispatchRole, RoleSlotAssignment } from '../../shared/project-roles-types';
import type { WorkItem, WorkGraphActor } from '../../shared/work-graph-types';
import { logger } from '../utils/logger';
import { buildAgentArgs, applyAgentConfigOverrides } from '../utils/agent-args';
import { wrapSpawnWithSsh } from '../utils/ssh-spawn-wrapper';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';

const LOG_CONTEXT = '[SlotExecutor]';

/**
 * Legacy Symphony-runner labels that are meaningless to this dispatch system.
 * The AI Status custom field on GitHub Projects v2 is the sole source of truth.
 * Presence of these labels on a work item is logged as a warning so operators
 * know to run `/PM migrate-labels` to clean up.
 */
const LEGACY_AGENT_LABEL_NAMES = [
	'agent:ready',
	'agent:running',
	'agent:review',
	'agent:failed-validation',
];

// ---------------------------------------------------------------------------
// Web client broadcast hook (#448)
//
// Optional callbacks injected by the web-server-factory so claim lifecycle
// events are forwarded to connected web/mobile clients without pulling a
// WebServer reference into this module.
// ---------------------------------------------------------------------------

let _onClaimStarted:
	| ((e: {
			projectPath: string;
			role: string;
			issueNumber?: number;
			issueTitle?: string;
			claimedAt: string;
	  }) => void)
	| null = null;

let _onClaimEnded: ((e: { projectPath: string; role: string }) => void) | null = null;

/**
 * Register callbacks that are fired alongside the Electron IPC events so
 * the web-server layer can broadcast to connected web/mobile clients.
 * Call this once from web-server-factory after the WebServer is running.
 */
export function setSlotExecutorWebBroadcasts(
	onClaimStarted: (e: {
		projectPath: string;
		role: string;
		issueNumber?: number;
		issueTitle?: string;
		claimedAt: string;
	}) => void,
	onClaimEnded: (e: { projectPath: string; role: string }) => void
): void {
	_onClaimStarted = onClaimStarted;
	_onClaimEnded = onClaimEnded;
}

// ---------------------------------------------------------------------------
// IPC event helpers — push claim lifecycle to renderer
// ---------------------------------------------------------------------------

function safeSendToRenderer(channel: string, payload: unknown): void {
	const windows = BrowserWindow.getAllWindows();
	for (const win of windows) {
		if (!win.isDestroyed()) {
			win.webContents.send(channel, payload);
		}
	}
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SlotExecutorProcessManager {
	spawn(config: {
		sessionId: string;
		toolType: string;
		cwd: string;
		command: string;
		args: string[];
		prompt?: string;
		promptArgs?: (prompt: string) => string[];
		noPromptSeparator?: boolean;
		customEnvVars?: Record<string, string>;
		sshRemoteId?: string;
		sshStdinScript?: string;
		sendPromptViaStdin?: boolean;
		sendPromptViaStdinRaw?: boolean;
	}): { pid: number; success?: boolean } | null;
	on(event: string, handler: (...args: unknown[]) => void): void;
	off(event: string, handler: (...args: unknown[]) => void): void;
	kill(sessionId: string): void;
}

/** Narrow session shape the executor needs from sessionsStore. */
export interface SlotSessionConfig {
	id: string;
	toolType: string;
	/** Path to agent binary override (per-session). */
	customPath?: string;
	/** Custom CLI arguments (per-session). */
	customArgs?: string;
	/** Custom env vars (per-session). */
	customEnvVars?: Record<string, string>;
	/** Model override (per-session). */
	customModel?: string;
	/** Effort/reasoning override (per-session). */
	customEffort?: string;
	/** SSH remote configuration for this session. */
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
}

export interface SlotExecutorContext {
	/** The work item being executed. */
	workItem: WorkItem;
	/** The pipeline role being executed. */
	role: DispatchRole;
	/** The slot assignment for this role (contains agentId + overrides). */
	slotAssignment: RoleSlotAssignment;
	/**
	 * Resolved session config for the slot's agentId.
	 * Caller fetches this from sessionsStore before invoking the executor.
	 */
	sessionConfig: SlotSessionConfig;
	/**
	 * Agent definition resolved by agentDetector.getAgent(toolType).
	 * Must be available (checked before calling this function).
	 */
	agentDef: {
		id: string;
		command: string;
		path?: string;
		args?: string[];
		batchModeArgs?: string[];
		batchModePrefix?: string[];
		jsonOutputArgs?: string[];
		workingDirArgs?: (cwd: string) => string[];
		promptArgs?: (prompt: string) => string[];
		noPromptSeparator?: boolean;
		configOptions?: Array<{
			key: string;
			argBuilder?: (v: unknown) => string[];
			default?: unknown;
		}>;
		defaultEnvVars?: Record<string, string>;
		binaryName?: string;
		contextWindow?: number;
	};
	/** Per-agent config values from agentConfigsStore (model, effort, etc.). */
	agentConfigValues: Record<string, unknown>;
	/** ProcessManager instance to spawn through. */
	processManager: SlotExecutorProcessManager;
	/** SSH settings store — required when session has SSH remote enabled. */
	sshStore?: SshRemoteSettingsStore | null;
	/**
	 * Called when the work item should be released after execution.
	 */
	releaseClaim: (
		workItemId: string,
		opts?: { note?: string; actor?: WorkGraphActor }
	) => Promise<void>;
	/**
	 * Called to advance the pipeline after a successful role completion.
	 */
	advancePipeline: (
		workItem: WorkItem,
		event: 'complete' | 'fail',
		actor?: WorkGraphActor
	) => Promise<void>;
	/**
	 * Structured audit log sink.
	 */
	auditLog: (event: SlotAuditEvent) => void;
}

export type SlotAuditEventKind =
	| 'spawn-start'
	| 'spawn-complete'
	| 'spawn-error'
	| 'pipeline-advanced'
	| 'claim-released';

export interface SlotAuditEvent {
	kind: SlotAuditEventKind;
	workItemId: string;
	role: DispatchRole;
	agentId: string;
	sessionId?: string;
	detail?: string;
	timestamp: string;
}

export interface SlotExecutorResult {
	success: boolean;
	error?: string;
}

// ---------------------------------------------------------------------------
// Prompt template loader
// ---------------------------------------------------------------------------

const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');

function loadRolePromptTemplate(role: DispatchRole): string {
	const templatePath = path.join(PROMPTS_DIR, `dispatch-role-${role}.md`);
	try {
		return fs.readFileSync(templatePath, 'utf8');
	} catch {
		// Fall back to a minimal inline prompt if the file is missing
		logger.warn(`[SlotExecutor] Role prompt template not found: ${templatePath}`, LOG_CONTEXT, {
			role,
		});
		return `You are a Maestro dispatch agent in the ${role} role. Please complete the assigned work item.`;
	}
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

/**
 * Execute a single work item claim using the slot's configured agent.
 *
 * Lifecycle:
 * 1. Load role prompt template
 * 2. Build agent args (batch mode + model/effort overrides)
 * 3. Apply SSH wrapping when agent has SSH remote enabled
 * 4. Spawn via ProcessManager
 * 5. Wait for exit event
 * 6. Advance pipeline + release claim
 */
export async function executeSlot(ctx: SlotExecutorContext): Promise<SlotExecutorResult> {
	const {
		workItem,
		role,
		slotAssignment,
		sessionConfig,
		agentDef,
		agentConfigValues,
		processManager,
		sshStore,
		releaseClaim,
		advancePipeline,
		auditLog,
	} = ctx;

	const workItemId = workItem.id;
	const agentId = slotAssignment.agentId;

	// Legacy-label warning: agent:* labels are ignored — AI Status field is the source of truth.
	const legacyLabels = LEGACY_AGENT_LABEL_NAMES.filter((l) => workItem.tags?.includes(l));
	if (legacyLabels.length > 0) {
		logger.warn(
			`Legacy label(s) detected on issue/item "${workItemId}": [${legacyLabels.join(', ')}]. ` +
				`These are ignored. Use /PM migrate-labels to convert legacy labels to AI Status field values.`,
			LOG_CONTEXT
		);
	}

	// Derive a stable session id for this dispatch invocation
	const claimId = workItem.claim?.id ?? workItemId;
	const dispatchSessionId = `dispatch-${role}-${claimId}`;

	// 1. Build prompt from role template + work item context
	const templatePrompt = loadRolePromptTemplate(role);
	const prompt = buildPrompt(templatePrompt, workItem);

	// 2. Build agent args
	const baseArgs = buildAgentArgs(agentDef as Parameters<typeof buildAgentArgs>[0], {
		baseArgs: agentDef.args || [],
		prompt,
		cwd: workItem.projectPath,
		readOnlyMode: false,
		modelId: undefined, // applied via applyAgentConfigOverrides below
		yoloMode: false,
	});

	// Resolve model / effort: slot overrides take precedence over session, then agent defaults
	const effectiveModel = slotAssignment.modelOverride ?? sessionConfig.customModel;
	const effectiveEffort = slotAssignment.effortOverride ?? sessionConfig.customEffort;

	const configResolution = applyAgentConfigOverrides(
		agentDef as Parameters<typeof applyAgentConfigOverrides>[0],
		baseArgs,
		{
			agentConfigValues: agentConfigValues as Record<string, unknown>,
			sessionCustomModel: effectiveModel,
			sessionCustomEffort: effectiveEffort,
			sessionCustomArgs: sessionConfig.customArgs,
			sessionCustomEnvVars: sessionConfig.customEnvVars,
		}
	);

	let resolvedArgs = configResolution.args;
	let resolvedCommand = sessionConfig.customPath || agentDef.path || agentDef.command;
	let resolvedCwd = workItem.projectPath;
	let resolvedEnvVars = configResolution.effectiveCustomEnvVars;
	let sshStdinScript: string | undefined;
	let resolvedPrompt: string | undefined = prompt;

	// 3. Apply SSH wrapping when the agent's session has SSH remote enabled
	const sshConfig = sessionConfig.sessionSshRemoteConfig;
	if (sshConfig?.enabled && sshStore) {
		const sshWrapped = await wrapSpawnWithSsh(
			{
				command: resolvedCommand,
				args: resolvedArgs,
				cwd: resolvedCwd,
				prompt: resolvedPrompt,
				customEnvVars: resolvedEnvVars,
				promptArgs: agentDef.promptArgs,
				noPromptSeparator: agentDef.noPromptSeparator,
				agentBinaryName: agentDef.binaryName,
			},
			sshConfig,
			sshStore
		);
		resolvedCommand = sshWrapped.command;
		resolvedArgs = sshWrapped.args;
		resolvedCwd = sshWrapped.cwd;
		resolvedPrompt = sshWrapped.prompt;
		resolvedEnvVars = sshWrapped.customEnvVars;
		sshStdinScript = sshWrapped.sshStdinScript;
	} else if (sshConfig?.enabled && !sshStore) {
		logger.warn(
			'SSH remote is enabled for slot agent but sshStore is unavailable — spawning locally',
			LOG_CONTEXT,
			{ agentId, role, workItemId }
		);
	}

	// 4. Spawn — emit claimStarted before spawning so the renderer shows the
	//    active state even while the process is initialising.
	const claimedAt = new Date().toISOString();
	const claimStartedPayload = {
		projectPath: workItem.projectPath,
		role,
		agentId,
		sessionId: dispatchSessionId,
		issueNumber: workItem.github?.issueNumber,
		issueTitle: workItem.title,
		claimedAt,
	};
	safeSendToRenderer('agentDispatch:claimStarted', claimStartedPayload);
	// Also push to web/mobile clients (#448).
	_onClaimStarted?.({
		projectPath: workItem.projectPath,
		role,
		issueNumber: workItem.github?.issueNumber,
		issueTitle: workItem.title,
		claimedAt,
	});

	auditLog({
		kind: 'spawn-start',
		workItemId,
		role,
		agentId,
		sessionId: dispatchSessionId,
		detail: `model=${effectiveModel ?? 'default'} effort=${effectiveEffort ?? 'default'} cwd=${resolvedCwd}`,
		timestamp: new Date().toISOString(),
	});

	logger.info('SlotExecutor: spawning agent for work item', LOG_CONTEXT, {
		dispatchSessionId,
		agentId,
		toolType: sessionConfig.toolType,
		role,
		workItemId,
		cwd: resolvedCwd,
		ssh: sshConfig?.enabled ?? false,
	});

	let spawnSuccess = false;
	let spawnError: string | undefined;

	try {
		const spawnResult = processManager.spawn({
			sessionId: dispatchSessionId,
			toolType: sessionConfig.toolType,
			cwd: resolvedCwd,
			command: resolvedCommand,
			args: resolvedArgs,
			prompt: resolvedPrompt,
			promptArgs: agentDef.promptArgs,
			noPromptSeparator: agentDef.noPromptSeparator,
			customEnvVars: resolvedEnvVars,
			sshStdinScript,
		});

		if (!spawnResult || spawnResult.pid === -1) {
			throw new Error('processManager.spawn returned no PID — process did not start');
		}

		// 5. Wait for the process to exit
		await new Promise<void>((resolve, reject) => {
			const onExit = (...args: unknown[]) => {
				const [eventSessionId, exitCode] = args as [string, number];
				if (eventSessionId !== dispatchSessionId) return;
				processManager.off('exit', onExit);
				processManager.off('agent-error', onError);
				if (exitCode === 0) {
					resolve();
				} else {
					reject(new Error(`Agent exited with code ${exitCode}`));
				}
			};

			const onError = (...args: unknown[]) => {
				const [eventSessionId, errorObj] = args as [string, { message?: string }];
				if (eventSessionId !== dispatchSessionId) return;
				processManager.off('exit', onExit);
				processManager.off('agent-error', onError);
				reject(new Error(errorObj?.message ?? 'Agent error'));
			};

			processManager.on('exit', onExit);
			processManager.on('agent-error', onError);
		});

		spawnSuccess = true;
		auditLog({
			kind: 'spawn-complete',
			workItemId,
			role,
			agentId,
			sessionId: dispatchSessionId,
			detail: 'Agent completed successfully',
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		spawnSuccess = false;
		spawnError = err instanceof Error ? err.message : String(err);
		auditLog({
			kind: 'spawn-error',
			workItemId,
			role,
			agentId,
			sessionId: dispatchSessionId,
			detail: spawnError,
			timestamp: new Date().toISOString(),
		});
		logger.warn('SlotExecutor: agent spawn failed', LOG_CONTEXT, {
			dispatchSessionId,
			workItemId,
			error: spawnError,
		});
	}

	// 6. Advance pipeline + release claim
	const actor: WorkGraphActor = {
		type: 'system',
		id: `dispatch-${role}-${claimId}`,
		name: `Dispatch ${role} agent (${agentId})`,
		agentId: undefined,
	};

	try {
		await advancePipeline(workItem, spawnSuccess ? 'complete' : 'fail', actor);
		auditLog({
			kind: 'pipeline-advanced',
			workItemId,
			role,
			agentId,
			detail: spawnSuccess ? 'complete' : 'fail',
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		logger.warn('SlotExecutor: failed to advance pipeline', LOG_CONTEXT, {
			workItemId,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	try {
		await releaseClaim(workItemId, {
			note: spawnSuccess
				? `Dispatch ${role} agent completed successfully`
				: `Dispatch ${role} agent failed: ${spawnError ?? 'unknown error'}`,
			actor,
		});
		auditLog({
			kind: 'claim-released',
			workItemId,
			role,
			agentId,
			timestamp: new Date().toISOString(),
		});
	} catch (err) {
		logger.warn('SlotExecutor: failed to release claim', LOG_CONTEXT, {
			workItemId,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// Emit claimEnded regardless of success/failure so the renderer clears the
	// active state.  exitCode is 0 for clean exits, non-zero otherwise.
	safeSendToRenderer('agentDispatch:claimEnded', {
		projectPath: workItem.projectPath,
		role,
		agentId,
		sessionId: dispatchSessionId,
		exitCode: spawnSuccess ? 0 : 1,
	});
	// Also push to web/mobile clients (#448).
	_onClaimEnded?.({ projectPath: workItem.projectPath, role });

	return { success: spawnSuccess, error: spawnError };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(template: string, workItem: WorkItem): string {
	const parts: string[] = [template.trim()];

	parts.push('');
	parts.push('## Work Item');
	parts.push(`**Title:** ${workItem.title}`);
	if (workItem.description) {
		parts.push('');
		parts.push(workItem.description);
	}
	if (workItem.github?.url) {
		parts.push('');
		parts.push(`**GitHub:** ${workItem.github.url}`);
	}
	if (workItem.projectPath) {
		parts.push('');
		parts.push(`**Project:** ${workItem.projectPath}`);
	}

	return parts.join('\n');
}
