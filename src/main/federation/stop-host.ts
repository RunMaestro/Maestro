/**
 * The desktop's Stop Host and Remove Host (Settings > SSH Hosts): stop the host Maestro started on
 * an SSH remote and disable its boot service, and for Remove Host also take away Maestro's own
 * install there.
 *
 * The work is `stopRemoteHost()`, the same function `maestro-cli remote-host stop` and
 * `remote-host uninstall` run, so the two cannot drift. It does not need the peer mirror: with
 * hosting off there is none, and that is when a person most wants the remote cleaned up. When the
 * mirror runs, the ssh calls go through its one SSH queue (`exclusive()`), so they never dial
 * beside a probe of the same remote.
 */

import {
	RemoteHostStopError,
	describeRemoteHostStop,
	stopRemoteHost,
	type RemoteHostAgent,
	type RemoteHostStopResult,
} from '../../shared/maestro-lib/client/remote-uninstall';
import { federationTurnedOffNote, withFederationOff } from '../../shared/federationRemote';
import type { SshRemoteConfig } from '../../shared/types';
import type { PeerMirrorService } from './peer-mirror-service';

export interface DesktopStopHostOptions {
	/** Remove Host: also remove the service file and Maestro's install under `~/.maestro`. */
	uninstall?: boolean;
	/** Stop even though the host holds agents (the confirmation named them). */
	force?: boolean;
}

export type DesktopStopHostAnswer =
	| {
			ok: true;
			outcome: RemoteHostStopResult['outcome'];
			/** What changed, or why nothing did, for a person. */
			message: string;
			/** `agents-held`: the agents the host holds, for the "stop anyway" confirmation. */
			agents?: RemoteHostAgent[] | 'unknown';
			/** The remote's Federation switch was turned off, so nothing starts the host again. */
			federationOff?: boolean;
	  }
	| {
			ok: false;
			code: string;
			error: string;
			/** The remote's Federation switch was turned off (the host stopped, its service did not). */
			federationOff?: boolean;
	  };

export interface DesktopStopHostDeps {
	readRemotes(): SshRemoteConfig[];
	service(): PeerMirrorService | null;
	/** Store the remote list (the Federation switch). */
	writeRemotes(remotes: SshRemoteConfig[]): void;
	stop?: typeof stopRemoteHost;
}

/**
 * Stop (or remove) the host on one SSH remote by id. A refusal is an `ok` answer naming why; an
 * expected failure (ssh, a host that would not stop) is `{ ok: false }`; anything else throws.
 */
export async function stopHostFromDesktop(
	remoteId: string,
	options: DesktopStopHostOptions,
	deps: DesktopStopHostDeps
): Promise<DesktopStopHostAnswer> {
	const remote = deps.readRemotes().find((candidate) => candidate.id === remoteId);
	if (!remote) return { ok: false, code: 'REMOTE_NOT_FOUND', error: 'SSH remote not found' };
	const uninstall = options.uninstall === true;
	const stop = deps.stop ?? stopRemoteHost;
	const run = () => stop(remote, { uninstall, force: options.force === true });
	const service = deps.service();
	let result: RemoteHostStopResult;
	try {
		result = service ? await service.exclusive(run) : await run();
	} catch (error) {
		if (error instanceof RemoteHostStopError) {
			return { ok: false, code: error.code, error: error.message };
		}
		throw error;
	}
	// Automatic Federation would start a stopped host again, and register its service again: the
	// remote's own Federation switch is what it honors, so the stop turns it off.
	const switched =
		result.outcome === 'done' ? withFederationOff(deps.readRemotes(), remote.id) : null;
	if (switched) deps.writeRemotes(switched);
	const message = describeRemoteHostStop(remote, result, uninstall);
	// A host that comes back at boot is not the stop that was asked for, even with the host stopped now.
	if (result.outcome === 'done' && result.serviceLeftAtBoot) {
		return {
			ok: false,
			code: 'service-disable',
			error: switched
				? `${message} ${federationTurnedOffNote(remote.name || remote.host)}`
				: message,
			...(switched ? { federationOff: true } : {}),
		};
	}
	return {
		ok: true,
		outcome: result.outcome,
		message: switched
			? `${message} ${federationTurnedOffNote(remote.name || remote.host)}`
			: message,
		...(result.outcome === 'agents-held' ? { agents: result.agents } : {}),
		...(switched ? { federationOff: true } : {}),
	};
}
