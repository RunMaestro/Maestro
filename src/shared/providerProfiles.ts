/**
 * Provider profiles.
 *
 * A "provider profile" is the account an agent actually runs as: the provider
 * binary plus, for providers whose credentials live in a config directory, the
 * directory that was selected for it (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
 *
 * The distinction matters because `toolType` alone is not the identity anyone
 * cares about once more than one account is in play. Three Claude agents can be
 * three different plans with three different quota buckets, and the only thing
 * that separates them is the config dir. This module is the single answer to
 * "which account is this agent on?", so the Usage Dashboard's provider filter,
 * the per-account agent-count badges on the quota panels, and anything added
 * later cannot disagree about the attribution.
 *
 * Pure and dependency-light on purpose: it is imported from the renderer today
 * and is safe to import from main.
 */

import { getAgentDisplayName } from './agentMetadata';

/** How a provider names the config directory that selects its account. */
export interface ProviderProfileConfig {
	/** Env var that selects the account home. */
	envVar: string;
	/** Directory under $HOME used when the env var is unset (`.claude`). */
	defaultSubdir: string;
}

/**
 * Providers whose agents can be split across accounts.
 *
 * A provider absent from this map has exactly one profile - itself. That is a
 * statement about what Maestro can currently attribute, not about what the CLI
 * supports: adding an entry here immediately splits that provider's agents in
 * every surface built on this module.
 */
export const PROVIDER_PROFILE_CONFIGS: Readonly<Record<string, ProviderProfileConfig>> = {
	'claude-code': { envVar: 'CLAUDE_CONFIG_DIR', defaultSubdir: '.claude' },
	codex: { envVar: 'CODEX_HOME', defaultSubdir: '.codex' },
};

export function getProviderProfileConfig(toolType: string): ProviderProfileConfig | undefined {
	return PROVIDER_PROFILE_CONFIGS[toolType];
}

export interface QuotaAccountKeyHelpers {
	/** Short slug used by badges, tabs, and `data-testid`s (`gmail`, `default`). */
	deriveShortName: (key: string | undefined) => string;
	/** Humanized variant of the short name (`default` -> `Default account`). */
	deriveDisplayName: (key: string | undefined) => string;
	/** Strip trailing slashes so two spellings of one path collapse to one key. */
	normalizeKey: (value: string) => string;
}

/**
 * Build the account-key string helpers for a provider whose accounts live in
 * `~/<prefix>` / `~/<prefix>-<name>` directories (`.claude`, `.codex`).
 *
 * Full `path.resolve()` semantics live on the main side; user-configured
 * account dirs are clean absolute paths in practice, so a string-level
 * normalize is enough here. If a renderer-derived key ever drifts from a
 * main-side snapshot key the quota tab simply shows the "Refresh to sample"
 * CTA instead of bars - graceful degradation rather than a crash.
 */
export function makeAccountKeyHelpers(prefix: string): QuotaAccountKeyHelpers {
	const dashPrefix = `${prefix}-`;

	function deriveShortName(key: string | undefined): string {
		if (!key) return 'default';
		const trimmed = key.replace(/\/+$/, '');
		const basename = trimmed.slice(trimmed.lastIndexOf('/') + 1);
		if (!basename || basename === prefix) return 'default';
		if (basename.startsWith(dashPrefix)) return basename.slice(dashPrefix.length);
		if (basename.startsWith(prefix)) return basename.slice(prefix.length) || 'default';
		return basename;
	}

	function deriveDisplayName(key: string | undefined): string {
		const shortName = deriveShortName(key);
		return shortName === 'default' ? 'Default account' : shortName;
	}

	function normalizeKey(value: string): string {
		return value.replace(/\/+$/, '');
	}

	return { deriveShortName, deriveDisplayName, normalizeKey };
}

/** Cached helpers per provider so callers don't rebuild the closures per row. */
const helpersByToolType = new Map<string, QuotaAccountKeyHelpers>();

/** Account-key helpers for a provider, or undefined when it has no accounts. */
export function getAccountKeyHelpers(toolType: string): QuotaAccountKeyHelpers | undefined {
	const config = getProviderProfileConfig(toolType);
	if (!config) return undefined;
	let helpers = helpersByToolType.get(toolType);
	if (!helpers) {
		helpers = makeAccountKeyHelpers(config.defaultSubdir);
		helpersByToolType.set(toolType, helpers);
	}
	return helpers;
}

/**
 * Resolve which account directory an agent runs against.
 *
 * `env` must already be the effective environment for the agent, lowest layer
 * first (agent-level `customEnvVars` merged under the session's own), matching
 * what the spawner assembles.
 *
 * Returns `null` when the provider has no account concept, or when the env var
 * is unset and `homeDir` has not resolved yet - in that second case there is no
 * key to attribute the agent to, and guessing one would file it under an
 * account that may not be the default.
 */
export function resolveAgentAccountKey(
	toolType: string,
	env: Record<string, string> | undefined,
	homeDir: string | undefined
): string | null {
	const config = getProviderProfileConfig(toolType);
	if (!config) return null;
	const helpers = getAccountKeyHelpers(toolType)!;
	const configured = env?.[config.envVar];
	if (typeof configured === 'string' && configured.length > 0) {
		return helpers.normalizeKey(configured);
	}
	return homeDir ? helpers.normalizeKey(`${homeDir}/${config.defaultSubdir}`) : null;
}

/** Dropdown value meaning "do not narrow by provider profile". */
export const ALL_PROFILES_VALUE = '__all_profiles__';

/** Separator between the provider id and the account key inside a profile key. */
const PROFILE_KEY_SEPARATOR = '::';

/**
 * Stable identity for a provider profile, safe to use as a dropdown value.
 *
 * Split on the FIRST separator only: provider ids never contain `::`, while an
 * account key is a filesystem path that is not ours to make promises about.
 */
export function providerProfileKey(toolType: string, accountKey: string | null): string {
	return accountKey ? `${toolType}${PROFILE_KEY_SEPARATOR}${accountKey}` : toolType;
}

export function parseProviderProfileKey(key: string): {
	toolType: string;
	accountKey: string | null;
} {
	const at = key.indexOf(PROFILE_KEY_SEPARATOR);
	if (at < 0) return { toolType: key, accountKey: null };
	return {
		toolType: key.slice(0, at),
		accountKey: key.slice(at + PROFILE_KEY_SEPARATOR.length),
	};
}

/**
 * Short label for a profile - the account's own name (`smash`, `Default
 * account`) for providers with accounts, and the provider name otherwise.
 * Used where the provider is already obvious from context, e.g. a card badge.
 */
export function providerProfileShortLabel(toolType: string, accountKey: string | null): string {
	const helpers = getAccountKeyHelpers(toolType);
	if (!helpers || !accountKey) return getAgentDisplayName(toolType);
	return helpers.deriveDisplayName(accountKey);
}

/**
 * Full label for a profile: `Claude Code - smash`, or just `OpenCode` for a
 * provider with no account split. Used in the filter dropdown, where the
 * provider name has to carry itself.
 */
export function providerProfileLabel(toolType: string, accountKey: string | null): string {
	const provider = getAgentDisplayName(toolType);
	const helpers = getAccountKeyHelpers(toolType);
	if (!helpers || !accountKey) return provider;
	return `${provider} - ${helpers.deriveDisplayName(accountKey)}`;
}
