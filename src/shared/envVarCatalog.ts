/**
 * Environment-variable name suggestions.
 *
 * Setting an env var on an agent is a two-step guess today: the user has to
 * remember the provider's exact spelling (`CLAUDE_CONFIG_DIR`, not
 * `CLAUDE_HOME`) and type it without a typo, and a typo is silent - the
 * variable is set, the provider ignores it, and the agent behaves as if nothing
 * was configured. This module is the list the name field offers instead.
 *
 * Two sources feed that list, in this order:
 *
 *  1. **The provider's own catalog below.** Short on purpose: the vars people
 *     actually reach for (account dir, credentials, gateway, model), not every
 *     var the CLI reads. A list nobody can scan is a list nobody uses.
 *  2. **Names the user has already set**, anywhere in Maestro. Setting
 *     `HTTPS_PROXY` on one agent is the strongest possible signal that it
 *     belongs in the list for the next one, and it costs nothing to remember:
 *     the keys are already on disk in the agent configs, the sessions, and the
 *     global environment settings.
 *
 * The catalog is advisory. Anything can still be typed by hand, and a name
 * missing from here is not an error - it is a suggestion this module has not
 * been taught yet.
 */

import { isBlankEnvValue } from './agentEnvironment';

/** One suggested variable name. */
export interface EnvVarSuggestion {
	key: string;
	/** One line on what the variable does, shown dimmed beside the name. */
	description: string;
	/** Which source offered it, so the UI can label a remembered name. */
	origin: 'provider' | 'common' | 'remembered';
}

/** A catalog entry, before an origin is attached. */
type CatalogEntry = Omit<EnvVarSuggestion, 'origin'>;

/**
 * Variables worth offering whatever the provider is.
 *
 * Kept to the ones that are about the network between Maestro and the provider
 * rather than about the provider itself, which is what makes them universal.
 */
export const COMMON_ENV_VAR_SUGGESTIONS: readonly CatalogEntry[] = [
	{ key: 'HTTPS_PROXY', description: 'Proxy for outbound HTTPS requests.' },
	{ key: 'HTTP_PROXY', description: 'Proxy for outbound HTTP requests.' },
	{ key: 'NO_PROXY', description: 'Hosts that bypass the proxy, comma separated.' },
	{
		key: 'NODE_EXTRA_CA_CERTS',
		description: 'Extra CA bundle, for a corporate TLS-inspecting proxy.',
	},
];

/**
 * Per-provider suggestions, most reached-for first, keyed by agent id.
 *
 * A provider absent from this map falls back to {@link COMMON_ENV_VAR_SUGGESTIONS}
 * plus whatever the user has set before. Adding a provider here is a one-entry
 * change and needs nothing else.
 *
 * `factory-droid` carries no config-dir var on purpose: it ships none. See the
 * verified env surface noted in `providerProfiles.ts`.
 */
