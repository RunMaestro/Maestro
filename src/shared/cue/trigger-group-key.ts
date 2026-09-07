/**
 * Stable identity key for "subscriptions that represent one visual trigger."
 *
 * The pipeline-editor serializer emits fan-out to mixed or command targets as
 * multiple parallel subscriptions that each re-carry the full trigger event
 * config. Three places need the same notion of "same trigger" and must agree:
 *
 *  - `yamlToPipeline.ts` collapses matching subs onto one trigger node on load.
 *  - `cue-engine.ts` fires every sibling sub when the user clicks Play, so a
 *    manual run matches what a scheduled tick would do.
 *  - `SessionsTable.tsx` picks one representative per group for Run Now.
 *
 * They previously carried three hand-mirrored copies of this function, and the
 * two runtime copies had already drifted from the editor's (missing the
 * re-trigger fields), which let a manual Play fire subs a real tick would not
 * have grouped. One implementation, imported everywhere, removes that class of
 * bug: any divergence in event-specific config still yields a distinct key, so
 * genuinely independent triggers stay independent.
 */

import type { CueSubscription } from './contracts';

export function triggerGroupKey(sub: CueSubscription): string {
	// Sort filter keys so two subs whose filter objects differ only in key
	// insertion order (hand-written YAML or library-reordered round-trips)
	// still collapse to the same visual trigger.
	const filter = sub.filter
		? Object.keys(sub.filter)
				.sort()
				.reduce<Record<string, unknown>>((acc, k) => {
					acc[k] = (sub.filter as Record<string, unknown>)[k];
					return acc;
				}, {})
		: null;
	return JSON.stringify({
		event: sub.event,
		schedule_times: sub.schedule_times ?? null,
		schedule_days: sub.schedule_days ?? null,
		interval_minutes: sub.interval_minutes ?? null,
		watch: sub.watch ?? null,
		repo: sub.repo ?? null,
		poll_minutes: sub.poll_minutes ?? null,
		gh_state: sub.gh_state ?? null,
		gh_label_target: sub.gh_label_target ?? null,
		gh_labels: sub.gh_labels ?? null,
		retrigger_on_comments: sub.retrigger_on_comments ?? null,
		max_notifications: sub.max_notifications ?? null,
		label: sub.label ?? null,
		filter,
	});
}
