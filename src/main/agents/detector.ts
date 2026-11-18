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
import { createHash } from 'crypto';
import { execFileNoThrow } from '../utils/execFile';
import { logger } from '../utils/logger';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { captureException } from '../utils/sentry';
import { getAgentCapabilities } from './capabilities';
import {
	checkBinaryExists,
	checkCustomPath,
	findAllBinaryPaths,
	getExpandedEnv,
} from './path-prober';
import { AGENT_DEFINITIONS, type AgentConfig } from './definitions';
import { resolveConfigDirKeyFromEnv } from './claudeSpawnCore';
import { discoverModelsFromLocalConfigs } from './opencode-config';
import { isWindows } from '../../shared/platformDetection';
import { parseJsonWithBom } from '../../shared/jsonUtils';
import { capabilitySnapshots } from './capability-snapshot';
import {
	setOmpModelCatalog,
	computeOmpCatalogKey,
	primeOmpModelCatalog,
	buildOmpPrimeEnv,
} from './omp-model-catalog';
import { isBlankEnvValue } from '../../shared/agentEnvironment';
import { resolveAgentAccountDir } from '../../shared/agentAccountDir';
import { resolveAgentAccountKey } from '../../shared/providerProfiles';
import { canonicalJson } from '../../shared/canonicalJson';
import type { AgentDiscoveryResult } from '../../shared/types';
import type { GrokAcpConfigurationObservation } from '../../shared/maestro-lib/grok/acp-turn';
import type { TurnProcessSpec } from '../../shared/maestro-lib/run/start-turn';
import {
	buildAgentEnvironment,
	type BuildAgentEnvironmentOptions,
} from '../../shared/maestro-lib/launch/env';
import type { SshLaunchTarget } from '../../shared/maestro-lib/launch/ssh-remote-resolver';

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
		// Config may not exist or be malformed - fall through to null.
	}
	return null;
}

/** A record's own entry, never one inherited from `Object.prototype`. */
function ownEntry<T>(record: Record<string, T>, key: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** What Maestro takes from Grok's own `$GROK_HOME/models_cache.json`. */
export interface GrokModelsCacheRead {
	/** Visible model ids, in the order the cache lists them. */
	models: string[];
	/** Context window in tokens by model id, for models that report one. */
	contextWindows: Record<string, number>;
	/** Reasoning-effort values by model id, for models that support effort. */
	efforts: Record<string, string[]>;
}

/**
 * Read the model catalog the Grok binary maintains in its account directory.
 * Only model ids, `info.context_window` and `info.reasoning_efforts[].value`
 * are taken: the file also carries `identity`, `auth_method`, `origin`, and a
 * per-model `api_key`, `env_key` and `api_base_url`, none of which may leave it.
 * Returns null when the file is absent, malformed, or lists no visible model.
 */
export function readGrokModelsCache(accountDir: string): GrokModelsCacheRead | null {
	try {
		const cache = parseJsonWithBom<{ models?: unknown }>(
			fs.readFileSync(path.join(accountDir, 'models_cache.json'), 'utf8')
		);
		const entries = cache?.models;
		if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
			throw new Error('models_cache.json has no models map');
		}
		const models: string[] = [];
		const windows: Array<[string, number]> = [];
		const efforts: Array<[string, string[]]> = [];
		for (const [id, entry] of Object.entries(entries as Record<string, unknown>)) {
			const info = (entry as { info?: Record<string, unknown> } | null)?.info;
			if (!id.trim() || !info || typeof info !== 'object' || info.hidden === true) continue;
			models.push(id);
			const window = info.context_window;
			if (typeof window === 'number' && Number.isSafeInteger(window) && window > 0) {
				windows.push([id, window]);
			}
			if (info.supports_reasoning_effort !== false && Array.isArray(info.reasoning_efforts)) {
				const values = info.reasoning_efforts
					.map((effort) => (effort as { value?: unknown } | null)?.value)
					.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
				if (values.length > 0) efforts.push([id, [...new Set(values)]]);
			}
		}
		if (models.length === 0) throw new Error('models_cache.json lists no visible model');
		return {
			models,
			contextWindows: Object.fromEntries(windows),
			efforts: Object.fromEntries(efforts),
		};
	} catch {
		logger.debug('Grok models_cache.json unavailable or malformed', LOG_CONTEXT);
		return null;
	}
}

/**
 * Fetch the list of Copilot CLI models from the models.dev catalog.
 * Returns null when the request fails or the schema doesn't match; callers
 * should fall back to the user-configured model in that case.
 */
async function fetchCopilotModelsFromApi(): Promise<string[] | null> {
	try {
		const response = await fetchWithTimeout(MODELS_DEV_API_URL, {}, MODELS_DEV_FETCH_TIMEOUT_MS);
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
	}
}

