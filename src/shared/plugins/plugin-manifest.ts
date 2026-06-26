/**
 * Maestro plugin manifest (plugin.json) contract and validator.
 *
 * This is the frozen public shape every plugin ships. It is validated with a
 * hand-rolled pure validator (the same convention as src/shared/pianola/storage.ts)
 * rather than a schema library, so it can be bundled into the renderer, the main
 * process, and the CLI without pulling in a runtime dependency.
 *
 * Phase 0 (foundations) only PARSES manifests and lists them; nothing in
 * `contributes` is wired into a registry yet. The contribution sub-shapes are
 * therefore captured loosely here (validated structurally, not semantically) and
 * tightened per contribution point as each lands in Phase 1+.
 */

import { isHostApiCompatible } from './host-api';

/**
 * Plugin trust/capability tier. Determines what the host will let a plugin do.
 * Only Tier 0 ships in the near term; the field is part of the frozen contract
 * so later tiers do not require a manifest-shape change.
 *
 * - 0: data-only. Declarative contributions (prompts, themes, settings, command
 *      macros). No code executes. Lowest risk.
 * - 1: sandboxed compute. Runs code in an isolated utilityProcess behind a
 *      permission broker.
 * - 2: UI contributions. Sandboxed panels/modals/commands.
 */
export type PluginTier = 0 | 1 | 2;

export const PLUGIN_TIERS: readonly PluginTier[] = [0, 1, 2];

/** The `maestro` compatibility block of a manifest. */
export interface PluginMaestroBlock {
	/** Minimum host API version this plugin requires (semver). */
	minHostApi: string;
}

/**
 * A parsed, validated plugin manifest. Unknown `contributes.*` keys are
 * preserved verbatim so a manifest authored against a newer host (more
 * contribution points) round-trips without loss on an older host.
 */
export interface PluginManifest {
	/** Unique, stable plugin id. Reverse-DNS or kebab-case (see ID regex). */
	id: string;
	/** Human-readable display name. */
	name: string;
	/** Plugin version (semver). Distinct from minHostApi. */
	version: string;
	/** Trust/capability tier. */
	tier: PluginTier;
	/** Host compatibility block. */
	maestro: PluginMaestroBlock;
	description?: string;
	author?: string;
	license?: string;
	homepage?: string;
	/** Declarative contributions. Structurally validated; semantics land later. */
	contributes?: Record<string, unknown>;
}

/** Outcome of validating one manifest. */
export interface ManifestValidationResult {
	manifest: PluginManifest | null;
	errors: string[];
}

/**
 * Allowed plugin id shape: reverse-DNS-ish or kebab-case, 3-100 chars, starting
 * with a letter. Kept strict so an id is always safe to use as an object key, a
 * log token, and (after a separate folder-name guard) a directory name.
 */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one parsed plugin.json object.
 *
 * Returns the typed manifest plus a list of human-readable errors. When any
 * fatal error is present `manifest` is null. This never throws on bad input -
 * callers (discovery, IPC) decide how to surface the errors.
 *
 * Host-API compatibility is intentionally NOT a fatal error here: a manifest can
 * be perfectly well-formed yet target a different host major. Discovery records
 * such a plugin with an `incompatible` status so the user sees it and learns
 * why, rather than the manifest silently vanishing. Callers that want to gate on
 * compatibility should additionally call isHostApiCompatible.
 */
export function validatePluginManifest(input: unknown): ManifestValidationResult {
	const errors: string[] = [];
	if (!isPlainObject(input)) {
		return { manifest: null, errors: ['manifest is not a JSON object'] };
	}

	const { id, name, version, tier, maestro, description, author, license, homepage, contributes } =
		input as Record<string, unknown>;

	if (!isNonEmptyString(id)) {
		errors.push('id is required and must be a non-empty string');
	} else if (!PLUGIN_ID_PATTERN.test(id)) {
		errors.push(
			`id "${id}" is invalid: use lowercase letters, digits, and . _ - separators, starting with a letter`
		);
	}

	if (!isNonEmptyString(name)) {
		errors.push('name is required and must be a non-empty string');
	}

	if (!isNonEmptyString(version)) {
		errors.push('version is required and must be a non-empty string');
	} else if (!SEMVER_PATTERN.test(version)) {
		errors.push(`version "${version}" is not a valid semver version`);
	}

	let normalizedTier: PluginTier = 0;
	if (tier === undefined) {
		errors.push('tier is required (0, 1, or 2)');
	} else if (tier !== 0 && tier !== 1 && tier !== 2) {
		errors.push(`tier ${String(tier)} is invalid: must be 0, 1, or 2`);
	} else {
		normalizedTier = tier;
	}

	let normalizedMaestro: PluginMaestroBlock = { minHostApi: '' };
	if (!isPlainObject(maestro)) {
		errors.push('maestro block is required (an object with minHostApi)');
	} else if (!isNonEmptyString(maestro.minHostApi)) {
		errors.push('maestro.minHostApi is required and must be a non-empty string');
	} else if (!SEMVER_PATTERN.test(maestro.minHostApi)) {
		errors.push(`maestro.minHostApi "${maestro.minHostApi}" is not a valid semver version`);
	} else {
		normalizedMaestro = { minHostApi: maestro.minHostApi };
	}

	if (description !== undefined && typeof description !== 'string') {
		errors.push('description, when present, must be a string');
	}
	if (author !== undefined && typeof author !== 'string') {
		errors.push('author, when present, must be a string');
	}
	if (license !== undefined && typeof license !== 'string') {
		errors.push('license, when present, must be a string');
	}
	if (homepage !== undefined && typeof homepage !== 'string') {
		errors.push('homepage, when present, must be a string');
	}
	if (contributes !== undefined && !isPlainObject(contributes)) {
		errors.push('contributes, when present, must be an object');
	}

	if (errors.length > 0) {
		return { manifest: null, errors };
	}

	const manifest: PluginManifest = {
		id: (id as string).trim(),
		name: (name as string).trim(),
		version: (version as string).trim(),
		tier: normalizedTier,
		maestro: normalizedMaestro,
		...(isNonEmptyString(description) ? { description: (description as string).trim() } : {}),
		...(isNonEmptyString(author) ? { author: (author as string).trim() } : {}),
		...(isNonEmptyString(license) ? { license: (license as string).trim() } : {}),
		...(isNonEmptyString(homepage) ? { homepage: (homepage as string).trim() } : {}),
		...(isPlainObject(contributes) ? { contributes } : {}),
	};
	return { manifest, errors: [] };
}

/** Convenience: is this manifest loadable on the given host API version? */
export function isManifestHostCompatible(manifest: PluginManifest, hostVersion?: string): boolean {
	return isHostApiCompatible(manifest.maestro.minHostApi, hostVersion).compatible;
}
