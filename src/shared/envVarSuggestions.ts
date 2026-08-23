/**
 * Env Var Suggestions
 *
 * What to offer in the environment-variable editors: which variable NAMES the
 * user is likely to want, and which VALUES make sense for each name.
 *
 * This replaces the narrower `KnownAuthDirs` (two hard-coded arrays,
 * `claudeConfigDirs` / `codexHomes`), which could only ever teach the value
 * field about two variables and taught the name field nothing at all - so
 * `CLAUDE_CONFIG_DIR` had to be typed out by hand every time.
 *
 * The value list is keyed BY VARIABLE NAME, and that is the whole point rather
 * than an implementation detail. A flat pool of every value Maestro has ever
 * seen would offer `63999` (a `MAX_THINKING_TOKENS` value) as a candidate
 * `CLAUDE_CONFIG_DIR`, which is worse than no suggestion: it invites a click
 * that produces a broken config. A value is only ever suggested for the name
 * it was observed under.
 *
 * Suggestions are a convenience, never a constraint. Every editor keeps free
 * text available, because the set of useful variables is open-ended and no
 * curated list will cover a user's private tooling.
 */

/** Variable names offered even when nothing on this host has set them yet. */
export interface EnvVarSuggestions {
	/** Variable names to offer, sorted. Union of well-known and observed. */
	keys: string[];
	/**
	 * Variable name -> values observed for THAT name on this host, sorted.
	 * A name with no observed values is absent rather than mapped to `[]`.
	 */
	valuesByKey: Record<string, string[]>;
}

export const EMPTY_ENV_VAR_SUGGESTIONS: EnvVarSuggestions = { keys: [], valuesByKey: {} };

/**
 * Variables Maestro itself understands, offered in the name dropdown before
 * anything has set them. Deliberately short: this is a shortcut past typing,
 * not a catalogue of every variable an agent might read. A name earns a place
 * here only if getting it wrong is easy and the consequence is confusing -
 * the account dirs above all, which silently change which login an agent runs
 * as.
 */
export const WELL_KNOWN_ENV_VAR_KEYS: readonly string[] = [
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_BASE_URL',
	'CLAUDE_CONFIG_DIR',
	'CODEX_HOME',
	'HTTPS_PROXY',
	'HTTP_PROXY',
	'MAESTRO_CLAUDE_BIN',
	'NO_PROXY',
	'OPENAI_API_KEY',
	'OPENAI_BASE_URL',
];

/**
 * Variables whose values name a directory. The main-process collector
 * canonicalizes these before deduping, so `~/.claude/` and `/Users/me/.claude`
 * collapse to one suggestion instead of appearing twice.
 */
export const PATH_VALUED_ENV_VAR_KEYS: readonly string[] = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];

/**
 * Variables whose values are secrets. Their values are never collected into
 * suggestions - a dropdown that lists API keys leaks them into a screenshot,
 * and the name suggestion alone is the useful part. Matched loosely on
 * purpose: a false positive costs one typed value, a false negative puts a
 * live key on screen.
 *
 * `TOKEN` is matched only in the singular. In this domain the plural names a
 * COUNT, not a credential (`MAX_THINKING_TOKENS`,
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS`), and those are exactly the values worth
 * offering. A credential variable named `..._TOKENS` would be missed, which is
 * the one deliberate hole here.
 */
export function isSecretValuedEnvKey(key: string): boolean {
	return /(KEY|TOKEN(?!S)|SECRET|PASSWORD|CREDENTIAL)/i.test(key);
}

/**
 * The values to offer for `key`, or an empty array when there is nothing
 * useful. Callers render a free-text field on empty rather than an empty
 * dropdown.
 */
export function suggestedValuesFor(suggestions: EnvVarSuggestions, key: string): string[] {
	return suggestions.valuesByKey[key] ?? [];
}
