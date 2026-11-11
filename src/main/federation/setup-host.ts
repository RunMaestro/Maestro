/**
 * The desktop's Make Federated and Start Host: put this app's `maestro-cli` on an SSH remote (or
 * upgrade an older one), start the host there, and have the peer mirror pick it up at once.
 *
 * The work is `setupRemoteHost()`, the same function `maestro-cli remote-host install --start`
 * runs, so the two cannot drift. It runs inside the mirror's one SSH queue (`exclusive()`), so the
 * installer's ssh never dials beside a probe of the same remote.
 */

import { FEDERATION_NOT_RUNNING_MESSAGE } from '../../shared/federationCommands';
import { isFederationRemote } from '../../shared/federationRemote';
import { federationOffMessage } from '../../shared/maestro-lib/client/peer-connection';
import type { MirrorPeerSummary } from '../../shared/maestro-lib/client/peer-mirror';
import { RemoteDiscoveryError } from '../../shared/maestro-lib/client/remote-discovery';
import {
	RemoteInstallError,
	resolveLocalCliBundle,
	setupRemoteHost,
	type LocalCliBundle,
	type RemoteHostSetupResult,
} from '../../shared/maestro-lib/client/remote-install';
import type { SshRemoteConfig } from '../../shared/types';
import type { PeerMirrorService } from './peer-mirror-service';

export interface DesktopSetupHostOptions {
	/** Replace a running host on an older version (`--restart`). */
	restart?: boolean;
	/** Install over a `maestro-cli` Maestro did not install (`--force`). */
	force?: boolean;
}

export type DesktopSetupHostAnswer =
	| { ok: true; result: RemoteHostSetupResult; peer?: MirrorPeerSummary; reconnectError?: string }
	| { ok: false; code: string; error: string };

export interface DesktopSetupHostDeps {
	readRemotes(): SshRemoteConfig[];
	service(): PeerMirrorService | null;
	/** This app's CLI bundle. */
	localBundle(): LocalCliBundle;
	setup?: typeof setupRemoteHost;
}

/** Set up the host on one SSH remote by id. Never throws: a refusal or failure is `{ ok: false }`. */
export async function setupHostFromDesktop(
	remoteId: string,
	options: DesktopSetupHostOptions,
	deps: DesktopSetupHostDeps
): Promise<DesktopSetupHostAnswer> {
	const service = deps.service();
	if (!service) {
		return { ok: false, code: 'FEDERATION_NOT_RUNNING', error: FEDERATION_NOT_RUNNING_MESSAGE };
	}
	const remote = deps.readRemotes().find((candidate) => candidate.id === remoteId);
	if (!remote) return { ok: false, code: 'REMOTE_NOT_FOUND', error: 'SSH remote not found' };
	if (remote.enabled === false) {
		return {
			ok: false,
			code: 'REMOTE_DISABLED',
			error: `SSH remote "${remote.name}" is disabled. Enable it in Settings > SSH Hosts first.`,
		};
	}
	if (!isFederationRemote(remote)) {
		return { ok: false, code: 'PEER_FEDERATION_OFF', error: federationOffMessage(remote) };
	}

	let result: RemoteHostSetupResult;
	try {
		const bundle = deps.localBundle();
		const setup = deps.setup ?? setupRemoteHost;
		result = await service.exclusive(() =>
			setup(remote, bundle, {
				start: true,
				// Make Federated keeps the host running across reboots too.
				service: true,
				restart: options.restart === true,
				force: options.force === true,
			})
		);
	} catch (error) {
		const code =
			error instanceof RemoteInstallError || error instanceof RemoteDiscoveryError
				? error.code
				: 'SETUP_FAILED';
		return { ok: false, code, error: error instanceof Error ? error.message : String(error) };
	}

	if (result.start && !result.start.installed) {
		return { ok: false, code: 'not-installed', error: result.start.fix };
	}
	const reconnected = await service.reconnectRemote(remote.id);
	return {
		ok: true,
		result,
		...(reconnected.peer ? { peer: reconnected.peer } : {}),
		...(reconnected.ok ? {} : { reconnectError: reconnected.error }),
	};
}

/** The deps the IPC handler runs on. */
export function buildDesktopSetupHostDeps(runtime: {
	readSshRemotes(): unknown;
	service(): PeerMirrorService | null;
	resolveCliFile(): string | null;
	appVersion(): string;
}): DesktopSetupHostDeps {
	return {
		readRemotes: () => {
			const remotes = runtime.readSshRemotes();
			return Array.isArray(remotes) ? (remotes as SshRemoteConfig[]) : [];
		},
		service: runtime.service,
		localBundle: () => {
			const cliFile = runtime.resolveCliFile();
			if (!cliFile) {
				throw new RemoteInstallError(
					'local-bundle',
					'This Maestro has no maestro-cli bundle to copy. Reinstall Maestro on this machine.'
				);
			}
			return resolveLocalCliBundle(cliFile, runtime.appVersion());
		},
	};
}
