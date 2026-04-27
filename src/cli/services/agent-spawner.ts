// Agent spawner service for CLI
// Spawns agent CLIs and parses their output

import { spawn, SpawnOptions, ChildProcess } from 'child_process';
import * as fs from 'fs';
import type { AgentSshRemoteConfig, ToolType, UsageStats } from '../../shared/types';
import { createOutputParser } from '../../main/parsers/parser-factory';
import { aggregateModelUsage } from '../../main/parsers/usage-aggregator';
import { getAgentDefinition } from '../../main/agents/definitions';
import { hasCapability } from '../../main/agents/capabilities';
import { getAgentCustomPath, readAgentConfig, readSshRemotes } from './storage';
import { generateUUID } from '../../shared/uuid';
import { buildExpandedPath, buildExpandedEnv } from '../../shared/pathUtils';
import { isWindows, getWhichCommand } from '../../shared/platformDetection';
import { applyAgentConfigOverrides } from '../../main/utils/agent-args';

// Types from the SSH wrapper are imported type-only so no runtime module load
// happens for non-SSH sessions — the SSH chain pulls in execFile/which helpers
// that aren't needed when a session runs locally. The wrapSpawnWithSsh
// implementation is dynamically imported inside maybeWrapSpawnWithSsh().
type SshSpawnWrapConfig = import('../../main/utils/ssh-spawn-wrapper').SshSpawnWrapConfig;
type SshSpawnWrapResult = import('../../main/utils/ssh-spawn-wrapper').SshSpawnWrapResult;

async function maybeWrapSpawnWithSsh(
	config: SshSpawnWrapConfig,
	sshConfig: AgentSshRemoteConfig
): Promise<SshSpawnWrapResult> {
	const { wrapSpawnWithSsh } = await import('../../main/utils/ssh-spawn-wrapper');
	return wrapSpawnWithSsh(config, sshConfig, { getSshRemotes: () => readSshRemotes() });
}

/**
 * Finalize child stdin for a spawned agent. When SSH stdin passthrough is in
 * effect, write the pre-built script before closing; otherwise just close.
 */
function finalizeAgentStdin(child: ChildProcess, sshStdinScript?: string): void {
	if (sshStdinScript) {
		child.stdin?.write(sshStdinScript);
	}
	child.stdin?.end();
}

type SpawnOverrides = Pick<
	SpawnAgentOptions,
	'customModel' | 'customEffort' | 'customArgs' | 'customEnvVars'
>;

/**
 * Resolve agent-level + session-level overrides and produce final args plus
 * the user-configured customEnvVars. Mirrors what the desktop process handler
 * does in `applyAgentConfigOverrides()` so CLI-spawned agents honor the same
 * custom model / effort / args / env vars as the desktop app.
 *
 * Note: `applyAgentConfigOverrides().effectiveCustomEnvVars` folds agent
 * `defaultEnvVars` into its return value. We deliberately strip that here —
 * defaults are layered separately by `applyEnvLayers()` and
 * `buildSshEnvForRemote()` with "shell wins" semantics, and treating them as
 * user overrides would clobber explicit shell env.
 */
function resolveAgentOverrides(
	toolType: ToolType,
	def: ReturnType<typeof getAgentDefinition>,
	baseArgs: string[],
	overrides: SpawnOverrides
): { args: string[]; userCustomEnvVars?: Record<string, string> } {
	const agentConfigValues = readAgentConfig(toolType);
	const result = applyAgentConfigOverrides(def ?? null, baseArgs, {
		agentConfigValues,
		sessionCustomModel: overrides.customModel,
		sessionCustomEffort: overrides.customEffort,
		sessionCustomArgs: overrides.customArgs,
		sessionCustomEnvVars: overrides.customEnvVars,
	});
	const userCustomEnvVars =
		overrides.customEnvVars ??
		(agentConfigValues.customEnvVars as Record<string, string> | undefined);
	return { args: result.args, userCustomEnvVars };
}

/**
 * Merge env vars onto an existing env record in the documented precedence
 * `defaults < batchMode < user < readOnly`. Defaults/batch-mode only fill
 * slots the shell hasn't already set, so users can still shadow built-in
 * agent defaults from the shell. User-configured vars (agent-level
 * customEnvVars + session customEnvVars) unconditionally override, because
 * the user explicitly opted into them.
 */
