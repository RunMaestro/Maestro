/**
 * Cue Executor — spawns background agent processes when Cue triggers fire.
 *
 * Reads prompt files, substitutes Cue-specific template variables, spawns the
 * agent process, captures output, enforces timeouts, and records history entries.
 * Follows the same spawn pattern as Auto Run (via process:spawn IPC handler).
 */

import { spawn, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CueEvent, CueRunResult, CueRunStatus, CueSubscription } from './cue-types';
import type { HistoryEntry, SessionInfo } from '../../shared/types';
import { substituteTemplateVariables, type TemplateContext } from '../../shared/templateVariables';
import { getAgentDefinition, getAgentCapabilities } from '../agents';
import { buildAgentArgs, applyAgentConfigOverrides } from '../utils/agent-args';
import { wrapSpawnWithSsh, type SshSpawnWrapConfig } from '../utils/ssh-spawn-wrapper';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';

const SIGKILL_DELAY_MS = 5000;
const MAX_HISTORY_RESPONSE_LENGTH = 10000;

/** Configuration for executing a Cue-triggered prompt */
export interface CueExecutionConfig {
	runId: string;
	session: SessionInfo;
	subscription: CueSubscription;
	event: CueEvent;
	promptPath: string;
	toolType: string;
	projectRoot: string;
	templateContext: TemplateContext;
	timeoutMs: number;
	sshRemoteConfig?: { enabled: boolean; remoteId: string | null };
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	onLog: (level: string, message: string) => void;
	/** Optional SSH settings store for SSH remote execution */
	sshStore?: SshRemoteSettingsStore;
	/** Optional agent-level config values (from agent config store) */
	agentConfigValues?: Record<string, unknown>;
}

/** Map of active Cue processes by runId */
const activeProcesses = new Map<string, ChildProcess>();

/**
 * Execute a Cue-triggered prompt by spawning an agent process.
 *
 * Steps:
 * 1. Resolve and read the prompt file
 * 2. Populate template context with Cue event data
 * 3. Substitute template variables
 * 4. Build agent spawn args (same pattern as process:spawn)
 * 5. Apply SSH wrapping if configured
 * 6. Spawn the process, capture stdout/stderr
 * 7. Enforce timeout with SIGTERM → SIGKILL escalation
 * 8. Return CueRunResult
 */
