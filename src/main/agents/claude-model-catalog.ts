/**
 * Claude Code's model list: the aliases it always accepts, and the model
 * catalog its CLI caches to render its own `/model` picker.
 *
 * Pure parsing, no filesystem: local discovery (`AgentDetector`) reads the
 * catalog files from this machine's config dir, SSH remote discovery
 * (`model-discovery.ts`) reads them off the remote in one round trip, and both
 * hand the file texts here so the two hosts apply the same rules.
 */

import { logger } from '../utils/logger';
import { parseJsonWithBom } from '../../shared/jsonUtils';

const LOG_CONTEXT = '[AgentDetector]';

/**
 * Tier aliases Claude Code always accepts, each resolving to the current model
 * in that tier. `[1m]` variants select the 1M extended context window and need
 * extra usage enabled at claude.ai/settings/usage; the CLI offers them for opus
 * and sonnet only.
 *
 * Not every model has an alias - limited-access models are reachable only by
 * their full ID - so this list is a floor, never the whole picture. The
 * catalog (and, locally, the user's own usage history) fills in the rest.
 */
export const CLAUDE_MODEL_ALIASES = ['fable', 'sonnet', 'opus', 'haiku', 'opus[1m]', 'sonnet[1m]'];

/**
 * Model catalog the Claude Code CLI caches to render its own `/model` picker,
 * relative to the Claude config directory.
 */
export const CLAUDE_CATALOG_SUBDIR = ['cache', 'model-catalog'];

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

/** Tolerate a field that is a single object in one CLI build and an array in another. */
function asConfigList(
	value: ClaudeCatalogSelectorConfig | ClaudeCatalogSelectorConfig[] | undefined
): ClaudeCatalogSelectorConfig[] {
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
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

/** One file of the Claude model catalog directory: its base name and its text. */
export interface ClaudeCatalogFileText {
	name: string;
	text: string;
}

/**
 * Whether a file in the catalog directory is a catalog. Every `.json` is a
 * candidate except `published-floor.json`, which is reliably an index.
 */
export function isClaudeCatalogFileName(name: string): boolean {
	return name.endsWith('.json') && name !== 'published-floor.json';
}

/**
 * Model IDs the `cc` surface offers across a set of catalog files, in file
 * order, without duplicates. Shared by local discovery (files read from disk)
 * and SSH remote discovery (files read over one ssh round trip), so both hosts
 * apply the same naming and shape rules. A file that is not a catalog by name,
 * or does not parse, is skipped rather than costing the others.
 */
export function claudeCatalogModelIds(files: readonly ClaudeCatalogFileText[]): string[] {
	const ids: string[] = [];
	for (const { name, text } of files) {
		if (!isClaudeCatalogFileName(name)) continue;
		try {
			for (const id of readCatalogSurfaceModelIds(parseJsonWithBom<ClaudeCatalogFile>(text))) {
				if (!ids.includes(id)) {
					ids.push(id);
				}
			}
		} catch {
			// A half-written or superseded catalog file should not cost us the others.
			logger.debug(`Could not parse Claude model catalog ${name}`, LOG_CONTEXT);
		}
	}
	return ids;
}