function applyEnvLayers(
	env: NodeJS.ProcessEnv,
	agentDefaults: Record<string, string> | undefined,
	batchDefaults: Record<string, string> | undefined,
	userEnvVars: Record<string, string> | undefined,
	readOnlyOverrides: Record<string, string> | undefined
): void {
	// Merge defaults first so batch-mode takes precedence over agent-wide
	// defaults for shared keys, then fill only slots the shell hasn't already
	// set. Iterating the two maps sequentially (each with `!env[k]`) would
	// invert the order: the first loop would fill the shell-unset slot and
	// the second loop's guard would then skip the batch-mode value.
	if (agentDefaults || batchDefaults) {
		const mergedDefaults = { ...(agentDefaults ?? {}), ...(batchDefaults ?? {}) };
		for (const [k, v] of Object.entries(mergedDefaults)) {
			if (!env[k]) env[k] = v;
		}
	}
	if (userEnvVars) Object.assign(env, userEnvVars);
	if (readOnlyOverrides) Object.assign(env, readOnlyOverrides);
}

// Claude Code arguments for batch mode (stream-json format)
const CLAUDE_ARGS = ['--print', '--verbose', '--output-format', 'stream-json'];

// Permission bypass arg for Claude — skipped in read-only mode
const CLAUDE_YOLO_ARGS = ['--dangerously-skip-permissions'];

// Cached paths per agent type (resolved once at startup)
const cachedPaths: Map<string, string> = new Map();

// Result from spawning an agent
export interface AgentResult {
	success: boolean;
	response?: string;
	agentSessionId?: string;
	usageStats?: UsageStats;
	error?: string;
}

// Detection result
export interface DetectResult {
	available: boolean;
	path?: string;
	source?: 'settings' | 'path';
}

/**
 * Build an expanded PATH that includes common binary installation locations
 */
function getExpandedPath(): string {
	return buildExpandedPath();
}

/**
 * Check if a file exists and is executable
 */
