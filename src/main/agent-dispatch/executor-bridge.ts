/**
 * Executor Bridge
 *
 * Connects the Agent Dispatch Engine's `executeClaim` callback to the two
 * execution back-ends available in Maestro:
 *
 * 1. **Auto Run / playbook trigger** — when the fleet entry's agent profile
 *    does NOT configure an external `runnerScriptPath` and the session has a
 *    matching playbook available, dispatch fires the work item as an Auto Run
 *    playbook trigger.
 *
 * 2. **External runner script** — when the fleet entry's agent profile
 *    specifies a `runnerScriptPath`, the claim is executed via
 *    `invokeRunnerScript`. SSH-remote entries pass the call through
 *    `wrapSpawnWithSsh` automatically. If no `runnerScriptPath` is configured
 *    the bridge returns a `RUNNER_SCRIPT_NOT_CONFIGURED` failure.
 *
 * Worktree ownership is recorded on every claim so that at most one runner
 * owns a given `(workItemId, agentId)` pair at a time. Attempting to execute
 * while ownership is already held is a no-op (the claim is retained).
 *
 * Runner failures are treated as lifecycle events and do NOT silently release
 * the claim — the caller is responsible for deciding the next step (retry,
 * escalate, or release).
 *
 * Wire into `AgentDispatchRuntime` by passing `createExecutorBridge(deps)` as
 * the `executeClaim` option when constructing the `AgentDispatchEngine`:
 *
 * ```ts
 * const bridge = createExecutorBridge({ publishWorkGraphEvent, sshStore });
 * const engine = new AgentDispatchEngine({
 *   workGraph,
 *   fleetRegistry,
 *   executeClaim: bridge.execute,
 * });
 * ```
 */

import type { AutoPickupExecution } from './dispatch-engine';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import { invokeRunnerScript, resolveRunnerScriptPath } from './runner-script-bridge';
import { logger } from '../utils/logger';
import * as fs from 'fs';

const LOG_CONTEXT = '[ExecutorBridge]';

// ---------------------------------------------------------------------------
// Worktree ownership registry
// ---------------------------------------------------------------------------

/**
 * Key format: `<workItemId>::<agentId>`.
 *
 * The registry is process-local (in-memory). If the main process restarts the
 * ownership table is reset; active DB claims from the Work Graph are the
 * authoritative source of truth for cross-restart ownership.
 */
const worktreeOwnership = new Map<string, WorktreeOwnershipRecord>();

export interface WorktreeOwnershipRecord {
	key: string;
	workItemId: string;
	agentId: string;
	entryId: string;
	claimedAt: string;
	executionMode: 'auto-run' | 'runner-script';
	runnerScriptPath?: string;
	usedSsh: boolean;
}

function ownershipKey(workItemId: string, agentId: string): string {
	return `${workItemId}::${agentId}`;
}

/** Returns `true` if the `(workItemId, agentId)` pair is already owned. */
export function isWorktreeOwned(workItemId: string, agentId: string): boolean {
	return worktreeOwnership.has(ownershipKey(workItemId, agentId));
}

/** Returns the ownership record, or `undefined` if not currently owned. */
export function getWorktreeOwnership(
	workItemId: string,
	agentId: string
): WorktreeOwnershipRecord | undefined {
	return worktreeOwnership.get(ownershipKey(workItemId, agentId));
}

/** Release ownership when execution completes or fails. */
export function releaseWorktreeOwnership(workItemId: string, agentId: string): boolean {
	return worktreeOwnership.delete(ownershipKey(workItemId, agentId));
}

/** Snapshot of all currently owned worktrees (copy — safe to mutate). */
export function listWorktreeOwnerships(): WorktreeOwnershipRecord[] {
	return [...worktreeOwnership.values()];
}

// ---------------------------------------------------------------------------
// Auto Run trigger
// ---------------------------------------------------------------------------

/**
 * Shape injected for Auto Run / playbook trigger support. The bridge uses this
 * narrow interface rather than depending on the full IPC surface.
 */
