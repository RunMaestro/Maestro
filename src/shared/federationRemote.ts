/**
 * Whether an SSH remote takes part in Federation. Renderer-safe: no Node imports, so the SSH
 * remote editor, the Left Bar, the CLI, and main all read one rule.
 *
 * Federation is opportunistic. A remote takes part unless it opted out with `federation: false`:
 * Maestro looks for a `maestro-cli host` on it, one remote at a time, and mirrors the host's
 * agents when one runs. Only the opt-out is ever stored.
 */

import type { SshRemoteConfig } from './types';

/** Whether Federation may look for a host on `remote`. */
export function isFederationRemote(remote: Pick<SshRemoteConfig, 'federation'>): boolean {
	return remote.federation !== false;
}

/** The stored value for a Federation switch: absent when on, `false` when opted out. */
export function federationFieldFor(on: boolean): false | undefined {
	return on ? undefined : false;
}
