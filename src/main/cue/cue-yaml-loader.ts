/**
 * YAML loader façade for Maestro Cue configuration files.
 *
 * Public entrypoints stay here for compatibility while parsing/validation/watching
 * are implemented in responsibility-focused config modules.
 */

import * as path from 'path';
import * as yaml from 'js-yaml';
import type { CueConfig } from './cue-types';
import {
	readCueConfigFile,
	resolveCueConfigPath,
	watchCueConfigFile,
} from './config/cue-config-repository';
import { materializeCueConfig, parseCueConfigDocument } from './config/cue-config-normalizer';
import {
	partitionValidSubscriptions,
	validateCueConfigDocument,
} from './config/cue-config-validator';

export { resolveCueConfigPath } from './config/cue-config-repository';

/**
 * Structured result of {@link loadCueConfigDetailed}. Distinguishes the four
 * outcomes (missing file / unparseable YAML / schema-invalid / valid) and
 * carries non-fatal warnings (e.g. unresolved prompt_file references) so the
 * caller can surface them to the user.
 */
export type LoadCueConfigDetailedResult =
	| { ok: true; config: CueConfig; warnings: string[] }
	| { ok: false; reason: 'missing' }
	| { ok: false; reason: 'parse-error'; message: string }
	| { ok: false; reason: 'invalid'; errors: string[] };

/**
 * Loads, validates, and materializes the Cue config for a project root.
 *
 * Returns a structured result so callers can distinguish "no config", a YAML
 * parse error, a schema-invalid config, and a valid config (with optional
 * non-fatal warnings such as unresolved prompt_file references).
 *
 * Prefer this over the legacy {@link loadCueConfig} when you need to surface
 * load failures to the user.
 */
export function loadCueConfigDetailed(projectRoot: string): LoadCueConfigDetailedResult {
	const file = readCueConfigFile(projectRoot);
	if (!file) {
		return { ok: false, reason: 'missing' };
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(file.raw);
	} catch (err) {
		return {
			ok: false,
			reason: 'parse-error',
			message: err instanceof Error ? err.message : String(err),
		};
	}

	if (!parsed || typeof parsed !== 'object') {
		return {
			ok: false,
			reason: 'parse-error',
			message: 'Cue config root must be a YAML mapping',
		};
	}

	// Lenient partition: config-level errors (missing subscriptions array, bad
	// settings) are still fatal, but per-subscription errors only drop that one
	// subscription. A single malformed subscription must not block valid
	// pipelines belonging to other agents that share the same project root.
	const partitioned = partitionValidSubscriptions(parsed);
	if (partitioned.configErrors.length > 0) {
		return { ok: false, reason: 'invalid', errors: partitioned.configErrors };
	}

	const document = parseCueConfigDocument(file.raw, projectRoot);
	if (!document) {
		// Should be unreachable since the config-level shape passed, but guard defensively.
		return {
			ok: false,
			reason: 'parse-error',
			message: 'Cue config could not be normalized',
		};
	}

	// Map raw-YAML subscription indices (used by the validator) to their
	// position in document.subscriptions, which is the normalized array.
	// parseCueConfigDocument silently skips raw entries that aren't objects
	// (e.g. `- "string-not-an-object"`), so the two arrays' indices drift —
	// filtering the normalized array using raw-index errors would drop the
	// wrong subscriptions. Build a translation table from the raw array.
	const rawSubs = (parsed as Record<string, unknown>).subscriptions as unknown[];
	const rawToNormalized = new Map<number, number>();
	let normIdx = 0;
	for (let i = 0; i < rawSubs.length; i++) {
		const entry = rawSubs[i];
		if (entry && typeof entry === 'object') {
			rawToNormalized.set(i, normIdx);
			normIdx++;
		}
	}

	const skippedNormalizedIndices = new Set<number>();
	for (const entry of partitioned.subscriptionErrors) {
		const norm = rawToNormalized.get(entry.index);
		if (norm !== undefined) skippedNormalizedIndices.add(norm);
	}

	const filteredDocument =
		skippedNormalizedIndices.size === 0
			? document
			: {
					...document,
					subscriptions: document.subscriptions.filter(
						(_, idx) => !skippedNormalizedIndices.has(idx)
					),
				};

	const materialized = materializeCueConfig(filteredDocument);

	// Surface skipped subscriptions as warnings so the user sees what was
	// excluded and can fix the YAML, but the rest of the config still loads.
	const warnings = [...materialized.warnings];
	for (const entry of partitioned.subscriptionErrors) {
		const detail = entry.errors.join('; ');
		warnings.push(`Skipped invalid subscription at index ${entry.index} — ${detail}`);
	}

	return { ok: true, config: materialized.config, warnings };
}

/**
 * Loads and parses a cue config file from the given project root.
 * Checks .maestro/cue.yaml first, then falls back to maestro-cue.yaml.
 * Returns null if neither file exists, or on parse / validation failure.
 *
 * Legacy entry point: prefer {@link loadCueConfigDetailed} when you need
 * to know *why* a config failed to load (parse error vs invalid vs missing)
 * or when you need to surface materialization warnings.
 */
export function loadCueConfig(projectRoot: string): CueConfig | null {
	const file = readCueConfigFile(projectRoot);
	if (!file) {
		return null;
	}

	const document = parseCueConfigDocument(file.raw, projectRoot);
	if (!document) {
		return null;
	}

	return materializeCueConfig(document).config;
}

/**
 * Watches a maestro-cue.yaml file for changes. Returns a cleanup function.
 * Calls onChange when the file is created, modified, or deleted.
 * Debounces by 1 second.
 */
export function watchCueYaml(projectRoot: string, onChange: () => void): () => void {
	return watchCueConfigFile(projectRoot, onChange);
}

/**
 * Validates a CueConfig-shaped object. Returns validation result with error messages.
 */
export function validateCueConfig(config: unknown): { valid: boolean; errors: string[] } {
	return validateCueConfigDocument(config);
}

/** Maximum number of parent directories to walk when searching for an ancestor config. */
const ANCESTOR_SEARCH_DEPTH = 5;

/**
 * Walk parent directories from `projectRoot` looking for a cue.yaml.
 * Returns the ancestor's project root if found, `null` otherwise.
 *
 * Stops at filesystem root or after {@link ANCESTOR_SEARCH_DEPTH} levels.
 * Does NOT return `projectRoot` itself — only strict ancestors.
 */
export function findAncestorCueConfigRoot(projectRoot: string): string | null {
	const roots = findAncestorCueConfigRoots(projectRoot);
	return roots.length > 0 ? roots[0] : null;
}

/**
 * Walk parent directories from `projectRoot` and return EVERY ancestor that
 * has a cue.yaml, in closest-first order. Used by callers that need to keep
 * walking when the closest ancestor's cue.yaml has nothing relevant to them
 * (e.g. a sub-agent's session whose subs live at a HIGHER ancestor while a
 * closer ancestor hosts an unrelated pipeline).
 *
 * Stops at filesystem root or after {@link ANCESTOR_SEARCH_DEPTH} levels.
 * Does NOT include `projectRoot` itself — only strict ancestors.
 */
export function findAncestorCueConfigRoots(projectRoot: string): string[] {
	const roots: string[] = [];
	let current = path.resolve(projectRoot);

	for (let depth = 0; depth < ANCESTOR_SEARCH_DEPTH; depth++) {
		const parent = path.dirname(current);
		if (parent === current) break; // reached filesystem root
		current = parent;

		if (resolveCueConfigPath(current) !== null) {
			roots.push(current);
		}
	}

	return roots;
}
