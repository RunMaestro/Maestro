// Agent spawner service for CLI
// Spawns agent CLIs and parses their output

import { spawn, SpawnOptions } from 'child_process';
import * as fs from 'fs';
import type { ToolType, UsageStats } from '../../shared/types';
import type { AgentOutputParser } from '../../main/parsers/agent-output-parser';
import { CodexOutputParser } from '../../main/parsers/codex-output-parser';
import { OpenCodeOutputParser } from '../../main/parsers/opencode-output-parser';
import { FactoryDroidOutputParser } from '../../main/parsers/factory-droid-output-parser';
import { aggregateModelUsage } from '../../main/parsers/usage-aggregator';
import { getAgentDefinition } from '../../main/agents/definitions';
import { getAgentCustomPath } from './storage';
import { generateUUID } from '../../shared/uuid';
import { buildExpandedPath, buildExpandedEnv } from '../../shared/pathUtils';
import { isWindows, getWhichCommand } from '../../shared/platformDetection';

// Claude Code arguments for batch mode (stream-json format)
const CLAUDE_ARGS = [
	'--print',
	'--verbose',
	'--output-format',
	'stream-json',
	'--dangerously-skip-permissions',
];

// Cached paths per agent type (resolved once at startup)
const cachedPaths: Map<string, string> = new Map();

// Agent types that support CLI batch mode via JSON line parsing
const JSON_LINE_AGENTS: ToolType[] = ['codex', 'opencode', 'factory-droid'];

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
 * NOTE: CLI spawner does not apply applyAgentConfigOverrides() or SSH wrapping.
 * Designed for headless batch execution without access to the Electron settings
 * store or per-session agent configuration. Custom model, args, env vars, and
 * SSH remote execution are not supported in CLI mode.
 *
 * Claude uses a unique JSON format (stream-json) that differs from the
 * AgentOutputParser interface used by other agents, so it has its own spawner.
 */
async function spawnClaudeAgent(
	cwd: string,
	prompt: string,
	agentSessionId?: string
): Promise<AgentResult> {
	return new Promise((resolve) => {
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

		const claudeCommand = getAgentCommand('claude-code');
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

/** Create the appropriate output parser for a given agent type */
function createParser(toolType: ToolType): AgentOutputParser {
	switch (toolType) {
		case 'codex':
			return new CodexOutputParser();
		case 'opencode':
			return new OpenCodeOutputParser();
		case 'factory-droid':
			return new FactoryDroidOutputParser();
		default:
			throw new Error(`No parser available for agent type: ${toolType}`);
	}
}

/**
 * Generic spawner for agents that use JSON line output parsed via AgentOutputParser.
 * Handles Codex, OpenCode, Factory Droid, and any future agents with the same pattern.
 *
 * NOTE: Same limitations as spawnClaudeAgent — no applyAgentConfigOverrides()
 * or SSH wrapping in CLI mode.
 */
async function spawnJsonLineAgent(
	toolType: ToolType,
	cwd: string,
	prompt: string,
	agentSessionId?: string
): Promise<AgentResult> {
	return new Promise((resolve) => {
		const env = buildExpandedEnv();
		const def = getAgentDefinition(toolType);

		// Apply default env vars from agent definition
		if (def?.defaultEnvVars) {
			for (const k of Object.keys(def.defaultEnvVars)) {
				if (!env[k]) env[k] = def.defaultEnvVars[k];
			}
		}

		// Build args from agent definition
		const args: string[] = [];
		if (def?.batchModePrefix) args.push(...def.batchModePrefix);
		if (def?.batchModeArgs) args.push(...def.batchModeArgs);
		if (def?.jsonOutputArgs) args.push(...def.jsonOutputArgs);

		if (agentSessionId && def?.resumeArgs) {
			args.push(...def.resumeArgs(agentSessionId));
		}

		// Codex requires explicit working directory arg (other agents use process cwd)
		if (toolType === 'codex' && def?.workingDirArgs) {
			args.push(...def.workingDirArgs(cwd));
		}

		// Add prompt (with or without '--' separator depending on agent)
		if (!def?.noPromptSeparator) {
			args.push('--');
		}
		args.push(prompt);

		const options: SpawnOptions = {
			cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		};

		const agentCommand = getAgentCommand(toolType);
		const child = spawn(agentCommand, args, options);

		const parser = createParser(toolType);
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

		const agentName = def?.name || toolType;
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
			resolve({ success: false, error: `Failed to spawn ${agentName}: ${error.message}` });
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
	if (toolType === 'claude-code') {
		return spawnClaudeAgent(cwd, prompt, agentSessionId);
	}

	if (JSON_LINE_AGENTS.includes(toolType)) {
		return spawnJsonLineAgent(toolType, cwd, prompt, agentSessionId);
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