export interface AutoRunTrigger {
	/**
	 * Trigger an Auto Run cycle for the given session, passing the work item
	 * description as context. Returns `true` if the trigger was accepted.
	 */
	triggerAutoRun(sessionId: string, workItemId: string, context: AutoRunContext): Promise<boolean>;
}

export interface AutoRunContext {
	workItemTitle: string;
	workItemDescription?: string;
	workItemProjectPath: string;
	capabilityTags: string[];
}

// ---------------------------------------------------------------------------
// Executor Bridge
// ---------------------------------------------------------------------------

export interface ExecutorBridgeDeps {
	/**
	 * Settings store for resolving SSH remote configurations.
	 * Required when any fleet entry may execute on a remote host.
	 */
	sshStore?: SshRemoteSettingsStore;
	/**
	 * Optional Auto Run trigger — when provided and the work item matches a
	 * playbook, the bridge prefers Auto Run over the runner script.
	 */
	autoRunTrigger?: AutoRunTrigger;
}

export interface ExecutorBridgeResult {
	mode: 'auto-run' | 'runner-script' | 'skipped';
	success: boolean;
	/** Set when `mode === 'runner-script'`. */
	exitCode?: number | string;
	/** Human-readable message for logging / lifecycle event payloads. */
	message: string;
	ownership?: WorktreeOwnershipRecord;
}

export interface ExecutorBridge {
	execute(execution: AutoPickupExecution): Promise<void>;
	getOwnership(workItemId: string, agentId: string): WorktreeOwnershipRecord | undefined;
	listOwnerships(): WorktreeOwnershipRecord[];
	releaseOwnership(workItemId: string, agentId: string): boolean;
}

/**
 * Create an executor bridge bound to the supplied dependencies.
 *
 * The returned `execute` function is suitable for direct assignment to
 * `AgentDispatchEngine`'s `executeClaim` option.
 */
