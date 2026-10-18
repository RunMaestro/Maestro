/**
 * Encore feature lifecycle: the ONE place a feature's background services
 * follow its Encore flag.
 *
 * A flag reaches the settings store by two routes. The Extensions toggle goes
 * through `FirstPartyPluginBridge.setEnabled`, which stops or reconciles the
 * feature's supervised work itself. `maestro-cli encore enable|disable` (and an
 * external edit of the settings file) is a plain `settings.set('encoreFeatures')`
 * that never touches the bridge, so a feature switched off from the CLI kept its
 * watchers, timers, and child processes running until the next launch.
 *
 * The `encoreFeatures` store change is the one signal every route produces.
 * `apply()` runs on it and, for every flag that changed, calls the SAME hooks
 * the bridge holds: `reconcile()` when the flag turned on, `stopAll()` when it
 * turned off. The bridge calling them too is harmless; every hook is idempotent.
 *
 * Deliberately NOT `FirstPartyPluginBridge.reconcileBackgroundService()`: that
 * forces a feature OFF when its first-party grants were never minted, which is
 * every default-on feature (Cue, Usage & Stats, ...) on an install that never
 * toggled it in the Extensions tile. Following the flag is this module's job;
 * grant enforcement stays with the bridge and the broker.
 */

import { resolveEncoreFeatures, type EncoreFeatureDefaults } from '../shared/encoreFeatureDefaults';
import type { FirstPartySupervisorHooks } from './plugins/first-party-bridge';

/** One Encore Feature flag (first-party features plus the community `plugins` switch). */
export type EncoreFlag = keyof EncoreFeatureDefaults;

/** The background-service hooks per feature, shared with the first-party bridges. */
export type EncoreServiceHooks = Partial<Record<EncoreFlag, FirstPartySupervisorHooks>>;

export interface EncoreFeatureLifecycleDeps {
	/** Report a hook that threw. The other features still settle. */
	onError: (flag: EncoreFlag, phase: 'reconcile' | 'stopAll', error: unknown) => void;
}

export interface EncoreFeatureLifecycle {
	/**
	 * Bind the live hooks and record `raw` as the state already applied. Called
	 * once the services exist; flag changes before that have nothing to settle.
	 */
	attach(hooks: EncoreServiceHooks, raw: unknown): void;
	/** Start `flag`'s background services when its flag is on (boot). */
	startIfEnabled(flag: EncoreFlag, raw: unknown): void;
	/** Settle every feature whose flag changed since the last call. */
	apply(raw: unknown): void;
}

export function createEncoreFeatureLifecycle(
	deps: EncoreFeatureLifecycleDeps
): EncoreFeatureLifecycle {
	let hooks: EncoreServiceHooks = {};
	let applied: EncoreFeatureDefaults | null = null;

	const run = (flag: EncoreFlag, phase: 'reconcile' | 'stopAll'): void => {
		const hook = hooks[flag];
		if (!hook) return;
		try {
			hook[phase]();
		} catch (error) {
			deps.onError(flag, phase, error);
		}
	};

	return {
		attach(nextHooks, raw) {
			hooks = nextHooks;
			applied = resolveEncoreFeatures(raw);
		},
		startIfEnabled(flag, raw) {
			if (resolveEncoreFeatures(raw)[flag]) run(flag, 'reconcile');
		},
		apply(raw) {
			if (!applied) return;
			const next = resolveEncoreFeatures(raw);
			const previous = applied;
			applied = next;
			for (const flag of Object.keys(hooks) as EncoreFlag[]) {
				if (next[flag] === previous[flag]) continue;
				run(flag, next[flag] ? 'reconcile' : 'stopAll');
			}
		},
	};
}
