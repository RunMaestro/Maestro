/**
 * The Federation peer mirror's place in the main process: the one service instance, the runtime
 * that starts it while hosted agents are on and stops it when they turn off or the app quits, and
 * the push channels.
 *
 * Federation runs only while hosted agents are on (`followHostingSetting()`). Then the service
 * probes every enabled SSH remote that has not opted out (`federation: false`), one at a time, and
 * mirrors the ones that run a host. A remote without a host is probed once and left alone until
 * something changes (see `PeerMirrorService`). Off, nothing of it runs and no remote is dialed.
 */

import { getSshForwardManager } from '../../shared/maestro-lib/client/ssh-forward';
import { createWsMaestroClient } from '../../shared/maestro-lib/client/ws-client';
import type { MirrorPush } from '../../shared/maestro-lib/client/peer-mirror';
import type { SshRemoteConfig } from '../../shared/types';
import { captureException } from '../utils/sentry';
import type { SafeSendFn } from '../utils/safe-send';
import { PeerMirrorService, type PeerMirrorServiceDeps } from './peer-mirror-service';
import type { AutoFederationCoordinator } from './auto-federation';
import {
	emptyAutoFederationSnapshot,
	type AutoFederationSnapshot,
} from '../../shared/federationAuto';
import { followHostingSetting, type HostingSetting } from './hosting-gate';

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

// The come-home job's holder lives beside the job, so the spawn refusal can read it without this
// module's imports.
export { getComeHomeRunner, setComeHomeRunner } from './come-home';

/**
 * What automatic Federation reports: the coordinator's snapshot, or, while it does not run (hosted
 * agents off), the idle one: nothing seen and no automatic moves in effect. The IPC and the CLI
 * bridge both answer this.
 */
export function autoFederationSnapshot(): AutoFederationSnapshot {
	return autoFederation?.snapshot() ?? emptyAutoFederationSnapshot(false);
}

/** Run Now: a pass while the coordinator runs; while it does not, the idle snapshot (nothing dials). */
export function runAutoFederationNow(): Promise<AutoFederationSnapshot> {
	return autoFederation
		? autoFederation.runNow()
		: Promise.resolve(emptyAutoFederationSnapshot(false));
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
	/** Whether the service should run: the last call was `start()`. */
	let wanted = false;
	/**
	 * The stop of the previous service, until it finished. A new service starts only after it: the
	 * old stop ends with `federation:reset`, which would empty what a new service already pushed.
	 */
	let stopping: Promise<void> | null = null;
	const launch = (): void => {
		if (!wanted || service || stopping) return;
		service = new PeerMirrorService(buildPeerMirrorServiceDeps(deps));
		service.start();
	};
	return {
		start: () => {
			wanted = true;
			if (service) {
				service.reconcile();
				return;
			}
			launch();
		},
		stop: () => {
			wanted = false;
			const running = service;
			service = null;
			if (!running) return;
			const done = running
				.stop()
				.catch((error) => void captureException(error, { operation: 'federation:stop' }))
				.finally(() => {
					if (stopping === done) stopping = null;
					// Turned on again while the old service was stopping: start the new one now.
					launch();
				});
			stopping = done;
		},
	};
}

/**
 * The boot start site: build the runtime and run it only while hosted agents are on. Returns the
 * dispose the app calls on quit (stops a running service).
 */
export function startFederationWhileHosting(
	deps: FederationRuntimeDeps & { hosting: HostingSetting }
): () => void {
	return followHostingSetting(deps.hosting, createFederationRuntime(deps));
}

/** Test seam. */
export function setPeerMirrorServiceForTests(next: PeerMirrorService | null): void {
	service = next;
}
