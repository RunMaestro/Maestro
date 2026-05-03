/**
 * In-memory ring buffer of completed Cue run results.
 *
 * Keeps the most recent N results for the activity log view
 * in the Cue Modal dashboard.
 */

import type { CueRunResult } from './cue-types';

const ACTIVITY_LOG_MAX = 500;

export interface CueActivityLog {
	push(result: CueRunResult): void;
	/**
	 * Replace the in-memory log with the given results (oldest → newest).
	 * Used at engine start to rehydrate from sqlite so the activity log
	 * survives app restarts. Trims to maxSize, keeping the newest entries.
	 */
	seed(results: CueRunResult[]): void;
	getAll(limit?: number): CueRunResult[];
	clear(): void;
}

export function createCueActivityLog(maxSize: number = ACTIVITY_LOG_MAX): CueActivityLog {
	let log: CueRunResult[] = [];

	return {
		push(result: CueRunResult): void {
			log.push(result);
			if (log.length > maxSize) {
				log = log.slice(-maxSize);
			}
		},

		seed(results: CueRunResult[]): void {
			log = results.length > maxSize ? results.slice(-maxSize) : [...results];
		},

		getAll(limit?: number): CueRunResult[] {
			if (limit !== undefined) {
				return log.slice(-limit);
			}
			return [...log];
		},

		clear(): void {
			log = [];
		},
	};
}