async function isExecutable(filePath: string): Promise<boolean> {
	try {
		const stats = await fs.promises.stat(filePath);
		if (!stats.isFile()) return false;

		// On Unix, check executable permission
		if (!isWindows()) {
			try {
				await fs.promises.access(filePath, fs.constants.X_OK);
			} catch {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Find a command in PATH using 'which' (Unix) or 'where' (Windows)
 */
async function findCommandInPath(commandName: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const env = { ...process.env, PATH: getExpandedPath() };
		const command = getWhichCommand();

		const proc = spawn(command, [commandName], { env });
		let stdout = '';

		proc.stdout?.on('data', (data) => {
			stdout += data.toString();
		});

		proc.on('close', (code) => {
			if (code === 0 && stdout.trim()) {
				resolve(stdout.trim().split('\n')[0]);
			} else {
				resolve(undefined);
			}
		});

		proc.on('error', () => {
			resolve(undefined);
		});
	});
}

/**
 * Detect if an agent CLI is available.
 * Checks custom path in settings first, then falls back to PATH detection.
 */
export async function detectAgent(toolType: ToolType): Promise<DetectResult> {
	const cached = cachedPaths.get(toolType);
	if (cached) {
		return { available: true, path: cached, source: 'settings' };
	}

	const def = getAgentDefinition(toolType);
	const defaultCommand = def?.binaryName || toolType;

	// 1. Check for custom path in settings
	const customPath = getAgentCustomPath(toolType);
	if (customPath) {
		if (await isExecutable(customPath)) {
			cachedPaths.set(toolType, customPath);
			return { available: true, path: customPath, source: 'settings' };
		}
		console.error(
			`Warning: Custom ${def?.name || toolType} path "${customPath}" is not executable, falling back to PATH detection`
		);
	}

	// 2. Fall back to PATH detection
	const pathResult = await findCommandInPath(defaultCommand);
	if (pathResult) {
		cachedPaths.set(toolType, pathResult);
		return { available: true, path: pathResult, source: 'path' };
	}

	return { available: false };
}

// Backward-compatible wrappers
export const detectClaude = () => detectAgent('claude-code');
export const detectCodex = () => detectAgent('codex');
export const detectOpenCode = () => detectAgent('opencode');
export const detectDroid = () => detectAgent('factory-droid');

/**
 * Get the resolved command/path for spawning an agent.
 * Uses cached path from detectAgent() or falls back to the agent's binaryName.
 */
export function getAgentCommand(toolType: ToolType): string {
	const cached = cachedPaths.get(toolType);
	if (cached) return cached;
	const def = getAgentDefinition(toolType);
	return def?.binaryName || toolType;
}

// Backward-compatible wrappers
export const getClaudeCommand = () => getAgentCommand('claude-code');
export const getCodexCommand = () => getAgentCommand('codex');
export const getOpenCodeCommand = () => getAgentCommand('opencode');
export const getDroidCommand = () => getAgentCommand('factory-droid');

/**
 * Spawn Claude Code with a prompt and return the result.
 *
 * Honors the same agent-level and session-level overrides as the desktop app:
 * custom model, effort, CLI args, env vars, and SSH remote execution. Custom
 * binary path is applied via getAgentCommand()/detectAgent().
 *
 * Claude uses a unique JSON format (stream-json) that differs from the
 * AgentOutputParser interface used by other agents, so it has its own spawner.
 */
async function spawnClaudeAgent(
	cwd: string,
	prompt: string,
	agentSessionId?: string,
	readOnlyMode?: boolean,
	sshRemoteConfig?: AgentSshRemoteConfig,
	overrides: SpawnOverrides = {}
): Promise<AgentResult> {
	const env = buildExpandedEnv();
	const def = getAgentDefinition('claude-code');

	// Build args WITHOUT the prompt — the prompt is appended below for local
	// execution or embedded into the SSH wrapper for remote execution.
	const preOverrideArgs = [...CLAUDE_ARGS];

	if (readOnlyMode) {
		if (def?.readOnlyArgs) preOverrideArgs.push(...def.readOnlyArgs);
	} else {
		preOverrideArgs.push(...CLAUDE_YOLO_ARGS);
	}

	if (agentSessionId) {
		preOverrideArgs.push('--resume', agentSessionId);
	} else {
		// Force a fresh, isolated session for each task execution
		// This prevents context bleeding between tasks in Auto Run
		preOverrideArgs.push('--session-id', generateUUID());
	}

	// Layer agent-level + session-level overrides (model, effort, customArgs)
	// and extract the user-configured env vars (agent + session customEnvVars).
	const { args: baseArgs, userCustomEnvVars } = resolveAgentOverrides(
		'claude-code',
		def,
		preOverrideArgs,
		overrides
	);

	// Build local env: defaults (shell wins) + batch-mode defaults (shell wins)
	// + user env vars (override shell) + read-only overrides (always).
	// Pass only the user-level env (no agent defaults) so shell-provided values
	// keep precedence over agent defaults.
	applyEnvLayers(
		env,
		def?.defaultEnvVars,
		def?.batchModeEnvVars,
		userCustomEnvVars,
		readOnlyMode ? def?.readOnlyEnvOverrides : undefined
	);

	const claudeCommand = getAgentCommand('claude-code');

	// SSH-wrap if a remote is configured; otherwise append prompt locally.
	// Claude uses '-- <prompt>' positional form — the default in wrapSpawnWithSsh.
	let spawnCommand = claudeCommand;
	let spawnArgs: string[] = [...baseArgs, '--', prompt];
	let spawnCwd = cwd;
	let spawnEnv: NodeJS.ProcessEnv = env;
	let sshStdinScript: string | undefined;

	if (sshRemoteConfig?.enabled) {
		const wrapped = await maybeWrapSpawnWithSsh(
			{
				command: claudeCommand,
				args: baseArgs,
				cwd,
				prompt,
				customEnvVars: buildSshEnvForRemote(def, readOnlyMode, userCustomEnvVars),
				agentBinaryName: def?.binaryName,
			},
			sshRemoteConfig
		);
		if (!wrapped.sshRemoteUsed) {
			return sshUnresolvedFailure(sshRemoteConfig);
		}
		({ spawnCommand, spawnArgs, spawnCwd, spawnEnv, sshStdinScript } = applySshWrapResult(wrapped));
	}

	return new Promise((resolve) => {
		const options: SpawnOptions = {
			cwd: spawnCwd,
			env: spawnEnv,
			stdio: ['pipe', 'pipe', 'pipe'],
		};

		const child = spawn(spawnCommand, spawnArgs, options);

		let jsonBuffer = '';
		let result: string | undefined;
		let assistantText = ''; // Accumulate text from assistant messages as fallback
		let sessionId: string | undefined;
		let usageStats: UsageStats | undefined;
		let resultEmitted = false;
		let sessionIdEmitted = false;

		// Process a single parsed JSON message from Claude Code's stream-json output

		const processMessage = (msg: any) => {
			// Capture result text (only once)
			if (msg.type === 'result' && msg.result && !resultEmitted) {
				resultEmitted = true;
				result = msg.result;
			}

			// Accumulate text from assistant messages — Claude Code may emit
			// an empty result field with the actual text in assistant messages
			if (msg.type === 'assistant' && msg.message?.content) {
				const content = msg.message.content;
				if (typeof content === 'string') {
					if (assistantText) assistantText += '\n';
					assistantText += content;
				} else if (Array.isArray(content)) {
					for (const block of content) {
						if (block.type === 'text' && block.text) {
							if (assistantText) assistantText += '\n';
							assistantText += block.text;
						}
					}
				}
			}

			// Capture session_id (only once)
			if (msg.session_id && !sessionIdEmitted) {
				sessionIdEmitted = true;
				sessionId = msg.session_id;
			}

			// Extract usage statistics using shared aggregator
			if (msg.modelUsage || msg.usage || msg.total_cost_usd !== undefined) {
				usageStats = aggregateModelUsage(msg.modelUsage, msg.usage || {}, msg.total_cost_usd || 0);
			}
		};

		// Handle stdout - parse stream-json format
		child.stdout?.on('data', (data: Buffer) => {
			jsonBuffer += data.toString();

			// Process complete lines
			const lines = jsonBuffer.split('\n');
			jsonBuffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.trim()) continue;

				try {
					processMessage(JSON.parse(line));
				} catch {
					// Ignore non-JSON lines
				}
			}
		});

		// Collect stderr for error reporting
		let stderr = '';
		child.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString();
		});

		finalizeAgentStdin(child, sshStdinScript);

		// Handle completion
		child.on('close', (code) => {
			// Flush any remaining data in the JSON buffer (last line may lack trailing \n)
			if (jsonBuffer.trim()) {
				let parsed;
				try {
					parsed = JSON.parse(jsonBuffer);
				} catch {
					// Ignore non-JSON remnants
				}
				if (parsed) {
					processMessage(parsed);
				}
			}

			// Use accumulated assistant text as fallback when result field is empty
			const finalResult = result || assistantText || undefined;

			if (code === 0 && finalResult) {
				resolve({
					success: true,
					response: finalResult,
					agentSessionId: sessionId,
					usageStats,
				});
			} else {
				resolve({
					success: false,
					error: stderr || `Process exited with code ${code}`,
					agentSessionId: sessionId,
					usageStats,
				});
			}
		});

		child.on('error', (error) => {
			resolve({
				success: false,
				error: `Failed to spawn Claude: ${error.message}`,
			});
		});
	});
}

