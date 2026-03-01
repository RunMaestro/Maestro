/**
 * Agent Detection and Configuration Manager
 *
 * Responsibilities:
 * - Detects installed agents via file system probing and PATH resolution
 * - Manages agent configuration and capability metadata
 * - Caches detection results for performance
 * - Discovers available models for agents that support model selection
 *
 * Model Discovery:
 * - Model lists are cached for 5 minutes (configurable) to balance freshness and performance
 * - Each agent implements its own model discovery command
 * - Cache can be manually cleared or bypassed with forceRefresh flag
 */

import * as path from 'path';
import { execFileNoThrow } from '../utils/execFile';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { getAgentCapabilities } from './capabilities';
import { checkBinaryExists, checkCustomPath, getExpandedEnv } from './path-prober';
import { AGENT_DEFINITIONS, type AgentConfig } from './definitions';

const LOG_CONTEXT = 'AgentDetector';

// ============ Agent Detector Class ============

/** Default cache TTL: 5 minutes (model lists don't change frequently) */
const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Minimum supported agent versions. Agents below these versions may have
 * incompatible output formats that Maestro's parsers cannot handle.
 *
 * Maintenance: update an entry when a parser is changed to depend on a newer
 * output format (e.g., new envelope fields, changed JSON structure). The
 * version should match the agent release that introduced the format change.
 * Add new entries when onboarding a new agent whose parser targets a specific
 * CLI version. Remove entries only if backward compatibility is restored.
 */
export const AGENT_MIN_VERSIONS: Record<string, string> = {
	codex: '0.41.0', // New msg-envelope JSONL format
	'claude-code': '1.0.0', // Baseline for --output-format stream-json
};

/** Timeout for agent version probes (ms) */
const VERSION_DETECT_TIMEOUT_MS = 3_000;

/**
 * Run `<binary> <versionArgs>` and parse the version string from stdout.
 * Returns the parsed version string, or null on failure.
 * Uses a fixed timeout to avoid blocking detection.
 */