// ============ Claude Code model discovery ============

/**
 * Tier aliases Claude Code always accepts, each resolving to the current model
 * in that tier. `[1m]` variants select the 1M extended context window and need
 * extra usage enabled at claude.ai/settings/usage; the CLI offers them for opus
 * and sonnet only.
 *
 * Not every model has an alias - limited-access models are reachable only by
 * their full ID - so this list is a floor, never the whole picture. The sources
 * below fill in the rest.
 */
const CLAUDE_MODEL_ALIASES = ['fable', 'sonnet', 'opus', 'haiku', 'opus[1m]', 'sonnet[1m]'];

/**
 * Model catalog the Claude Code CLI caches to render its own `/model` picker,
 * relative to the Claude config directory.
 */
const CLAUDE_CATALOG_SUBDIR = ['cache', 'model-catalog'];

/**
 * Surface key for Claude Code inside the catalog. The catalog also carries
 * `chat`, `cowork` and others, whose model lists differ.
 */
const CLAUDE_CATALOG_SURFACE = 'cc';

/** One entry of a surface's model selector, in either catalog shape. */
interface ClaudeCatalogSelectorConfig {
	models?: Array<{ id?: string }>;
}

/**
 * The CLI's cached catalog, in both shapes seen in the wild.
 *
 * Shape A (observed on CLI 2.1.257): one `published-<hash>.json` holding every
 * surface, keyed by name under `document.surfaces`, each with an array of
 * selector configs.
 *
 * Shape B (observed on CLI 2.1.294): one `<uuid>-<hash>-<surface>.json` per
 * surface, the surface named in a field rather than a key, and a single
 * selector config object instead of an array.
 *
 * This is an undocumented cache that has already been reshaped once between two
 * patch releases, so both shapes are read and neither is required.
 */
interface ClaudeCatalogFile {
	document?: {
		surfaces?: Record<
			string,
			{ model_selector_config?: ClaudeCatalogSelectorConfig | ClaudeCatalogSelectorConfig[] }
		>;
	};
	catalog?: {
		surface?: string;
		config?: ClaudeCatalogSelectorConfig | ClaudeCatalogSelectorConfig[];
	};
}

interface ClaudeConfigFile {
	projects?: Record<string, { lastModelUsage?: Record<string, unknown> }>;
}

interface ClaudeStatsCacheFile {
	modelUsage?: Record<string, unknown>;
}

/** Tolerate a field that is a single object in one CLI build and an array in another. */
function asConfigList(
	value: ClaudeCatalogSelectorConfig | ClaudeCatalogSelectorConfig[] | undefined
): ClaudeCatalogSelectorConfig[] {
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
}

/**
 * The Claude Code state directory this machine's CLI actually writes to:
 * `$CLAUDE_CONFIG_DIR` when set, `~/.claude` otherwise.
 *
 * Maestro supports several Claude accounts at once by pointing agents at
 * different config dirs, so discovery that hardcoded `~/.claude` would offer
 * one account's models while the agent runs as another.
 *
 * `resolveConfigDirKeyFromEnv` is the canonical resolver - the spawner, the
 * usage sampler and the CLI all key off it - but a blank `CLAUDE_CONFIG_DIR`
 * survives its `??` and resolves to the process cwd, which is nobody's account.
 * `isBlankEnvValue` is the codebase's existing answer to set-but-empty, so a
 * blank value is folded back to unset before the resolver sees it.
 */
function resolveClaudeConfigDir(): string {
	return resolveConfigDirKeyFromEnv(hasExplicitClaudeConfigDir() ? process.env : {});
}

/** Whether `CLAUDE_CONFIG_DIR` is set to something that actually names a directory. */
function hasExplicitClaudeConfigDir(): boolean {
	const value = process.env.CLAUDE_CONFIG_DIR;
	return typeof value === 'string' && !isBlankEnvValue(value);
}

/**
 * Where the CLI keeps `.claude.json`.
 *
 * By default it sits *beside* `~/.claude`, not inside it. With
 * `CLAUDE_CONFIG_DIR` set, the CLI writes it inside that directory instead.
 */
function resolveClaudeConfigJsonPath(): string {
	return hasExplicitClaudeConfigDir()
		? path.join(resolveClaudeConfigDir(), '.claude.json')
		: path.join(os.homedir(), '.claude.json');
}