/**
 * Build the env-vars record to forward to an SSH remote. Layers in documented
 * precedence: agent defaults < batch-mode defaults < user-configured vars <
 * read-only overrides. Takes user-only env (no agent defaults folded in) so a
 * key present in both `defaultEnvVars` and `batchModeEnvVars` keeps the
 * batch-mode value on the remote instead of being reverted to the default.
 * Local process.env is NOT forwarded — the remote host has its own environment.
 */
function buildSshEnvForRemote(
	def: ReturnType<typeof getAgentDefinition>,
	readOnlyMode: boolean | undefined,
	userCustomEnvVars: Record<string, string> | undefined
): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	if (def?.defaultEnvVars) Object.assign(out, def.defaultEnvVars);
	if (def?.batchModeEnvVars) Object.assign(out, def.batchModeEnvVars);
	if (userCustomEnvVars) Object.assign(out, userCustomEnvVars);
	if (readOnlyMode && def?.readOnlyEnvOverrides) Object.assign(out, def.readOnlyEnvOverrides);
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Return an AgentResult that tells the caller the configured SSH remote
 * couldn't be resolved. Fails loudly instead of silently running locally —
 * when the user explicitly enabled SSH, they don't want their prompt leaking
 * onto the local machine if the remote is misconfigured.
 */
function sshUnresolvedFailure(sshRemoteConfig: AgentSshRemoteConfig): AgentResult {
	const remoteLabel = sshRemoteConfig.remoteId ? ` "${sshRemoteConfig.remoteId}"` : '';
	return {
		success: false,
		error:
			`SSH remote execution is enabled for this session but the configured ` +
			`remote${remoteLabel} could not be resolved. Check that the remote exists, ` +
			`is enabled, and that the session's remoteId points at a valid SSH remote.`,
	};
}