async function detectAgentVersion(
	binaryPath: string,
	versionArgs: string[],
	agentId: string,
	env: NodeJS.ProcessEnv
): Promise<string | null> {
	try {
		const resultPromise = execFileNoThrow(binaryPath, versionArgs, undefined, env);
		const timeoutPromise = new Promise<null>((resolve) =>
			setTimeout(() => resolve(null), VERSION_DETECT_TIMEOUT_MS)
		);

		const result = await Promise.race([resultPromise, timeoutPromise]);
		if (!result) {
			logger.warn(`${agentId} version check timed out`, LOG_CONTEXT);
			return null;
		}

		if (result.exitCode !== 0) {
			logger.warn(
				`${agentId} version check failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
				LOG_CONTEXT
			);
			return null;
		}

		const stdout = result.stdout.trim();
		if (!stdout) {
			logger.warn(`${agentId} version check returned empty output`, LOG_CONTEXT);
			return null;
		}

		// Parse version from output: try each whitespace-separated part
		// to find one that looks like a semver (starts with digit, contains dots)
		const parts = stdout.split(/\s+/);
		const version = parts.map((p) => p.replace(/^v/i, '')).find((p) => /^\d+\.\d+/.test(p));

		if (!version) {
			logger.warn(`Could not parse version from ${agentId} output: "${stdout}"`, LOG_CONTEXT);
			return null;
		}

		logger.info(`${agentId} version detected: ${version}`, LOG_CONTEXT);
		return version;
	} catch (error) {
		logger.warn(`${agentId} version check threw exception`, LOG_CONTEXT, {
			error: String(error),
		});
		return null;
	}
}

export class AgentDetector {
	private cachedAgents: AgentConfig[] | null = null;
	private detectionInProgress: Promise<AgentConfig[]> | null = null;
	private customPaths: Record<string, string> = {};
	// Cache for model discovery results: agentId -> { models, timestamp }
	private modelCache: Map<string, { models: string[]; timestamp: number }> = new Map();
	// Configurable cache TTL (useful for testing or different environments)
	private readonly modelCacheTtlMs: number;

	/**
	 * Create an AgentDetector instance
	 * @param modelCacheTtlMs - Model cache TTL in milliseconds (default: 5 minutes)
	 */
	constructor(modelCacheTtlMs: number = DEFAULT_MODEL_CACHE_TTL_MS) {
		this.modelCacheTtlMs = modelCacheTtlMs;
	}

	/**
	 * Set custom paths for agents (from user configuration)
	 */
	setCustomPaths(paths: Record<string, string>): void {
		this.customPaths = paths;
		// Clear cache when custom paths change
		this.cachedAgents = null;
	}

	/**
	 * Get the current custom paths
	 */
	getCustomPaths(): Record<string, string> {
		return { ...this.customPaths };
	}

	/**
	 * Detect which agents are available on the system
	 * Uses promise deduplication to prevent parallel detection when multiple calls arrive simultaneously
	 */
	async detectAgents(): Promise<AgentConfig[]> {
		if (this.cachedAgents) {
			return this.cachedAgents;
		}

		// If detection is already in progress, return the same promise to avoid parallel runs
		if (this.detectionInProgress) {
			return this.detectionInProgress;
		}

		// Start detection and track the promise
		this.detectionInProgress = this.doDetectAgents();
		try {
			return await this.detectionInProgress;
		} finally {
			this.detectionInProgress = null;
		}
	}

	/**
	 * Internal method that performs the actual agent detection
	 */
	private async doDetectAgents(): Promise<AgentConfig[]> {
		const agents: AgentConfig[] = [];
		const expandedEnv = getExpandedEnv();

		logger.info(`Agent detection starting. PATH: ${expandedEnv.PATH}`, LOG_CONTEXT);

		for (const agentDef of AGENT_DEFINITIONS) {
			const customPath = this.customPaths[agentDef.id];
			let detection: { exists: boolean; path?: string };

			// If user has specified a custom path, check that first
			if (customPath) {
				detection = await checkCustomPath(customPath);
				if (detection.exists) {
					logger.info(
						`Agent "${agentDef.name}" found at custom path: ${detection.path}`,
						LOG_CONTEXT
					);
				} else {
					logger.warn(`Agent "${agentDef.name}" custom path not valid: ${customPath}`, LOG_CONTEXT);
					// Fall back to PATH detection
					detection = await checkBinaryExists(agentDef.binaryName);
					if (detection.exists) {
						logger.info(
							`Agent "${agentDef.name}" found in PATH at: ${detection.path}`,
							LOG_CONTEXT
						);
					}
				}
			} else {
				detection = await checkBinaryExists(agentDef.binaryName);

				if (detection.exists) {
					logger.info(`Agent "${agentDef.name}" found at: ${detection.path}`, LOG_CONTEXT);
				} else if (agentDef.binaryName !== 'bash') {
					// Don't log bash as missing since it's always present, log others as warnings
					logger.warn(
						`Agent "${agentDef.name}" (binary: ${agentDef.binaryName}) not found. ` +
							`Searched in PATH: ${expandedEnv.PATH}`,
						LOG_CONTEXT
					);
				}
			}

			// Version detection for agents that define versionArgs (non-blocking, 3s timeout)
			let detectedVersion: string | undefined;
			if (detection.exists && detection.path && agentDef.versionArgs) {
				detectedVersion =
					(await detectAgentVersion(
						detection.path,
						agentDef.versionArgs,
						agentDef.id,
						expandedEnv
					)) ?? undefined;
			}

			agents.push({
				...agentDef,
				available: detection.exists,
				path: detection.path,
				customPath: customPath || undefined,
				capabilities: getAgentCapabilities(agentDef.id),
				detectedVersion,
			});
		}

		const availableAgents = agents.filter((a) => a.available);
		const isWindows = process.platform === 'win32';

		// On Windows, log detailed path info to help debug shell execution issues
		if (isWindows) {
			logger.info(`Agent detection complete (Windows)`, LOG_CONTEXT, {
				platform: process.platform,
				agents: availableAgents.map((a) => ({
					id: a.id,
					name: a.name,
					path: a.path,
					pathExtension: a.path ? path.extname(a.path) : 'none',
					// .exe = direct execution, .cmd = requires shell
					willUseShell: a.path
						? a.path.toLowerCase().endsWith('.cmd') ||
							a.path.toLowerCase().endsWith('.bat') ||
							!path.extname(a.path)
						: true,
				})),
			});
		} else {
			logger.info(
				`Agent detection complete. Available: ${availableAgents.map((a) => (a.detectedVersion ? `${a.name} v${a.detectedVersion}` : a.name)).join(', ') || 'none'}`,
				LOG_CONTEXT
			);
		}

		this.cachedAgents = agents;
		return agents;
	}

	/**
	 * Get a specific agent by ID
	 */
	async getAgent(agentId: string): Promise<AgentConfig | null> {
		const agents = await this.detectAgents();
		return agents.find((a) => a.id === agentId) || null;
	}

	/**
	 * Clear the cache (useful if PATH changes)
	 */
	clearCache(): void {
		this.cachedAgents = null;
	}

	/**
	 * Clear the model cache for a specific agent or all agents
	 */
	clearModelCache(agentId?: string): void {
		if (agentId) {
			this.modelCache.delete(agentId);
		} else {
			this.modelCache.clear();
		}
	}

	/**
	 * Discover available models for an agent that supports model selection.
	 * Returns cached results if available and not expired.
	 *
	 * @param agentId - The agent identifier (e.g., 'opencode')
	 * @param forceRefresh - If true, bypass cache and fetch fresh model list
	 * @returns Array of model names, or empty array if agent doesn't support model discovery
	 */
	async discoverModels(agentId: string, forceRefresh = false): Promise<string[]> {
		const agent = await this.getAgent(agentId);

		if (!agent || !agent.available) {
			logger.warn(`Cannot discover models: agent ${agentId} not available`, LOG_CONTEXT);
			return [];
		}

		// Check if agent supports model selection
		if (!agent.capabilities.supportsModelSelection) {
			logger.debug(`Agent ${agentId} does not support model selection`, LOG_CONTEXT);
			return [];
		}

		// Check cache unless force refresh
		if (!forceRefresh) {
			const cached = this.modelCache.get(agentId);
			if (cached && Date.now() - cached.timestamp < this.modelCacheTtlMs) {
				logger.debug(`Returning cached models for ${agentId}`, LOG_CONTEXT);
				return cached.models;
			}
		}

		// Run agent-specific model discovery command
		const models = await this.runModelDiscovery(agentId, agent);

		// Cache the results
		this.modelCache.set(agentId, { models, timestamp: Date.now() });

		return models;
	}

	/**
	 * Run the agent-specific model discovery command.
	 * Each agent may have a different way to list available models.
	 *
	 * This method catches all exceptions to ensure graceful degradation
	 * when model discovery fails for any reason.
	 */
	private async runModelDiscovery(agentId: string, agent: AgentConfig): Promise<string[]> {
		const env = getExpandedEnv();
		const command = agent.path || agent.command;

		try {
			// Agent-specific model discovery commands
			switch (agentId) {
				case 'opencode': {
					// OpenCode: `opencode models` returns one model per line
					const result = await execFileNoThrow(command, ['models'], undefined, env);

					if (result.exitCode !== 0) {
						logger.warn(
							`Model discovery failed for ${agentId}: exit code ${result.exitCode}`,
							LOG_CONTEXT,
							{ stderr: result.stderr }
						);
						return [];
					}

					// Parse output: one model per line (e.g., "opencode/gpt-5-nano", "ollama/gpt-oss:latest")
					const models = result.stdout
						.split('\n')
						.map((line) => line.trim())
						.filter((line) => line.length > 0);

					logger.info(`Discovered ${models.length} models for ${agentId}`, LOG_CONTEXT, {
						models,
					});
					return models;
				}

				default:
					// For agents without model discovery implemented, return empty array
					logger.debug(`No model discovery implemented for ${agentId}`, LOG_CONTEXT);
					return [];
			}
		} catch (error) {
			logger.error(`Model discovery threw exception for ${agentId}`, LOG_CONTEXT, { error });
			captureException(error, { operation: 'agent:modelDiscovery', agentId });
			return [];
		}
	}
}
