/**
 * OpenCode Configuration Utilities
 *
 * Shared helpers for resolving OpenCode config file paths, extracting models
 * from provider definitions, and reading slash commands. Used by both local
 * discovery (AgentDetector) and SSH remote discovery (agents IPC handlers).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isWindows } from '../../shared/platformDetection';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'OpenCodeConfig';

// ────────────────────────────────────────────────────
// Config path resolution
// ────────────────────────────────────────────────────

/**
 * Resolve the ordered list of opencode.json config file paths to probe.
 *
 * Follows OpenCode's own resolution logic:
 *   1. OPENCODE_CONFIG env var (explicit override)
 *   2. Project-local  <cwd>/opencode.json
 *   3. Platform-specific global paths
 *
 * @param cwd  Current working directory (for project-local config)
 * @param env  Optional environment overrides (defaults to process.env)
 */
export function getOpenCodeConfigPaths(
	cwd?: string,
	env?: Record<string, string | undefined>
): string[] {
	const effectiveEnv = env ?? process.env;
	const home = os.homedir();
	const opencodeHome = path.join(home, '.opencode');
	const globalConfigBase = effectiveEnv.XDG_CONFIG_HOME || path.join(home, '.config');
	const paths: string[] = [];

	if (effectiveEnv.OPENCODE_CONFIG) {
		paths.push(effectiveEnv.OPENCODE_CONFIG);
	}

	const projectLocal = cwd ? path.join(cwd, 'opencode.json') : null;

	if (isWindows()) {
		const localAppData = effectiveEnv.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
		if (projectLocal) paths.push(projectLocal);
		paths.push(
			path.join(localAppData, 'opencode', 'opencode.json'),
			path.join(home, '.opencode.json'),
			path.join(opencodeHome, 'opencode.json')
		);
	} else {
		if (projectLocal) paths.push(projectLocal);
		paths.push(
			path.join(opencodeHome, 'opencode.json'),
			path.join(home, '.opencode.json'),
			path.join(globalConfigBase, 'opencode', 'opencode.json')
		);
	}

	return paths;
}

/**
 * Resolve the ordered list of OpenCode slash-command directories to probe.
 *
 * @param cwd  Current working directory (for project-local commands)
 */
export function getOpenCodeCommandDirs(cwd?: string): string[] {
	const home = os.homedir();
	const opencodeHome = path.join(home, '.opencode');
	const globalConfigBase = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
	const dirs: string[] = [];

	if (cwd) dirs.push(path.join(cwd, '.opencode', 'commands'));
	dirs.push(path.join(opencodeHome, 'commands'));

	if (isWindows()) {
		const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
		dirs.push(path.join(localAppData, 'opencode', 'commands'));
	} else {
		dirs.push(path.join(globalConfigBase, 'opencode', 'commands'));
	}

	return dirs;
}

// ────────────────────────────────────────────────────
// Config file parsing
// ────────────────────────────────────────────────────

/**
 * Parse an opencode.json string and return its content as a typed object.
 * Returns `null` on invalid JSON.
 */
export function parseOpenCodeConfig(content: string): OpenCodeConfig | null {
	try {
		return JSON.parse(content) as OpenCodeConfig;
	} catch {
		return null;
	}
}

/**
 * Minimal typing for the subset of opencode.json we care about.
 *
 * Full spec: https://opencode.ai/docs/config/
 */
export interface OpenCodeConfig {
	/** Top-level model override (e.g. "ollama/qwen3:8b") */
	model?: string;
	/** Provider definitions, each with their own model catalogue */
	provider?: Record<string, OpenCodeProvider>;
	/** Slash command definitions */
	command?: Record<string, string | { prompt?: string }>;
}

export interface OpenCodeProvider {
	models?: Record<string, OpenCodeModelEntry>;
	[key: string]: unknown;
}

export interface OpenCodeModelEntry {
	name?: string;
	[key: string]: unknown;
}

// ────────────────────────────────────────────────────
// Model extraction
// ────────────────────────────────────────────────────

/**
 * Extract model IDs from a parsed OpenCode config.
 *
 * Models are derived from `provider.<provider_id>.models.<model_id>` entries
 * and returned in `provider/model` format (e.g. `ollama/gpt-oss:latest`).
 *
 * If a top-level `model` field is set, it's included as well.
 */
export function extractModelsFromConfig(config: OpenCodeConfig): string[] {
	const models: string[] = [];

	// Top-level model override
	if (typeof config.model === 'string' && config.model.trim()) {
		models.push(config.model.trim());
	}

	// Provider-defined models
	if (config.provider && typeof config.provider === 'object') {
		for (const [providerId, providerDef] of Object.entries(config.provider)) {
			if (!providerDef?.models || typeof providerDef.models !== 'object') continue;
			for (const modelId of Object.keys(providerDef.models)) {
				const fullId = `${providerId}/${modelId}`;
				if (!models.includes(fullId)) {
					models.push(fullId);
				}
			}
		}
	}

	return models;
}

// ────────────────────────────────────────────────────
// Local filesystem helpers
// ────────────────────────────────────────────────────

/**
 * Read and extract models from all local opencode.json config files.
 *
 * Probes each path from {@link getOpenCodeConfigPaths} in order, collecting
 * unique model IDs across all configs. Duplicate model IDs are skipped.
 *
 * @param cwd  Current working directory (for project-local config)
 */
export async function discoverModelsFromLocalConfigs(cwd?: string): Promise<string[]> {
	const configPaths = getOpenCodeConfigPaths(cwd);
	const seen = new Set<string>();
	const models: string[] = [];

	for (const configPath of configPaths) {
		let content: string;
		try {
			content = await fs.promises.readFile(configPath, 'utf-8');
		} catch (error: any) {
			if (error?.code === 'ENOENT') {
				logger.debug(`OpenCode config not found: ${configPath}`, LOG_CONTEXT);
				continue;
			}
			throw error;
		}

		const config = parseOpenCodeConfig(content);
		if (!config) {
			logger.warn(`OpenCode config has invalid JSON, skipping: ${configPath}`, LOG_CONTEXT);
			continue;
		}

		const extracted = extractModelsFromConfig(config);
		for (const modelId of extracted) {
			if (!seen.has(modelId)) {
				seen.add(modelId);
				models.push(modelId);
			}
		}

		if (extracted.length > 0) {
			logger.debug(`Extracted ${extracted.length} models from ${configPath}`, LOG_CONTEXT, {
				models: extracted,
			});
		}
	}

	return models;
}
