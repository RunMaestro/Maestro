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
 * Hosting reads as on only once the default-off migration has run (its marker is set), as the CLI
 * reads it (`withFederationHostingDefaultOff()`): a migration that failed to write leaves the old
 * `true` on disk, and that must not dial every remote. A change made outside the store (a
 * `maestro-cli settings set`, an editor) reaches the gate through
 * `settleHostingAfterExternalChange()`, which the settings file watcher calls.
 *
 * Not `createEncoreFeatureLifecycle()`: that follows the `encoreFeatures` map, and this is a plain
 * boolean setting with its own key.
 */

import {
	FEDERATION_AUTO_MOVE_SETTING,
	FEDERATION_HOSTING_DEFAULT_OFF_MIGRATION_MARKER,
	withFederationHostingDefaultOff,
} from '../../shared/federationAuto';
import {
	HOSTED_AGENTS_SETTING,
	hostedAgentsEnabled,
} from '../../shared/maestro-lib/agents/lift-pointer';

/** The settings keys the gate reads. */
type HostingKey =
	| typeof HOSTED_AGENTS_SETTING
	| typeof FEDERATION_AUTO_MOVE_SETTING
	| typeof FEDERATION_HOSTING_DEFAULT_OFF_MIGRATION_MARKER;

/** The two Federation switches, by settings key. */
export type HostingSwitches = Record<
	typeof HOSTED_AGENTS_SETTING | typeof FEDERATION_AUTO_MOVE_SETTING,
	boolean
>;

/** Whether `key` names one of the two Federation switches. */
export function isHostingSwitchKey(key: string): key is keyof HostingSwitches {
	return key === HOSTED_AGENTS_SETTING || key === FEDERATION_AUTO_MOVE_SETTING;
}

/**
 * The two Federation switches as every desktop reader must see them: the gate, the launch guard,
 * and the settings the windows read. Each is on only for an explicit `true` written after the
 * default-off migration ran (`withFederationHostingDefaultOff()`), so a migration that failed to
 * write reads as off everywhere at once, never on in one place and off in another.
 */
export function readHostingSwitches(store: Pick<HostingSettingStore, 'get'>): HostingSwitches {
	const settings = withFederationHostingDefaultOff({
		[HOSTED_AGENTS_SETTING]: store.get(HOSTED_AGENTS_SETTING),
		[FEDERATION_AUTO_MOVE_SETTING]: store.get(FEDERATION_AUTO_MOVE_SETTING),
		[FEDERATION_HOSTING_DEFAULT_OFF_MIGRATION_MARKER]: store.get(
			FEDERATION_HOSTING_DEFAULT_OFF_MIGRATION_MARKER
		),
	});
	return {
		[HOSTED_AGENTS_SETTING]: hostedAgentsEnabled(settings),
		[FEDERATION_AUTO_MOVE_SETTING]: settings[FEDERATION_AUTO_MOVE_SETTING] === true,
	};
}

/** Every gate's watcher, told when the settings file changed outside the store. */
const externalChangeListeners = new Set<() => void>();

/**
 * The settings file changed outside the store (the CLI writes it directly, and no `onDidChange`
 * fires for that): every gate reads the setting again and starts or stops what it gates.
 */
export function settleHostingAfterExternalChange(): void {
	for (const listener of [...externalChangeListeners]) listener();
}

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
	get(key: HostingKey): unknown;
	onDidChange(key: HostingKey, callback: () => void): () => void;
}

/**
 * The hosted agents setting of the settings store: on only for an explicit `true` written after
 * the default-off migration ran.
 */
export function hostingSettingOf(store: HostingSettingStore): HostingSetting {
	return {
		isOn: () => readHostingSwitches(store)[HOSTED_AGENTS_SETTING],
		watch: (onChange) => {
			const listener = () => onChange();
			const offHosting = store.onDidChange(HOSTED_AGENTS_SETTING, listener);
			const offMarker = store.onDidChange(
				FEDERATION_HOSTING_DEFAULT_OFF_MIGRATION_MARKER,
				listener
			);
			externalChangeListeners.add(listener);
			return () => {
				offHosting();
				offMarker();
				externalChangeListeners.delete(listener);
			};
		},
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