/** Model IDs the `cc` surface offers, from whichever catalog shape this file is in. */
function readCatalogSurfaceModelIds(file: ClaudeCatalogFile): string[] {
	const configs = [
		...asConfigList(file.document?.surfaces?.[CLAUDE_CATALOG_SURFACE]?.model_selector_config),
		...(file.catalog?.surface === CLAUDE_CATALOG_SURFACE ? asConfigList(file.catalog.config) : []),
	];

	const ids: string[] = [];
	for (const config of configs) {
		for (const model of config?.models ?? []) {
			if (typeof model?.id === 'string' && model.id && !ids.includes(model.id)) {
				ids.push(model.id);
			}
		}
	}
	return ids;
}

/**
 * Model IDs from the CLI's cached model catalog.
 *
 * This is the list Claude Code's own `/model` picker renders. Anthropic
 * publishes the catalog and the CLI refreshes it on its own schedule, so new
 * models reach the dropdown without a Maestro release.
 *
 * Every `.json` in the directory is a candidate: the file naming has already
 * changed once (`published-<hash>.json` -> `<uuid>-<hash>-cc.json`) between two
 * patch releases, so the name is not a contract. Only `published-floor.json` is
 * reliably an index rather than a catalog. Files belonging to another surface
 * are discarded by the surface check, not by their name.
 *
 * Returns an empty list when the cache is missing or unreadable - it is written
 * lazily, so a fresh install legitimately has none.
 */
function readClaudeCatalogModelIds(): string[] {
	const dir = path.join(resolveClaudeConfigDir(), ...CLAUDE_CATALOG_SUBDIR);
	let entries: string[];
	try {
		entries = fs
			.readdirSync(dir)
			.filter((name) => name.endsWith('.json') && name !== 'published-floor.json');
	} catch {
		logger.debug('No Claude model catalog cache for model discovery', LOG_CONTEXT);
		return [];
	}

	const ids: string[] = [];
	for (const entry of entries) {
		try {
			const catalog = parseJsonWithBom<ClaudeCatalogFile>(
				fs.readFileSync(path.join(dir, entry), 'utf8')
			);
			for (const id of readCatalogSurfaceModelIds(catalog)) {
				if (!ids.includes(id)) {
					ids.push(id);
				}
			}
		} catch {
			// A half-written or superseded catalog file should not cost us the others.
			logger.debug(`Could not read Claude model catalog ${entry}`, LOG_CONTEXT);
		}
	}
	return ids;
}

/**
 * Model IDs this user has actually run, across every project.
 *
 * Read from `.claude.json`, where the CLI records per-project usage as
 * `projects.<cwd>.lastModelUsage`. This is what surfaces a model the published
 * catalog does not list - preview and limited-access models - once it has been
 * used at least once.
 */
function readClaudeUsedModelIds(): string[] {
	const ids: string[] = [];
	try {
		const config = parseJsonWithBom<ClaudeConfigFile>(
			fs.readFileSync(resolveClaudeConfigJsonPath(), 'utf8')
		);
		for (const project of Object.values(config.projects ?? {})) {
			for (const modelId of Object.keys(project?.lastModelUsage ?? {})) {
				if (modelId && !ids.includes(modelId)) {
					ids.push(modelId);
				}
			}
		}
	} catch {
		// Absent on a fresh install, and unreadable is not worth failing over.
		logger.debug('Could not read .claude.json for model discovery', LOG_CONTEXT);
	}
	return ids;
}

/**
 * Model IDs from the legacy `stats-cache.json`.
 *
 * Current Claude Code does not write this file here any more - the path moved
 * under the CLI's XDG state directory - which is why it had stopped
 * contributing anything. Machines that ran an older build still have it, and on
 * those it is the only record of what they used, so it stays as a third
 * fail-soft source. Absent is the ordinary case and costs one failed read.
 */
function readClaudeStatsCacheModelIds(): string[] {
	const ids: string[] = [];
	try {
		const stats = parseJsonWithBom<ClaudeStatsCacheFile>(
			fs.readFileSync(path.join(resolveClaudeConfigDir(), 'stats-cache.json'), 'utf8')
		);
		for (const modelId of Object.keys(stats.modelUsage ?? {})) {
			if (modelId && !ids.includes(modelId)) {
				ids.push(modelId);
			}
		}
	} catch {
		// Expected on any machine that never ran a CLI build that wrote it here.
		logger.debug('Could not read Claude stats-cache.json for model discovery', LOG_CONTEXT);
	}
	return ids;
}
// ============ Agent Detector Class ============

/** Default cache TTL: 5 minutes (model lists don't change frequently) */
const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