export const PROVIDER_ENV_VAR_SUGGESTIONS: Readonly<Record<string, readonly CatalogEntry[]>> = {
	'claude-code': [
		{
			key: 'CLAUDE_CONFIG_DIR',
			description: 'Account home. Point two agents at two dirs to run two accounts.',
		},
		{ key: 'ANTHROPIC_API_KEY', description: 'API key, used instead of the OAuth login.' },
		{ key: 'ANTHROPIC_AUTH_TOKEN', description: 'Bearer token for a gateway in front of the API.' },
		{ key: 'ANTHROPIC_BASE_URL', description: 'Send requests to a gateway instead of the API.' },
		{ key: 'ANTHROPIC_MODEL', description: 'Default model for this agent.' },
		{ key: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', description: 'Cap the tokens one reply may produce.' },
		{ key: 'MAX_THINKING_TOKENS', description: 'Thinking budget per turn.' },
		{ key: 'CLAUDE_CODE_USE_BEDROCK', description: 'Run against AWS Bedrock credentials.' },
		{ key: 'CLAUDE_CODE_USE_VERTEX', description: 'Run against Google Vertex AI credentials.' },
	],
	codex: [
		{
			key: 'CODEX_HOME',
			description: 'Account home. Point two agents at two dirs to run two accounts.',
		},
		{ key: 'OPENAI_API_KEY', description: 'API key, used instead of the ChatGPT login.' },
		{ key: 'OPENAI_BASE_URL', description: 'Send requests to a gateway instead of the API.' },
	],
	opencode: [
		{ key: 'OPENCODE_CONFIG', description: 'Path to the config file this agent should load.' },
		{ key: 'OPENCODE_CONFIG_CONTENT', description: 'Inline JSON config, merged over the file.' },
		{ key: 'ANTHROPIC_API_KEY', description: 'Anthropic key for OpenCode to use.' },
		{ key: 'OPENAI_API_KEY', description: 'OpenAI key for OpenCode to use.' },
		{
			key: 'XDG_DATA_HOME',
			description: 'Data root holding credentials and transcripts (OS-wide, not per provider).',
		},
	],
	'factory-droid': [
		{ key: 'FACTORY_API_KEY', description: 'API key, used instead of the browser login.' },
		{ key: 'FACTORY_PROJECT_DIR', description: 'Project root the droid treats as its workspace.' },
		{ key: 'FACTORY_DISABLE_KEYRING', description: 'Keep credentials out of the OS keyring.' },
		{ key: 'FACTORY_LOG_FILE', description: 'Write the droid log to this path.' },
	],
	'copilot-cli': [
		{
			key: 'COPILOT_HOME',
			description: 'Account home. Point two agents at two dirs to run two accounts.',
		},
		{ key: 'COPILOT_GITHUB_TOKEN', description: 'Token Copilot prefers over GH_TOKEN.' },
		{ key: 'GH_TOKEN', description: 'GitHub token, also read by the gh CLI.' },
		{ key: 'GITHUB_TOKEN', description: 'GitHub token, lowest of the three in precedence.' },
	],
};

/** Names the user has already set, as gathered by `agents:getKnownEnvVarKeys`. */
export interface KnownEnvVarKeys {
	/** Keys set on agents of each provider, keyed by agent id. */
	byProvider: Record<string, string[]>;
	/** Keys set in Settings -> Environment, which apply to every provider. */
	global: string[];
}

export const EMPTY_KNOWN_ENV_VAR_KEYS: KnownEnvVarKeys = { byProvider: {}, global: [] };

/** Shown for a name we only know because the user typed it somewhere before. */
const REMEMBERED_DESCRIPTION = 'Already set elsewhere in Maestro.';

export interface SuggestEnvVarKeysOptions {
	/** Agent id being edited. Omit for the global environment, which has no provider. */
	toolType?: string;
	/** What the user has set before. Omit to offer the catalog alone. */
	known?: KnownEnvVarKeys;
	/** Names already used in the editor, so a row is never offered twice. */
	exclude?: Iterable<string>;
	/** What the user has typed into the name field so far. */
	query?: string;
	/** Most suggestions to return. The dropdown scrolls, but a long list is noise. */
	limit?: number;
}

/**
 * Build the suggestion list for one name field.
 *
 * Order is catalog, then remembered, then the common set, and a match on what
 * the user has typed so far beats one in the middle of a name. Both rules exist
 * so the first row is the one most likely to be wanted: keystrokes land on the
 * provider's own vars, and the list never reorders itself under the cursor.
 */
export function suggestEnvVarKeys({
	toolType,
	known = EMPTY_KNOWN_ENV_VAR_KEYS,
	exclude,
	query = '',
	limit = 12,
}: SuggestEnvVarKeysOptions): EnvVarSuggestion[] {
	const seen = new Set<string>();
	const ordered: EnvVarSuggestion[] = [];
	const push = (entry: CatalogEntry, origin: EnvVarSuggestion['origin']) => {
		if (!entry.key || seen.has(entry.key)) return;
		seen.add(entry.key);
		ordered.push({ ...entry, origin });
	};

	// The global editor has no provider, so it offers every provider's catalog
	// rather than none: a user who sets CLAUDE_CONFIG_DIR for everything Maestro
	// spawns is doing something ordinary, and should not have to type it blind.
	const catalogKeys = toolType ? [toolType] : Object.keys(PROVIDER_ENV_VAR_SUGGESTIONS).sort();
	for (const key of catalogKeys) {
		for (const entry of PROVIDER_ENV_VAR_SUGGESTIONS[key] ?? []) push(entry, 'provider');
	}

	// Remembered names, this provider's first. Other providers' names are left
	// out when a provider is named: a CODEX_HOME row on a Claude agent is noise,
	// and the global list below already carries anything set for everything.
	const remembered = [
		...(toolType ? (known.byProvider[toolType] ?? []) : Object.values(known.byProvider).flat()),
		...known.global,
	];
	for (const key of remembered) push({ key, description: REMEMBERED_DESCRIPTION }, 'remembered');

	for (const entry of COMMON_ENV_VAR_SUGGESTIONS) push(entry, 'common');

	const excluded = new Set(exclude ?? []);
	const needle = query.trim().toUpperCase();
	const matches = ordered.filter(
		(entry) => !excluded.has(entry.key) && (!needle || entry.key.toUpperCase().includes(needle))
	);
	if (!needle) return matches.slice(0, limit);

	// Stable partition rather than a sort: within each half the catalog order
	// above still holds, so the list only ever narrows as the user types.
	const prefixed = matches.filter((entry) => entry.key.toUpperCase().startsWith(needle));
	const rest = matches.filter((entry) => !entry.key.toUpperCase().startsWith(needle));
	return [...prefixed, ...rest].slice(0, limit);
}

/**
 * Names worth remembering out of one env-var record.
 *
 * A name with no value is a half-finished editor row (`VAR`, added by the "Add
 * Variable" button and never filled in), not a choice the user made, and
 * offering it back later would spread the placeholder rather than the setting.
 */
export function rememberableEnvVarKeys(
	record: Record<string, unknown> | undefined | null
): string[] {
	if (!record || typeof record !== 'object') return [];
	return Object.entries(record)
		.filter(([key, value]) => key && typeof value === 'string' && !isBlankEnvValue(value))
		.map(([key]) => key);
}
