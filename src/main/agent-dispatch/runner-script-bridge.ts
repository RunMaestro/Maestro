/**
 * Runner Script Bridge
 *
 * Invokes an external runner script for a dispatched work item. The runner
 * script path MUST be set via `dispatchProfile.runnerScriptPath` on the fleet
 * entry's agent profile. There is no default path — omitting the field causes
 * `invokeRunnerScript` to return a structured `RUNNER_SCRIPT_NOT_CONFIGURED`
 * failure without executing anything.
 *
 * Execution is always via `execFileNoThrow` — no shell expansion. SSH-remote
 * fleet entries wrap the invocation through `wrapSpawnWithSsh` before calling
 * the script, so the runner executes on the correct host.
 *
 * The runner script is called with:
 *   <script> <workItemId> <agentId> <sessionId> [<projectPath>]
 *
 * A non-zero exit code is treated as a runner failure and surfaces as a
 * structured result — callers are responsible for deciding whether to release
 * or retain the claim.
 */

import * as path from 'path';
import type { AgentDispatchFleetEntry } from '../../shared/agent-dispatch-types';
import type { WorkItem } from '../../shared/work-graph-types';
import { execFileNoThrow } from '../utils/execFile';
import { wrapSpawnWithSsh } from '../utils/ssh-spawn-wrapper';
import { createSshRemoteStoreAdapter } from '../utils/ssh-remote-resolver';
import { logger } from '../utils/logger';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';

const DEFAULT_RUNNER_SCRIPT_NAME = 'run.sh';
const LOG_CONTEXT = '[RunnerScriptBridge]';

/**
 * Timeout for a single runner script invocation (10 minutes).
 * Long-running tasks should signal progress via work-graph updates rather than
 * running for longer than this window.
 */
const RUNNER_TIMEOUT_MS = 10 * 60 * 1000;

export interface RunnerScriptBridgeDeps {
	/**
	 * Settings store — only required for SSH-remote fleet entries. If omitted
	 * and the entry has SSH enabled, the invocation is rejected.
	 */
	sshStore?: SshRemoteSettingsStore;
}

export interface RunnerScriptResult {
	success: boolean;
	exitCode: number | string;
	stdout: string;
	stderr: string;
	/** Absolute path of the script that was invoked. */
	scriptPath: string;
	/** Whether the execution ran via SSH remote. */
	usedSsh: boolean;
}

/**
 * Resolve the absolute path of the runner script for a fleet entry.
 *
 * Returns the configured `dispatchProfile.runnerScriptPath` value, or `null`
 * when no path has been set. Bare directory paths (no file extension) get the
 * default script name (`run.sh`) appended automatically.
 *
 * Callers MUST handle the `null` case — `invokeRunnerScript` will return a
 * `RUNNER_SCRIPT_NOT_CONFIGURED` failure result when no path is configured.
 */
export function resolveRunnerScriptPath(entry: AgentDispatchFleetEntry): string | null {
	const profile = entry.dispatchProfile as unknown as Record<string, unknown>;
	const configured =
		typeof profile.runnerScriptPath === 'string' ? profile.runnerScriptPath : undefined;

	if (!configured) {
		return null;
	}

	// Allow bare directory paths — append the default script name
	if (!path.extname(configured)) {
		return path.join(configured, DEFAULT_RUNNER_SCRIPT_NAME);
	}
	return configured;
}

/**
 * Invoke the runner script for the given fleet entry and work item.
 *
 * For SSH-remote entries the script arguments are forwarded through the SSH
 * wrapper so the script runs on the remote host. The `sshStore` dependency is
 * required in that case — omitting it causes an immediate failure result.
 */