/** Host-selected context, never inferred from another account's native cache. */
export interface ModelDiscoveryContext {
	environment: BuildAgentEnvironmentOptions;
	cwd: string;
	customPath?: string;
	/** Remote discovery belongs to the remote host; this detector is local. */
	target: SshLaunchTarget;
	/** Keep an explicit selection even when discovery is unavailable. */
	model?: string;
	effort?: string;
	/**
	 * Host-owned revision covering file-based auth, endpoint and project config.
	 * An owned ACP observation port must supply one when the caller cannot.
	 */
	configGeneration?: string;
	/** Host-owned cancellation; never serialize an AbortSignal over IPC. */
	signal?: AbortSignal;
}

export interface AgentDetectorDeps {
	/** Provider-settings context when no individual agent was selected. */
	modelDiscoveryContext?: (agentId: string) => ModelDiscoveryContext | undefined;
	/**
	 * Read only, no spawn/RPC: the host returns a current owned-process observation
	 * for this exact selection, or undefined. It owns auth/config-file invalidation,
	 * actual executable/version and local account/host identity. Never persist/log
	 * the launch environment; return the actual launch receipt, not echoed input.
	 * Production wiring belongs to the route owner, not the renderer or detector.
	 */
	grokAcpObservation?: (
		selection: Pick<TurnProcessSpec, 'command' | 'env' | 'cwd'> & { model?: string }
	) =>
		| {
				launch: Pick<TurnProcessSpec, 'command' | 'env' | 'cwd'>;
				agentVersion: string;
				configGeneration: string;
				observation: GrokAcpConfigurationObservation;
		  }
		| undefined;
}

export class AgentDetector {
	private cachedAgents: AgentConfig[] | null = null;
	private detectionInProgress: Promise<AgentConfig[]> | null = null;
	private customPaths: Record<string, string> = {};
	// Model discovery: provider ID, or Grok's ephemeral selected-context key.
	private modelCache: Map<string, { models: string[]; timestamp: number }> = new Map();
	// Cache for config option discovery: "agentId:optionKey" -> { options, timestamp }
	private configOptionCache: Map<string, { options: string[]; timestamp: number }> = new Map();
	// Configurable cache TTL (useful for testing or different environments)
	private readonly modelCacheTtlMs: number;
	private readonly deps: AgentDetectorDeps;

	/**
	 * Create an AgentDetector instance
	 * @param modelCacheTtlMs - Model cache TTL in milliseconds (default: 5 minutes)
	 * @param deps - Grok selected-context discovery: the provider-settings context and the owned ACP observation
	 */
	constructor(modelCacheTtlMs: number = DEFAULT_MODEL_CACHE_TTL_MS, deps: AgentDetectorDeps = {}) {
		this.modelCacheTtlMs = modelCacheTtlMs;
		this.deps = deps;
	}