export async function executeCuePrompt(config: CueExecutionConfig): Promise<CueRunResult> {
	const {
		runId,
		session,
		subscription,
		event,
		promptPath,
		toolType,
		projectRoot,
		templateContext,
		timeoutMs,
		sshRemoteConfig,
		customPath,
		customArgs,
		customEnvVars,
		customModel,
		onLog,
		sshStore,
		agentConfigValues,
	} = config;

	const startedAt = new Date().toISOString();
	const startTime = Date.now();

	// 1. Resolve the prompt path
	const resolvedPath = path.isAbsolute(promptPath)
		? promptPath
		: path.join(projectRoot, promptPath);

	// 2. Read the prompt file
	let promptContent: string;
	try {
		promptContent = fs.readFileSync(resolvedPath, 'utf-8');
	} catch (error) {
		const message = `Failed to read prompt file: ${resolvedPath} - ${error instanceof Error ? error.message : String(error)}`;
		onLog('error', message);
		return {
			runId,
			sessionId: session.id,
			sessionName: session.name,
			subscriptionName: subscription.name,
			event,
			status: 'failed',
			stdout: '',
			stderr: message,
			exitCode: null,
			durationMs: Date.now() - startTime,
			startedAt,
			endedAt: new Date().toISOString(),
		};
	}

	// 3. Populate the template context with Cue event data
	templateContext.cue = {
		eventType: event.type,
		eventTimestamp: event.timestamp,
		triggerName: subscription.name,
		runId,
		filePath: String(event.payload.path ?? ''),
		fileName: String(event.payload.filename ?? ''),
		fileDir: String(event.payload.directory ?? ''),
		fileExt: String(event.payload.extension ?? ''),
		sourceSession: String(event.payload.sourceSession ?? ''),
		sourceOutput: String(event.payload.sourceOutput ?? ''),
	};

	// 4. Substitute template variables
	const substitutedPrompt = substituteTemplateVariables(promptContent, templateContext);

	// 5. Look up agent definition and build args
	const agentDef = getAgentDefinition(toolType);
	if (!agentDef) {
		const message = `Unknown agent type: ${toolType}`;
		onLog('error', message);
		return {
			runId,
			sessionId: session.id,
			sessionName: session.name,
			subscriptionName: subscription.name,
			event,
			status: 'failed',
			stdout: '',
			stderr: message,
			exitCode: null,
			durationMs: Date.now() - startTime,
			startedAt,
			endedAt: new Date().toISOString(),
		};
	}

	// Build args following the same pipeline as process:spawn
	// Cast to AgentConfig-like shape with available/path/capabilities for buildAgentArgs
	const agentConfig = {
		...agentDef,
		available: true,
		path: customPath || agentDef.command,
		capabilities: getAgentCapabilities(toolType),
	};

	let finalArgs = buildAgentArgs(agentConfig, {
		baseArgs: agentDef.args,
		prompt: substitutedPrompt,
		cwd: projectRoot,
		yoloMode: true, // Cue runs always use YOLO mode like Auto Run
	});

	// Apply config overrides (custom model, custom args, custom env vars)
	const configResolution = applyAgentConfigOverrides(agentConfig, finalArgs, {
		agentConfigValues: (agentConfigValues ?? {}) as Record<string, any>,
		sessionCustomModel: customModel,
		sessionCustomArgs: customArgs,
		sessionCustomEnvVars: customEnvVars,
	});
	finalArgs = configResolution.args;
	const effectiveEnvVars = configResolution.effectiveCustomEnvVars;

	// Determine the command to use
	let command = customPath || agentDef.command;

	// 6. Apply SSH wrapping if configured
	let spawnArgs = finalArgs;
	let spawnCwd = projectRoot;
	let spawnEnvVars = effectiveEnvVars;
	let prompt: string | undefined = substitutedPrompt;

	if (sshRemoteConfig?.enabled && sshStore) {
		const sshWrapConfig: SshSpawnWrapConfig = {
			command,
			args: finalArgs,
			cwd: projectRoot,
			prompt: substitutedPrompt,
			customEnvVars: effectiveEnvVars,
			agentBinaryName: agentDef.binaryName,
			promptArgs: agentDef.promptArgs,
			noPromptSeparator: agentDef.noPromptSeparator,
		};

		const sshResult = await wrapSpawnWithSsh(sshWrapConfig, sshRemoteConfig, sshStore);
		command = sshResult.command;
		spawnArgs = sshResult.args;
		spawnCwd = sshResult.cwd;
		spawnEnvVars = sshResult.customEnvVars;
		prompt = sshResult.prompt;

		if (sshResult.sshRemoteUsed) {
			onLog(
				'cue',
				`[CUE] Using SSH remote: ${sshResult.sshRemoteUsed.name || sshResult.sshRemoteUsed.host}`
			);
		}
	}

	// 7. Spawn the process
	onLog('cue', `[CUE] Executing run ${runId}: "${subscription.name}" → ${command} (${event.type})`);

	return new Promise<CueRunResult>((resolve) => {
		const env = {
			...process.env,
			...(spawnEnvVars || {}),
		};

		const child = spawn(command, spawnArgs, {
			cwd: spawnCwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		activeProcesses.set(runId, child);

		let stdout = '';
		let stderr = '';
		let settled = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = (status: CueRunStatus, exitCode: number | null) => {
			if (settled) return;
			settled = true;

			activeProcesses.delete(runId);
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);

			resolve({
				runId,
				sessionId: session.id,
				sessionName: session.name,
				subscriptionName: subscription.name,
				event,
				status,
				stdout,
				stderr,
				exitCode,
				durationMs: Date.now() - startTime,
				startedAt,
				endedAt: new Date().toISOString(),
			});
		};

		// Capture stdout
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (data: string) => {
			stdout += data;
		});

		// Capture stderr
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (data: string) => {
			stderr += data;
		});

		// Handle process exit
		child.on('close', (code) => {
			const status: CueRunStatus = code === 0 ? 'completed' : 'failed';
			finish(status, code);
		});

		// Handle spawn errors
		child.on('error', (error) => {
			stderr += `\nSpawn error: ${error.message}`;
			finish('failed', null);
		});

		// Write prompt to stdin if not embedded in args
		// For agents with promptArgs (like OpenCode -p), the prompt is in the args
		// For others (like Claude --print), if prompt was passed via args separator, skip stdin
		// When SSH wrapping returns a prompt, it means "send via stdin"
		if (prompt && sshRemoteConfig?.enabled) {
			// SSH large prompt mode — send via stdin
			child.stdin?.write(prompt);
			child.stdin?.end();
		} else {
			// Local mode — prompt is already in the args (via buildAgentArgs)
			child.stdin?.end();
		}

		// 8. Enforce timeout
		if (timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				if (settled) return;
				onLog('cue', `[CUE] Run ${runId} timed out after ${timeoutMs}ms, sending SIGTERM`);
				child.kill('SIGTERM');

				// Escalate to SIGKILL after delay
				killTimer = setTimeout(() => {
					if (settled) return;
					onLog('cue', `[CUE] Run ${runId} still alive, sending SIGKILL`);
					child.kill('SIGKILL');
				}, SIGKILL_DELAY_MS);

				// If the process exits after SIGTERM, mark as timeout
				child.removeAllListeners('close');
				child.on('close', (code) => {
					finish('timeout', code);
				});
			}, timeoutMs);
		}
	});
}

