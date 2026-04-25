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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileNoThrow } from '../utils/execFile';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { getAgentCapabilities } from './capabilities';
import { checkBinaryExists, checkCustomPath, getExpandedEnv } from './path-prober';
import { AGENT_DEFINITIONS, type AgentConfig } from './definitions';
import { discoverModelsFromLocalConfigs } from './opencode-config';
import { isWindows } from '../../shared/platformDetection';

const LOG_CONTEXT = 'AgentDetector';

const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const MODELS_DEV_FETCH_TIMEOUT_MS = 3000;

/** Read the user's configured Copilot CLI model from ~/.copilot/config.json (if present). */
function readCopilotConfiguredModel(): string | null {
	try {
		const configPath = path.join(os.homedir(), '.copilot', 'config.json');
		const configContent = fs.readFileSync(configPath, 'utf8');
		const config = JSON.parse(configContent);
		if (typeof config?.model === 'string' && config.model.length > 0) {
			return config.model;
		}
	} catch {
		// Config may not exist or be malformed — fall through to null.
	}
	return null;
}

/**
 * Fetch the list of Copilot CLI models from the models.dev catalog.
 * Returns null when the request fails or the schema doesn't match; callers
 * should fall back to the user-configured model in that case.
 */
async function fetchCopilotModelsFromApi(): Promise<string[] | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), MODELS_DEV_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(MODELS_DEV_API_URL, { signal: controller.signal });
		if (!response.ok) {
			return null;
		}
		const data = (await response.json()) as Record<string, unknown>;
		const copilotProvider = data?.['github-copilot'] as
			| { models?: Record<string, unknown> }
			| undefined;
		const models = copilotProvider?.models;
		if (models && typeof models === 'object') {
			return Object.keys(models).sort();
		}
		return null;
	} catch (err) {
		logger.warn('Failed to fetch models from models.dev for copilot-cli', LOG_CONTEXT, {
			error: String(err),
		});
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

// ============ Agent Detector Class ============

/** Default cache TTL: 5 minutes (model lists don't change frequently) */
const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

export class AgentDetector {
	private cachedAgents: AgentConfig[] | null = null;
	private detectionInProgress: Promise<AgentConfig[]> | null = null;
	private customPaths: Record<string, string> = {};
	// Cache for model discovery results: agentId -> { models, timestamp }
	private modelCache: Map<string, { models: string[]; timestamp: number }> = new Map();
	// Cache for config option discovery: "agentId:optionKey" -> { options, timestamp }
	private configOptionCache: Map<string, { options: string[]; timestamp: number }> = new Map();
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

		// On Windows, log detailed path info to help debug shell execution issues
		if (isWindows()) {
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
			// Also clear config option caches for this agent
			for (const key of this.configOptionCache.keys()) {
				if (key.startsWith(`${agentId}:`)) {
					this.configOptionCache.delete(key);
				}
			}
		} else {
			this.modelCache.clear();
			this.configOptionCache.clear();
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
				case 'claude-code': {
					// Claude Code: no CLI listing command.
					// Discover models dynamically from two sources:
					// 1. Well-known aliases (always valid, resolve to latest in each tier)
					//    Includes [1m] variants for 1M extended context window
					//    (requires extra usage enabled at claude.ai/settings/usage)
					// 2. Historical model usage from ~/.claude/stats-cache.json
					const models: string[] = ['sonnet', 'opus', 'haiku', 'opus[1m]', 'sonnet[1m]'];
					try {
						const statsPath = path.join(os.homedir(), '.claude', 'stats-cache.json');
						const statsContent = fs.readFileSync(statsPath, 'utf8');
						const stats = JSON.parse(statsContent);
						// modelUsage keys are full model IDs the user has used
						if (stats.modelUsage && typeof stats.modelUsage === 'object') {
							for (const modelId of Object.keys(stats.modelUsage)) {
								if (!models.includes(modelId)) {
									models.push(modelId);
								}
							}
						}
					} catch {
						// stats-cache.json may not exist yet (fresh install)
						logger.debug('Could not read Claude stats-cache.json for model discovery', LOG_CONTEXT);
					}
					logger.info(`Discovered ${models.length} models for ${agentId}`, LOG_CONTEXT, { models });
					return models;
				}

				case 'codex': {
					// Codex: read ~/.codex/models_cache.json maintained by the Codex CLI.
					// Contains the full list of available models with metadata.
					try {
						const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
						const cachePath = path.join(codexHome, 'models_cache.json');
						const cacheContent = fs.readFileSync(cachePath, 'utf8');
						const cache = JSON.parse(cacheContent);
						if (Array.isArray(cache.models)) {
							const models = cache.models
								.filter(
									(m: { slug?: string; visibility?: string }) => m.slug && m.visibility !== 'hide'
								)
								.map((m: { slug: string }) => m.slug);
							logger.info(
								`Discovered ${models.length} models for ${agentId} from models_cache.json`,
								LOG_CONTEXT,
								{ models }
							);
							return models;
						}
					} catch {
						logger.debug('Could not read Codex models_cache.json for model discovery', LOG_CONTEXT);
					}
					return [];
				}

				case 'opencode': {
					// OpenCode: merge models from two sources:
					// 1. `opencode models` CLI command (runtime-available models)
					// 2. opencode.json config files (provider-defined models that may
					//    not appear in `opencode models` output, e.g. cloud providers)
					const seen = new Set<string>();
					const models: string[] = [];

					// Source 1: CLI discovery
					const result = await execFileNoThrow(command, ['models'], undefined, env);
					if (result.exitCode === 0) {
						const cliModels = result.stdout
							.split('\n')
							.map((line) => line.trim())
							.filter((line) => line.length > 0);
						for (const m of cliModels) {
							if (!seen.has(m)) {
								seen.add(m);
								models.push(m);
							}
						}
					} else {
						logger.warn(
							`CLI model discovery failed for ${agentId}: exit code ${result.exitCode}`,
							LOG_CONTEXT,
							{ stderr: result.stderr }
						);
					}

					// Source 2: opencode.json config files
					const configModels = await discoverModelsFromLocalConfigs();
					for (const m of configModels) {
						if (!seen.has(m)) {
							seen.add(m);
							models.push(m);
						}
					}

					logger.info(`Discovered ${models.length} models for ${agentId}`, LOG_CONTEXT, {
						models,
					});
					return models;
				}

				case 'copilot-cli': {
					// Copilot CLI: fetch available models from models.dev API (github-copilot
					// provider) and merge with the user's configured model from
					// ~/.copilot/config.json. Falls back to just the configured model if the
					// API is unavailable.
					const userModel = readCopilotConfiguredModel();
					const apiModels = await fetchCopilotModelsFromApi();

					if (apiModels !== null) {
						const models = [...apiModels];
						if (userModel && !models.includes(userModel)) {
							models.unshift(userModel);
						}
						logger.info(
							`Discovered ${models.length} models for ${agentId} from models.dev`,
							LOG_CONTEXT
						);
						return models;
					}

					return userModel ? [userModel] : [];
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

	/**
	 * Discover available values for a dynamic select config option.
	 * Returns an array of option values, or empty array if discovery is not supported.
	 *
	 * @param agentId - Agent identifier
	 * @param optionKey - The config option key (e.g., 'effort', 'reasoningEffort')
	 * @param forceRefresh - If true, bypass cache
	 */
	async discoverConfigOptions(
		agentId: string,
		optionKey: string,
		forceRefresh = false
	): Promise<string[]> {
		const agent = await this.getAgent(agentId);

		if (!agent || !agent.available) {
			return [];
		}

		// Check cache
		const cacheKey = `${agentId}:${optionKey}`;
		if (!forceRefresh) {
			const cached = this.configOptionCache.get(cacheKey);
			if (cached && Date.now() - cached.timestamp < this.modelCacheTtlMs) {
				return cached.options;
			}
		}

		const options = await this.runConfigOptionDiscovery(agentId, optionKey);
		this.configOptionCache.set(cacheKey, { options, timestamp: Date.now() });
		return options;
	}

	/**
	 * Run agent-specific discovery for a config option's available values.
	 */
	private async runConfigOptionDiscovery(agentId: string, optionKey: string): Promise<string[]> {
		try {
			switch (agentId) {
				case 'claude-code': {
					if (optionKey === 'effort') {
						// Claude Code: parse --help output to extract effort levels
						const command =
							(await this.getAgent(agentId))?.path ||
							(await this.getAgent(agentId))?.command ||
							'claude';
						const env = getExpandedEnv();
						const result = await execFileNoThrow(command, ['--help'], undefined, env);
						if (result.exitCode === 0) {
							// Match: --effort <level>  Effort level ... (low, medium, high, max)
							const match = result.stdout.match(/--effort\s+<\w+>\s+.*?\(([^)]+)\)/);
							if (match) {
								const levels = match[1]
									.split(',')
									.map((s) => s.trim())
									.filter((s) => s.length > 0);
								logger.info(
									`Discovered ${levels.length} effort levels for ${agentId} from --help`,
									LOG_CONTEXT,
									{ levels }
								);
								return ['', ...levels]; // Empty string = use default
							}
						}
						logger.debug('Could not parse effort levels from Claude --help output', LOG_CONTEXT);
						return [];
					}
					break;
				}

				case 'codex': {
					if (optionKey === 'reasoningEffort') {
						// Codex: read reasoning levels from ~/.codex/models_cache.json
						const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
						const cachePath = path.join(codexHome, 'models_cache.json');
						const cacheContent = fs.readFileSync(cachePath, 'utf8');
						const cache = JSON.parse(cacheContent);
						if (Array.isArray(cache.models)) {
							// Collect union of all reasoning levels across visible models
							const levelSet = new Set<string>();
							for (const model of cache.models) {
								if (model.visibility === 'hide') continue;
								for (const rl of model.supported_reasoning_levels || []) {
									if (rl.effort) levelSet.add(rl.effort);
								}
							}
							const levels = Array.from(levelSet);
							// Sort by severity: minimal < low < medium < high < xhigh
							const order = ['minimal', 'low', 'medium', 'high', 'xhigh'];
							levels.sort(
								(a, b) =>
									(order.indexOf(a) === -1 ? 99 : order.indexOf(a)) -
									(order.indexOf(b) === -1 ? 99 : order.indexOf(b))
							);
							logger.info(
								`Discovered ${levels.length} reasoning levels for ${agentId} from models_cache.json`,
								LOG_CONTEXT,
								{ levels }
							);
							return ['', ...levels]; // Empty string = use default
						}
					}
					break;
				}
			}
		} catch (error) {
			void captureException(error);
			logger.debug(`Config option discovery failed for ${agentId}:${optionKey}`, LOG_CONTEXT, {
				error,
			});
		}

		return [];
	}
}
