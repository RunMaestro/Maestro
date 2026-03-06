// Agent spawner service for CLI
// Spawns agent CLIs (Claude Code, Codex) and parses their output

import { spawn, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import type { ToolType, UsageStats } from '../../shared/types';
import { CodexOutputParser } from '../../main/parsers/codex-output-parser';
import { OpenCodeOutputParser } from '../../main/parsers/opencode-output-parser';
import { FactoryDroidOutputParser } from '../../main/parsers/factory-droid-output-parser';
import { aggregateModelUsage } from '../../main/parsers/usage-aggregator';
import { getAgentDefinition } from '../../main/agents/definitions';
import { getAgentCustomPath } from './storage';
import { generateUUID } from '../../shared/uuid';
import { buildExpandedPath, buildExpandedEnv } from '../../shared/pathUtils';
import { isWindows, getWhichCommand } from '../../shared/platformDetection';

// Claude Code default command and arguments (same as Electron app)
const CLAUDE_DEFAULT_COMMAND = 'claude';
const CLAUDE_ARGS = [
	'--print',
	'--verbose',
	'--output-format',
	'stream-json',
	'--dangerously-skip-permissions',
];

// Cached Claude path (resolved once at startup)
let cachedClaudePath: string | null = null;

// Codex default command and arguments (batch mode)
const CODEX_DEFAULT_COMMAND = 'codex';
const CODEX_ARGS = [
	'exec',
	'--json',
	'--dangerously-bypass-approvals-and-sandbox',
	'--skip-git-repo-check',
];

// Cached Codex path (resolved once at startup)
let cachedCodexPath: string | null = null;

// OpenCode default command
const OPENCODE_DEFAULT_COMMAND = 'opencode';
// Cached OpenCode path (resolved once at startup)
let cachedOpenCodePath: string | null = null;

// Factory Droid default command
const DROID_DEFAULT_COMMAND = 'droid';
// Cached Factory Droid path (resolved once at startup)
let cachedDroidPath: string | null = null;

// Result from spawning an agent
export interface AgentResult {
	success: boolean;
	response?: string;
	agentSessionId?: string;
	usageStats?: UsageStats;
	error?: string;
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
 * Find Claude in PATH using 'which' command
 */
async function findClaudeInPath(): Promise<string | undefined> {
	return new Promise((resolve) => {
		const env = { ...process.env, PATH: getExpandedPath() };
		const command = getWhichCommand();

		const proc = spawn(command, [CLAUDE_DEFAULT_COMMAND], { env });
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
 * Find Codex in PATH using 'which' command
 */
async function findCodexInPath(): Promise<string | undefined> {
	return new Promise((resolve) => {
		const env = { ...process.env, PATH: getExpandedPath() };
		const command = getWhichCommand();

		const proc = spawn(command, [CODEX_DEFAULT_COMMAND], { env });
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
 * Generic which-style lookup for arbitrary command names
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
 * Check if Claude Code is available
 * First checks for a custom path in settings, then falls back to PATH detection
 */
export async function detectClaude(): Promise<{
	available: boolean;
	path?: string;
	source?: 'settings' | 'path';
}> {
	// Return cached result if available
	if (cachedClaudePath) {
		return { available: true, path: cachedClaudePath, source: 'settings' };
	}

	// 1. Check for custom path in settings (same settings as desktop app)
	const customPath = getAgentCustomPath('claude-code');
	if (customPath) {
		if (await isExecutable(customPath)) {
			cachedClaudePath = customPath;
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
		cachedClaudePath = pathResult;
		return { available: true, path: pathResult, source: 'path' };
	}

	return { available: false };
}

/**
 * Check if Codex CLI is available
 * First checks for a custom path in settings, then falls back to PATH detection
 */
export async function detectCodex(): Promise<{
	available: boolean;
	path?: string;
	source?: 'settings' | 'path';
}> {
	if (cachedCodexPath) {
		return { available: true, path: cachedCodexPath, source: 'settings' };
	}

	const customPath = getAgentCustomPath('codex');
	if (customPath) {
		if (await isExecutable(customPath)) {
			cachedCodexPath = customPath;
			return { available: true, path: customPath, source: 'settings' };
		}
		console.error(
			`Warning: Custom Codex path "${customPath}" is not executable, falling back to PATH detection`
		);
	}

	const pathResult = await findCodexInPath();
	if (pathResult) {
		cachedCodexPath = pathResult;
		return { available: true, path: pathResult, source: 'path' };
	}

	return { available: false };
}

/**
 * Check if OpenCode CLI is available
 * First checks for a custom path in settings, then falls back to PATH detection
 */
export async function detectOpenCode(): Promise<{
	available: boolean;
	path?: string;
	source?: 'settings' | 'path';
}> {
	if (cachedOpenCodePath) {
		return { available: true, path: cachedOpenCodePath, source: 'settings' };
	}

	const customPath = getAgentCustomPath('opencode');
	if (customPath) {
		if (await isExecutable(customPath)) {
			cachedOpenCodePath = customPath;
			return { available: true, path: customPath, source: 'settings' };
		}
		console.error(
			`Warning: Custom OpenCode path "${customPath}" is not executable, falling back to PATH detection`
		);
	}

	const pathResult = await findCommandInPath(OPENCODE_DEFAULT_COMMAND);
	if (pathResult) {
		cachedOpenCodePath = pathResult;
		return { available: true, path: pathResult, source: 'path' };
	}

	return { available: false };
}

/**
 * Check if Factory Droid CLI is available
 * First checks for a custom path in settings, then falls back to PATH detection
 */
export async function detectDroid(): Promise<{
	available: boolean;
	path?: string;
	source?: 'settings' | 'path';
}> {
	if (cachedDroidPath) {
		return { available: true, path: cachedDroidPath, source: 'settings' };
	}

	const customPath = getAgentCustomPath('factory-droid');
	if (customPath) {
		if (await isExecutable(customPath)) {
			cachedDroidPath = customPath;
			return { available: true, path: customPath, source: 'settings' };
		}
		console.error(
			`Warning: Custom Droid path "${customPath}" is not executable, falling back to PATH detection`
		);
	}

	const pathResult = await findCommandInPath(DROID_DEFAULT_COMMAND);
	if (pathResult) {
		cachedDroidPath = pathResult;
		return { available: true, path: pathResult, source: 'path' };
	}

	return { available: false };
}

/**
 * Get the resolved OpenCode command/path for spawning
 */
export function getOpenCodeCommand(): string {
	return cachedOpenCodePath || OPENCODE_DEFAULT_COMMAND;
}

/**
 * Get the resolved Factory Droid command/path for spawning
 */
export function getDroidCommand(): string {
	return cachedDroidPath || DROID_DEFAULT_COMMAND;
}

/**
 * Get the resolved Claude command/path for spawning
 * Uses cached path from detectClaude() or falls back to default command
 */
export function getClaudeCommand(): string {
	return cachedClaudePath || CLAUDE_DEFAULT_COMMAND;
}

/**
 * Get the resolved Codex command/path for spawning
 * Uses cached path from detectCodex() or falls back to default command
 */
export function getCodexCommand(): string {
	return cachedCodexPath || CODEX_DEFAULT_COMMAND;
}

/**
 * Spawn Claude Code with a prompt and return the result.
 *
 * NOTE: CLI spawner does not apply applyAgentConfigOverrides() or SSH wrapping.
 * Designed for headless batch execution without access to the Electron settings
 * store or per-session agent configuration. Custom model, args, env vars, and
 * SSH remote execution are not supported in CLI mode.
 */
async function spawnClaudeAgent(
	cwd: string,
	prompt: string,
	agentSessionId?: string
): Promise<AgentResult> {
	return new Promise((resolve) => {
		// Note: CLI agent spawner doesn't have access to settingsStore with global shell env vars.
		// For CLI, we rely on the environment that Maestro itself is running in.
		// Global shell env vars are primarily used by the desktop app's process manager.
		const env = buildExpandedEnv();

		// Build args: base args + session handling + prompt
		const args = [...CLAUDE_ARGS];

		if (agentSessionId) {
			// Resume an existing session (e.g., for synopsis generation)
			args.push('--resume', agentSessionId);
		} else {
			// Force a fresh, isolated session for each task execution
			// This prevents context bleeding between tasks in Auto Run
			args.push('--session-id', generateUUID());
		}

		// Add prompt as positional argument
		args.push('--', prompt);

		const options: SpawnOptions = {
			cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		};

		// Use the resolved Claude path (from settings or PATH detection)
		const claudeCommand = getClaudeCommand();
		const child = spawn(claudeCommand, args, options);

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

/**
 * Spawn Codex with a prompt and return the result.
 *
 * NOTE: Same limitations as spawnClaudeAgent — no applyAgentConfigOverrides()
 * or SSH wrapping in CLI mode.
 */
async function spawnCodexAgent(
	cwd: string,
	prompt: string,
	agentSessionId?: string
): Promise<AgentResult> {
	return new Promise((resolve) => {
		// Note: CLI agent spawner doesn't have access to settingsStore with global shell env vars.
		// For CLI, we rely on the environment that Maestro itself is running in.
		// Global shell env vars are primarily used by the desktop app's process manager.
		const env = buildExpandedEnv();

		const args = [...CODEX_ARGS];
		args.push('-C', cwd);

		if (agentSessionId) {
			args.push('resume', agentSessionId);
		}

		args.push('--', prompt);

		const options: SpawnOptions = {
			cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		};

		const codexCommand = getCodexCommand();
		const child = spawn(codexCommand, args, options);

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

async function spawnOpenCodeAgent(
	cwd: string,
	prompt: string,
	agentSessionId?: string
): Promise<AgentResult> {
	return new Promise((resolve) => {
		const env = buildExpandedEnv();

		// Ensure OpenCode default env vars (prevents interactive permission prompts)
		const def = getAgentDefinition('opencode');
		if (def?.defaultEnvVars) {
			for (const k of Object.keys(def.defaultEnvVars)) {
				if (!env[k]) env[k] = def.defaultEnvVars[k];
			}
		}

		const args: string[] = [];
		// batchModePrefix + json output
		const defArgs = def?.batchModePrefix || ['run'];
		args.push(...defArgs);
		if (def?.jsonOutputArgs) args.push(...def.jsonOutputArgs);

		if (agentSessionId && def?.resumeArgs) {
			args.push(...def.resumeArgs(agentSessionId));
		}

		// OpenCode uses positional prompt without '--'
		args.push(prompt);

		const options: SpawnOptions = {
			cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		};

		const openCodeCommand = getOpenCodeCommand();
		const child = spawn(openCodeCommand, args, options);

		const parser = new OpenCodeOutputParser();
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

				// Capture structured JSON error events emitted by OpenCode
				// (opencode --format json can emit { type: 'error', error: ... })
				if (event.type === 'error' && event.text && !errorText) {
					errorText = event.text;
				}

				const usage = parser.extractUsage(event as any);
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
			}
		});

		child.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString();
		});

		child.stdin?.end();

		child.on('close', (code) => {
			// If OpenCode emitted a structured JSON 'error' event, treat it as a failure
			// even when the process exits with code 0. This mirrors Codex/Factory Droid
			// behaviour and preserves provider error messages emitted in JSON mode.
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
			resolve({ success: false, error: `Failed to spawn OpenCode: ${error.message}` });
		});
	});
}

async function spawnDroidAgent(
	cwd: string,
	prompt: string,
	agentSessionId?: string
): Promise<AgentResult> {
	return new Promise((resolve) => {
		const env = buildExpandedEnv();

		const def = getAgentDefinition('factory-droid');

		const args: string[] = [];
		if (def?.batchModePrefix) args.push(...def.batchModePrefix);
		if (def?.batchModeArgs) args.push(...def.batchModeArgs);
		if (def?.jsonOutputArgs) args.push(...def.jsonOutputArgs);

		if (agentSessionId && def?.resumeArgs) {
			args.push(...def.resumeArgs(agentSessionId));
		}

		// Factory Droid uses positional prompt
		args.push(prompt);

		const options: SpawnOptions = {
			cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		};

		const droidCommand = getDroidCommand();
		const child = spawn(droidCommand, args, options);

		const parser = new FactoryDroidOutputParser();
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

				const usage = parser.extractUsage(event as any);
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
			}
		});

		child.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString();
		});

		child.stdin?.end();

		child.on('close', (code) => {
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
			resolve({ success: false, error: `Failed to spawn Factory Droid: ${error.message}` });
		});
	});
}

/**
 * Spawn an agent with a prompt and return the result
 */
export async function spawnAgent(
	toolType: ToolType,
	cwd: string,
	prompt: string,
	agentSessionId?: string
): Promise<AgentResult> {
	if (toolType === 'codex') {
		return spawnCodexAgent(cwd, prompt, agentSessionId);
	}

	if (toolType === 'claude-code') {
		return spawnClaudeAgent(cwd, prompt, agentSessionId);
	}

	if (toolType === 'opencode') {
		return spawnOpenCodeAgent(cwd, prompt, agentSessionId);
	}

	if (toolType === 'factory-droid') {
		return spawnDroidAgent(cwd, prompt, agentSessionId);
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
