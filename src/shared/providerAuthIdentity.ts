/**
 * Provider authentication identity.
 *
 * Credentials are NOT per-agent. One `claude login` writes one credential store
 * on one machine, and every agent backed by that provider reads it. So when a
 * token expires, it does not fail one agent - it fails all of them, and any Cue
 * pipeline they own, at the same instant.
 *
 * This module names that shared scope. It is the key everything auth-related is
 * grouped by: one prompt per provider rather than one per agent, and one list
 * of blocked agents to resume once the login succeeds.
 *
 * The scope is (agent binary, host). The host matters because an SSH remote has
 * its own credential store: the same agent can be authenticated locally and
 * expired on a remote, and re-authenticating one does nothing for the other.
 *
 * The second question this module answers is whether a login flow is the right
 * remedy at all. Not every credential is an OAuth login: an API key, a gateway
 * base URL, and a Bedrock/Vertex agent all fail with the same `auth_expired`
 * output, and none of them is repaired by running the provider's login command.
 * See {@link classifyCredentialKind}.
 */

/**
 * Identity of a credential store shared by a set of agents.
 *
 * Treat as opaque: build it with {@link providerAuthKey} and compare for
 * equality. The format is an implementation detail and is not persisted.
 */
export type ProviderAuthKey = string;

/**
 * Build the key for the credential store an agent authenticates against.
 *
 * @param toolType - The agent id (e.g. `claude-code`).
 * @param sshRemoteId - The SSH remote the agent runs on, when it runs remotely.
 *   Omit (or pass null) for a local agent.
 */
export function providerAuthKey(toolType: string, sshRemoteId?: string | null): ProviderAuthKey {
	return sshRemoteId ? `${toolType}@${sshRemoteId}` : toolType;
}

// ============================================================================
// Credential kind
// ============================================================================

/**
 * What kind of credential an agent presents, which decides what "fix it" means.
 *
 * A login flow repairs exactly one of these. The others fail with the same
 * `auth_expired` output and would happily accept a login the agent then ignores,
 * which is worse than offering nothing: the flow succeeds, the user believes the
 * problem is solved, and the next prompt burns on the same rejection.
 *
 * - `oauth` - a browser or device login against a config directory. The ONLY
 *   kind a login flow can repair.
 * - `api-key` - a secret in the environment. The remedy is editing the key.
 * - `gateway` - a base-URL override points the agent at a third-party operator.
 *   Whatever failed belongs to that operator, not to the provider.
 * - `cloud-provider` - Bedrock or Vertex. Credentials come from the cloud SDK
 *   chain, not from the agent CLI.
 */
export type CredentialKind = 'oauth' | 'api-key' | 'gateway' | 'cloud-provider';

/** What an agent's environment says about the credential it will present. */
export interface CredentialClassification {
	kind: CredentialKind;
	/** The env var that decided it, when one did. Named in the UI. */
	envVarName?: string;
	/** Short human name for that decision: a gateway host, a cloud provider. */
	label?: string;
}

/**
 * Anthropic secret-bearing keys, most specific first so a gateway token wins
 * over a plain API key. Mirrors `ANTHROPIC_CREDENTIAL_ENV_KEYS` in
 * `shared/providerFailover.ts`, which is that module's name for the same two.
 */
const ANTHROPIC_SECRET_ENV_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

/** Flags that route claude-code at a cloud provider instead of Anthropic's API. */
const CLOUD_PROVIDER_FLAGS = [
	{ envVarName: 'CLAUDE_CODE_USE_BEDROCK', label: 'AWS Bedrock' },
	{ envVarName: 'CLAUDE_CODE_USE_VERTEX', label: 'Google Vertex AI' },
] as const;

/** Copilot token vars in the CLI's own precedence order (`copilot login --help`). */
const COPILOT_TOKEN_ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

/**
 * OpenCode recognizes roughly a hundred provider key vars (`ANTHROPIC_API_KEY`,
 * `GROQ_API_KEY`, `MOONSHOT_API_KEY`, ...) and keeps them all in one auth.json,
 * so a key set for ANY provider changes what the agent presents. Matching the
 * shape they share beats freezing a list that goes stale on every release.
 *
 * The trade-off is a false positive: a stray `OPENAI_API_KEY` in the environment
 * of an agent that is really signed in via OAuth reads as `api-key`. That costs
 * a login button, which is the safer direction to be wrong in.
 */
const OPENCODE_API_KEY_PATTERN = /^[A-Z][A-Z0-9_]*_API_KEY$/;

/**
 * Read an env var, treating whitespace-only as unset.
 *
 * Blank has to mean unset here: an explicitly emptied row is how a user turns an
 * inherited variable off, and `resolveFailoverEnv()` already skips blank values
 * for the same reason. A half-filled editor row must not invent a credential.
 */
