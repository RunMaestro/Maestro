/**
 * Effective environment for an agent process.
 *
 * An agent's environment is assembled from three layers that are each edited in
 * a different place, so "which profile am I actually running as?" is a question
 * no single settings pane can answer. This module does the same merge the
 * spawner does and reports WHERE each surviving value came from, which is the
 * part that makes the answer useful: seeing `ANTHROPIC_BASE_URL` is only half
 * the story if you cannot tell whether it came from this one agent or from
 * every agent on the machine.
 *
 * Precedence (later wins), mirroring `process:spawnTerminalTab`:
 *   1. global   - Settings -> Environment, applies to every process Maestro spawns
 *   2. agent    - Settings -> Agents, applies to every agent of one provider
 *   3. session  - this agent's own overrides, from Edit Agent
 */

/** Which layer a value was set in. */
export type EnvVarSource = 'global' | 'agent' | 'session';

export interface ResolvedEnvVar {
	key: string;
	value: string;
	/** The layer whose value won. */
	source: EnvVarSource;
	/** Layers that set this key but were overridden, lowest first. */
	shadowedBy: EnvVarSource[];
}

export interface AgentEnvironmentLayers {
	/** Settings -> Environment. */
	global?: Record<string, string>;
	/** Settings -> Agents, for this provider. */
	agent?: Record<string, string>;
	/** This agent's own overrides. */
	session?: Record<string, string>;
}

/**
 * Keys whose values are credentials rather than configuration.
 *
 * Matched loosely and on purpose: a false positive costs one click to reveal,
 * while a false negative puts a live key on screen during a screen share. The
 * modal that shows this is opened by a credential failure, which is exactly
 * when someone is most likely to be sharing their screen for help.
 */
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION)/i;

/**
 * Keys that match {@link SECRET_KEY_RE} but are not secrets. `*_AUTH_TOKEN` is
 * still a secret; these name a mode or a path, and masking them would hide the
 * very thing the user opened this view to check.
 */
const SECRET_KEY_EXCEPTIONS =
	/^(.*_AUTH_TYPE|.*_KEY_PATH|.*_KEYCHAIN|.*_TOKEN_PATH|.*_AUTH_MODE)$/i;

/** Whether a variable's value should be masked until explicitly revealed. */
export function isSecretEnvKey(key: string): boolean {
	if (SECRET_KEY_EXCEPTIONS.test(key)) return false;
	return SECRET_KEY_RE.test(key);
}

/**
 * Mask a secret value, keeping the last few characters.
 *
 * The tail is what distinguishes one key from another when you are checking
 * which credential is loaded, and it is not enough to use. Short values are
 * masked whole, since a 6-character secret would be mostly disclosed.
 */
export function maskEnvValue(value: string): string {
	if (value.length <= 8) return '•'.repeat(Math.max(value.length, 1));
	return `${'•'.repeat(8)}${value.slice(-4)}`;
}

/**
 * Merge the layers and report where each surviving value came from.
 *
 * Empty-string values are kept: `FOO=` is a real, meaningful setting (it
 * overrides a lower layer with an empty value), not an absent one.
 *
 * @returns One entry per key, sorted by key for a stable read.
 */
export function resolveAgentEnvironment(layers: AgentEnvironmentLayers): ResolvedEnvVar[] {
	const ordered: Array<[EnvVarSource, Record<string, string> | undefined]> = [
		['global', layers.global],
		['agent', layers.agent],
		['session', layers.session],
	];

	const resolved = new Map<string, ResolvedEnvVar>();

	for (const [source, vars] of ordered) {
		if (!vars) continue;
		for (const [key, value] of Object.entries(vars)) {
			const previous = resolved.get(key);
			resolved.set(key, {
				key,
				value,
				source,
				// The layer being overridden is recorded now, while we still know
				// it existed - the merged result alone cannot show it.
				shadowedBy: previous ? [...previous.shadowedBy, previous.source] : [],
			});
		}
	}

	return [...resolved.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Human label for a layer, for UI that explains where a value was set. */
export function envSourceLabel(source: EnvVarSource): string {
	switch (source) {
		case 'global':
			return 'Global';
		case 'agent':
			return 'Provider';
		case 'session':
			return 'This agent';
	}
}