export function createExecutorBridge(deps: ExecutorBridgeDeps = {}): ExecutorBridge {
	async function execute(execution: AutoPickupExecution): Promise<void> {
		const { decision, claimedItem } = execution;
		const { agent } = decision;
		const workItemId = claimedItem.id;
		const agentId = agent.agentId;

		// --- Guard: exclusive worktree ownership ---
		const key = ownershipKey(workItemId, agentId);
		if (worktreeOwnership.has(key)) {
			logger.warn(
				'Skipping executor: worktree already owned for this (workItemId, agentId) pair',
				LOG_CONTEXT,
				{ workItemId, agentId, entryId: agent.id }
			);
			return;
		}

		// --- Decide execution mode ---
		const mode = resolveExecutionMode(agent, deps);

		logger.info('Executor bridge starting', LOG_CONTEXT, {
			workItemId,
			agentId,
			entryId: agent.id,
			mode,
			locality: agent.locality,
		});

		// --- Record ownership before execution starts ---
		const record: WorktreeOwnershipRecord = {
			key,
			workItemId,
			agentId,
			entryId: agent.id,
			claimedAt: new Date().toISOString(),
			executionMode: mode,
			usedSsh: agent.locality === 'ssh',
			runnerScriptPath:
				mode === 'runner-script' ? (resolveRunnerScriptPath(agent) ?? undefined) : undefined,
		};
		worktreeOwnership.set(key, record);

		try {
			const result = await dispatchExecution(mode, execution, deps);

			logger.info('Executor bridge completed', LOG_CONTEXT, {
				workItemId,
				agentId,
				mode: result.mode,
				success: result.success,
				message: result.message,
			});

			if (!result.success) {
				logger.warn(
					'Executor bridge execution failed — claim retained for caller review',
					LOG_CONTEXT,
					{
						workItemId,
						agentId,
						exitCode: result.exitCode,
						message: result.message,
					}
				);
			}
		} finally {
			worktreeOwnership.delete(key);
		}
	}

	return {
		execute,
		getOwnership: getWorktreeOwnership,
		listOwnerships: listWorktreeOwnerships,
		releaseOwnership: releaseWorktreeOwnership,
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ExecutionMode = 'auto-run' | 'runner-script';

function resolveExecutionMode(
	agent: AutoPickupExecution['decision']['agent'],
	deps: ExecutorBridgeDeps
): ExecutionMode {
	// Prefer Auto Run when a trigger is available and the entry runs locally
	if (deps.autoRunTrigger && agent.sessionId) {
		return 'auto-run';
	}

	return 'runner-script';
}

async function dispatchExecution(
	mode: ExecutionMode,
	execution: AutoPickupExecution,
	deps: ExecutorBridgeDeps
): Promise<ExecutorBridgeResult> {
	const { decision, claimedItem } = execution;
	const { agent } = decision;

	if (mode === 'auto-run') {
		return dispatchAutoRun(agent, claimedItem, deps);
	}

	return dispatchRunnerScript(agent, claimedItem, deps);
}

async function dispatchAutoRun(
	agent: AutoPickupExecution['decision']['agent'],
	workItem: AutoPickupExecution['claimedItem'],
	deps: ExecutorBridgeDeps
): Promise<ExecutorBridgeResult> {
	const trigger = deps.autoRunTrigger!;
	const sessionId = agent.sessionId!;

	try {
		const accepted = await trigger.triggerAutoRun(sessionId, workItem.id, {
			workItemTitle: workItem.title,
			workItemDescription: workItem.description,
			workItemProjectPath: workItem.projectPath,
			capabilityTags: agent.dispatchCapabilities,
		});

		if (accepted) {
			return {
				mode: 'auto-run',
				success: true,
				message: `Auto Run triggered for session ${sessionId}`,
			};
		}

		// Trigger was not accepted — fall through to runner script if available
		logger.info('Auto Run trigger not accepted, falling through to runner script', LOG_CONTEXT, {
			workItemId: workItem.id,
			sessionId,
		});
		return dispatchRunnerScript(agent, workItem, deps);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn('Auto Run trigger threw an error — falling through to runner script', LOG_CONTEXT, {
			workItemId: workItem.id,
			sessionId,
			error: message,
		});
		return dispatchRunnerScript(agent, workItem, deps);
	}
}

async function dispatchRunnerScript(
	agent: AutoPickupExecution['decision']['agent'],
	workItem: AutoPickupExecution['claimedItem'],
	deps: ExecutorBridgeDeps
): Promise<ExecutorBridgeResult> {
	// Validate that the script is configured and exists before trying to exec it
	// (local path only; for SSH we trust the remote path is configured correctly).
	if (agent.locality === 'local') {
		const scriptPath = resolveRunnerScriptPath(agent);
		if (scriptPath === null) {
			const msg = `No runner script configured for fleet entry ${agent.id} — set dispatchProfile.runnerScriptPath to enable external runner execution`;
			logger.warn(msg, LOG_CONTEXT, {
				workItemId: workItem.id,
				agentId: agent.agentId,
			});
			return {
				mode: 'runner-script',
				success: false,
				exitCode: 'RUNNER_SCRIPT_NOT_CONFIGURED',
				message: msg,
			};
		}
		if (!runnerScriptExists(scriptPath)) {
			const msg = `Runner script not found at ${scriptPath} — no executor available for work item ${workItem.id}`;
			logger.warn(msg, LOG_CONTEXT, {
				workItemId: workItem.id,
				agentId: agent.agentId,
				scriptPath,
			});
			return {
				mode: 'runner-script',
				success: false,
				exitCode: 'ENOENT',
				message: msg,
			};
		}
	}

	const result = await invokeRunnerScript(agent, workItem, { sshStore: deps.sshStore });

	return {
		mode: 'runner-script',
		success: result.success,
		exitCode: result.exitCode,
		message: result.success
			? `Runner script completed (exit 0) for work item ${workItem.id}`
			: `Runner script failed (exit ${result.exitCode}) for work item ${workItem.id}: ${result.stderr.slice(0, 200)}`,
	};
}

/** Check whether the runner script file exists on the local filesystem. */
function runnerScriptExists(scriptPath: string): boolean {
	try {
		fs.accessSync(scriptPath);
		return true;
	} catch {
		return false;
	}
}
