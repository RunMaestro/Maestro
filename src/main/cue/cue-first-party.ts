/**
 * Maestro Cue — first-party plugin supervisor hooks (encore-lifts L3).
 *
 * The Cue engine IS the feature's one supervised background service
 * (`cue.engine` in MAESTRO_CUE_FIRST_PARTY_PLUGIN): every watcher, GitHub
 * poller, schedule timer, and the recovery heartbeat live inside
 * `CueEngine.start()`/`stop()`. These hooks route the first-party bridge's
 * lifecycle (marketplace tile enable/disable, grant revocation, fail-closed
 * paths) through that SAME start/stop seam the EncoreTab toggle already
 * drives via `cue:enable`/`cue:disable` IPC — so disabling the tile ACTUALLY
 * halts watchers/pollers instead of merely hiding UI.
 *
 * - `reconcile()` starts the engine when it is not running. It passes
 *   'system-boot' for the same reason the `cue:enable` IPC handler does:
 *   a user-driven enable should fire `app.startup` subscriptions exactly
 *   like an Electron launch (see cue-startup.test.ts). Already running →
 *   no-op, so a redundant reconcile never tears down live subscriptions
 *   or re-fires startup triggers.
 * - `stopAll()` fully stops the engine (clears every trigger source, run
 *   queue, heartbeat, and closes the DB). Idempotent via the engine's own
 *   `enabled` guard.
 *
 * The engine reference is a getter because index.ts constructs the bridge
 * wiring before the engine exists on some paths and nulls it on teardown.
 */

import type { FirstPartySupervisorHooks } from '../plugins/first-party-bridge';

/** The narrow slice of CueEngine the supervisor hooks need. */
export interface CueEngineLifecycle {
	isEnabled(): boolean;
	start(reason: 'system-boot'): void;
	stop(): void;
}

/**
 * Build the `firstPartySupervisors.maestroCue` hooks over a live engine
 * getter. A null engine (headless boot, teardown) makes both hooks no-ops —
 * there is nothing running to reconcile or stop.
 */
export function createCueSupervisorHooks(
	getEngine: () => CueEngineLifecycle | null
): FirstPartySupervisorHooks {
	return {
		reconcile: () => {
			const engine = getEngine();
			if (!engine || engine.isEnabled()) return;
			engine.start('system-boot');
		},
		stopAll: () => {
			getEngine()?.stop();
		},
	};
}