	/**
	 * Set custom paths for agents (from user configuration)
	 */
	setCustomPaths(paths: Record<string, string>): void {
		this.customPaths = paths;
		// Clear cache when custom paths change
		this.cachedAgents = null;
		this.clearModelCache('grok');
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
			let resolvedCustomPath: string | undefined;

			// If user has specified a custom path, check that first
			if (customPath) {
				detection = await checkCustomPath(customPath);
				if (detection.exists) {
					resolvedCustomPath = detection.path || customPath;
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

			// Enumerate every detected installation so the renderer can offer a
			// chooser when multiple valid binaries exist (e.g. nvm-managed codex
			// alongside a wrapper like codex-multi-auth-codex). Bash is on every
			// system and not user-selectable, so we skip the extra probe for it.
			let allPaths: string[] | undefined;
			if (detection.exists && agentDef.binaryName !== 'bash') {
				try {
					const found = await findAllBinaryPaths(agentDef.binaryName);
					// Always include the active path (custom or detected) so the
					// chooser reflects what is currently in use, even if it isn't
					// one of the auto-probed locations. Compared by canonical path, not
					// raw string, so a symlink alias (or a Windows casing difference)
					// that resolves to an entry already in `found` doesn't show up as a
					// second, phantom install.
					const active = detection.path;
					let isActiveAlreadyFound = false;
					if (active) {
						const normalize = async (p: string): Promise<string> => {
							const resolved = await fs.promises.realpath(p).catch(() => p);
							return isWindows() ? resolved.toLowerCase() : resolved;
						};
						const activeKey = await normalize(active);
						const foundKeys = await Promise.all(found.map(normalize));
						isActiveAlreadyFound = foundKeys.includes(activeKey);
					}
					const merged = active && !isActiveAlreadyFound ? [active, ...found] : found;
					if (merged.length > 1) {
						allPaths = merged;
					}
				} catch (err) {
					// Non-fatal: chooser is just a nice-to-have, single-path mode still works.
					logger.debug(`findAllBinaryPaths failed for ${agentDef.binaryName}`, LOG_CONTEXT, {
						err,
					});
				}
			}

			agents.push({
				...agentDef,
				available: detection.exists,
				path: detection.path,
				customPath: resolvedCustomPath,
				allPaths,
				capabilities: getAgentCapabilities(agentDef.id),
			});

			// Mirror detection into the capability snapshot store so the
			// renderer has a persisted readiness pill for every agent. Skip
			// the internal `terminal` agent - it isn't user-facing.
			//
			// Each agent is only written when its observed state actually
			// changed (status differs, or the detected path differs). This
			// keeps full-detection runs (incl. reprobe-driven ones) from
			// firing `snapshot-updated` broadcasts for every unchanged agent.
			if (agentDef.id !== 'terminal') {
				const existing = capabilitySnapshots.get(agentDef.id);
				if (detection.exists) {
					// Preserve any reactive auth_required state set by a recent
					// spawn failure - detection alone shouldn't clear it. The
					// next successful spawn (or explicit re-probe) flips it back.
					if (existing?.status === 'auth_required') {
						// no-op: leave reactive state intact
					} else if (existing?.status !== 'ok' || existing.path !== detection.path) {
						capabilitySnapshots.markOk(agentDef.id, { path: detection.path });
					}
				} else if (existing?.status !== 'not_installed') {
					capabilitySnapshots.markNotInstalled(agentDef.id);
				}
			}

			// Warm the default-identity omp context-window catalog the moment omp
			// is detected, so a user's first prompt already has the real per-turn
			// window resolved instead of losing a cold-start race against the
			// spawn-time prime cap. Non-blocking: the catalog's own TTL/dedupe
			// guards against repeated primes, and custom-path/env sessions still
			// prime their own identity at spawn time.
			if (agentDef.id === 'omp' && detection.exists && detection.path) {
				// Prime with the same env-construction the spawn path uses
				// (expanded PATH + the binary's own dir first) so a bun-based
				// `omp` at ~/.bun/bin resolves its co-located runtime here too.
				// getExpandedEnv() alone omits ~/.bun/bin, so the eager warm-up
				// would lose the very cold-start race it exists to win.
				primeOmpModelCatalog(
					detection.path,
					buildOmpPrimeEnv(detection.path),
					computeOmpCatalogKey(detection.path, undefined)
				);
			}
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
			for (const key of this.modelCache.keys()) {
				if (key === agentId || key.startsWith(`${agentId}:`)) this.modelCache.delete(key);
			}
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
	async discoverModels(
		agentId: string,
		forceRefresh = false,
		context?: ModelDiscoveryContext
	): Promise<string[]> {
		if (agentId === 'grok') {
			return (
				await this.discoverGrokOptions(
					context ?? this.deps.modelDiscoveryContext?.(agentId),
					'model',
					forceRefresh
				)
			).options;
		}
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

		// A transient `omp models --json` failure returns an empty list. Don't cache
		// that, or the picker stays empty for the whole TTL even after the CLI
		// recovers; let the next call retry. (omp always has a non-empty catalog.)
		if (agentId === 'omp' && models.length === 0) {
			return models;
		}

		// Cache the results
		this.modelCache.set(agentId, { models, timestamp: Date.now() });

		return models;
	}

	/** Typed selected-context discovery keeps empty catalogs distinct from unavailable metadata. */
	async discoverGrokOptions(
		context: ModelDiscoveryContext | undefined,
		optionKey = 'model',
		forceRefresh = false
	): Promise<AgentDiscoveryResult> {
		const isModel = optionKey === 'model';
		const isEffort = optionKey === 'effort' || optionKey === 'reasoningEffort';
		const configuredValue = (
			isModel ? context?.model : isEffort ? context?.effort : undefined
		)?.trim();
		const fallback = (reason: AgentDiscoveryResult['reason']): AgentDiscoveryResult => ({
			status: configuredValue ? 'configured-fallback' : 'unavailable',
			options: configuredValue ? [configuredValue] : [],
			configuredValue: configuredValue || undefined,
			reason,
		});
		if (!context) return fallback('missing-context');
		if (context.target.kind !== 'local') return fallback('remote-unqualified');
		if (!path.isAbsolute(context.cwd)) return fallback('missing-context');
		if (!isModel && !isEffort) return fallback('metadata-unavailable');
		if (context.signal?.aborted) return fallback('discovery-unavailable');
		try {
			const readObservation = this.deps.grokAcpObservation;
			// Pre-turn discovery has no contained probe route. Even --version remains
			// refused by runProviderProbe (grok-probe.ts); do not create a second spawn path.
			// Without an owned observation the account's models_cache.json, which the
			// binary itself maintains, is the only menu and window source.
			context = { ...context, environment: structuredClone(context.environment) };
			const customPath = context.customPath?.trim() || this.customPaths.grok?.trim();
			const binary = customPath
				? await checkCustomPath(customPath)
				: await checkBinaryExists('grok');
			if (context.signal?.aborted) return fallback('discovery-unavailable');
			if (!binary.exists || !binary.path) return fallback('executable-context-unavailable');
			const command = binary.path;
			const env = buildAgentEnvironment({
				...context.environment,
				extraPathDirs: [path.dirname(command), ...(context.environment.extraPathDirs ?? [])],
			});
			const accountDir = resolveAgentAccountDir(
				{ toolType: 'grok' },
				{ env, homeDir: os.homedir() }
			) as string;
			env.GROK_HOME = accountDir;
			const accountKey = resolveAgentAccountKey('grok', { GROK_HOME: accountDir }, os.homedir());
			const cacheRead = readGrokModelsCache(accountDir);
			this.recordGrokContextWindows(accountKey, cacheRead, context.model);
			const discovered = (values: string[]): AgentDiscoveryResult => {
				const stale = configuredValue && !values.includes(configuredValue);
				return {
					status: stale ? 'configured-fallback' : 'discovered',
					options: [...new Set([...values, ...(configuredValue ? [configuredValue] : [])])],
					configuredValue: configuredValue || undefined,
					...(stale ? { reason: 'metadata-unavailable' as const } : {}),
				};
			};
			const fromCache = (
				reason: AgentDiscoveryResult['reason'] = 'discovery-unavailable'
			): AgentDiscoveryResult => {
				const values = isModel
					? cacheRead?.models
					: context?.model && cacheRead
						? ownEntry(cacheRead.efforts, context.model)
						: undefined;
				return values ? discovered(values) : fallback(reason);
			};
			const launch = { command, env, cwd: context.cwd };
			const owned = readObservation?.(structuredClone({ ...launch, model: context.model }));
			if (context.signal?.aborted) return fallback('discovery-unavailable');
			if (!owned) return fromCache();
			const {
				observation,
				agentVersion,
				configGeneration,
				launch: actualLaunch,
			} = structuredClone(owned);
			const { configuration, observedAt } = observation;
			if (
				canonicalJson(actualLaunch) !== canonicalJson(launch) ||
				observation.cwd !== context.cwd ||
				!agentVersion?.trim() ||
				configuration.agentVersion !== agentVersion ||
				!configGeneration?.trim() ||
				(context.configGeneration !== undefined && context.configGeneration !== configGeneration) ||
				!observation.account?.trim() ||
				!observation.host?.trim() ||
				!observation.processGeneration?.trim() ||
				!observation.sessionId?.trim() ||
				!Number.isFinite(observedAt) ||
				observedAt > Date.now() ||
				Date.now() - observedAt >= this.modelCacheTtlMs
			)
				return fromCache();
			// The observation names the account's current model; with none configured
			// it is the default whose cached window the gauge may use.
			if (!context.model?.trim() && configuration.model?.trim())
				this.recordGrokContextWindows(accountKey, cacheRead, undefined, configuration.model);
			// Only hashes/menus enter the existing ephemeral caches. Each read still
			// requires a current host receipt, even when a matching cache entry exists.
			const key = `grok:${createHash('sha256')
				.update(
					canonicalJson({
						launch,
						agentVersion,
						configGeneration,
						observation,
						selectedModel: context.model,
					})
				)
				.digest('hex')}`;
			const modelSelector = configuration.configOptions.find(({ id }) => id === 'model');
			const effortSelector = configuration.configOptions.find(
				({ id }) => id === 'reasoning_effort'
			);
			const models =
				observation.models?.availableModels.map(({ modelId }) => modelId) ??
				modelSelector?.options.map(({ value }) => value);
			const efforts =
				configuration.model && (!context.model || context.model === configuration.model)
					? effortSelector?.options.map(({ value }) => value)
					: undefined;
			const cached = isModel
				? this.modelCache.get(key)?.models
				: this.configOptionCache.get(key)?.options;
			// Replace both menus together, including absence after a model change.
			this.clearModelCache('grok');
			if (models !== undefined) this.modelCache.set(key, { models, timestamp: observedAt });
			if (efforts !== undefined)
				this.configOptionCache.set(key, { options: efforts, timestamp: observedAt });
			const values = !forceRefresh && cached !== undefined ? cached : isModel ? models : efforts;
			if (values === undefined) return fromCache('metadata-unavailable');
			return discovered(values);
		} catch {
			// Never expose native diagnostics, receipt keys or credential-bearing contexts.
			logger.debug('Grok discovery unavailable: owned observation unavailable', LOG_CONTEXT);
			return fallback('discovery-unavailable');
		}
	}

	/**
	 * Keep the Grok snapshot's per-account windows in step with the account's
	 * models_cache.json: replace that account's entry, or drop it when the cache
	 * is absent, malformed or reports no window, so the gauge goes unknown rather
	 * than keeping a stale size. Only a snapshot already marked ok is patched;
	 * detection owns the readiness status.
	 */
	private recordGrokContextWindows(
		accountKey: string | null,
		read: GrokModelsCacheRead | null,
		selectedModel: string | undefined,
		observedDefaultModel?: string
	): void {
		const previous = capabilitySnapshots.get('grok');
		if (!accountKey || previous?.status !== 'ok') return;
		const all = { ...previous.accountModelContextWindows };
		const before = ownEntry(all, accountKey);
		const defaultModel =
			observedDefaultModel?.trim() || (selectedModel?.trim() ? before?.defaultModel : undefined);
		if (read && Object.keys(read.contextWindows).length > 0) {
			all[accountKey] = { windows: read.contextWindows, ...(defaultModel ? { defaultModel } : {}) };
		} else {
			delete all[accountKey];
		}
		if (canonicalJson(before ?? null) === canonicalJson(ownEntry(all, accountKey) ?? null)) return;
		capabilitySnapshots.markOk('grok', {
			accountModelContextWindows: Object.keys(all).length > 0 ? all : undefined,
		});
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
					// Claude Code: no CLI listing command, so the list is assembled from
					// whatever the CLI itself leaves on disk. Every source is optional and
					// fails soft; the aliases alone are always a usable list.
					//
					// All three on-disk sources are read from the config dir this machine's
					// CLI actually writes to (`$CLAUDE_CONFIG_DIR`, else `~/.claude`), so a
					// multi-account setup is offered its own account's models.
					//
					// Ordering is deliberate: aliases first (short and the common case),
					// then full IDs, so the top of the dropdown stays stable.
					const models: string[] = [...CLAUDE_MODEL_ALIASES];
					const add = (modelId: unknown): void => {
						if (typeof modelId === 'string' && modelId && !models.includes(modelId)) {
							models.push(modelId);
						}
					};

					// 1. The CLI's own model catalog - the same list its `/model` picker
					//    renders. Anthropic publishes it, the CLI caches it, so new models
					//    appear here without a Maestro release.
					for (const modelId of readClaudeCatalogModelIds()) {
						add(modelId);
					}

					// 2. Models this user has actually run. Covers anything the published
					//    catalog does not carry (limited-access and preview models), which
					//    the catalog alone would never surface.
					for (const modelId of readClaudeUsedModelIds()) {
						add(modelId);
					}

					// 3. The legacy stats cache. Current CLI builds no longer write it
					//    here, so it contributes nothing on an up-to-date machine - but
					//    one that ran an older build keeps its history this way.
					for (const modelId of readClaudeStatsCacheModelIds()) {
						add(modelId);
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
						const cache = parseJsonWithBom<{
							models?: Array<{ slug?: string; visibility?: string }>;
						}>(cacheContent);
						if (Array.isArray(cache.models)) {
							const models = cache.models
								.filter(
									(m: {
										slug?: string;
										visibility?: string;
									}): m is { slug: string; visibility?: string } =>
										typeof m.slug === 'string' && m.visibility !== 'hide'
								)
								.map((m) => m.slug);
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

				case 'omp': {
					// Oh My Pi: `omp models --json` returns { models: [{ id, selector, ... }] }
					// across every configured provider. Prefer the provider-qualified `selector`
					// (e.g. anthropic/claude-opus-4-8), which is unambiguous for --model.
					// Use the same env as the two prime sites (detection warm-up and spawn):
					// `buildOmpPrimeEnv` expands the PATH with `~/.bun/bin` and prepends the
					// binary's own directory so a co-located runtime resolves. Running this
					// discovery with the shared `getExpandedEnv()` result instead would let
					// it fail (or resolve differently) where the primes succeed, and it feeds
					// `setOmpModelCatalog` below, so the catalogs must stay in lockstep.
					const result = await execFileNoThrow(
						command,
						['models', '--json'],
						undefined,
						buildOmpPrimeEnv(command)
					);
					if (result.exitCode !== 0) {
						logger.warn(
							`CLI model discovery failed for ${agentId}: exit code ${result.exitCode}`,
							LOG_CONTEXT,
							{ stderr: result.stderr }
						);
						return [];
					}
					let parsed: {
						models?: Array<{ id?: string; selector?: string; contextWindow?: number }>;
					};
					try {
						parsed = parseJsonWithBom<{
							models?: Array<{ id?: string; selector?: string; contextWindow?: number }>;
						}>(result.stdout);
					} catch (parseError) {
						captureException(parseError, {
							operation: 'agent:modelDiscovery',
							agentId,
						});
						logger.warn('Failed to parse omp models --json output', LOG_CONTEXT, {
							error: parseError,
						});
						return [];
					}
					// Feed the context-window catalog off the same call, so the usage path
					// can resolve a model's real window without a second fetch. Key it to
					// the default identity (this binary, no env overrides) so it warms
					// only same-config sessions; custom-path/env sessions prime their own.
					setOmpModelCatalog(parsed.models ?? [], computeOmpCatalogKey(command, undefined));
					const seen = new Set<string>();
					const models: string[] = [];
					for (const entry of parsed.models ?? []) {
						const modelId = entry.selector || entry.id;
						if (modelId && !seen.has(modelId)) {
							seen.add(modelId);
							models.push(modelId);
						}
					}
					logger.info(`Discovered ${models.length} models for ${agentId}`, LOG_CONTEXT);
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
		forceRefresh = false,
		context?: ModelDiscoveryContext
	): Promise<string[]> {
		if (agentId === 'grok') {
			if (!['model', 'effort', 'reasoningEffort'].includes(optionKey)) return [];
			const result = await this.discoverGrokOptions(
				context ?? this.deps.modelDiscoveryContext?.(agentId),
				optionKey,
				forceRefresh
			);
			return ['', ...result.options];
		}
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
						const command =
							(await this.getAgent(agentId))?.path ||
							(await this.getAgent(agentId))?.command ||
							'claude';
						const env = getExpandedEnv();

						// Primary: parse --help output. Older CLI builds list the levels
						// inline, e.g. `--effort <level>  Effort level ... (low, medium, high, max)`.
						const help = await execFileNoThrow(command, ['--help'], undefined, env);
						if (help.exitCode === 0) {
							const match = help.stdout.match(/--effort\s+<\w+>\s+.*?\(([^)]+)\)/);
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

						// Fallback: newer CLI builds dropped the parenthetical from --help but
						// still validate the flag. Probe with an invalid value and read back the
						// valid set the CLI names. Two known phrasings, depending on the build:
						//   - commander rejection (non-zero exit):
						//     `error: option '--effort <level>' argument 'x' is invalid. It must be one of: low, medium, high, xhigh, max`
						//   - soft warning (exit 0, still runs --version):
						//     `Warning: Unknown --effort value 'x' - ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max.`
						const probe = await execFileNoThrow(
							command,
							['--effort', '__maestro_probe__', '--version'],
							undefined,
							env
						);
						const probeOutput = `${probe.stderr}\n${probe.stdout}`;
						const probeMatch = probeOutput.match(
							/--effort\b[^\n]*?(?:must be one of|valid values):\s*([^\n]+)/i
						);
						if (probeMatch) {
							const levels = probeMatch[1]
								.split(',')
								.map((s) => s.trim().replace(/[.\s]+$/, ''))
								.filter((s) => s.length > 0);
							if (levels.length > 0) {
								logger.info(
									`Discovered ${levels.length} effort levels for ${agentId} from validation probe`,
									LOG_CONTEXT,
									{ levels }
								);
								return ['', ...levels]; // Empty string = use default
							}
						}

						logger.debug(
							'Could not discover effort levels for Claude Code; using static fallback',
							LOG_CONTEXT
						);
						// Fall through to the static-options fallback below rather than
						// returning [] - that keeps the effort pill/dropdown populated even
						// when the CLI reworded its --help/validation output yet again.
						break;
					}
					break;
				}

				case 'codex': {
					if (optionKey === 'reasoningEffort') {
						// Codex: read reasoning levels from ~/.codex/models_cache.json
						try {
							const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
							const cachePath = path.join(codexHome, 'models_cache.json');
							const cacheContent = fs.readFileSync(cachePath, 'utf8');
							const cache = parseJsonWithBom<{
								models?: Array<{
									visibility?: string;
									supported_reasoning_levels?: Array<{ effort?: string }>;
								}>;
							}>(cacheContent);
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
						} catch {
							// Fresh Codex installs may not have populated the cache yet.
							logger.debug(
								'Could not read Codex models_cache.json for config option discovery',
								LOG_CONTEXT
							);
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

		// Fallback: return the static options declared on the agent's select config option.
		// This handles agents whose options are hardcoded in the definition (e.g. Copilot-CLI,
		// Factory Droid reasoning effort) rather than discovered at runtime.
		const definition = AGENT_DEFINITIONS.find((d) => d.id === agentId);
		const option = definition?.configOptions?.find((o) => o.key === optionKey);
		if (option && option.type === 'select' && option.options && option.options.length > 0) {
			return option.options;
		}

		return [];
	}
}
