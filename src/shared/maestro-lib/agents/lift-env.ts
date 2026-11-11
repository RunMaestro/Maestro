/**
 * Which environment variables a Federation lift sends to the host.
 *
 * An SSH agent carries only its own custom vars to the remote (the provider-level set when it has
 * no record of its own), so that layer is exactly what its provider saw there, and exactly what
 * the host's copy of the agent must hold. Global Settings -> Environment never reached the remote,
 * so it is not sent.
 *
 * Secrets (`isSecretEnvKey()`) stay behind unless the person asks for them (`--with-env`): the host
 * stores them in its own agent record, which is a second copy of a credential.
 *
 * The provider's session-dir selector (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...) is always sent.
 * It decides where the provider looks for the session files the lifted tabs resume, so leaving it
 * behind would make the next turn silently start a new session. The host checks that the dir it
 * names exists before it accepts the agent ({@link liftSessionDirProblem}).
 *
 * Pure, except {@link liftSessionDirProblem}, which stats the host's filesystem.
 */

import { isBlankEnvKey, isBlankEnvValue, isSecretEnvKey } from '../../agentEnvironment';
import { expandTilde } from '../../pathUtils';
import { effectiveAgentCustomEnvVars, getProviderProfileConfig } from '../../providerProfiles';
import { unusableDirectoryReason } from '../launch/cwd';

/** The variable that selects a provider's config and session dir, and the dir it names. */
export interface SessionDirSelector {
	key: string;
	value: string;
}

export interface LiftEnvInput {
	/** Provider id of the agent being lifted. */
	provider: string;
	/** The agent's own env vars. `undefined` means it has no record and inherits `providerEnvVars`. */
	customEnvVars?: Record<string, string>;
	/** The provider-level set (Settings -> Agents), which the agent inherits when it has no record. */
	providerEnvVars?: Record<string, string>;
	/** Send secret vars too (`--with-env`). */
	withEnv: boolean;
}

export interface LiftEnvPlan {
	/** The env the host's agent is created with. Blank values are dropped: blank means unset. */
	send: Record<string, string>;
	/** Secret keys sent, because `withEnv` was set. Sorted. */
	secretsSent: string[];
	/** Secret keys left on this machine, because `withEnv` was not set. Sorted. */
	withheld: string[];
	/** The provider's session-dir selector, when the agent sets one. Always also in `send`. */
	sessionDir?: SessionDirSelector;
}

/**
 * The provider's session-dir selector in `env`, or undefined when the provider has none or the
 * env does not set it (blank counts as unset: the provider then uses its default dir).
 */
export function providerSessionDirSelector(
	provider: string,
	env: Record<string, string> | undefined
): SessionDirSelector | undefined {
	const key = getProviderProfileConfig(provider)?.envVar;
	if (!key) return undefined;
	const value = env?.[key];
	if (typeof value !== 'string' || isBlankEnvValue(value)) return undefined;
	return { key, value };
}

/** Split an SSH agent's env into what the lift sends and what stays behind. */
export function planLiftEnv(input: LiftEnvInput): LiftEnvPlan {
	const env = effectiveAgentCustomEnvVars(input.customEnvVars, input.providerEnvVars);
	const sessionDir = providerSessionDirSelector(input.provider, env);
	const send: Record<string, string> = {};
	const secretsSent: string[] = [];
	const withheld: string[] = [];

	for (const [key, value] of Object.entries(env)) {
		if (isBlankEnvKey(key) || isBlankEnvValue(value)) continue;
		// The selector decides which session files the resume reads, so it never stays behind,
		// whatever its name looks like.
		if (key === sessionDir?.key || !isSecretEnvKey(key)) {
			send[key] = value;
		} else if (input.withEnv) {
			send[key] = value;
			secretsSent.push(key);
		} else {
			withheld.push(key);
		}
	}

	secretsSent.sort();
	withheld.sort();
	return { send, secretsSent, withheld, ...(sessionDir ? { sessionDir } : {}) };
}

/**
 * Why the host cannot resume a lifted agent's sessions, or null. The session-dir selector the
 * agent brings must name a directory on the host: a missing one makes the provider create a fresh
 * config dir and start a new session, with no error anyone sees. No selector is fine: the host runs
 * as the SSH user, so the provider's default dir is the one the SSH agent used.
 *
 * `~` expands against `homeDir` (the host's home), the same way the account-dir resolver reads it.
 */
export function liftSessionDirProblem(
	provider: string,
	env: Record<string, string> | undefined,
	homeDir?: string
): string | null {
	const selector = providerSessionDirSelector(provider, env);
	if (!selector) return null;
	const reason = unusableDirectoryReason(
		expandTilde(selector.value.trim(), homeDir),
		`The provider session directory set by ${selector.key}`
	);
	if (!reason) return null;
	return `${reason}. The provider's session files are not there on this host, so the next turn would start a new session instead of resuming. Create it, or fix ${selector.key} on the agent, then lift again.`;
}