/**
 * Stop a running Cue process by runId.
 * Sends SIGTERM, then SIGKILL after 5 seconds.
 *
 * @returns true if the process was found and signaled, false if not found
 */
export function stopCueRun(runId: string): boolean {
	const child = activeProcesses.get(runId);
	if (!child) return false;

	child.kill('SIGTERM');

	// Escalate to SIGKILL after delay
	setTimeout(() => {
		if (!child.killed) {
			child.kill('SIGKILL');
		}
	}, SIGKILL_DELAY_MS);

	return true;
}

/**
 * Get the map of currently active processes (for testing/monitoring).
 */
export function getActiveProcesses(): Map<string, ChildProcess> {
	return activeProcesses;
}

/**
 * Construct a HistoryEntry for a completed Cue run.
 *
 * Follows the same pattern as Auto Run's history recording with type: 'AUTO',
 * but uses type: 'CUE' and populates Cue-specific fields.
 */
export function recordCueHistoryEntry(result: CueRunResult, session: SessionInfo): HistoryEntry {
	const fullResponse =
		result.stdout.length > MAX_HISTORY_RESPONSE_LENGTH
			? result.stdout.substring(0, MAX_HISTORY_RESPONSE_LENGTH)
			: result.stdout;

	return {
		id: crypto.randomUUID(),
		type: 'CUE',
		timestamp: Date.now(),
		summary: `[CUE] "${result.subscriptionName}" (${result.event.type})`,
		fullResponse: fullResponse || undefined,
		projectPath: session.projectRoot || session.cwd,
		sessionId: session.id,
		sessionName: session.name,
		success: result.status === 'completed',
		elapsedTimeMs: result.durationMs,
		cueTriggerName: result.subscriptionName,
		cueEventType: result.event.type,
		cueSourceSession: result.event.payload.sourceSession
			? String(result.event.payload.sourceSession)
			: undefined,
	};
}
