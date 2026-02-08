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

			agents.push({
				...agentDef,
				available: detection.exists,
				path: detection.path,
				customPath: customPath || undefined,
				capabilities: getAgentCapabilities(agentDef.id),
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
				`Agent detection complete. Available: ${availableAgents.map((a) => a.name).join(', ') || 'none'}`,
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
