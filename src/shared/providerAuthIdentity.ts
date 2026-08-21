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
