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

/**
 * The remote list with Federation switched off for `remoteId`, or null when it already is (or the
 * remote is gone). Stop Host and Remove Host write it: automatic Federation skips a remote whose
 * switch is off, so a host the person stopped is not started, or its service registered, again.
 */
export function withFederationOff<T extends Pick<SshRemoteConfig, 'id' | 'federation'>>(
	remotes: T[],
	remoteId: string
): T[] | null {
	const index = remotes.findIndex((remote) => remote.id === remoteId);
	if (index === -1 || !isFederationRemote(remotes[index])) return null;
	const next = [...remotes];
	next[index] = { ...remotes[index], federation: federationFieldFor(false) };
	return next;
}

/** What a person reads once Stop Host or Remove Host switched Federation off for the remote. */
export function federationTurnedOffNote(remoteName: string): string {
	return `Federation is now off for ${remoteName}, so Maestro does not start the host there again. Switch it back on in the remote's SSH Hosts settings, or with maestro-cli update-ssh-remote <id> --federation on.`;
}
