/**
 * The one gate where Federation starts: the hosted agents setting (`federationHostedAgents`).
 *
 * Off (the default), Maestro starts nothing of Federation: no peer mirror, no automatic
 * Federation coordinator, so no probe of an SSH remote, no SSH forward, no install, no host start,
 * no move, and no timer. On, both start; off again, both stop (every mirror connection closed,
 * every forward released, every timer cleared, and the windows told to drop what they showed).
 *
 * The gate sits at the two start sites (the runtime in `src/main/index.ts`, the coordinator in
 * `src/main/ipc/handlers/federation.ts`), never inside a service, so a user action that needs one
 * host for one call (Move Back from Host) still has the functions it calls.
 *
 * Not `createEncoreFeatureLifecycle()`: that follows the `encoreFeatures` map, and this is a plain
 * boolean setting with its own key.
 */

import {
	HOSTED_AGENTS_SETTING,
	hostedAgentsEnabled,
} from '../../shared/maestro-lib/agents/lift-pointer';

/** The hosted agents setting: its current value and its changes. */
export interface HostingSetting {
	isOn(): boolean;
	/** Call `onChange` when the setting changes. Returns the unsubscribe. */
	watch(onChange: () => void): () => void;
}

/** What the gate starts and stops. Both are called only on a change of state. */
export interface HostingGatedService {
	start(): void;
	stop(): void;
}

/** The part of the settings store the gate reads. */
export interface HostingSettingStore {
	get(key: typeof HOSTED_AGENTS_SETTING): unknown;
	onDidChange(key: typeof HOSTED_AGENTS_SETTING, callback: () => void): () => void;
}

/** The hosted agents setting of the settings store (absent or anything but `true` is off). */
export function hostingSettingOf(store: HostingSettingStore): HostingSetting {
	return {
		isOn: () => hostedAgentsEnabled({ [HOSTED_AGENTS_SETTING]: store.get(HOSTED_AGENTS_SETTING) }),
		watch: (onChange) => store.onDidChange(HOSTED_AGENTS_SETTING, () => onChange()),
	};
}

/**
 * Start `service` now when hosting is on, and from then on start it when hosting turns on and stop
 * it when hosting turns off. Returns a dispose that stops following and stops a running service.
 */
export function followHostingSetting(
	setting: HostingSetting,
	service: HostingGatedService
): () => void {
	let running = false;
	const settle = (): void => {
		const on = setting.isOn();
		if (on === running) return;
		running = on;
		if (on) service.start();
		else service.stop();
	};
	const unwatch = setting.watch(settle);
	settle();
	return () => {
		unwatch();
		if (!running) return;
		running = false;
		service.stop();
	};
}