/**
 * Apply a successful SSH wrap result to our local spawn state. The local ssh
 * client inherits process.env (for SSH_AUTH_SOCK, etc.); the remote's own
 * env vars travel inside the wrapped command or stdin script.
 */
function applySshWrapResult(wrapped: SshSpawnWrapResult): {
	spawnCommand: string;
	spawnArgs: string[];
	spawnCwd: string;
	spawnEnv: NodeJS.ProcessEnv;
	sshStdinScript: string | undefined;
} {
	return {
		spawnCommand: wrapped.command,
		spawnArgs: wrapped.args,
		spawnCwd: wrapped.cwd,
		spawnEnv: { ...process.env },
		sshStdinScript: wrapped.sshStdinScript,
	};
}

function mergeUsageStats(
	current: UsageStats | undefined,
	next: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheCreationTokens?: number;
		costUsd?: number;
		contextWindow?: number;
		reasoningTokens?: number;
	}
): UsageStats {
	const merged: UsageStats = {
		inputTokens: (current?.inputTokens || 0) + (next.inputTokens || 0),
		outputTokens: (current?.outputTokens || 0) + (next.outputTokens || 0),
		cacheReadInputTokens: (current?.cacheReadInputTokens || 0) + (next.cacheReadTokens || 0),
		cacheCreationInputTokens:
			(current?.cacheCreationInputTokens || 0) + (next.cacheCreationTokens || 0),
		totalCostUsd: (current?.totalCostUsd || 0) + (next.costUsd || 0),
		contextWindow: Math.max(current?.contextWindow || 0, next.contextWindow || 0),
		reasoningTokens: (current?.reasoningTokens || 0) + (next.reasoningTokens || 0),
	};

	if (!next.reasoningTokens && !current?.reasoningTokens) {
		delete merged.reasoningTokens;
	}

	return merged;
}

/**
 * Generic spawner for agents that use JSON line output parsed via AgentOutputParser.
 * Handles Codex, OpenCode, Factory Droid, and any future agents with the same pattern.
 *
 * Honors the same agent-level and session-level overrides as the desktop app:
 * custom model, effort, CLI args, env vars, and SSH remote execution. Custom
 * binary path is applied via getAgentCommand()/detectAgent().
 */
