/**
 * Process-wide handle to the single {@link WakaTimeManager}.
 *
 * Cue executes agents through its own `child_process.spawn` rather than the
 * ProcessManager, so it never sees the `data` events the WakaTime listener
 * hooks. It still has to reach the SAME manager instance the desktop uses:
 * the per-session heartbeat debounce and the CLI auto-install/update guard are
 * instance state, and a second manager would defeat both.
 *
 * Registered once during main-process startup. Callers that run before startup
 * (or in tests) get `null` and simply skip the heartbeat.
 */

import type { WakaTimeManager } from './wakatime-manager';

let instance: WakaTimeManager | null = null;

/** Register the process-wide manager. Called once from main startup. */
export function setWakaTimeManager(manager: WakaTimeManager | null): void {
	instance = manager;
}

/** The registered manager, or null when WakaTime has not been initialized. */
export function getWakaTimeManager(): WakaTimeManager | null {
	return instance;
}
