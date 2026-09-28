/**
 * WakaTime heartbeats for CLI-spawned agents (batch, `send`, playbooks).
 *
 * The desktop app beats via a ProcessManager listener, but the CLI spawns
 * agents itself and so was invisible to WakaTime: Auto Run and playbook time
 * simply never got recorded under Maestro.
 *
 * This reuses the single {@link WakaTimeManager} implementation rather than
 * reimplementing heartbeat logic. Two constraints shape the wiring:
 *
 *  - `maestro-cli` is an esbuild bundle with no native modules, so the manager
 *    is constructed with a plain settings adapter over `maestro-settings.json`
 *    (`readSettings()`), not electron-store.
 *  - The CLI is short-lived and heartbeats are fire-and-forget, so a beat must
 *    never delay or fail the agent run it is describing.
 */

import * as path from 'path';
import { WakaTimeManager, type WakaTimeSettingsSource } from '../../main/wakatime-manager';
import { readSettings } from './storage';

/** Cached manager for this CLI process. `null` once we know WakaTime is off. */
let cached: WakaTimeManager | null | undefined;

/**
 * CLI build version. `__MAESTRO_CLI_VERSION__` is substituted by esbuild at
 * build time and is genuinely absent when running from source (tests, ts-node),
 * hence the `typeof` guard - referencing it directly would throw a
 * ReferenceError. Same mechanism `src/cli/index.ts` uses for `--version`.
 */
declare const __MAESTRO_CLI_VERSION__: string;
function getCliVersion(): string {
	return typeof __MAESTRO_CLI_VERSION__ !== 'undefined' ? __MAESTRO_CLI_VERSION__ : '0.0.0-dev';
}

/**
 * Read WakaTime settings straight off disk.
 *
 * Values are read per call (not snapshotted) so a long-running batch picks up a
 * mid-run settings change, matching the desktop's `onDidChange` behavior.
 */
const settingsAdapter: WakaTimeSettingsSource = {
	get(key: string, defaultValue: unknown) {
		const settings = readSettings() as Record<string, unknown>;
		const value = settings?.[key];
		return (value === undefined || value === null ? defaultValue : value) as never;
	},
} as WakaTimeSettingsSource;

/**
 * The manager for this process, or null when WakaTime is disabled.
 *
 * The enabled check happens here as well as inside the manager so a disabled
 * install never pays for the module's lazy CLI detection.
 */
function getManager(): WakaTimeManager | null {
	if (cached !== undefined) return cached;
	try {
		if (!settingsAdapter.get('wakatimeEnabled', false)) {
			cached = null;
			return null;
		}
		cached = new WakaTimeManager(settingsAdapter, getCliVersion());
	} catch {
		// Unreadable settings must not break agent spawning.
		cached = null;
	}
	return cached;
}

/**
 * Build the heartbeat callback for one CLI agent run, or undefined when
 * WakaTime is off so the caller can skip the work entirely.
 *
 * Call the returned function on every stdout chunk: the manager debounces to
 * one beat per two minutes, and beating throughout the run is what makes a long
 * run record its real duration instead of a single instant.
 */
export function buildCliWakaTimeHeartbeat(
	heartbeatSessionId: string,
	cwd: string,
	isRemote: boolean
): (() => void) | undefined {
	const manager = getManager();
	if (!manager) return undefined;

	const projectName = cwd ? path.basename(cwd) : heartbeatSessionId;
	return () => {
		void manager
			.sendHeartbeat(heartbeatSessionId, projectName, cwd, {
				// CLI runs are unattended automation, the same category Cue uses.
				source: 'auto',
				isRemote,
				origin: 'cli',
			})
			.catch(() => {
				/* telemetry must never fail the run it describes */
			});
	};
}

/** Reset cached state. Test seam only. */
export function resetCliWakaTimeForTests(): void {
	cached = undefined;
}