async function spawnJsonLineAgent(
	toolType: ToolType,
	cwd: string,
	prompt: string,
	agentSessionId?: string,
	readOnlyMode?: boolean,
	sshRemoteConfig?: AgentSshRemoteConfig,
	overrides: SpawnOverrides = {}
): Promise<AgentResult> {
	const env = buildExpandedEnv();
	const def = getAgentDefinition(toolType);

	// Build args from agent definition (without the prompt or model/customArgs —
	// those come from applyAgentConfigOverrides via configOptions).
	const preOverrideArgs: string[] = [];
	if (def?.batchModePrefix) preOverrideArgs.push(...def.batchModePrefix);

	// In read-only mode, filter out YOLO/bypass args from batchModeArgs
	// (they override read-only flags). In normal mode, apply all batchModeArgs.
	// Skip filtering for agents without CLI-level read-only enforcement
	// (e.g., Gemini CLI needs -y to avoid interactive prompts that hang with closed stdin).
	if (def?.batchModeArgs) {
		if (readOnlyMode && def.readOnlyCliEnforced !== false && def.yoloModeArgs?.length) {
			const yoloSet = new Set(def.yoloModeArgs);
			preOverrideArgs.push(...def.batchModeArgs.filter((a) => !yoloSet.has(a)));
		} else {
			preOverrideArgs.push(...def.batchModeArgs);
		}
	}

	if (def?.jsonOutputArgs) preOverrideArgs.push(...def.jsonOutputArgs);
	if (readOnlyMode && def?.readOnlyArgs) preOverrideArgs.push(...def.readOnlyArgs);

	if (agentSessionId && def?.resumeArgs) {
		preOverrideArgs.push(...def.resumeArgs(agentSessionId));
	}

	// Codex requires explicit working directory arg (other agents use process cwd)
	if (toolType === 'codex' && def?.workingDirArgs) {
		preOverrideArgs.push(...def.workingDirArgs(cwd));
	}

	// Layer agent-level + session-level overrides (model, effort, customArgs)
	// and extract the user-configured env vars (agent + session customEnvVars).
	const { args: baseArgs, userCustomEnvVars } = resolveAgentOverrides(
		toolType,
		def,
		preOverrideArgs,
		overrides
	);

	// Pass only the user-level env (no agent defaults) so shell-provided values
	// keep precedence over agent defaults.
	applyEnvLayers(
		env,
		def?.defaultEnvVars,
		def?.batchModeEnvVars,
		userCustomEnvVars,
		readOnlyMode ? def?.readOnlyEnvOverrides : undefined
	);

	const noPromptSeparator = !!def?.noPromptSeparator;

	// Local prompt embedding mirrors wrapSpawnWithSsh's default behavior.
	// Mirror ChildProcessSpawner's precedence so agents like Copilot/Gemini
	// that ship a `promptArgs` builder (e.g. ['-p', prompt]) get the prompt
	// via their flag instead of the bare '--' separator (which Copilot CLI
	// doesn't accept as a positional prompt).
	const localArgs = def?.promptArgs
		? [...baseArgs, ...def.promptArgs(prompt)]
		: noPromptSeparator
			? [...baseArgs, prompt]
			: [...baseArgs, '--', prompt];

	const agentCommand = getAgentCommand(toolType);

	let spawnCommand = agentCommand;
	let spawnArgs = localArgs;
	let spawnCwd = cwd;
	let spawnEnv: NodeJS.ProcessEnv = env;
	let sshStdinScript: string | undefined;

	if (sshRemoteConfig?.enabled) {
		const wrapped = await maybeWrapSpawnWithSsh(
			{
				command: agentCommand,
				args: baseArgs,
				cwd,
				prompt,
				customEnvVars: buildSshEnvForRemote(def, readOnlyMode, userCustomEnvVars),
				agentBinaryName: def?.binaryName,
				noPromptSeparator,
				promptArgs: def?.promptArgs,
			},
			sshRemoteConfig
		);
		if (!wrapped.sshRemoteUsed) {
			return sshUnresolvedFailure(sshRemoteConfig);
		}
		({ spawnCommand, spawnArgs, spawnCwd, spawnEnv, sshStdinScript } = applySshWrapResult(wrapped));
	}

	// Resolve the output parser before spawning so a misconfigured agent type
	// fails fast instead of leaving an orphaned child process. Reviewer flagged
	// the previous post-spawn null-check as a process leak (greptile P1).
	const parser = createOutputParser(toolType);
	if (!parser) {
		return { success: false, error: `No parser available for agent type: ${toolType}` };
	}

	return new Promise((resolve) => {
		const options: SpawnOptions = {
			cwd: spawnCwd,
			env: spawnEnv,
			stdio: ['pipe', 'pipe', 'pipe'],
		};

		const child = spawn(spawnCommand, spawnArgs, options);

		let jsonBuffer = '';
		let result: string | undefined;
		let sessionId: string | undefined;
		let usageStats: UsageStats | undefined;
		let stderr = '';
		let errorText: string | undefined;

		// Process a single parsed event from an agent's JSON line output
		const processEvent = (event: ReturnType<typeof parser.parseJsonLine>) => {
			if (!event) return;

			if (event.type === 'init' && event.sessionId && !sessionId) {
				sessionId = event.sessionId;
			}

			if (event.type === 'result' && event.text) {
				result = result ? `${result}\n${event.text}` : event.text;
			}

			if (event.type === 'error' && event.text && !errorText) {
				errorText = event.text;
			}

			const usage = parser.extractUsage(event);
			if (usage) {
				usageStats = mergeUsageStats(usageStats, {
					inputTokens: usage.inputTokens || 0,
					outputTokens: usage.outputTokens || 0,
					cacheReadTokens: usage.cacheReadTokens || 0,
					cacheCreationTokens: usage.cacheCreationTokens || 0,
					costUsd: usage.costUsd || 0,
					contextWindow: usage.contextWindow || 0,
					reasoningTokens: usage.reasoningTokens || 0,
				});
			}
		};

		child.stdout?.on('data', (data: Buffer) => {
			jsonBuffer += data.toString();
			const lines = jsonBuffer.split('\n');
			jsonBuffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.trim()) continue;
				processEvent(parser.parseJsonLine(line));
			}
		});

		child.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString();
		});

		finalizeAgentStdin(child, sshStdinScript);

		const agentName = def?.name || toolType;
		child.on('close', (code) => {
			// Flush any remaining data in the JSON buffer (last line may lack trailing \n)
			if (jsonBuffer.trim()) {
				processEvent(parser.parseJsonLine(jsonBuffer));
			}

			if (code === 0 && !errorText) {
				resolve({ success: true, response: result, agentSessionId: sessionId, usageStats });
			} else {
				resolve({
					success: false,
					error: errorText || stderr || `Process exited with code ${code}`,
					agentSessionId: sessionId,
					usageStats,
				});
			}
		});

		child.on('error', (error) => {
			resolve({ success: false, error: `Failed to spawn ${agentName}: ${error.message}` });
		});
	});
}

