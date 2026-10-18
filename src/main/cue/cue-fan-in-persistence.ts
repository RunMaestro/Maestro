/**
 * Durable fan-in progress (standalone engine only).
 *
 * Thin facade over `cue_fan_in_state` in cue-db, the fan-in counterpart of
 * `cue-queue-persistence.ts`. `CueFanInTracker` writes through it as each
 * source completes and deletes a fan-in's rows when it fires, times out or is
 * reset, so a kill -9, a power loss or a drain keeps partial progress; the
 * engine restores it at start (`CueFanInTracker.restore`).
 *
 * Fail-open like the queue: a DB failure degrades to in-memory only.
 *
 * Gated to the standalone runner: the desktop renderer re-runs
 * `refreshSession` for every agent at boot, and a refresh tears fan-in state
 * down, so durable state there would need a change to what a yaml reload does.
 */

import type { MainLogLevel } from '../../shared/logger-types';
import {
	getFanInState,
	safePersistFanInSource,
	safeRemoveFanInState,
	type CueFanInStateRecord,
} from './cue-db';

export type { CueFanInStateRecord };

export interface CueFanInPersistence {
	saveSource(record: CueFanInStateRecord): void;
	remove(ownerSessionId: string, subscriptionName: string): void;
	loadAll(): CueFanInStateRecord[];
}

export function createCueFanInPersistence(deps: {
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
}): CueFanInPersistence {
	return {
		saveSource: safePersistFanInSource,
		remove: safeRemoveFanInState,
		loadAll() {
			try {
				return getFanInState();
			} catch (err) {
				deps.onLog(
					'warn',
					`[CUE] Failed to read persisted fan-in progress - starting empty: ${err instanceof Error ? err.message : String(err)}`
				);
				return [];
			}
		},
	};
}
