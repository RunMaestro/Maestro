/**
 * The Federation peer mirror's place in the main process: the one service instance, the runtime
 * that starts it at boot and stops it on quit, and the push channels.
 *
 * Federation is always on and opportunistic: the service probes every enabled SSH remote that has
 * not opted out (`federation: false`), one at a time, and mirrors the ones that run a host. A
 * remote without a host is probed once and left alone until something changes (see
 * `PeerMirrorService`).
 */

import { getSshForwardManager } from '../../shared/maestro-lib/client/ssh-forward';
import { createWsMaestroClient } from '../../shared/maestro-lib/client/ws-client';
import type { MirrorPush } from '../../shared/maestro-lib/client/peer-mirror';
import type { SshRemoteConfig } from '../../shared/types';
import { captureException } from '../utils/sentry';
import type { SafeSendFn } from '../utils/safe-send';
import { PeerMirrorService, type PeerMirrorServiceDeps } from './peer-mirror-service';
import type { AutoFederationCoordinator } from './auto-federation';

export { PeerMirrorService } from './peer-mirror-service';

/** One change to a mirrored peer, pushed to every window: a `MirrorPush`. */
export const FEDERATION_EVENT_CHANNEL = 'federation:event';
/** The service stopped: every window drops what it mirrors. */
export const FEDERATION_RESET_CHANNEL = 'federation:reset';

let service: PeerMirrorService | null = null;
let autoFederation: AutoFederationCoordinator | null = null;
const pushListeners = new Set<(payload: MirrorPush) => void>();

/** Follow every change the mirror pushes to the windows (the auto-federation coordinator does). */
export function onMirrorPush(listener: (payload: MirrorPush) => void): () => void {
	pushListeners.add(listener);
	return () => pushListeners.delete(listener);
}

/** The automatic Federation coordinator, once the IPC handlers built it. */
export function getAutoFederation(): AutoFederationCoordinator | null {
	return autoFederation;
}

export function setAutoFederation(next: AutoFederationCoordinator | null): void {
	autoFederation = next;
}

/** Pushes the automatic Federation snapshot to every window. */
export const FEDERATION_AUTO_CHANNEL = 'federation:auto';

/** The running service, or null before boot started it and after quit stopped it. */
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
		push: (payload: MirrorPush) => {
			deps.safeSend(FEDERATION_EVENT_CHANNEL, payload);
			for (const listener of pushListeners) listener(payload);
		},
		reset: () => deps.safeSend(FEDERATION_RESET_CHANNEL),
		onError: (error, operation) => void captureException(error, { operation }),
		...deps.overrides,
	};
}

/** Start and stop the one peer mirror service. Both are idempotent. */
export interface FederationRuntime {
	/** Create and start the service, or settle the mirrored set when it already runs. */
	start(): void;
	/** Stop the service and forget it. */
	stop(): void;
}

export function createFederationRuntime(deps: FederationRuntimeDeps): FederationRuntime {
	return {
		start: () => {
			if (service) {
				service.reconcile();
				return;
			}
			service = new PeerMirrorService(buildPeerMirrorServiceDeps(deps));
			service.start();
		},
		stop: () => {
			const running = service;
			service = null;
			void running
				?.stop()
				.catch((error) => void captureException(error, { operation: 'federation:stop' }));
		},
	};
}

/** Test seam. */
export function setPeerMirrorServiceForTests(next: PeerMirrorService | null): void {
	service = next;
}