/**
 * Options for spawning an agent via CLI.
 *
 * Session-level overrides take precedence over the agent-level config read
 * from `maestro-agent-configs.json`. Pass the session values directly here —
 * the spawner merges agent + session overrides via applyAgentConfigOverrides().
 */
export interface SpawnAgentOptions {
	/** Resume an existing agent session */
	agentSessionId?: string;
	/** Run in read-only/plan mode (uses centralized agent definitions for provider-specific flags) */
	readOnlyMode?: boolean;
	/** Per-session model override (wins over agent-level model). */
	customModel?: string;
	/** Per-session effort/reasoning override (wins over agent-level). */
	customEffort?: string;
	/** Per-session extra CLI args (shell-quote aware, appended after built-in args). */
	customArgs?: string;
	/** Per-session env vars merged over agent-level customEnvVars and agent defaults. */
	customEnvVars?: Record<string, string>;
	/**
	 * Per-session SSH remote config. When `enabled`, the spawn is wrapped with
	 * ssh so the agent runs on the remote host. Required for parity with the
	 * desktop app when sessions are configured for SSH remote execution.
	 */
	sshRemoteConfig?: AgentSshRemoteConfig;
}

/**
 * Spawn an agent with a prompt and return the result
 */
export async function spawnAgent(
	toolType: ToolType,
	cwd: string,
	prompt: string,
	agentSessionId?: string,
	options?: SpawnAgentOptions
): Promise<AgentResult> {
	const readOnly = options?.readOnlyMode;
	const sshRemoteConfig = options?.sshRemoteConfig;
	const overrides: SpawnOverrides = {
		customModel: options?.customModel,
		customEffort: options?.customEffort,
		customArgs: options?.customArgs,
		customEnvVars: options?.customEnvVars,
	};

	if (toolType === 'claude-code') {
		return spawnClaudeAgent(cwd, prompt, agentSessionId, readOnly, sshRemoteConfig, overrides);
	}

	if (hasCapability(toolType, 'usesJsonLineOutput')) {
		return spawnJsonLineAgent(
			toolType,
			cwd,
			prompt,
			agentSessionId,
			readOnly,
			sshRemoteConfig,
			overrides
		);
	}

	return {
		success: false,
		error: `Unsupported agent type for batch mode: ${toolType}`,
	};
}

/**
 * Read a markdown document and count unchecked tasks
 */
export function readDocAndCountTasks(
	folderPath: string,
	filename: string
): { content: string; taskCount: number } {
	const filePath = `${folderPath}/${filename}.md`;

	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const matches = content.match(/^[\s]*-\s*\[\s*\]\s*.+$/gm);
		return {
			content,
			taskCount: matches ? matches.length : 0,
		};
	} catch {
		return { content: '', taskCount: 0 };
	}
}

/**
 * Read a markdown document and extract unchecked task text
 */
export function readDocAndGetTasks(
	folderPath: string,
	filename: string
): { content: string; tasks: string[] } {
	const filePath = `${folderPath}/${filename}.md`;

	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const matches = content.match(/^[\s]*-\s*\[\s*\]\s*(.+)$/gm);
		const tasks = matches ? matches.map((m) => m.replace(/^[\s]*-\s*\[\s*\]\s*/, '').trim()) : [];
		return { content, tasks };
	} catch {
		return { content: '', tasks: [] };
	}
}

/**
 * Uncheck all markdown checkboxes in content (for reset-on-completion)
 */
export function uncheckAllTasks(content: string): string {
	return content.replace(/^(\s*-\s*)\[x\]/gim, '$1[ ]');
}

/**
 * Write content to a document
 */
export function writeDoc(folderPath: string, filename: string, content: string): void {
	const filePath = `${folderPath}/${filename}`;
	fs.writeFileSync(filePath, content, 'utf-8');
}
