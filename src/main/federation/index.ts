/**
 * The Federation peer mirror's place in the main process: the one service instance, the Encore
 * lifecycle hooks that create and stop it, and the push channels.
 *
 * Zero footprint while the Federation Encore Feature is off: the service is never constructed, no
 * store listener is registered, no ssh runs, and the IPC handlers answer `{ enabled: false }`.
 */

import { getSshForwardManager } from '../../shared/maestro-lib/client/ssh-forward';
import { createWsMaestroClient } from '../../shared/maestro-lib/client/ws-client';
import type { MirrorPush } from '../../shared/maestro-lib/client/peer-mirror';
import type { SshRemoteConfig } from '../../shared/types';
import type { FirstPartySupervisorHooks } from '../plugins/first-party-bridge';
import { captureException } from '../utils/sentry';
import type { SafeSendFn } from '../utils/safe-send';
import { PeerMirrorService, type PeerMirrorServiceDeps } from './peer-mirror-service';

export { PeerMirrorService } from './peer-mirror-service';

/** One change to a mirrored peer, pushed to every window: a `MirrorPush`. */
export const FEDERATION_EVENT_CHANNEL = 'federation:event';
/** The feature turned off: every window drops what it mirrors. */
export const FEDERATION_RESET_CHANNEL = 'federation:reset';

let service: PeerMirrorService | null = null;

/** The running service, or null while the Federation Encore Feature is off. */
export function getPeerMirrorService(): PeerMirrorService | null {
	return service;
}

export interface FederationRuntimeDeps {
	/** The stored SSH remotes. */
	readRemotes(): SshRemoteConfig[];
	/** Call `onChange` when the stored SSH remotes change. Returns the unsubscribe. */
	watchRemotes(onChange: () => void): () => void;
	/** The all-windows push. */
	safeSend: SafeSendFn;
	/** Test seam: build the service from these deps instead of the real forward and client. */
	overrides?: Partial<PeerMirrorServiceDeps>;
}

/** The deps the real service runs on: the shared SSH forward manager and the WebSocket client. */
export function buildPeerMirrorServiceDeps(deps: FederationRuntimeDeps): PeerMirrorServiceDeps {
	return {
		readRemotes: deps.readRemotes,
		watchRemotes: deps.watchRemotes,
		acquireForward: (remote) => getSshForwardManager().acquire(remote),
		createClient: (endpoint) => createWsMaestroClient({ endpoint }),
		push: (payload: MirrorPush) => deps.safeSend(FEDERATION_EVENT_CHANNEL, payload),
		reset: () => deps.safeSend(FEDERATION_RESET_CHANNEL),
		onError: (error, operation) => void captureException(error, { operation }),
		...deps.overrides,
	};
}

/**
 * The Encore lifecycle hooks for `federation`: `reconcile()` creates and starts the service (or
 * settles the mirrored set when it already runs), `stopAll()` stops it and forgets it. Both are
 * idempotent.
 */
export function createFederationSupervisorHooks(
	deps: FederationRuntimeDeps
): FirstPartySupervisorHooks {
	return {
		reconcile: () => {
			if (service) {
				service.reconcile();
				return;
			}
			service = new PeerMirrorService(buildPeerMirrorServiceDeps(deps));
			service.start();
		},
		stopAll: () => {
			const running = service;
			service = null;
			void running
				?.stop()
				.catch((error) => void captureException(error, { operation: 'federation:stopAll' }));
		},
	};
}

/** Test seam. */
export function setPeerMirrorServiceForTests(next: PeerMirrorService | null): void {
	service = next;
}