function envValue(env: Record<string, string>, key: string): string {
	return (env[key] ?? '').trim();
}

/** First key with a non-blank value, or `undefined`. */
function firstSetKey(env: Record<string, string>, keys: readonly string[]): string | undefined {
	return keys.find((key) => envValue(env, key) !== '');
}

/**
 * Whether a boolean-ish env flag is on. Unset, empty, `0`, `false`, `no`, and
 * `off` are off; anything else (including `1` and `true`) is on.
 */
function isFlagEnabled(value: string): boolean {
	const normalized = value.toLowerCase();
	if (normalized === '') return false;
	return !['0', 'false', 'no', 'off'].includes(normalized);
}

/** The host part of a base URL, falling back to the raw value when unparseable. */
function baseUrlHost(raw: string): string {
	try {
		return new URL(raw).host || raw;
	} catch {
		return raw;
	}
}

/**
 * Classify the credential an agent will present, from its effective environment.
 *
 * Build `env` the same way the spawner does (`resolveAgentEnvironment`, global
 * then provider then agent), because a classification from a different merge
 * describes a process nobody is running.
 *
 * Defaults to `oauth`: every supported provider's out-of-the-box setup is a
 * login, and an env with no credential vars in it is that setup.
 *
 * @param toolType - The agent id, e.g. `claude-code`.
 * @param env - The agent's effective environment.
 */
export function classifyCredentialKind(
	toolType: string,
	env: Record<string, string>
): CredentialClassification {
	if (toolType === 'claude-code') {
		// Cloud provider first: Bedrock and Vertex ignore both the config dir and
		// the Anthropic vars, so anything below would describe a credential the
		// CLI is not going to use.
		for (const flag of CLOUD_PROVIDER_FLAGS) {
			if (isFlagEnabled(envValue(env, flag.envVarName))) {
				return { kind: 'cloud-provider', envVarName: flag.envVarName, label: flag.label };
			}
		}
		// A gateway outranks the token check even when a token is present: the
		// token belongs to the gateway operator, and no provider login can fix it.
		// Same reasoning as `failoverUnsetEnvKeys()` in shared/providerFailover.ts.
		const baseUrl = envValue(env, 'ANTHROPIC_BASE_URL');
		if (baseUrl !== '') {
			return { kind: 'gateway', envVarName: 'ANTHROPIC_BASE_URL', label: baseUrlHost(baseUrl) };
		}
		const secretKey = firstSetKey(env, ANTHROPIC_SECRET_ENV_KEYS);
		if (secretKey) return { kind: 'api-key', envVarName: secretKey };
		return { kind: 'oauth', envVarName: 'CLAUDE_CONFIG_DIR' };
	}

	if (toolType === 'codex') {
		if (envValue(env, 'OPENAI_API_KEY') !== '') {
			return { kind: 'api-key', envVarName: 'OPENAI_API_KEY' };
		}
		return { kind: 'oauth', envVarName: 'CODEX_HOME' };
	}

	if (toolType === 'copilot-cli') {
		const tokenKey = firstSetKey(env, COPILOT_TOKEN_ENV_KEYS);
		if (tokenKey) return { kind: 'api-key', envVarName: tokenKey };
		return { kind: 'oauth' };
	}

	if (toolType === 'opencode') {
		const secretKey = Object.keys(env)
			.filter((key) => OPENCODE_API_KEY_PATTERN.test(key) || key === 'ANTHROPIC_AUTH_TOKEN')
			.filter((key) => envValue(env, key) !== '')
			.sort()[0];
		if (secretKey) return { kind: 'api-key', envVarName: secretKey };
		return { kind: 'oauth', envVarName: 'OPENCODE_CONFIG_DIR' };
	}

	return { kind: 'oauth' };
}

/**
 * Why a login flow cannot repair this credential, or null when it can.
 *
 * One sentence, phrased as what the user should do instead. Returning null for
 * `oauth` is what the login surfaces gate on.
 */
export function credentialKindBlocksLogin(
	classification: CredentialClassification,
	agentName: string
): string | null {
	const named = classification.envVarName ?? 'its environment';
	switch (classification.kind) {
		case 'oauth':
			return null;
		case 'api-key':
			return `${agentName} authenticates with the key in ${named}, so signing in would not change what it presents. Replace that key, then resume.`;
		case 'gateway':
			return `${agentName} is pointed at ${classification.label ?? 'a gateway'} by ${named}. The credential belongs to that operator, so a provider login cannot repair it.`;
		case 'cloud-provider':
			return `${agentName} runs against ${classification.label ?? 'a cloud provider'} via ${named}, which takes its credentials from the cloud SDK chain rather than from the agent CLI. Refresh those credentials, then resume.`;
	}
}
