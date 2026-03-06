// Agent spawner service for CLI
// Spawns agent CLIs (Claude Code, Codex, OpenCode, Factory Droid) and parses their output

import { spawn, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import type { ToolType, UsageStats, AgentSshRemoteConfig } from '../../shared/types';
import { CodexOutputParser } from '../../main/parsers/codex-output-parser';
import { OpenCodeOutputParser } from '../../main/parsers/opencode-output-parser';
import { FactoryDroidOutputParser } from '../../main/parsers/factory-droid-output-parser';
import { aggregateModelUsage } from '../../main/parsers/usage-aggregator';
import { getAgentDefinition } from '../../main/agents/definitions';
import {
	applyAgentConfigOverrides,
	buildAgentArgs,
	getContextWindowValue,
} from '../../main/utils/agent-args';
import { getAgentConfigValues, getAgentCustomPath, readSshRemotes } from './storage';
import { generateUUID } from '../../shared/uuid';
import { buildExpandedPath, buildExpandedEnv } from '../../shared/pathUtils';
import { isWindows, getWhichCommand } from '../../shared/platformDetection';
import { wrapSpawnWithSsh } from '../../main/utils/ssh-spawn-wrapper';

// Claude Code default command and arguments (same as Electron app)
const CLAUDE_DEFAULT_COMMAND = 'claude';
const CLAUDE_ARGS = [
	'--print',
	'--verbose',
	'--output-format',
	'stream-json',
	'--dangerously-skip-permissions',
];

type CachedPath = { path: string; source: 'settings' | 'path' };

// Cached Claude path (resolved once at startup)
let cachedClaudePath: CachedPath | null = null;

// Codex default command and arguments (batch mode)
const CODEX_DEFAULT_COMMAND = 'codex';
const CODEX_ARGS = [
	'exec',
	'--json',
	'--dangerously-bypass-approvals-and-sandbox',
	'--skip-git-repo-check',
];

// Cached Codex path (resolved once at startup)
let cachedCodexPath: CachedPath | null = null;

// OpenCode default command
const OPENCODE_DEFAULT_COMMAND = 'opencode';

// Cached OpenCode path (resolved once at startup)
let cachedOpenCodePath: CachedPath | null = null;

// Factory Droid default command
const DROID_DEFAULT_COMMAND = 'droid';

// Cached Factory Droid path (resolved once at startup)
let cachedDroidPath: CachedPath | null = null;

// Result from spawning an agent
export interface AgentResult {
	success: boolean;
	response?: string;
	agentSessionId?: string;
	usageStats?: UsageStats;
	error?: string;
}

export interface AgentSpawnOverrides {
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	sshRemoteConfig?: AgentSshRemoteConfig;
}

function getCliSshRemoteStore() {
	return {
		getSshRemotes: () => readSshRemotes(),
	};
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
 * Find a command in PATH using 'which' command
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
				resolve(stdout.trim().split('\n')[0]); // First match
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
 * Find Claude in PATH using 'which' command
 */
async function findClaudeInPath(): Promise<string | undefined> {
	return findCommandInPath(CLAUDE_DEFAULT_COMMAND);
}

/**
 * Find Codex in PATH using 'which' command
 */
async function findCodexInPath(): Promise<string | undefined> {
	return findCommandInPath(CODEX_DEFAULT_COMMAND);
}

/**
 * Check if Claude Code is available
 * First checks for a custom path in settings, then falls back to PATH detection
 */
export async function detectClaude(
	customPathOverride?: string,
	sshRemoteConfig?: AgentSshRemoteConfig
): Promise<{
	available: boolean;
	path?: string;
	source?: 'settings' | 'path';
}> {
	if (sshRemoteConfig?.enabled) {
		return { available: true, source: 'settings' };
	}
	if (customPathOverride) {
		if (await isExecutable(customPathOverride)) {
			return { available: true, path: customPathOverride, source: 'settings' };
		}
		console.error(
			`Warning: Custom Claude path "${customPathOverride}" is not executable, falling back to PATH detection`
		);
	}

	// Return cached result if available
	if (cachedClaudePath) {
		return {
			available: true,
			path: cachedClaudePath.path,
			source: cachedClaudePath.source,
		};
	}

	// 1. Check for custom path in settings (same settings as desktop app)
	const customPath = getAgentCustomPath('claude-code');
	if (customPath) {
		if (await isExecutable(customPath)) {
			cachedClaudePath = { path: customPath, source: 'settings' };
			return { available: true, path: customPath, source: 'settings' };
		}
		// Custom path is set but invalid - warn but continue to PATH detection
		console.error(
			`Warning: Custom Claude path "${customPath}" is not executable, falling back to PATH detection`
		);
	}

	// 2. Fall back to PATH detection
	const pathResult = await findClaudeInPath();
	if (pathResult) {
		cachedClaudePath = { path: pathResult, source: 'path' };
		return { available: true, path: pathResult, source: 'path' };
	}

	return { available: false };
}

/**
 * Check if Codex CLI is available
 * First checks for a custom path in settings, then falls back to PATH detection
 */
export async function detectCodex(
	customPathOverride?: string,
	sshRemoteConfig?: AgentSshRemoteConfig
): Promise<{
	available: boolean;
	path?: string;
	source?: 'settings' | 'path';
}> {
	if (sshRemoteConfig?.enabled) {
		return { available: true, source: 'settings' };
	}
	if (customPathOverride) {
		if (await isExecutable(customPathOverride)) {
			return { available: true, path: customPathOverride, source: 'settings' };
		}
		console.error(
			`Warning: Custom Codex path "${customPathOverride}" is not executable, falling back to PATH detection`
		);
	}

	if (cachedCodexPath) {
		return {
			available: true,
			path: cachedCodexPath.path,
			source: cachedCodexPath.source,
		};
	}

	const customPath = getAgentCustomPath('codex');
	if (customPath) {
		if (await isExecutable(customPath)) {
			cachedCodexPath = { path: customPath, source: 'settings' };
			return { available: true, path: customPath, source: 'settings' };
		}
		console.error(
			`Warning: Custom Codex path "${customPath}" is not executable, falling back to PATH detection`
		);
	}

	const pathResult = await findCodexInPath();
	if (pathResult) {
		cachedCodexPath = { path: pathResult, source: 'path' };
		return { available: true, path: pathResult, source: 'path' };
	}

	return { available: false };
}

/**
 * Check if OpenCode CLI is available
 * First checks for a custom path in settings, then falls back to PATH detection
 */
export async function detectOpenCode(
	customPathOverride?: string,
	sshRemoteConfig?: AgentSshRemoteConfig
): Promise<{
	available: boolean;
	path?: string;
	source?: 'settings' | 'path';
}> {
	if (sshRemoteConfig?.enabled) {
		return { available: true, source: 'settings' };
	}
	if (customPathOverride) {
		if (await isExecutable(customPathOverride)) {
			return { available: true, path: customPathOverride, source: 'settings' };
		}
		console.error(
			`Warning: Custom OpenCode path "${customPathOverride}" is not executable, falling back to PATH detection`
		);
	}

	if (cachedOpenCodePath) {
		return {
			available: true,
			path: cachedOpenCodePath.path,
			source: cachedOpenCodePath.source,
		};
	}

	const customPath = getAgentCustomPath('opencode');
	if (customPath) {
		if (await isExecutable(customPath)) {
			cachedOpenCodePath = { path: customPath, source: 'settings' };
			return { available: true, path: customPath, source: 'settings' };
		}
		console.error(
			`Warning: Custom OpenCode path "${customPath}" is not executable, falling back to PATH detection`
		);
	}

	const pathResult = await findCommandInPath(OPENCODE_DEFAULT_COMMAND);
	if (pathResult) {
		cachedOpenCodePath = { path: pathResult, source: 'path' };
		return { available: true, path: pathResult, source: 'path' };
	}

	return { available: false };
}

/**
 * Check if Factory Droid CLI is available
 * First checks for a custom path in settings, then falls back to PATH detection
 */
export async function detectDroid(
	customPathOverride?: string,
	sshRemoteConfig?: AgentSshRemoteConfig
): Promise<{
	available: boolean;
	path?: string;
	source?: 'settings' | 'path';
}> {
	if (sshRemoteConfig?.enabled) {
		return { available: true, source: 'settings' };
	}
	if (customPathOverride) {
		if (await isExecutable(customPathOverride)) {
			return { available: true, path: customPathOverride, source: 'settings' };
		}
		console.error(
			`Warning: Custom Droid path "${customPathOverride}" is not executable, falling back to PATH detection`
		);
	}

	if (cachedDroidPath) {
		return {
			available: true,
			path: cachedDroidPath.path,
			source: cachedDroidPath.source,
		};
	}

	const customPath = getAgentCustomPath('factory-droid');
	if (customPath) {
		if (await isExecutable(customPath)) {
			cachedDroidPath = { path: customPath, source: 'settings' };
			return { available: true, path: customPath, source: 'settings' };
		}
		console.error(
			`Warning: Custom Droid path "${customPath}" is not executable, falling back to PATH detection`
		);
	}

	const pathResult = await findCommandInPath(DROID_DEFAULT_COMMAND);
	if (pathResult) {
		cachedDroidPath = { path: pathResult, source: 'path' };
		return { available: true, path: pathResult, source: 'path' };
	}

	return { available: false };
}

/**
 * Get the resolved Claude command/path for spawning
 * Uses cached path from detectClaude() or falls back to default command
 */
export function getClaudeCommand(customPath?: string): string {
	if (customPath && customPath.trim()) {
		return customPath;
	}
	return cachedClaudePath?.path || CLAUDE_DEFAULT_COMMAND;
}

/**
 * Get the resolved Codex command/path for spawning
 * Uses cached path from detectCodex() or falls back to default command
 */
export function getCodexCommand(customPath?: string): string {
	if (customPath && customPath.trim()) {
		return customPath;
	}
	return cachedCodexPath?.path || CODEX_DEFAULT_COMMAND;
}

/**
 * Get the resolved OpenCode command/path for spawning
 */
export function getOpenCodeCommand(customPath?: string): string {
	if (customPath && customPath.trim()) {
		return customPath;
	}
	return cachedOpenCodePath?.path || OPENCODE_DEFAULT_COMMAND;
}

/**
 * Get the resolved Factory Droid command/path for spawning
 */
export function getDroidCommand(customPath?: string): string {
	if (customPath && customPath.trim()) {
		return customPath;
	}
	return cachedDroidPath?.path || DROID_DEFAULT_COMMAND;
}

/**
 * Spawn Claude Code with a prompt and return the result.
 *
 * NOTE: CLI spawner can SSH-wrap when sshRemoteConfig is provided, but it does not use
 * the Electron settingsStore/global shell env. Session overrides (model, args, env vars,
 * and custom CLI path) are still applied via applyAgentConfigOverrides().
 */
async function spawnClaudeAgent(
	cwd: string,
	prompt: string,
	agentSessionId?: string,
	overrides?: AgentSpawnOverrides
): Promise<AgentResult> {
	const agentDef = getAgentDefinition('claude-code');
	const agentConfigValues = getAgentConfigValues('claude-code') as Record<string, any>;

	// Build args: base args + session handling (prompt appended after overrides)
	const baseArgs = [...CLAUDE_ARGS];

	if (agentSessionId) {
		// Resume an existing session (e.g., for synopsis generation)
		baseArgs.push('--resume', agentSessionId);
	} else {
		// Force a fresh, isolated session for each task execution
		// This prevents context bleeding between tasks in Auto Run
		baseArgs.push('--session-id', generateUUID());
	}

	const { args: resolvedArgs, effectiveCustomEnvVars } = applyAgentConfigOverrides(
		agentDef,
		baseArgs,
		{
			agentConfigValues,
			sessionCustomModel: overrides?.customModel,
			sessionCustomArgs: overrides?.customArgs,
			sessionCustomEnvVars: overrides?.customEnvVars,
		}
	);

	// Add prompt as positional argument after overrides
	const args = [...resolvedArgs, '--', prompt];

	// Note: CLI agent spawner doesn't have access to settingsStore with global shell env vars.
	// For CLI, we rely on the environment that Maestro itself is running in.
	// Global shell env vars are primarily used by the desktop app's process manager.
	const env = buildExpandedEnv(effectiveCustomEnvVars);

	let spawnCommand =
		overrides?.sshRemoteConfig && !overrides?.customPath && agentDef?.binaryName
			? agentDef.binaryName
			: getClaudeCommand(overrides?.customPath);
	let spawnArgs = args;
	let spawnCwd = cwd;
	let spawnEnv = env;

	if (overrides?.sshRemoteConfig) {
		const sshWrapped = await wrapSpawnWithSsh(
			{
				command: spawnCommand,
				args: spawnArgs,
				cwd,
				customEnvVars: effectiveCustomEnvVars,
				agentBinaryName: agentDef?.binaryName,
			},
			overrides.sshRemoteConfig,
			getCliSshRemoteStore()
		);
		spawnCommand = sshWrapped.command;
		spawnArgs = sshWrapped.args;
		spawnCwd = sshWrapped.cwd;
		spawnEnv = buildExpandedEnv(sshWrapped.customEnvVars);
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
		let resultEmitted = false;
		let sessionIdEmitted = false;

		// Handle stdout - parse stream-json format
		child.stdout?.on('data', (data: Buffer) => {
			jsonBuffer += data.toString();

			// Process complete lines
			const lines = jsonBuffer.split('\n');
			jsonBuffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.trim()) continue;

				try {
					const msg = JSON.parse(line);

					// Capture result (only once)
					if (msg.type === 'result' && msg.result && !resultEmitted) {
						resultEmitted = true;
						result = msg.result;
					}

					// Capture session_id (only once)
					if (msg.session_id && !sessionIdEmitted) {
						sessionIdEmitted = true;
						sessionId = msg.session_id;
					}

					// Extract usage statistics using shared aggregator
					if (msg.modelUsage || msg.usage || msg.total_cost_usd !== undefined) {
						usageStats = aggregateModelUsage(
							msg.modelUsage,
							msg.usage || {},
							msg.total_cost_usd || 0
						);
					}
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

		// Close stdin immediately
		child.stdin?.end();

		// Handle completion
		child.on('close', (code) => {
			if (code === 0 && result) {
				resolve({
					success: true,
					response: result,
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

type StreamJsonParser = {
	parseJsonLine: (line: string) => any | null;
	extractSessionId: (event: any) => string | null | undefined;
	isResultMessage: (event: any) => boolean;
	extractUsage: (event: any) =>
		| {
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens?: number;
				cacheCreationTokens?: number;
				costUsd?: number;
				contextWindow?: number;
				reasoningTokens?: number;
		  }
		| null
		| undefined;
};

async function spawnStreamingAgent(
	toolType: 'opencode' | 'factory-droid',
	cwd: string,
	prompt: string,
	agentSessionId: string | undefined,
	overrides: AgentSpawnOverrides | undefined,
	commandGetter: (customPath?: string) => string,
	createParser: () => StreamJsonParser,
	agentLabel: string
): Promise<AgentResult> {
	const { args, env, contextWindow, effectiveCustomEnvVars } = resolveAgentInvocation(
		toolType,
		cwd,
		prompt,
		agentSessionId,
		overrides
	);
	const agentDef = getAgentDefinition(toolType);

	let spawnCommand =
		overrides?.sshRemoteConfig && !overrides?.customPath && agentDef?.binaryName
			? agentDef.binaryName
			: commandGetter(overrides?.customPath);
	let spawnArgs = args;
	let spawnCwd = cwd;
	let spawnEnv = env;

	if (overrides?.sshRemoteConfig) {
		const sshWrapped = await wrapSpawnWithSsh(
			{
				command: spawnCommand,
				args: spawnArgs,
				cwd,
				customEnvVars: effectiveCustomEnvVars,
				agentBinaryName: agentDef?.binaryName,
			},
			overrides.sshRemoteConfig,
			getCliSshRemoteStore()
		);
		spawnCommand = sshWrapped.command;
		spawnArgs = sshWrapped.args;
		spawnCwd = sshWrapped.cwd;
		spawnEnv = buildExpandedEnv(sshWrapped.customEnvVars);
	}

	return new Promise((resolve) => {
		const options: SpawnOptions = {
			cwd: spawnCwd,
			env: spawnEnv,
			stdio: ['pipe', 'pipe', 'pipe'],
		};

		const child = spawn(spawnCommand, spawnArgs, options);

		const parser = createParser();
		let jsonBuffer = '';
		let result: string | undefined;
		let sessionId: string | undefined;
		let usageStats: UsageStats | undefined;
		let stderr = '';
		let errorText: string | undefined;

		child.stdout?.on('data', (data: Buffer) => {
			jsonBuffer += data.toString();
			const lines = jsonBuffer.split('\n');
			jsonBuffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.trim()) continue;
				const event = parser.parseJsonLine(line);
				if (!event) continue;

				const extractedSessionId = parser.extractSessionId(event);
				if (extractedSessionId && !sessionId) {
					sessionId = extractedSessionId;
				}

				if (parser.isResultMessage(event) && event.text) {
					result = result ? `${result}\n${event.text}` : event.text;
				}

				if (event.type === 'error' && event.text && !errorText) {
					errorText = event.text;
				}

				const usage = parser.extractUsage(event);
				if (usage) {
					usageStats = mergeUsageStats(usageStats, {
						inputTokens: usage.inputTokens,
						outputTokens: usage.outputTokens,
						cacheReadTokens: usage.cacheReadTokens,
						cacheCreationTokens: usage.cacheCreationTokens,
						costUsd: usage.costUsd,
						contextWindow: usage.contextWindow,
						reasoningTokens: usage.reasoningTokens,
					});
				}
			}
		});

		child.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString();
		});

		child.stdin?.end();

		child.on('close', (code) => {
			if (usageStats && (!usageStats.contextWindow || usageStats.contextWindow === 0)) {
				usageStats.contextWindow = contextWindow;
			}

			if (code === 0 && !errorText) {
				resolve({
					success: true,
					response: result,
					agentSessionId: sessionId,
					usageStats,
				});
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
			resolve({
				success: false,
				error: `Failed to spawn ${agentLabel}: ${error.message}`,
			});
		});
	});
}

function resolveAgentInvocation(
	toolType: ToolType,
	cwd: string,
	prompt: string,
	agentSessionId: string | undefined,
	overrides?: AgentSpawnOverrides
): {
	args: string[];
	env: NodeJS.ProcessEnv;
	contextWindow: number;
	effectiveCustomEnvVars?: Record<string, string>;
} {
	const agentDef = getAgentDefinition(toolType);
	const agentConfigValues = getAgentConfigValues(toolType) as Record<string, any>;

	const baseArgs = buildAgentArgs(agentDef, {
		baseArgs: [],
		prompt,
		cwd,
		agentSessionId,
	});

	const { args: resolvedArgs, effectiveCustomEnvVars } = applyAgentConfigOverrides(
		agentDef,
		baseArgs,
		{
			agentConfigValues,
			sessionCustomModel: overrides?.customModel,
			sessionCustomArgs: overrides?.customArgs,
			sessionCustomEnvVars: overrides?.customEnvVars,
		}
	);

	const finalArgs = [...resolvedArgs];
	if (!agentDef?.noPromptSeparator) {
		finalArgs.push('--');
	}
	finalArgs.push(prompt);

	const env = buildExpandedEnv(effectiveCustomEnvVars);
	const contextWindow = getContextWindowValue(agentDef, agentConfigValues);

	return { args: finalArgs, env, contextWindow, effectiveCustomEnvVars };
}

/**
 * Spawn Codex with a prompt and return the result.
 *
 * NOTE: Same limitations as spawnClaudeAgent (no global settingsStore); per-session
 * overrides are still applied.
 */
async function spawnCodexAgent(
	cwd: string,
	prompt: string,
	agentSessionId?: string,
	overrides?: AgentSpawnOverrides
): Promise<AgentResult> {
	const agentDef = getAgentDefinition('codex');
	const agentConfigValues = getAgentConfigValues('codex') as Record<string, any>;

	const baseArgs = [...CODEX_ARGS];
	baseArgs.push('-C', cwd);

	if (agentSessionId) {
		baseArgs.push('resume', agentSessionId);
	}

	const { args: resolvedArgs, effectiveCustomEnvVars } = applyAgentConfigOverrides(
		agentDef,
		baseArgs,
		{
			agentConfigValues,
			sessionCustomModel: overrides?.customModel,
			sessionCustomArgs: overrides?.customArgs,
			sessionCustomEnvVars: overrides?.customEnvVars,
		}
	);

	const args = [...resolvedArgs, '--', prompt];

	// Note: CLI agent spawner doesn't have access to settingsStore with global shell env vars.
	// For CLI, we rely on the environment that Maestro itself is running in.
	// Global shell env vars are primarily used by the desktop app's process manager.
	const env = buildExpandedEnv(effectiveCustomEnvVars);

	let spawnCommand = !overrides?.customPath
		? agentDef?.binaryName || getCodexCommand()
		: getCodexCommand(overrides?.customPath);
	let spawnArgs = args;
	let spawnCwd = cwd;
	let spawnEnv = env;

	if (overrides?.sshRemoteConfig) {
		const sshWrapped = await wrapSpawnWithSsh(
			{
				command: spawnCommand,
				args: spawnArgs,
				cwd,
				customEnvVars: effectiveCustomEnvVars,
				agentBinaryName: agentDef?.binaryName,
			},
			overrides.sshRemoteConfig,
			getCliSshRemoteStore()
		);
		spawnCommand = sshWrapped.command;
		spawnArgs = sshWrapped.args;
		spawnCwd = sshWrapped.cwd;
		spawnEnv = buildExpandedEnv(sshWrapped.customEnvVars);
	}

	return new Promise((resolve) => {
		const options: SpawnOptions = {
			cwd: spawnCwd,
			env: spawnEnv,
			stdio: ['pipe', 'pipe', 'pipe'],
		};

		const child = spawn(spawnCommand, spawnArgs, options);

		const parser = new CodexOutputParser();
		let jsonBuffer = '';
		let result: string | undefined;
		let sessionId: string | undefined;
		let usageStats: UsageStats | undefined;
		let stderr = '';
		let errorText: string | undefined;

		child.stdout?.on('data', (data: Buffer) => {
			jsonBuffer += data.toString();
			const lines = jsonBuffer.split('\n');
			jsonBuffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.trim()) continue;
				const event = parser.parseJsonLine(line);
				if (!event) continue;

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
					usageStats = mergeUsageStats(usageStats, usage);
				}
			}
		});

		child.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString();
		});

		child.stdin?.end();

		child.on('close', (code) => {
			if (code === 0 && !errorText) {
				resolve({
					success: true,
					response: result,
					agentSessionId: sessionId,
					usageStats,
				});
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
			resolve({
				success: false,
				error: `Failed to spawn Codex: ${error.message}`,
			});
		});
	});
}

/**
 * Spawn OpenCode with a prompt and return the result
 */
async function spawnOpenCodeAgent(
	cwd: string,
	prompt: string,
	agentSessionId?: string,
	overrides?: AgentSpawnOverrides
): Promise<AgentResult> {
	return spawnStreamingAgent(
		'opencode',
		cwd,
		prompt,
		agentSessionId,
		overrides,
		getOpenCodeCommand,
		() => new OpenCodeOutputParser(),
		'OpenCode'
	);
}

/**
 * Spawn Factory Droid with a prompt and return the result
 */
async function spawnFactoryDroidAgent(
	cwd: string,
	prompt: string,
	agentSessionId?: string,
	overrides?: AgentSpawnOverrides
): Promise<AgentResult> {
	return spawnStreamingAgent(
		'factory-droid',
		cwd,
		prompt,
		agentSessionId,
		overrides,
		getDroidCommand,
		() => new FactoryDroidOutputParser(),
		'Factory Droid'
	);
}

/**
 * Spawn an agent with a prompt and return the result
 */
export async function spawnAgent(
	toolType: ToolType,
	cwd: string,
	prompt: string,
	agentSessionId?: string,
	overrides?: AgentSpawnOverrides
): Promise<AgentResult> {
	// Claude + Codex have bespoke spawners; OpenCode + Factory Droid share the streaming JSON path.
	if (toolType === 'codex') {
		return spawnCodexAgent(cwd, prompt, agentSessionId, overrides);
	}

	if (toolType === 'claude-code') {
		return spawnClaudeAgent(cwd, prompt, agentSessionId, overrides);
	}

	if (toolType === 'opencode') {
		return spawnOpenCodeAgent(cwd, prompt, agentSessionId, overrides);
	}

	if (toolType === 'factory-droid') {
		return spawnFactoryDroidAgent(cwd, prompt, agentSessionId, overrides);
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