export async function invokeRunnerScript(
	entry: AgentDispatchFleetEntry,
	workItem: WorkItem,
	deps: RunnerScriptBridgeDeps = {}
): Promise<RunnerScriptResult> {
	const scriptPath = resolveRunnerScriptPath(entry);

	if (scriptPath === null) {
		const msg = `No runner script configured for fleet entry ${entry.id} — set dispatchProfile.runnerScriptPath to use external runner execution`;
		logger.warn(msg, LOG_CONTEXT, { workItemId: workItem.id, agentId: entry.agentId });
		return {
			success: false,
			exitCode: 'RUNNER_SCRIPT_NOT_CONFIGURED',
			stdout: '',
			stderr: msg,
			scriptPath: '',
			usedSsh: false,
		};
	}

	const args = buildRunnerArgs(entry, workItem);

	logger.info('Invoking runner script', LOG_CONTEXT, {
		scriptPath,
		workItemId: workItem.id,
		agentId: entry.agentId,
		sessionId: entry.sessionId,
		locality: entry.locality,
	});

	const isSshRemote = entry.locality === 'ssh' && entry.sshRemote?.enabled !== false;

	if (isSshRemote) {
		return invokeRunnerScriptSsh(entry, workItem, scriptPath, args, deps);
	}

	const result = await execFileNoThrow(scriptPath, args, undefined, {
		timeout: RUNNER_TIMEOUT_MS,
	});

	const success = result.exitCode === 0;
	if (!success) {
		logger.warn('Runner script exited with failure', LOG_CONTEXT, {
			scriptPath,
			exitCode: result.exitCode,
			stderr: result.stderr.slice(0, 500),
			workItemId: workItem.id,
		});
	} else {
		logger.info('Runner script completed successfully', LOG_CONTEXT, {
			scriptPath,
			workItemId: workItem.id,
		});
	}

	return {
		success,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		scriptPath,
		usedSsh: false,
	};
}

async function invokeRunnerScriptSsh(
	entry: AgentDispatchFleetEntry,
	workItem: WorkItem,
	scriptPath: string,
	args: string[],
	deps: RunnerScriptBridgeDeps
): Promise<RunnerScriptResult> {
	const sshRemote = entry.sshRemote;

	if (!sshRemote?.id) {
		const msg = `SSH-remote fleet entry ${entry.id} is missing sshRemote.id — cannot invoke runner script`;
		logger.error(msg, LOG_CONTEXT, { workItemId: workItem.id });
		return {
			success: false,
			exitCode: 'SSH_CONFIG_MISSING',
			stdout: '',
			stderr: msg,
			scriptPath,
			usedSsh: false,
		};
	}

	if (!deps.sshStore) {
		const msg = `sshStore is required for SSH-remote runner script invocation (entry ${entry.id})`;
		logger.error(msg, LOG_CONTEXT, { workItemId: workItem.id });
		return {
			success: false,
			exitCode: 'SSH_STORE_MISSING',
			stdout: '',
			stderr: msg,
			scriptPath,
			usedSsh: false,
		};
	}

	const sessionSshConfig = {
		enabled: true,
		remoteId: sshRemote.id,
		workingDirOverride: sshRemote.workingDirOverride,
	};

	const wrapped = await wrapSpawnWithSsh(
		{
			command: scriptPath,
			args,
			cwd: workItem.projectPath || '/',
			agentBinaryName: path.basename(scriptPath),
		},
		sessionSshConfig,
		deps.sshStore
	);

	if (!wrapped.sshRemoteUsed) {
		// SSH config resolved but the remote was not active — fall back to local
		logger.warn('SSH remote not resolved, falling back to local runner script', LOG_CONTEXT, {
			remoteId: sshRemote.id,
			workItemId: workItem.id,
		});
		const result = await execFileNoThrow(scriptPath, args, undefined, {
			timeout: RUNNER_TIMEOUT_MS,
		});
		return {
			success: result.exitCode === 0,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			scriptPath,
			usedSsh: false,
		};
	}

	const result = await execFileNoThrow(wrapped.command, wrapped.args, wrapped.cwd, {
		timeout: RUNNER_TIMEOUT_MS,
	});

	const success = result.exitCode === 0;
	if (!success) {
		logger.warn('SSH runner script exited with failure', LOG_CONTEXT, {
			scriptPath,
			remoteId: sshRemote.id,
			exitCode: result.exitCode,
			stderr: result.stderr.slice(0, 500),
			workItemId: workItem.id,
		});
	}

	return {
		success,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		scriptPath,
		usedSsh: true,
	};
}

function buildRunnerArgs(entry: AgentDispatchFleetEntry, workItem: WorkItem): string[] {
	// Positional args: workItemId agentId sessionId [projectPath]
	const args = [workItem.id, entry.agentId, entry.sessionId ?? entry.id];
	if (workItem.projectPath) {
		args.push(workItem.projectPath);
	}
	return args;
}

/**
 * Create a `SshRemoteSettingsStore` from an electron-store compatible object.
 * Re-exported here for convenience so callers don't need to import from the
 * resolver module directly.
 */
export { createSshRemoteStoreAdapter };
