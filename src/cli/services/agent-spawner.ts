// Agent spawner service for CLI
// Spawns agent CLIs (Claude Code, Codex) and parses their output

import { spawn, SpawnOptions } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import type { ToolType, UsageStats } from '../../shared/types';
import { CodexOutputParser } from '../../main/parsers/codex-output-parser';
import { getAgentCustomPath } from './storage';
import { generateUUID } from '../../shared/uuid';

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
	const home = os.homedir();
	const additionalPaths = [
		'/opt/homebrew/bin',
		'/opt/homebrew/sbin',
		'/usr/local/bin',
		'/usr/local/sbin',
		`${home}/.local/bin`,
		`${home}/.npm-global/bin`,
		`${home}/bin`,
		`${home}/.claude/local`,
		'/usr/bin',
		'/bin',
		'/usr/sbin',
		'/sbin',
	];

	const currentPath = process.env.PATH || '';
	const pathParts = currentPath.split(':');

	for (const p of additionalPaths) {
		if (!pathParts.includes(p)) {
			pathParts.unshift(p);
		}
	}

	return pathParts.join(':');
}

/**
 * Check if a file exists and is executable
 */
async function isExecutable(filePath: string): Promise<boolean> {
	try {
		const stats = await fs.promises.stat(filePath);
		if (!stats.isFile()) return false;

		// On Unix, check executable permission
		if (process.platform !== 'win32') {
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
		const command = process.platform === 'win32' ? 'where' : 'which';

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
		const command = process.platform === 'win32' ? 'where' : 'which';

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
 * Spawn Claude Code with a prompt and return the result
 */
async function spawnClaudeAgent(
	cwd: string,
	prompt: string,
	agentSessionId?: string
): Promise<AgentResult> {
	return new Promise((resolve) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PATH: getExpandedPath(),
		};

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

					// Extract usage statistics
					if (msg.modelUsage || msg.usage || msg.total_cost_usd !== undefined) {
						const usage = msg.usage || {};

						let aggregatedInputTokens = 0;
						let aggregatedOutputTokens = 0;
						let aggregatedCacheReadTokens = 0;
						let aggregatedCacheCreationTokens = 0;
						let contextWindow = 200000;

						if (msg.modelUsage) {
							for (const modelStats of Object.values(msg.modelUsage) as Record<string, number>[]) {
								aggregatedInputTokens += modelStats.inputTokens || 0;
								aggregatedOutputTokens += modelStats.outputTokens || 0;
								aggregatedCacheReadTokens += modelStats.cacheReadInputTokens || 0;
								aggregatedCacheCreationTokens += modelStats.cacheCreationInputTokens || 0;
								if (modelStats.contextWindow && modelStats.contextWindow > contextWindow) {
									contextWindow = modelStats.contextWindow;
								}
							}
						}

						if (aggregatedInputTokens === 0 && aggregatedOutputTokens === 0) {
							aggregatedInputTokens = usage.input_tokens || 0;
							aggregatedOutputTokens = usage.output_tokens || 0;
							aggregatedCacheReadTokens = usage.cache_read_input_tokens || 0;
							aggregatedCacheCreationTokens = usage.cache_creation_input_tokens || 0;
						}

						usageStats = {
							inputTokens: aggregatedInputTokens,
							outputTokens: aggregatedOutputTokens,
							cacheReadInputTokens: aggregatedCacheReadTokens,
							cacheCreationInputTokens: aggregatedCacheCreationTokens,
							totalCostUsd: msg.total_cost_usd || 0,
							contextWindow,
						};
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
 * Spawn Codex with a prompt and return the result
 */
async function spawnCodexAgent(
	cwd: string,
	prompt: string,
	agentSessionId?: string
): Promise<AgentResult> {
	return new Promise((resolve) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PATH: getExpandedPath(),
		};

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

	if (toolType === 'claude' || toolType === 'claude-code') {
		return spawnClaudeAgent(cwd, prompt, agentSessionId);
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
