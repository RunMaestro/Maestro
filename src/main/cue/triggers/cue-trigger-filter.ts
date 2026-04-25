/**
 * Centralized filter check for Cue subscriptions.
 *
 * Replaces the 6+ duplicated `if (sub.filter && !matchesFilter(...))` blocks
 * that previously lived in cue-subscription-setup.ts (one per trigger setup
 * function) and cue-session-runtime-service.ts (the app.startup loop). Each
 * trigger source now calls `passesFilter` exactly once before its `emit`,
 * which means a future change to filter semantics is one edit instead of six.
 */

import type { MainLogLevel } from '../../../shared/logger-types';
import { describeFilter, matchesFilter } from '../cue-filter';
import type { CueEvent, CueSubscription } from '../cue-types';

/**
 * Returns `true` if `event` matches the subscription's filter (or there is no
 * filter at all). Returns `false` and logs a `[CUE]` line on a filter miss so
 * the user can see why a trigger didn't fire.
 */
export function passesFilter(
	sub: CueSubscription,
	event: CueEvent,
	onLog: (level: MainLogLevel, message: string) => void
): boolean {
	if (!sub.filter) return true;
	if (matchesFilter(event.payload, sub.filter)) return true;
	onLog('cue', `[CUE] "${sub.name}" filter not matched (${describeFilter(sub.filter)})`);
	return false;
}
